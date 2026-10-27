// services/word/docxToHtml.js — chuyển .docx (Word) → HTML sạch để soạn/xem như bản Word.
//
//  Hỗ trợ: đoạn văn + Heading/Title, chữ đậm/nghiêng/gạch chân/gạch ngang, màu chữ, tô nền,
//  phông + cỡ chữ, căn lề, thụt dòng, danh sách (bullet/số), bảng (gộp cột cơ bản), ảnh nhúng,
//  liên kết ngoài, công thức MathType (.wmf → SVG), hộp văn bản/đường nối/nét ink đặt tự do, ngắt trang, khổ giấy + lề. Không hỗ trợ: SmartArt, chart, macro, text box phức tạp…
//  Không dùng thư viện ngoài — tự đọc ZIP + XML của OOXML.
'use strict';
const { readZip } = require('./zip');
const { parseXml, local, escapeText, escapeAttr } = require('./xml');
const { ommlToMathml } = require('./omml');
const { wmfToSvg } = require('./wmf');

const { LANGS } = require('../../config/codeConfig');
const EMU_PER_PX = 9525;          // 1 px CSS = 9525 EMU
const TWIPS_PER_PX = 15;          // 1 px CSS = 15 twips (96dpi)
const MAX_HTML_BYTES = (LANGS.word && LANGS.word.maxHtmlBytes) || 40 * 1024 * 1024;

function elementChildren(n) { return ((n && n.children) || []).filter((c) => c && c.text == null && c.name); }
function kids(n, ln) { return elementChildren(n).filter((c) => local(c.name) === ln); }
function child(n, ln) { return kids(n, ln)[0] || null; }
function descendants(n, ln, out = []) {
    for (const c of elementChildren(n)) {
        if (local(c.name) === ln) out.push(c);
        descendants(c, ln, out);
    }
    return out;
}
function firstDesc(n, ln) { return descendants(n, ln, [])[0] || null; }
function attr(n, ln) {
    if (!n || !n.attrs) return undefined;
    if (Object.prototype.hasOwnProperty.call(n.attrs, ln)) return n.attrs[ln];
    for (const k of Object.keys(n.attrs)) if (local(k) === ln) return n.attrs[k];
    return undefined;
}
const valOf = (n) => (n ? attr(n, 'val') : undefined);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const truthy = (v) => (v == null ? true : !/^(0|false|off|none|nil)$/i.test(String(v)));
const hex = (v) => {
    const s = String(v || '').replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : (/^[0-9a-fA-F]{3}$/.test(s) ? s.split('').map((c) => c + c).join('').toUpperCase() : null);
};
const px = (tw) => Math.max(0, Math.round(num(tw) / TWIPS_PER_PX));

// ---------------------------------------------------------------- thuộc tính run / paragraph
function parseRunProps(rPr) {
    const p = {};
    if (!rPr) return p;
    const b = child(rPr, 'b');
    if (b && truthy(valOf(b))) p.bold = true;
    const i = child(rPr, 'i');
    if (i && truthy(valOf(i))) p.italic = true;
    const u = child(rPr, 'u');
    if (u && !/^(none|0|false)$/i.test(String(valOf(u) || 'single'))) p.underline = true;
    const st = child(rPr, 'strike');
    if (st && truthy(valOf(st))) p.strike = true;
    const dst = child(rPr, 'dstrike');
    if (dst && truthy(valOf(dst))) p.strike = true;
    const color = child(rPr, 'color');
    if (color) { const c = hex(valOf(color)); if (c) p.color = c; }
    const sz = child(rPr, 'sz') || child(rPr, 'szCs');
    if (sz) { const n = num(valOf(sz)); if (n > 0) p.sizePt = n / 2; }
    const fonts = child(rPr, 'rFonts');
    if (fonts) p.font = attr(fonts, 'ascii') || attr(fonts, 'hAnsi') || attr(fonts, 'cs') || attr(fonts, 'eastAsia') || undefined;
    const hl = child(rPr, 'highlight');
    if (hl) { const v = String(valOf(hl) || ''); if (v && !/^none$/i.test(v)) p.highlight = v; }
    const shd = child(rPr, 'shd');
    if (shd) { const c = hex(attr(shd, 'fill')); if (c && c !== 'FFFFFF') p.fill = c; }
    const va = child(rPr, 'vertAlign');
    if (va) { const v = String(valOf(va) || ''); if (v === 'superscript' || v === 'subscript') p.vertAlign = v; }
    const pos = child(rPr, 'position'); if (pos) { const n = num(valOf(pos)); if (n) p.position = n / 2; }
    const caps = child(rPr, 'caps'); if (caps && truthy(valOf(caps))) p.caps = true;
    const smallCaps = child(rPr, 'smallCaps'); if (smallCaps && truthy(valOf(smallCaps))) p.smallCaps = true;
    return p;
}

function parseParaProps(pPr) {
    const p = {};
    if (!pPr) return p;
    const ps = child(pPr, 'pStyle'); if (ps) p.styleId = valOf(ps);
    const jc = child(pPr, 'jc'); if (jc) p.align = String(valOf(jc) || '');
    const outline = child(pPr, 'outlineLvl'); if (outline) p.outlineLvl = num(valOf(outline), 9);
    const numPr = child(pPr, 'numPr');
    if (numPr) {
        const ilvl = child(numPr, 'ilvl'), numId = child(numPr, 'numId');
        if (numId) { p.numId = String(valOf(numId) || ''); p.ilvl = num(ilvl ? valOf(ilvl) : 0, 0); }
    }
    const ind = child(pPr, 'ind');
    if (ind) {
        const left = attr(ind, 'left') != null ? attr(ind, 'left') : attr(ind, 'start');
        if (left != null) p.indLeftTw = num(left);
        const right = attr(ind, 'right') != null ? attr(ind, 'right') : attr(ind, 'end');
        if (right != null) p.indRightTw = num(right);
        if (attr(ind, 'firstLine') != null) p.firstLineTw = num(attr(ind, 'firstLine'));
        if (attr(ind, 'hanging') != null) p.hangingTw = num(attr(ind, 'hanging'));
    }
    const spacing = child(pPr, 'spacing');
    if (spacing) {
        const after = attr(spacing, 'after'); if (after != null) p.afterTw = num(after);
        const before = attr(spacing, 'before'); if (before != null) p.beforeTw = num(before);
        const line = attr(spacing, 'line'); if (line != null) p.line = num(line);
        const rule = attr(spacing, 'lineRule'); if (rule != null) p.lineRule = String(rule);
    }
    const shd = child(pPr, 'shd');
    if (shd) { const c = hex(attr(shd, 'fill')); if (c && c !== 'FFFFFF') p.fill = c; }
    const pBdr = child(pPr, 'pBdr');
    if (pBdr) p.hasBorder = true;
    return p;
}

// ---------------------------------------------------------------- styles / numbering / relationships
function readStyles(zip) {
    const root = parseXml(zip.text('word/styles.xml') || '');
    const def = { run: {}, para: {} };
    const docDefaults = firstDesc(root, 'docDefaults');
    if (docDefaults) {
        const rDefault = firstDesc(docDefaults, 'rPrDefault');
        const pDefault = firstDesc(docDefaults, 'pPrDefault');
        if (rDefault) def.run = parseRunProps(firstDesc(rDefault, 'rPr'));
        if (pDefault) def.para = parseParaProps(firstDesc(pDefault, 'pPr'));
    }
    const styles = new Map();
    let defaultParaId = null;
    for (const st of descendants(root, 'style')) {
        const id = attr(st, 'styleId');
        if (!id) continue;
        styles.set(id, {
            id, type: attr(st, 'type') || 'paragraph', name: valOf(child(st, 'name')) || id,
            basedOn: valOf(child(st, 'basedOn')) || null,
            run: parseRunProps(child(st, 'rPr')), para: parseParaProps(child(st, 'pPr'))
        });
        if ((attr(st, 'default') === '1' || attr(st, 'default') === 'true') && (attr(st, 'type') || 'paragraph') === 'paragraph') defaultParaId = id;
    }
    const cache = new Map();
    function resolve(id) {
        if (!id || !styles.has(id)) return { id: null, name: '', type: 'paragraph', run: {}, para: {} };
        if (cache.has(id)) return cache.get(id);
        const own = styles.get(id);
        const base = own.basedOn ? resolve(own.basedOn) : { run: {}, para: {} };
        const out = {
            id, name: own.name, type: own.type,
            run: { ...base.run, ...own.run }, para: { ...base.para, ...own.para }
        };
        cache.set(id, out);
        return out;
    }
    return { resolve, defaults: def, defaultParaId, styles };
}

function readNumbering(zip) {
    const xml = zip.text('word/numbering.xml');
    if (!xml) return { fmt: () => 'decimal', levels: () => [], level: () => ({ fmt: 'decimal', text: '', start: 1 }) };
    const root = parseXml(xml);
    const abstracts = new Map();
    for (const a of descendants(root, 'abstractNum')) {
        const id = attr(a, 'abstractNumId');
        const levels = [];
        for (const lvl of kids(a, 'lvl')) {
            const il = num(attr(lvl, 'ilvl'), 0);
            const fmt = valOf(child(lvl, 'numFmt')) || 'decimal';
            const text = valOf(child(lvl, 'lvlText')) || '';
            const start = num(valOf(child(lvl, 'start')), 1);
            levels[il] = { fmt, text, start };
        }
        abstracts.set(String(id), levels);
    }
    const nums = new Map();
    for (const n of descendants(root, 'num')) {
        const id = attr(n, 'numId');
        const aid = valOf(child(n, 'abstractNumId'));
        if (id != null) nums.set(String(id), abstracts.get(String(aid)) || []);
    }
    return {
        fmt: (numId, ilvl = 0) => {
            const levels = nums.get(String(numId));
            return (levels && levels[ilvl] && levels[ilvl].fmt) || 'decimal';
        },
        levels: (numId) => nums.get(String(numId)) || [],
        level: (numId, ilvl = 0) => { const l = nums.get(String(numId)); return (l && l[ilvl]) || { fmt: 'decimal', text: '', start: 1 }; }
    };
}

function readRels(zip) {
    const root = parseXml(zip.text('word/_rels/document.xml.rels') || '');
    const map = new Map();
    for (const r of descendants(root, 'Relationship')) {
        const id = attr(r, 'Id'); if (!id) continue;
        map.set(id, { target: attr(r, 'Target') || '', mode: attr(r, 'TargetMode') || '', type: attr(r, 'Type') || '' });
    }
    return map;
}

function normalizePart(p) {
    const out = [];
    for (const s of String(p || '').replace(/\\/g, '/').split('/')) {
        if (!s || s === '.') continue;
        if (s === '..') out.pop(); else out.push(s);
    }
    return out.join('/');
}
function relTargetPath(rel) {
    if (!rel || !rel.target) return null;
    if (/^[a-z]+:/i.test(rel.target)) return null;
    return normalizePart(rel.target.startsWith('/') ? rel.target.slice(1) : 'word/' + rel.target);
}

// ---------------------------------------------------------------- ảnh
const IMAGE_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp'
};
const LEN_PX = { pt: 96 / 72, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pc: 16 };
function cssLenPx(v) {
    const m = /^\s*(-?[\d.]+)\s*(pt|px|in|cm|mm|pc)?\s*$/i.exec(String(v || ''));
    return m ? Number(m[1]) * LEN_PX[(m[2] || 'px').toLowerCase()] : 0;
}
function styleMap(str) {
    const o = {};
    for (const part of String(str || '').split(';')) { const i = part.indexOf(':'); if (i > 0) o[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
    return o;
}
const textOf = (n) => ((n && n.children) || []).map((x) => x.text || '').join('');
const toB64Svg = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

/** Kích thước ảnh (px): DrawingML extent → VML style (đối tượng OLE/MathType) → dxaOrig/dyaOrig. */
function imageSize(xmlNode) {
    const extent = firstDesc(xmlNode, 'extent') || firstDesc(xmlNode, 'ext');
    if (extent && num(attr(extent, 'cx')) > 0) return { w: num(attr(extent, 'cx')) / EMU_PER_PX, h: num(attr(extent, 'cy')) / EMU_PER_PX };
    const shape = firstDesc(xmlNode, 'shape');
    if (shape) {
        const st = styleMap(attr(shape, 'style'));
        const w = cssLenPx(st.width), h = cssLenPx(st.height);
        if (w > 0) return { w, h };
    }
    const dx = num(attr(xmlNode, 'dxaOrig')), dy = num(attr(xmlNode, 'dyaOrig'));
    if (dx > 0) return { w: dx / TWIPS_PER_PX, h: dy / TWIPS_PER_PX };
    return { w: 0, h: 0 };
}

function imageSrc(xmlNode, ctx) {
    let rid = null;
    const blip = firstDesc(xmlNode, 'blip');
    if (blip) rid = attr(blip, 'embed') || attr(blip, 'link') || null;
    if (!rid) {
        const imagedata = firstDesc(xmlNode, 'imagedata');
        if (imagedata) rid = attr(imagedata, 'id') || null;
    }
    if (!rid) return null;
    const part = relTargetPath(ctx.rels.get(String(rid)));
    if (!part) return null;
    let cached = ctx.images.get(part);
    if (cached === undefined) {
        const buf = ctx.zip.get(part);
        const ext = String(part).split('.').pop().toLowerCase();
        cached = null;
        if (buf && buf.length <= 6 * 1024 * 1024) {
            if (IMAGE_MIME[ext]) cached = `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`;
            else if (ext === 'wmf') { const svg = wmfToSvg(buf); if (svg) cached = toB64Svg(svg); }   // công thức MathType, hình vẽ cũ
        }
        ctx.images.set(part, cached);
    }
    return cached;
}

function imageFrom(xmlNode, ctx) {
    const src = imageSrc(xmlNode, ctx);
    if (!src) return null;
    const { w: cw, h: ch } = imageSize(xmlNode);
    const w = cw > 0 ? Math.max(4, Math.round(cw)) : 480;
    const h = ch > 0 ? Math.max(4, Math.round(ch)) : 0;
    // mô tả ảnh (nếu Word có) → alt; khi tách ảnh sẽ thành phần tên file anh-001-<mô-tả>
    const docPr = firstDesc(xmlNode, 'docPr');
    const alt = docPr ? String(attr(docPr, 'descr') || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    return `<img src="${src}" alt="${escapeAttr(alt)}" style="width:${w}px${h ? ';height:' + h + 'px' : ''};max-width:100%;height:auto">`;
}

// ---------------------------------------------------------------- render
function cssFont(f) { return String(f || '').replace(/['"\\]/g, '').trim(); }
function preserveSpaces(s) {
    let t = escapeText(s);
    t = t.replace(/ {2,}/g, (m) => '\u00a0'.repeat(m.length));
    t = t.replace(/^ /, '\u00a0').replace(/ $/, '\u00a0');
    return t;
}
const HIGHLIGHT = {
    yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff',
    red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080',
    darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000'
};

function wrapRun(inner, p) {
    if (!inner) return '';
    let html = inner;
    if (p.caps) html = html.replace(/(>|^)([^<]*)(?=<|$)/g, (m, a, b) => a + b.toLocaleUpperCase('vi'));
    if (p.smallCaps) html = `<span style="font-variant:small-caps">${html}</span>`;
    const st = [];
    if (p.font) st.push('font-family:' + cssFont(p.font));
    if (p.sizePt) st.push('font-size:' + Math.round(p.sizePt * 100) / 100 + 'pt');
    if (p.color) st.push('color:#' + p.color);
    if (p.position) st.push('vertical-align:' + Math.round(p.position * 100) / 100 + 'pt');
    if (p.highlight) st.push('background-color:' + (HIGHLIGHT[p.highlight] || p.highlight));
    else if (p.fill) st.push('background-color:#' + p.fill);
    if (st.length) html = `<span style="${escapeAttr(st.join(';'))}">${html}</span>`;
    if (p.bold) html = `<strong>${html}</strong>`;
    if (p.italic) html = `<em>${html}</em>`;
    if (p.underline) html = `<u>${html}</u>`;
    if (p.strike) html = `<s>${html}</s>`;
    if (p.vertAlign === 'superscript') html = `<sup>${html}</sup>`;
    if (p.vertAlign === 'subscript') html = `<sub>${html}</sub>`;
    return html;
}

// ---------------------------------------------------------------- hình đặt tự do (hộp văn bản, đường nối, ink)
const SCHEME = { tx1: '000000', dk1: '000000', bg1: 'FFFFFF', lt1: 'FFFFFF', tx2: '44546A', bg2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47' };
function colorOf(n) {
    if (!n) return null;
    const c = firstDesc(n, 'srgbClr') || firstDesc(n, 'scrgbClr') || firstDesc(n, 'schemeClr') || firstDesc(n, 'sysClr');
    if (!c) return null;
    const ln = local(c.name);
    if (ln === 'srgbClr') return hex(attr(c, 'val'));
    if (ln === 'scrgbClr') return [attr(c, 'r'), attr(c, 'g'), attr(c, 'b')].map((v) => ('0' + Math.max(0, Math.min(255, Math.round(num(v) / 100000 * 255))).toString(16)).slice(-2)).join('').toUpperCase();
    if (ln === 'sysClr') return hex(attr(c, 'lastClr')) || '000000';
    return SCHEME[attr(c, 'val')] || '000000';
}
const emuPx = (v) => Math.round(num(v) / EMU_PER_PX * 10) / 10;

/** Vị trí neo của hình (wp:anchor). float=true khi có thể đặt tuyệt đối theo đoạn văn (không bọc chữ). */
function anchorInfo(node, ctx) {
    const a = firstDesc(node, 'anchor');
    if (!a) return null;
    const ext = child(a, 'extent');
    const info = { w: ext ? emuPx(attr(ext, 'cx')) : 0, h: ext ? emuPx(attr(ext, 'cy')) : 0, float: false };
    const ph = child(a, 'positionH'), pv = child(a, 'positionV');
    const hOff = ph && child(ph, 'posOffset'), vOff = pv && child(pv, 'posOffset');
    const hRel = (ph && attr(ph, 'relativeFrom')) || 'column', vRel = (pv && attr(pv, 'relativeFrom')) || 'paragraph';
    if (!child(a, 'wrapNone') || !hOff || !vOff || !(vRel === 'paragraph' || vRel === 'line')) return info;
    let left = emuPx(textOf(hOff));
    if (hRel === 'page') left -= (ctx.page && ctx.page.marginsPx.left) || 0;
    else if (!/^(column|margin|leftMargin|insideMargin|character)$/.test(hRel)) return info;
    info.left = left; info.top = emuPx(textOf(vOff));
    info.z = attr(a, 'behindDoc') === '1' ? -1 : 1;
    info.float = info.w > 0 && info.h > 0;
    return info;
}
function floatDiv(info, inner, box, extraStyle, pad) {
    const st = ['position:absolute', `left:${Math.round((info.left - (pad || 0)) * 10) / 10}px`, `top:${Math.round((info.top - (pad || 0)) * 10) / 10}px`, `z-index:${info.z}`];
    if (box) st.push(`width:${Math.round(info.w)}px`, `min-height:${Math.round(info.h)}px`);
    if (extraStyle) st.push(extraStyle);
    return `<div class="word-float" style="${escapeAttr(st.join(';'))}">${inner}</div>`;
}

/** Hình khối/đường nối (wps:wsp không chứa chữ) → SVG. */
function shapeSvg(wsp, w, h) {
    const spPr = child(wsp, 'spPr');
    if (!spPr) return null;
    const geom = child(spPr, 'prstGeom');
    const prst = geom ? attr(geom, 'prst') : '';
    if (!prst) return null;
    const xfrm = child(spPr, 'xfrm');
    const flipH = xfrm && attr(xfrm, 'flipH') === '1', flipV = xfrm && attr(xfrm, 'flipV') === '1';
    const ln = child(spPr, 'ln'), styleEl = child(wsp, 'style');
    let color = null, lw = 1, drawn = true;
    if (ln && child(ln, 'noFill')) drawn = false;
    else {
        if (ln) { const sf = child(ln, 'solidFill'); color = sf ? colorOf(sf) : null; if (attr(ln, 'w') != null) lw = Math.max(0.75, emuPx(attr(ln, 'w'))); }
        if (!color) { const ref = styleEl && firstDesc(styleEl, 'lnRef'); color = (ref && colorOf(ref)) || '000000'; }
    }
    const sfill = child(spPr, 'solidFill'), fillC = sfill ? colorOf(sfill) : null;
    const pad = 8, W = Math.max(w, 0.1), H = Math.max(h, 0.1);
    const adj = (() => { const g = geom && firstDesc(geom, 'gd'); const m = g && /(-?\d+)/.exec(String(attr(g, 'fmla') || '')); return m ? num(m[1]) / 100000 : 0.5; })();
    let d = '', shape = '';
    if (/^(line|straightConnector1)$/.test(prst)) d = `M0,0L${W},${H}`;
    else if (/^bentConnector2$/.test(prst)) d = `M0,0H${W}V${H}`;
    else if (/^bentConnector\d$/.test(prst)) { const x1 = W * adj; d = `M0,0H${x1}V${H}H${W}`; }
    else if (/^curvedConnector\d$/.test(prst)) d = `M0,0C${W * adj},0 ${W * adj},${H} ${W},${H}`;
    else if (prst === 'ellipse') shape = `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${W / 2}" ry="${H / 2}"`;
    else if (prst === 'roundRect') shape = `<rect width="${W}" height="${H}" rx="${Math.min(W, H) * 0.16}"`;
    else if (/^(rect|flowChartProcess)$/.test(prst)) shape = `<rect width="${W}" height="${H}"`;
    else if (prst === 'rightArrow') shape = `<polygon points="0,${H * 0.25} ${W * 0.6},${H * 0.25} ${W * 0.6},0 ${W},${H / 2} ${W * 0.6},${H} ${W * 0.6},${H * 0.75} 0,${H * 0.75}"`;
    else return null;
    const head = ln && child(ln, 'headEnd'), tail = ln && child(ln, 'tailEnd');
    const hasArrow = (e) => e && attr(e, 'type') && attr(e, 'type') !== 'none';
    const col = '#' + (color || '000000');
    let defs = '', ends = '';
    const mk = (id, rev) => `<marker id="${id}" viewBox="0 0 10 10" refX="${rev ? 1 : 9}" refY="5" markerWidth="${4 + lw}" markerHeight="${4 + lw}" markerUnits="userSpaceOnUse" orient="auto"><path d="${rev ? 'M10,0L0,5L10,10Z' : 'M0,0L10,5L0,10Z'}" fill="${col}"/></marker>`;
    if (hasArrow(head)) { defs += mk('s', true); ends += ' marker-start="url(#s)"'; }
    if (hasArrow(tail)) { defs += mk('e', false); ends += ' marker-end="url(#e)"'; }
    const paint = `fill="${fillC && !d ? '#' + fillC : 'none'}" stroke="${drawn ? col : 'none'}" stroke-width="${lw}"`;
    const body = d ? `<path d="${d}" ${paint}${ends}/>` : `${shape} ${paint}/>`;
    const tr = `translate(${pad} ${pad})` + (flipH || flipV ? ` translate(${flipH ? W : 0} ${flipV ? H : 0}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1})` : '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + pad * 2} ${H + pad * 2}" width="${W + pad * 2}" height="${H + pad * 2}">${defs ? '<defs>' + defs + '</defs>' : ''}<g transform="${tr}">${body}</g></svg>`;
    return { src: toB64Svg(svg), pad, w: W + pad * 2, h: H + pad * 2, rot: xfrm ? num(attr(xfrm, 'rot')) / 60000 : 0 };
}

/** Hình trong run: ảnh → <img>; hộp văn bản (w:txbxContent) → khối đặt tự do hoặc .word-textbox; đường nối/ink → SVG/ảnh.
 *  fb = nhánh Fallback của mc:AlternateContent (dùng khi nhánh chính là ink/đối tượng không dựng được). */
function drawingHtml(node, ctx, fb) {
    const boxes = [];
    (function find(n) {
        for (const c of elementChildren(n)) {
            if (local(c.name) === 'txbxContent') boxes.push(c);
            else find(c);
        }
    })(node);
    const info = anchorInfo(node, ctx);
    if (boxes.length) {
        const rendered = [];
        for (const b of boxes) {
            const sb = ctx.boxes, sf = ctx.floats; ctx.boxes = []; ctx.floats = [];
            const inner = renderBlocks(elementChildren(b), ctx);
            ctx.boxes = sb; ctx.floats = sf;
            if (inner) rendered.push(inner);
        }
        if (!rendered.length) return '';
        const wsp = firstDesc(node, 'wsp');
        if (info && info.float && rendered.length === 1 && wsp) {
            const spPr = child(wsp, 'spPr'), body = child(wsp, 'bodyPr'), ln = spPr && child(spPr, 'ln');
            const ins = (k, d) => emuPx(body && attr(body, k) != null ? attr(body, k) : d);
            const x = [];
            x.push(`padding:${ins('tIns', 45720)}px ${ins('rIns', 91440)}px ${ins('bIns', 45720)}px ${ins('lIns', 91440)}px`);
            const sf = spPr && child(spPr, 'solidFill'); if (sf && colorOf(sf)) x.push('background-color:#' + colorOf(sf));
            if (ln && !child(ln, 'noFill') && child(ln, 'solidFill')) x.push(`border:${Math.max(1, emuPx(attr(ln, 'w') || 9525))}px solid #${colorOf(child(ln, 'solidFill')) || '000000'}`);
            ctx.floats.push(floatDiv(info, rendered[0], true, x.join(';')));
        } else {
            for (const r of rendered) ctx.boxes.push('<div class="word-textbox">' + r + '</div>');
        }
        return '';
    }
    const wsp = firstDesc(node, 'wsp');
    if (wsp && !firstDesc(node, 'blip')) {
        const w = info ? info.w : imageSize(node).w, h = info ? info.h : imageSize(node).h;
        const sh = shapeSvg(wsp, w, h);
        if (!sh) return '';
        const img = `<img src="${sh.src}" alt="" style="width:${Math.round(sh.w)}px;height:${Math.round(sh.h)}px;max-width:none">`;
        if (info && info.float) {
            ctx.floats.push(floatDiv(info, img, false, sh.rot ? `transform:rotate(${Math.round(sh.rot * 10) / 10}deg)` : '', sh.pad));
            return '';
        }
        return img;
    }
    let img = imageFrom(node, ctx);
    if (!img && fb) img = imageFrom(fb, ctx);                 // ink (nét viết tay): Word kèm sẵn ảnh dự phòng
    if (!img) return '';
    if (info && info.float) { ctx.floats.push(floatDiv(info, img.replace(/;max-width:100%;height:auto/, ';max-width:none'), false, '')); return ''; }
    return img;
}

// Wingdings/Symbol: mã PUA (F0xx) → ký tự Unicode thường gặp (mũi tên, tương đương…)
const WINGDINGS = { 0xe7: '←', 0xe8: '→', 0xe9: '↑', 0xea: '↓', 0xf0: '⇨', 0xf1: '⇦', 0xf3: '⇔', 0xfb: '✗', 0xfc: '✓', 0x6c: '●', 0x6e: '■', 0xa7: '▪', 0xd8: '➢', 0xfe: '☑', 0x71: '❑' };
function symChar(font, code) {
    const lo = code & 0xff;
    if (/wingdings/i.test(String(font || ''))) return WINGDINGS[lo] || (lo >= 0x20 && lo < 0x7f && code < 0x100 ? String.fromCharCode(code) : '•');
    if (/^symbol$/i.test(String(font || ''))) { const m = require('./wmf').SYMBOL[lo]; if (m) return m; }
    return String.fromCharCode(code);
}

function renderRun(run, ctx, baseProps) {
    const rPr = child(run, 'rPr');
    let props = { ...baseProps, ...parseRunProps(rPr) };
    const rs = valOf(child(rPr || run, 'rStyle'));
    if (rs && ctx.styles.styles.has(rs)) props = { ...ctx.styles.resolve(rs).run, ...props };
    const parts = [];
    for (const c of elementChildren(run)) {
        const ln = local(c.name);
        if (ln === 't') parts.push(preserveSpaces(c.children.map((x) => x.text || '').join('')));
        else if (ln === 'tab') parts.push('<span class="word-tab">\t</span>');
        else if (ln === 'br') parts.push(attr(c, 'type') === 'page' ? '<hr class="word-pagebreak">' : '<br>');
        else if (ln === 'cr') parts.push('<br>');
        else if (ln === 'noBreakHyphen') parts.push('-');
        else if (ln === 'sym') {
            const code = parseInt(attr(c, 'char') || '', 16);
            if (Number.isFinite(code)) parts.push(escapeText(symChar(attr(c, 'font'), code)));
        } else if (ln === 'drawing' || ln === 'pict' || ln === 'object') {
            const img = drawingHtml(c, ctx); if (img) parts.push(img);
        } else if (ln === 'AlternateContent') {
            // Word ghi cùng một hình 2 lần: Choice (DrawingML) + Fallback (VML) → chỉ lấy một nhánh để khỏi nhân đôi;
            // nếu Choice không dựng được (vd. ink, SmartArt) thì dùng Fallback.
            const choice = elementChildren(c).find((x) => local(x.name) === 'Choice');
            const fallback = elementChildren(c).find((x) => local(x.name) === 'Fallback');
            const pick = choice || fallback;
            const before = parts.length + ctx.floats.length + ctx.boxes.length;
            const fbShape = fallback ? firstDesc(fallback, 'pict') || firstDesc(fallback, 'object') : null;
            if (pick) for (const d of elementChildren(pick)) {
                const l2 = local(d.name);
                if (l2 === 'drawing' || l2 === 'pict' || l2 === 'object') { const img = drawingHtml(d, ctx, choice ? fbShape : null); if (img) parts.push(img); }
            }
            if (choice && fallback && before === parts.length + ctx.floats.length + ctx.boxes.length) {
                for (const d of elementChildren(fallback)) {
                    const l2 = local(d.name);
                    if (l2 === 'drawing' || l2 === 'pict' || l2 === 'object') { const img = drawingHtml(d, ctx); if (img) parts.push(img); }
                }
            }
        }
    }
    return wrapRun(parts.join(''), props);
}

function renderInline(n, ctx, baseProps) {
    let out = '';
    for (const c of elementChildren(n)) {
        const ln = local(c.name);
        if (ln === 'r') out += renderRun(c, ctx, baseProps);
        else if (ln === 'hyperlink') {
            const rel = ctx.rels.get(String(attr(c, 'id') || ''));
            const href = rel && rel.target && /^(https?:|mailto:|tel:)/i.test(rel.target) ? rel.target : null;
            const inner = renderInline(c, ctx, baseProps);
            out += href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
        } else if (ln === 'ins' || ln === 'smartTag' || ln === 'sdt' || ln === 'sdtContent' || ln === 'customXml' || ln === 'fldSimple' || ln === 'dir' || ln === 'bdo') {
            out += renderInline(c, ctx, baseProps);
        } else if (ln === 'del') {
            /* bỏ phần đã xoá (tracked changes) */
        } else if (ln === 'oMath' || ln === 'oMathPara') {
            out += ommlToMathml(c);            // công thức → MathML (giữ chỉ số trên/dưới, phân số, ma trận, vector…)
        }
    }
    return out;
}

function paragraphInfo(p, ctx) {
    const own = parseParaProps(child(p, 'pPr'));
    const style = own.styleId ? ctx.styles.resolve(own.styleId) : { name: '', run: {}, para: {} };
    const para = { ...ctx.styles.defaults.para, ...style.para, ...own };
    const run = { ...ctx.styles.defaults.run, ...style.run };
    const name = String(style.name || '');
    const sid = String(own.styleId || '');
    const hm = /(?:heading|tieude|tiêu đề|tieu de)\s*([1-6])/i.exec(name + ' ' + sid);
    let tag = 'p', cls = '';
    if (hm) tag = 'h' + Math.min(6, Math.max(1, Number(hm[1])));
    else if (/^(title|tiêu đề|tieu de)$/i.test(name) || /^Title$/i.test(sid)) { tag = 'h1'; cls = 'word-title'; }
    else if (/^subtitle$/i.test(name) || /^Subtitle$/i.test(sid)) { tag = 'h2'; cls = 'word-subtitle'; }
    else if (/quote/i.test(name)) tag = 'blockquote';
    else if (/^(pre|mã|code)$/i.test(name) || /^HTMLPreformatted$/i.test(sid)) { tag = 'pre'; cls = 'word-pre'; }
    let level = para.outlineLvl;
    if (!hm && level != null && level >= 0 && level <= 5) tag = 'h' + (level + 1);
    // Danh sách khai báo trong STYLE (vd "List Bullet", "List Number") chứ không ở đoạn → vẫn là danh sách
    if (own.numId == null && !hm && tag === 'p' && style.para && style.para.numId != null && style.para.numId !== '0' && /list|bullet|number|danh sách|danh sach/i.test(name + ' ' + sid)) {
        own.numId = style.para.numId;
        own.ilvl = style.para.ilvl || 0;
    }
    return { own, para, run, tag, cls };
}

function paraStyleAttr(info) {
    const p = info.para, st = [];
    const align = String(p.align || '').toLowerCase();
    if (align === 'center') st.push('text-align:center');
    else if (align === 'right' || align === 'end') st.push('text-align:right');
    else if (align === 'both' || align === 'justify' || align === 'distribute') st.push('text-align:justify');
    const left = p.indLeftTw != null ? p.indLeftTw : null;
    if (left != null) st.push('margin-left:' + px(left) + 'px');
    if (p.indRightTw != null) st.push('margin-right:' + px(p.indRightTw) + 'px');
    if (p.firstLineTw != null) st.push('text-indent:' + px(p.firstLineTw) + 'px');
    else if (p.hangingTw != null) st.push('text-indent:-' + px(p.hangingTw) + 'px');
    if (p.fill) st.push('background-color:#' + p.fill);
    if (p.hasBorder) st.push('border-bottom:1px solid #cbd5e1');
    if (p.afterTw != null) st.push('margin-bottom:' + px(p.afterTw) + 'pt');
    return st.length ? ` style="${escapeAttr(st.join(';'))}"` : '';
}

function renderParagraph(p, ctx) {
    const info = paragraphInfo(p, ctx);
    if (info.own.numId != null && info.own.numId !== '0') return { list: true, info };
    const inner = renderInline(p, ctx, info.run);
    const empty = !inner || !inner.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, '').trim() && !/<(img|br|hr|math)\b/i.test(inner);
    const body = empty ? '<br>' : inner;
    const attrs = paraStyleAttr(info) + (info.cls ? ` class="${info.cls}"` : '');
    // <hr> không được nằm trong <p>/<span> (trình duyệt tự cắt đoạn) → đặt ngắt trang ở mức khối
    const PB = '<hr class="word-pagebreak">';
    const stripped = body.replace(/<hr class="word-pagebreak">/g, '\u0001');
    if (stripped !== body) {
        return { html: stripped.split('\u0001').map((seg, i, arr) => {
            const t = seg.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, '').trim();
            const has = t || /<(img|br|math)\b/i.test(seg);
            return (has ? `<${info.tag}${attrs}>${seg}</${info.tag}>` : '') + (i < arr.length - 1 ? PB : '');
        }).join('') };
    }
    return { html: `<${info.tag}${attrs}>${body}</${info.tag}>` };
}

function renderTable(tbl, ctx) {
    const rows = kids(tbl, 'tr');
    let maxCols = 0;
    for (const tr of rows) maxCols = Math.max(maxCols, kids(tr, 'tc').reduce((n, tc) => n + Math.max(1, num(attr(child(tc, 'tcPr') ? child(child(tc, 'tcPr'), 'gridSpan') : null, 'val'), 1)), 0));
    // độ rộng cột theo w:tblGrid → bảng nhiều cột vẫn vừa khổ giấy, tỉ lệ cột giống Word
    const grid = kids(child(tbl, 'tblGrid') || tbl, 'gridCol').map((g) => num(attr(g, 'w')));
    const gridTotal = grid.reduce((a, v) => a + v, 0);
    const fixed = gridTotal > 0 && grid.length === maxCols;
    const out = [`<table class="word-table" style="border-collapse:collapse;width:100%;table-layout:${fixed ? 'fixed' : 'auto'}">`];
    for (const tr of rows) {
        let gi = 0;
        const trPr = child(tr, 'trPr');
        const isHeader = !!(trPr && child(trPr, 'tblHeader') && truthy(valOf(child(trPr, 'tblHeader'))));
        out.push('<tr>');
        for (const tc of kids(tr, 'tc')) {
            const tcPr = child(tc, 'tcPr');
            const span = Math.max(1, num(valOf(child(tcPr || tc, 'gridSpan')), 1));
            const vMerge = child(tcPr || tc, 'vMerge');
            const startCol = gi; gi += span;
            if (vMerge && /continue/i.test(String(valOf(vMerge) || ''))) continue;
            const tag = isHeader ? 'th' : 'td';
            const st = ['border:1px solid #94a3b8', 'padding:4px 7px', 'vertical-align:top'];
            if (fixed) { const w = grid.slice(startCol, startCol + span).reduce((a, v) => a + v, 0); st.push('width:' + Math.round(w / gridTotal * 1000) / 10 + '%', 'min-width:0'); }
            const fill = tcPr && hex(attr(child(tcPr, 'shd') || {}, 'fill'));
            if (fill) st.push('background-color:#' + fill);
            if (tag === 'th') st.push('font-weight:700', 'background-color:#f1f5f9');
            const inner = renderBlocks(elementChildren(tc), ctx);
            out.push(`<${tag}${span > 1 ? ` colspan="${span}"` : ''} style="${st.join(';')}">${inner || '<p><br></p>'}</${tag}>`);
        }
        out.push('</tr>');
    }
    out.push('</table>');
    return out.join('');
}

const LIST_CSS = { decimal: 'decimal', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman', decimalZero: 'decimal-leading-zero' };
const LIST_PAREN = { decimal: 'wd-decimal-paren', lowerLetter: 'wd-alpha-paren', upperLetter: 'wd-upper-alpha-paren', lowerRoman: 'wd-roman-paren', upperRoman: 'wd-upper-roman-paren' };
/** Kiểu đánh số của mức danh sách: bullet / số / chữ / La Mã, kể cả dạng "a)" "1)" "i)". */
function listKind(ctx, numId, lvl) {
    const L = ctx.numbering.level(numId, lvl);
    if (/^bullet$/i.test(L.fmt)) return { tag: 'ul', css: ['disc', 'circle', 'square'][lvl % 3] };
    const paren = /\)\s*$/.test(String(L.text || '')) && LIST_PAREN[L.fmt];
    return { tag: 'ol', css: paren || LIST_CSS[L.fmt] || 'decimal' };
}
/** Số thứ tự của mục kế tiếp (nối tiếp qua các đoạn xen giữa, đặt lại khi sang mức nông hơn). */
function nextListNumber(ctx, numId, lvl) {
    const key = String(numId);
    const c = ctx.counters.get(key) || [];
    const start = ctx.numbering.level(numId, lvl).start;
    c[lvl] = c[lvl] == null ? start : c[lvl] + 1;
    c.length = lvl + 1;
    ctx.counters.set(key, c);
    return c[lvl];
}

function renderBlocks(nodes, ctx) {
    const out = [];
    let listOpen = null, listNumId = null;
    const closeList = () => { if (listOpen) { out.push('</' + listOpen + '>'); listOpen = null; listNumId = null; } };
    // hình nổi (wrapNone) neo vào đoạn văn: khối cao 0 đặt ngay trước đoạn, toạ độ tính từ đỉnh đoạn → đúng vị trí như trong Word
    const flushFloats = () => { if (ctx.floats && ctx.floats.length) out.push('<div class="word-anchor">' + ctx.floats.splice(0).join('') + '</div>'); };
    for (const n of nodes) {
        const ln = local(n.name);
        if (ln === 'p') {
            const info = paragraphInfo(n, ctx);
            if (info.own.numId != null && info.own.numId !== '0') {
                const lvl = info.own.ilvl || 0;
                const kind = listKind(ctx, info.own.numId, lvl);
                const num0 = nextListNumber(ctx, info.own.numId, lvl);
                if (listOpen !== kind.tag || listNumId !== info.own.numId) {
                    closeList(); listOpen = kind.tag; listNumId = info.own.numId;
                    const base = lvl === 0 && kind.css !== 'decimal' && kind.css !== 'disc' ? ` style="list-style-type:${kind.css}"` : '';
                    out.push(`<${kind.tag}${kind.tag === 'ol' && num0 > 1 ? ` start="${num0}"` : ''}${base}>`);
                }
                const inner = renderInline(n, ctx, info.run);
                const st = lvl > 0 ? ` style="margin-left:${lvl * 24}px;list-style-type:${kind.css}"` : '';
                out.push(`<li${st}>${inner || '<br>'}</li>`);
                if ((ctx.boxes && ctx.boxes.length) || (ctx.floats && ctx.floats.length)) {
                    closeList(); flushFloats();
                    if (ctx.boxes.length) out.push(ctx.boxes.splice(0).join(''));
                }
                continue;
            }
            closeList();
            const r = renderParagraph(n, ctx);
            flushFloats();
            if (r.html) out.push(r.html);
            if (ctx.boxes && ctx.boxes.length) out.push(ctx.boxes.splice(0).join(''));
        } else if (ln === 'tbl') { closeList(); out.push(renderTable(n, ctx)); }
        else if (ln === 'sdt') { closeList(); const c = firstDesc(n, 'sdtContent'); if (c) out.push(renderBlocks(elementChildren(c), ctx)); }
    }
    closeList();
    return out.join('');
}

// ---------------------------------------------------------------- khổ giấy
function pageSettings(body) {
    const sect = child(body, 'sectPr') || descendants(body, 'sectPr').pop();
    const pgSz = sect ? child(sect, 'pgSz') : null;
    const pgMar = sect ? child(sect, 'pgMar') : null;
    let wTw = num(pgSz ? attr(pgSz, 'w') : null, 11906);
    let hTw = num(pgSz ? attr(pgSz, 'h') : null, 16838);
    if (wTw < 1000 || hTw < 1000) { wTw = 11906; hTw = 16838; }
    const margins = {
        top: px(pgMar ? attr(pgMar, 'top') : 1440),
        right: px(pgMar ? attr(pgMar, 'right') : 1440),
        bottom: px(pgMar ? attr(pgMar, 'bottom') : 1440),
        left: px(pgMar ? attr(pgMar, 'left') : 1440)
    };
    const widthPx = Math.round(wTw / TWIPS_PER_PX), heightPx = Math.round(hTw / TWIPS_PER_PX);
    const isA4 = Math.abs(wTw - 11906) < 300 && Math.abs(hTw - 16838) < 300;
    const isA4L = Math.abs(wTw - 16838) < 300 && Math.abs(hTw - 11906) < 300;
    const isLetter = Math.abs(wTw - 12240) < 300 && Math.abs(hTw - 15840) < 300;
    const isLetterL = Math.abs(wTw - 15840) < 300 && Math.abs(hTw - 12240) < 300;
    const size = isA4 || isA4L ? 'A4' : isLetter || isLetterL ? 'Letter' : 'Custom';
    const orientation = widthPx > heightPx ? 'landscape' : 'portrait';
    const all = ['top', 'right', 'bottom', 'left'].map((k) => margins[k]);
    const close = (v) => all.every((x) => Math.abs(x - v) <= 6);
    const margin = close(96) ? 'normal' : close(48) ? 'narrow' : close(144) ? 'wide' : 'custom';
    return { size, orientation, margin, marginsPx: margins, widthPx, heightPx };
}

/** convertDocx(buffer) → { html, page, title } */
function convertDocx(buf) {
    const zip = readZip(buf);
    const root = parseXml(zip.text('word/document.xml'));
    const body = firstDesc(root, 'body');
    if (!body) throw Object.assign(new Error('File Word không có nội dung (thiếu w:body).'), { status: 400 });
    const page = pageSettings(body);
    const ctx = {
        zip, rels: readRels(zip), styles: readStyles(zip), numbering: readNumbering(zip),
        images: new Map(), boxes: [], floats: [], counters: new Map(), page
    };
    const html = renderBlocks(elementChildren(body), ctx);
    let title = '';
    try {
        const core = parseXml(zip.text('docProps/core.xml') || '');
        const t = firstDesc(core, 'title');
        if (t) title = t.children.map((x) => x.text || '').join('').trim().slice(0, 200);
    } catch (_) { /* không có core.xml */ }
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
        throw Object.assign(new Error('Tài liệu Word quá lớn sau khi chuyển sang HTML (tối đa ' + Math.round(MAX_HTML_BYTES / 1048576) + 'MB). Hãy bớt ảnh hoặc chia nhỏ tài liệu.'), { status: 413 });
    }
    return { html, page, title };
}

module.exports = { convertDocx, pageSettings, parseRunProps, parseParaProps };
