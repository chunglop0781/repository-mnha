// services/word/htmlToDocx.js — chuyển HTML (nội dung trình soạn Word) → .docx thật (OOXML).
// Không dùng thư viện ngoài; tự tạo ZIP + document.xml/styles.xml/numbering.xml + ảnh nhúng.
'use strict';
const { writeZip } = require('./zip');
const { parseHtml } = require('./htmlSanitize');
const { escapeText } = require('./xml');
const { mathmlToOmml } = require('./omml');
const { LANGS } = require('../../config/codeConfig');

const PX_PER_PT = 96 / 72;
const EMU_PER_PX = 9525;
const TWIPS_PER_PX = 15;
// Ảnh đơn lẻ không thể lớn hơn cả tài liệu: dùng cùng trần HTML để KHÔNG âm thầm bỏ ảnh khi tải .docx
const MAX_IMAGE_BYTES = (LANGS.word && LANGS.word.maxHtmlBytes) || 40 * 1024 * 1024;

const COLORS = {
    black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
    yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', purple: '800080',
    cyan: '00FFFF', magenta: 'FF00FF', transparent: null
};
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote', 'pre', 'hr']);
const HEADING_OF = { h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', h4: 'Heading4', h5: 'Heading5', h6: 'Heading6' };

// Ký tự điều khiển (\u0000-\u0008, \u000b, \u000c, \u000e-\u001f, \ufffe, \uffff) KHÔNG hợp lệ trong XML 1.0 → Word từ chối mở cả file. Bỏ trước khi ghi.
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const esc = (s) => escapeText(String(s == null ? '' : s).replace(XML_BAD, '')).replace(/"/g, '&quot;');

function cssStyle(node) {
    const out = {};
    const raw = String((node.attrs && node.attrs.style) || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const k = part.slice(0, i).trim().toLowerCase();
        const v = part.slice(i + 1).trim();
        if (k && v) out[k] = v;
    }
    return out;
}
function toPx(v, base = 16) {
    const s = String(v || '').trim().toLowerCase();
    const m = /^(-?\d+(?:\.\d+)?)\s*(px|pt|em|rem|%|cm|mm|in)?$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    const u = m[2] || 'px';
    if (u === 'pt') return n * PX_PER_PT;
    if (u === 'em' || u === 'rem') return n * base;
    if (u === 'cm') return n * 37.8;
    if (u === 'mm') return n * 3.78;
    if (u === 'in') return n * 96;
    return n;
}
function ptOf(v) {
    const s = String(v || '').trim().toLowerCase();
    const m = /^(-?\d+(?:\.\d+)?)\s*(px|pt|em|rem)?$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    const u = m[2] || 'pt';
    const px = u === 'px' ? n : u === 'em' || u === 'rem' ? n * 16 : n * PX_PER_PT;
    return Math.max(1, Math.min(200, Math.round(px * 0.75 * 100) / 100));
}
function colorHex(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (COLORS[s] !== undefined) return COLORS[s];
    let m = /^#([0-9a-f]{3,8})$/.exec(s.replace(/\s/g, ''));
    if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        if (h.length === 8) h = h.slice(0, 6);
        if (/^[0-9a-f]{6}$/.test(h)) return h.toUpperCase();
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
    if (m) {
        const h = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0').toUpperCase();
        return h(m[1]) + h(m[2]) + h(m[3]);
    }
    return null;
}
function fontName(v) {
    const f = String(v || '').split(',')[0].replace(/['"]/g, '').trim();
    return f ? f.slice(0, 80) : null;
}
function alignOf(v) {
    const s = String(v || '').toLowerCase();
    if (s === 'center') return 'center';
    if (s === 'right' || s === 'end') return 'right';
    if (s === 'justify' || s === 'both') return 'both';
    return null;
}

function imageSize(buf) {
    try {
        if (buf.length > 22 && buf.readUInt32LE(0) === 0x9ac6cdd7) return { w: Math.abs(buf.readInt16LE(10) - buf.readInt16LE(6)), h: Math.abs(buf.readInt16LE(12) - buf.readInt16LE(8)) };   // WMF
        if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504E47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
        if (buf.length > 10 && /^GIF8/.test(buf.toString('latin1', 0, 4))) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
        if (buf.length > 26 && buf.toString('latin1', 0, 2) === 'BM') return { w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
        if (buf.length > 4 && buf.readUInt16BE(0) === 0xFFD8) {
            let p = 2;
            while (p + 9 < buf.length) {
                if (buf[p] !== 0xFF) { p++; continue; }
                const marker = buf[p + 1], len = buf.readUInt16BE(p + 2);
                if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    return { w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5) };
                }
                p += 2 + len;
            }
        }
    } catch (_) { /* ảnh lạ */ }
    return null;
}

function runPropsXml(p) {
    // Thứ tự theo schema CT_RPr: rFonts, b, bCs, i, iCs, strike, color, sz, szCs, u, shd, vertAlign (Word kén thứ tự)
    const out = [];
    if (p.font) out.push(`<w:rFonts w:ascii="${esc(p.font)}" w:hAnsi="${esc(p.font)}" w:cs="${esc(p.font)}"/>`);
    if (p.bold) out.push('<w:b/><w:bCs/>');
    if (p.italic) out.push('<w:i/><w:iCs/>');
    if (p.strike) out.push('<w:strike/>');
    if (p.color) out.push(`<w:color w:val="${p.color}"/>`);
    if (p.sizePt) out.push(`<w:sz w:val="${Math.round(p.sizePt * 2)}"/><w:szCs w:val="${Math.round(p.sizePt * 2)}"/>`);
    if (p.underline) out.push('<w:u w:val="single"/>');
    if (p.fill) out.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.fill}"/>`);
    if (p.vertAlign) out.push(`<w:vertAlign w:val="${p.vertAlign}"/>`);
    return out.length ? `<w:rPr>${out.join('')}</w:rPr>` : '';
}

function applyInline(tag, style, base) {
    const p = { ...base };
    if (tag === 'strong' || tag === 'b') p.bold = true;
    if (tag === 'em' || tag === 'i') p.italic = true;
    if (tag === 'u') p.underline = true;
    if (tag === 's' || tag === 'strike' || tag === 'del') p.strike = true;
    if (tag === 'sup') p.vertAlign = 'superscript';
    if (tag === 'sub') p.vertAlign = 'subscript';
    if (tag === 'mark') p.fill = colorHex(style['background-color']) || 'FFFF00';
    const fw = String(style['font-weight'] || '').toLowerCase();
    if (fw === 'bold' || fw === 'bolder' || Number(fw) >= 600) p.bold = true;
    else if (fw === 'normal' || (Number(fw) > 0 && Number(fw) <= 400)) p.bold = false;
    if (String(style['font-style'] || '').toLowerCase() === 'italic') p.italic = true;
    const td = String(style['text-decoration'] || style['text-decoration-line'] || '').toLowerCase();
    if (td.includes('underline')) p.underline = true;
    if (td.includes('line-through')) p.strike = true;
    const c = colorHex(style.color); if (c) p.color = c;
    const bg = colorHex(style['background-color']); if (bg) p.fill = bg;
    const f = fontName(style['font-family']); if (f) p.font = f;
    const sz = ptOf(style['font-size']); if (sz) p.sizePt = sz;
    const va = String(style['vertical-align'] || '').toLowerCase();
    if (va === 'super') p.vertAlign = 'superscript';
    else if (va === 'sub') p.vertAlign = 'subscript';
    return p;
}

function textRuns(text, props, out, pre) {
    const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!s) return;
    if (pre) {
        const lines = s.split('\n');
        lines.forEach((line, i) => {
            if (i) out.push({ br: true, ...props });
            if (line) out.push({ text: line, ...props });
        });
        return;
    }
    const t = s.replace(/[\t\n\r ]+/g, ' ');
    if (!t) return;
    out.push({ text: t, ...props });
}

function collectRuns(node, props, ctx, out, pre) {
    if (node.text != null) { textRuns(node.text, props, out, pre); return; }
    const tag = node.tag;
    if (tag === 'br') { out.push({ br: true, ...props }); return; }
    if (tag === 'img') { const img = imageRun(node, props, ctx); if (img) out.push(img); return; }
    if (tag === 'math') {
        try { out.push({ omml: mathmlToOmml(node).xml }); }
        catch (_) { out.push({ text: (function t(n) { return n.text != null ? n.text : (n.children || []).map(t).join(''); })(node), ...props }); }
        return;
    }
    const style = cssStyle(node);
    let p = applyInline(tag, style, props);
    const cls = String((node.attrs && node.attrs.class) || '');
    if (/\bword-comment\b/.test(cls)) { p.fill = p.fill || 'FFF2CC'; p.color = p.color || 'C00000'; }
    if (/\bword-citation\b/.test(cls)) { p.italic = true; p.color = p.color || '595959'; }
    if (/\bword-caption\b/.test(cls)) { p.italic = true; p.color = p.color || '595959'; }
    if (tag === 'a' && node.attrs && node.attrs.href) p.href = node.attrs.href;
    const blockChild = (node.children || []).some((c) => c.text == null && BLOCK_TAGS.has(c.tag) && c.tag !== 'br' && c.tag !== 'img' && c.tag !== 'hr');
    if (blockChild && tag === 'div') return;
    for (const c of node.children || []) collectRuns(c, p, ctx, out, pre || tag === 'pre' || tag === 'code');
}

function imageRun(node, props, ctx) {
    const src = String((node.attrs && node.attrs.src) || '');
    let m = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,([\s\S]+)$/i.exec(src);
    let buf, ext;
    if (m) {
        try { buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64'); } catch (_) { return null; }
        ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    } else {
        // SVG sinh từ công thức .wmf: mang theo WMF gốc (data-wmf) → nhúng lại nguyên bản để Word hiển thị y như file đầu vào
        m = /^data:image\/svg\+xml;base64,([\s\S]+)$/i.exec(src);
        if (!m) return null;
        let svg;
        try { svg = Buffer.from(m[1].replace(/\s/g, ''), 'base64').toString('utf8'); } catch (_) { return null; }
        const w = /\bdata-wmf="([A-Za-z0-9+/=]+)"/.exec(svg);
        if (!w) return null;
        buf = Buffer.from(w[1], 'base64'); ext = 'wmf';
        if (buf.length < 30 || buf.readUInt32LE(0) !== 0x9ac6cdd7) return null;
    }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    const size = imageSize(buf);
    const style = cssStyle(node);
    let w = toPx(style.width) || (node.attrs && toPx(node.attrs.width)) || (ext !== 'wmf' && size && size.w) || 480;
    let h = toPx(style.height) || (node.attrs && toPx(node.attrs.height)) || 0;
    if (!h) h = size && size.w > 0 && size.h > 0 ? Math.round(w * size.h / size.w) : Math.round(w * 0.66);
    perspective: {
        if (size && size.w > 0 && size.h > 0) {
            if (!style.height && !(node.attrs && node.attrs.height)) h = Math.round(w * size.h / size.w);
        }
    }
    const maxW = Math.max(120, ctx.contentWidthPx || 620);
    if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
    const rel = ctx.addImage(buf, ext);
    const alt = String((node.attrs && node.attrs.alt) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { image: rel, props, wPx: Math.max(16, Math.round(w)), hPx: Math.max(16, Math.round(h)), alt };
}

function runXml(run, ctx) {
    if (run.omml) return run.omml;          // công thức: m:oMath / m:oMathPara nằm cùng cấp với w:r
    if (run.image && /\.wmf$/i.test(run.image.name)) {
        // WMF (công thức MathType): dùng VML như Word vẫn ghi — Word/LibreOffice đều hiển thị đúng
        const wpt = Math.round(run.wPx * 0.75 * 100) / 100, hpt = Math.round(run.hPx * 0.75 * 100) / 100;
        return '<w:r><w:pict xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">' +
            `<v:shape type="#_x0000_t75" style="width:${wpt}pt;height:${hpt}pt" stroked="f" filled="f">` +
            `<v:imagedata r:id="${run.image.rId}" o:title=""/></v:shape></w:pict></w:r>`;
    }
    if (run.image) {
        const rel = run.image;
        const cx = run.wPx * EMU_PER_PX, cy = run.hPx * EMU_PER_PX;
        const id = ctx.nextId();
        return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
            `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
            `<wp:docPr id="${id}" name="Picture ${id}"${run.alt ? ` descr="${esc(run.alt)}"` : ''}/>` +
            '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
            '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
            `<a:pic><a:nvPicPr><a:cNvPr id="${id}" name="Picture ${id}"/><a:cNvPicPr/></a:nvPicPr>` +
            `<a:blipFill><a:blip r:embed="${rel.rId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>` +
            `<a:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></a:spPr></a:pic>` +
            '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    }
    if (run.br) return `<w:r>${runPropsXml(run)}<w:br${run.page ? ' w:type="page"' : ''}/></w:r>`;
    if (!run.text) return '';
    const rPr = runPropsXml(run);
    const text = String(run.text).split('\n').map((line) => `<w:t xml:space="preserve">${esc(line)}</w:t>`).join('<w:br/>');
    return `<w:r>${rPr}${text}</w:r>`;
}


// ---------------------------------------------------------------- hình khối (DrawingML wps)
const SHAPE_PRST = { rect: 'rect', round: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', diamond: 'diamond', hexagon: 'hexagon', arrow: 'rightArrow', star: 'star5', plus: 'mathPlus', line: 'line' };

function borderOf(st, line) {
    const src = line ? st['border-top'] : st.border;
    let w = null, color = null;
    if (src) {
        const m = /(-?[\d.]+)px/.exec(src);
        if (m) w = Number(m[1]);
        const c = /(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(src);
        if (c) color = colorHex(c[1]);
        if (/\bnone\b/.test(src)) w = 0;
    }
    if (w == null && st['border-width']) w = toPx(String(st['border-width']).split(/\s+/)[0]);
    if (!color && st['border-color']) color = colorHex(String(st['border-color']).replace(/\s*,\s*/g, ',').split(/\s+(?![^(]*\))/)[0]);
    if (line) {
        if (st['border-top-width']) w = toPx(st['border-top-width']);
        if (st['border-top-color']) color = colorHex(st['border-top-color']) || color;
    }
    return { w: w == null ? 0 : w, color };
}

function shapeXml(node, ctx) {
    const a = node.attrs || {};
    const st = cssStyle(node);
    const kind = SHAPE_PRST[a['data-shape']] ? a['data-shape'] : 'rect';
    const isLine = kind === 'line';
    const free = /absolute/i.test(st.position || '');
    const wPx = Math.max(6, toPx(st.width) || 150);
    const hPx = isLine ? 0 : Math.max(6, toPx(st.height) || 90);
    const cx = Math.round(wPx * EMU_PER_PX), cy = Math.round(hPx * EMU_PER_PX);
    const rm = /rotate\((-?[\d.]+)deg\)/.exec(st.transform || '');
    const rot = rm ? Math.round((((Number(rm[1]) % 360) + 360) % 360) * 60000) : 0;
    const z = parseInt(st['z-index'], 10) || 1;
    const fill = isLine ? null : colorHex(st['background-color']);
    const bd = borderOf(st, isLine);
    const lnXml = bd.w > 0 && bd.color
        ? `<a:ln w="${Math.round(bd.w * EMU_PER_PX)}"><a:solidFill><a:srgbClr val="${bd.color}"/></a:solidFill></a:ln>`
        : '<a:ln><a:noFill/></a:ln>';
    const fillXml = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>';
    const ta = String(st['text-align'] || 'center').toLowerCase();
    const jc = ta === 'right' || ta === 'end' ? 'right' : ta === 'left' || ta === 'start' ? 'left' : 'center';
    const base = {};
    const tc = colorHex(st.color); if (tc) base.color = tc;
    base.sizePt = ptOf(st['font-size']) || 11.25;
    if (/^(bold|[6-9]00)$/.test(String(st['font-weight'] || ''))) base.bold = true;
    const paras = [];
    let runs = [];
    const flush = () => { paras.push(paragraphXml(runs, { align: jc, noAnchors: true }, ctx)); runs = []; };
    if (!isLine) {
        for (const c of node.children || []) {
            if (c.text == null && (c.tag === 'div' || c.tag === 'p')) {
                if (runs.length) flush();
                for (const cc of c.children || []) collectRuns(cc, base, ctx, runs, false);
                flush();
            } else collectRuns(c, base, ctx, runs, false);
        }
    }
    if (runs.length || !paras.length) flush();
    const ai = String(st['align-items'] || 'center').toLowerCase();
    const anchorV = ai === 'flex-start' ? 't' : ai === 'flex-end' ? 'b' : 'ctr';
    const id = ctx.nextId();
    const descr = a.title ? ` descr="${esc(String(a.title).slice(0, 300))}"` : '';
    const wsp = '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
        '<wps:wsp><wps:cNvSpPr/>' +
        `<wps:spPr><a:xfrm${rot ? ` rot="${rot}"` : ''}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        `<a:prstGeom prst="${SHAPE_PRST[kind]}"><a:avLst/></a:prstGeom>${fillXml}${lnXml}</wps:spPr>` +
        (isLine ? '' : `<wps:txbx><w:txbxContent>${paras.join('')}</w:txbxContent></wps:txbx>`) +
        `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchorV}" anchorCtr="0"><a:noAutofit/></wps:bodyPr>` +
        '</wps:wsp></a:graphicData></a:graphic>';
    if (!free) {
        return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
            `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
            `<wp:docPr id="${id}" name="Shape ${id}"${descr}/><wp:cNvGraphicFramePr/>${wsp}</wp:inline></w:drawing></w:r>`;
    }
    const left = Math.round((toPx(st.left) || 0) * EMU_PER_PX);
    const oy = a['data-oy'] != null && a['data-oy'] !== '' && Number.isFinite(Number(a['data-oy'])) ? Number(a['data-oy']) : (toPx(st.top) || 0);
    const top = Math.round(oy * EMU_PER_PX);
    return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${1000 + (z + 60) * 10}" behindDoc="${z < 0 ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">` +
        '<wp:simplePos x="0" y="0"/>' +
        `<wp:positionH relativeFrom="margin"><wp:posOffset>${left}</wp:posOffset></wp:positionH>` +
        `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${top}</wp:posOffset></wp:positionV>` +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
        `<wp:docPr id="${id}" name="Shape ${id}"${descr}/><wp:cNvGraphicFramePr/>${wsp}</wp:anchor></w:drawing></w:r>`;
}
// hình tự do được "neo" vào đoạn văn kế tiếp (không tạo dòng trống); nếu không còn đoạn nào thì dùng đoạn rất thấp
function takeAnchors(ctx) { return ctx.pending.splice(0).join(''); }
function flushAnchors(ctx, out) {
    if (!ctx.pending.length) return;
    out.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>${takeAnchors(ctx)}</w:p>`);
}

function paragraphXml(runs, o, ctx) {
    // Thứ tự theo schema CT_PPr: pStyle, keepNext, numPr, pBdr, shd, ind, jc
    const pPr = [];
    if (o.styleId) pPr.push(`<w:pStyle w:val="${esc(o.styleId)}"/>`);
    if (o.keepNext) pPr.push('<w:keepNext/>');
    if (o.numId) pPr.push(`<w:numPr><w:ilvl w:val="${o.ilvl || 0}"/><w:numId w:val="${o.numId}"/></w:numPr>`);
    if (o.border) pPr.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="94A3B8"/></w:pBdr>');
    if (o.fill) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>`);
    if (o.indLeftPx) pPr.push(`<w:ind w:left="${Math.round(o.indLeftPx * TWIPS_PER_PX)}"${o.hangingPx ? ` w:hanging="${Math.round(o.hangingPx * TWIPS_PER_PX)}"` : ''}/>`);
    if (o.align) pPr.push(`<w:jc w:val="${o.align}"/>`);
    const body = runs.map((r) => {
        const x = runXml(r, ctx);
        if (!x) return '';
        if (r.href) return `<w:hyperlink r:id="${ctx.addLink(r.href)}">${x}</w:hyperlink>`;
        return x;
    }).join('');
    const anchors = o.noAnchors || !ctx.pending ? '' : takeAnchors(ctx);
    return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${anchors}${body}</w:p>`;
}

function listXml(node, ctx, level, out) {
    const ordered = node.tag === 'ol';
    for (const li of (node.children || [])) {
        if (li.text != null) {
            if (!li.text.trim()) continue;
            out.push(paragraphXml([{ text: li.text }], { numId: ordered ? 2 : 1, ilvl: level }, ctx));
            continue;
        }
        if (li.tag !== 'li') { blocksOf([li], ctx, out); continue; }
        const style = cssStyle(li);
        const runs = [];
        for (const c of li.children || []) {
            if (c.text == null && (c.tag === 'ul' || c.tag === 'ol' || c.tag === 'table' || c.tag === 'p' || c.tag === 'div')) continue;
            collectRuns(c, {}, ctx, runs, false);
        }
        const align = alignOf(style['text-align']);
        out.push(paragraphXml(runs, { numId: ordered ? 2 : 1, ilvl: Math.min(8, level), align, fill: colorHex(style['background-color']) }, ctx));
        for (const c of li.children || []) {
            if (c.text == null && (c.tag === 'ul' || c.tag === 'ol')) listXml(c, ctx, level + 1, out);
            else if (c.text == null && (c.tag === 'p' || c.tag === 'div' || c.tag === 'table')) blocksOf([c], ctx, out);
        }
    }
}

function tableXml(node, ctx) {
    const rows = [];
    const walkRows = (n) => {
        for (const c of n.children || []) {
            if (c.text != null) continue;
            if (c.tag === 'tr') rows.push(c);
            else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') walkRows(c);
        }
    };
    walkRows(node);
    const widthPx = Math.max(200, ctx.contentWidthPx || 620);
    const pending = new Map();       // cột → số hàng còn gộp
    let maxCols = 1;
    const rowCells = [];
    for (const tr of rows) {
        const cells = [];
        let col = 0;
        for (const tc of tr.children || []) {
            if (tc.text != null || (tc.tag !== 'td' && tc.tag !== 'th')) continue;
            while (pending.get(col) > 0) { cells.push({ vmerge: true }); pending.set(col, pending.get(col) - 1); col++; }
            const colspan = Math.max(1, Math.min(20, Number((tc.attrs && tc.attrs.colspan) || 1) || 1));
            const rowspan = Math.max(1, Math.min(100, Number((tc.attrs && tc.attrs.rowspan) || 1) || 1));
            cells.push({ node: tc, colspan, rowspan, vmerge: false });
            for (let k = 0; k < colspan; k++) {
                if (rowspan > 1) pending.set(col + k, rowspan - 1);
                else pending.delete(col + k);
            }
            col += colspan;
        }
        while (col < maxCols) { cells.push({}); col++; }
        maxCols = Math.max(maxCols, col);
        rowCells.push(cells);
    }
    for (const cells of rowCells) {
        while (cells.length < maxCols) cells.push({});
    }
    const colW = Math.round(widthPx / maxCols * TWIPS_PER_PX);
    const out = ['<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
        '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/><w:left w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/><w:right w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>' +
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>' +
        '</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' +
        `<w:gridCol w:w="${colW}"/>`.repeat(maxCols) + '</w:tblGrid>'];
    for (const cells of rowCells) {
        out.push('<w:tr>');
        for (const c of cells) {
            if (!c.node) { out.push(`<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`); continue; }
            const tc = c.node;
            const tcPr = [`<w:tcW w:w="${colW * c.colspan}" w:type="dxa"/>`];
            if (c.colspan > 1) tcPr.push(`<w:gridSpan w:val="${c.colspan}"/>`);
            if (c.rowspan > 1) tcPr.push('<w:vMerge w:val="restart"/>');
            if (c.vmerge) tcPr.push('<w:vMerge/>');
            const cellStyle = cssStyle(tc);
            const fill = colorHex(cellStyle['background-color']) || (tc.tag === 'th' ? 'F1F5F9' : null);
            if (fill) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
            const tmp = [];
            if (c.vmerge) tmp.length = 0;
            else blocksOf(tc.children || [], ctx, tmp, tc.tag === 'th');
            out.push(`<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr>${tmp.join('') || '<w:p/>'}</w:tc>`);
        }
        out.push('</w:tr>');
    }
    out.push('</w:tbl>');
    return out.join('');
}

function blocksOf(nodes, ctx, out, forceBold) {
    for (const n of nodes) {
        if (n.text != null) {
            if (!n.text.trim()) continue;
            out.push(paragraphXml([{ text: n.text.replace(/[\t\n\r ]+/g, ' ') }], {}, ctx));
            continue;
        }
        const tag = n.tag;
        if (tag === 'ul' || tag === 'ol') { listXml(n, ctx, 0, out); continue; }
        if (tag === 'div' && /(?:^|\s)word-shape(?:\s|$)/.test(String((n.attrs && n.attrs.class) || ''))) {
            const sx = shapeXml(n, ctx);
            if (/<wp:anchor\b/.test(sx)) ctx.pending.push(sx);
            else out.push(`<w:p>${sx}</w:p>`);
            continue;
        }
        if (tag === 'table') { flushAnchors(ctx, out); out.push(tableXml(n, ctx)); continue; }
        if (tag === 'hr') {
            out.push(paragraphXml([{ br: true, page: true }], {}, ctx));
            continue;
        }
        if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'tr' || tag === 'td' || tag === 'th') continue;
        const style = cssStyle(n);
        const hasBlock = (n.children || []).some((c) => c.text == null && BLOCK_TAGS.has(c.tag) && !['br', 'hr'].includes(c.tag));
        if ((tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main') && hasBlock) {
            blocksOf(n.children || [], ctx, out, forceBold);
            continue;
        }
        if (tag === 'li') { listXml({ tag: 'ul', children: [n] }, ctx, 0, out); continue; }
        const runs = [];
        const base = forceBold ? { bold: true } : {};
        const pre = tag === 'pre';
        for (const c of n.children || []) collectRuns(c, base, ctx, runs, pre);
        if (tag === 'pre') {
            for (const r of runs) if (r.text) r.font = r.font || 'Courier New';
        }
        const heading = HEADING_OF[tag] || null;
        const align = alignOf(style['text-align']);
        const indLeftPx = toPx(style['margin-left']) || (tag === 'blockquote' ? 36 : null);
        const opts = {
            styleId: heading, align, indLeftPx,
            fill: colorHex(style['background-color']),
            border: tag === 'hr',
            keepNext: !!heading
        };
        if (!heading) {
            const f = ptOf(style['font-size']); const fam = fontName(style['font-family']);
            if (f) for (const r of runs) if (r.text && !r.sizePt) r.sizePt = f;
            if (fam) for (const r of runs) if (r.text && !r.font) r.font = fam;
        }
        out.push(paragraphXml(runs, opts, ctx));
    }
}

function contentWidth(page) {
    const m = page && page.marginsPx ? page.marginsPx : { left: 96, right: 96 };
    return Math.max(120, (page && page.widthPx ? page.widthPx : 794) - (m.left || 0) - (m.right || 0));
}

// ---------------------------------------------------------------- XML phụ trợ
function stylesXml() {
    const heading = (n, size, color, before, after) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
        `<w:rPr><w:b/><w:bCs/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="vi-VN"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        heading(1, 32, '2F5496', 240, 120) + heading(2, 28, '2F5496', 200, 100) + heading(3, 24, '2F5496', 160, 80) +
        heading(4, 22, '2F5496', 120, 60) + heading(5, 20, '2F5496', 100, 40) + heading(6, 18, '2F5496', 80, 20) +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
        '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
        '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>' +
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/><w:left w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/><w:right w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>' +
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>' +
        '</w:tblBorders></w:tblPr></w:style></w:styles>';
}

function numberingXml() {
    const bullets = ['\u2022', 'o', '\u25aa'];
    const decimals = ['%1.', '%2.', '%3.'];
    const levels = (kind) => {
        let out = '';
        for (let i = 0; i < 9; i++) {
            const fmt = kind === 'bullet' ? 'bullet' : 'decimal';
            const txt = kind === 'bullet' ? bullets[i % bullets.length] : decimals[i % decimals.length];
            out += `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${esc(txt)}"/><w:lvlJc w:val="left"/>` +
                `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>` +
                `<w:rPr>${kind === 'bullet' ? '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' : ''}</w:rPr></w:lvl>`;
        }
        return out;
    };
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + levels('bullet') + '</w:abstractNum>' +
        '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + levels('decimal') + '</w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
}

function coreXml(title) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${esc(title || 'Tài liệu Word')}</dc:title><dc:creator>repository-mnha</dc:creator><cp:lastModifiedBy>repository-mnha</cp:lastModifiedBy>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}
function appXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        '<Application>repository-mnha Word</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>';
}

// ---------------------------------------------------------------- convert
/**
 * htmlToDocx(html, opt) → Buffer .docx
 * opt = { title, page: { widthPx, heightPx, marginsPx } }
 */
function htmlToDocx(html, opt = {}) {
    const page = Object.assign({ widthPx: 794, heightPx: 1123, marginsPx: { top: 96, right: 96, bottom: 96, left: 96 } }, opt.page || {});
    page.marginsPx = Object.assign({ top: 96, right: 96, bottom: 96, left: 96 }, page.marginsPx || {});
    const ctx = {
        contentWidthPx: contentWidth(page),
        media: [], rels: [], links: new Map(), ids: 0, pending: [],
        addImage(buf, ext) {
            const n = this.media.length + 1;
            const name = `image${n}.${ext}`;
            this.media.push({ name, data: buf, ext });
            const rId = 'rIdImg' + n;
            this.rels.push({ id: rId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: 'media/' + name });
            return { rId, name };
        },
        addLink(href) {
            const key = String(href);
            if (this.links.has(key)) return this.links.get(key);
            const rId = 'rIdLink' + (this.links.size + 1);
            this.links.set(key, rId);
            this.rels.push({ id: rId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', target: key, external: true });
            return rId;
        },
        nextId() { return ++this.ids; }
    };
    const root = parseHtml(html);
    const blocks = [];
    blocksOf(root.children, ctx, blocks);
    flushAnchors(ctx, blocks);
    const wTw = Math.round((page.widthPx || 794) * TWIPS_PER_PX);
    const hTw = Math.round((page.heightPx || 1123) * TWIPS_PER_PX);
    const m = page.marginsPx;
    const sect = `<w:sectPr><w:pgSz w:w="${wTw}" w:h="${hTw}"/><w:pgMar w:top="${Math.round((m.top || 0) * TWIPS_PER_PX)}" w:right="${Math.round((m.right || 0) * TWIPS_PER_PX)}" w:bottom="${Math.round((m.bottom || 0) * TWIPS_PER_PX)}" w:left="${Math.round((m.left || 0) * TWIPS_PER_PX)}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
        `<w:body>${blocks.join('') || '<w:p/>'}${sect}</w:body></w:document>`;

    const docRels = [
        { id: 'rIdStyles', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', target: 'styles.xml' },
        { id: 'rIdNumbering', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering', target: 'numbering.xml' },
        ...ctx.rels
    ];
    const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        docRels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
        '</Relationships>';
    const exts = [...new Set(ctx.media.map((x) => x.ext))];
    const imageDefaults = exts.map((e) => {
        const mime = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', wmf: 'image/x-wmf' }[e] || 'application/octet-stream';
        return `<Default Extension="${e}" ContentType="${mime}"/>`;
    }).join('');
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        imageDefaults +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>';

    const entries = [
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rootRels },
        { name: 'docProps/core.xml', data: coreXml(opt.title) },
        { name: 'docProps/app.xml', data: appXml() },
        { name: 'word/document.xml', data: documentXml },
        { name: 'word/styles.xml', data: stylesXml() },
        { name: 'word/numbering.xml', data: numberingXml() },
        { name: 'word/_rels/document.xml.rels', data: relsXml }
    ];
    for (const mimg of ctx.media) entries.push({ name: 'word/media/' + mimg.name, data: mimg.data, store: true });
    return writeZip(entries);
}

module.exports = { htmlToDocx, imageSize, contentWidth };
