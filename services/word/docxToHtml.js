// services/word/docxToHtml.js — chuyển .docx (Word) → HTML sạch để soạn/xem như bản Word.
//
//  Hỗ trợ: đoạn văn + Heading/Title, chữ đậm/nghiêng/gạch chân/gạch ngang, màu chữ, tô nền,
//  phông + cỡ chữ, căn lề, thụt dòng, danh sách (bullet/số), bảng (gộp cột cơ bản), ảnh nhúng,
//  liên kết ngoài, ngắt trang, khổ giấy + lề. Không hỗ trợ: SmartArt, chart, macro, text box phức tạp…
//  Không dùng thư viện ngoài — tự đọc ZIP + XML của OOXML.
'use strict';
const { readZip } = require('./zip');
const { parseXml, local, escapeText, escapeAttr } = require('./xml');
const { ommlToMathml } = require('./omml');

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
    if (!xml) return { fmt: () => 'decimal', levels: () => [] };
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
        levels: (numId) => nums.get(String(numId)) || []
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
function imageFrom(xmlNode, ctx) {
    let rid = null, cx = 0, cy = 0;
    const blip = firstDesc(xmlNode, 'blip');
    if (blip) rid = attr(blip, 'embed') || attr(blip, 'link') || null;
    if (!rid) {
        const imagedata = firstDesc(xmlNode, 'imagedata');
        if (imagedata) rid = attr(imagedata, 'id') || null;
    }
    const extent = firstDesc(xmlNode, 'extent') || firstDesc(xmlNode, 'ext');
    if (extent) { cx = num(attr(extent, 'cx')); cy = num(attr(extent, 'cy')); }
    if (!rid) return null;
    const rel = ctx.rels.get(String(rid));
    const part = relTargetPath(rel);
    if (!part) return null;
    let cached = ctx.images.get(part);
    if (cached === undefined) {
        const buf = ctx.zip.get(part);
        const ext = String(part).split('.').pop().toLowerCase();
        const mime = IMAGE_MIME[ext];
        cached = buf && mime && buf.length <= 6 * 1024 * 1024 ? `data:${mime};base64,${buf.toString('base64')}` : null;
        ctx.images.set(part, cached);
    }
    if (!cached) return null;
    const w = cx > 0 ? Math.max(16, Math.round(cx / EMU_PER_PX)) : 480;
    const h = cy > 0 ? Math.max(16, Math.round(cy / EMU_PER_PX)) : 0;
    // mô tả ảnh (nếu Word có) → alt; khi tách ảnh sẽ thành phần tên file anh-001-<mô-tả>
    const docPr = firstDesc(xmlNode, 'docPr');
    const alt = docPr ? String(attr(docPr, 'descr') || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    return `<img src="${cached}" alt="${escapeAttr(alt)}" style="width:${w}px${h ? ';height:' + h + 'px' : ''};max-width:100%;height:auto">`;
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

/** Hình trong run: ảnh → <img>; hộp văn bản (w:txbxContent) → khối .word-textbox, chèn ngay sau đoạn chứa nó (xem renderBlocks). */
function drawingHtml(node, ctx) {
    const boxes = [];
    (function find(n) {
        for (const c of elementChildren(n)) {
            if (local(c.name) === 'txbxContent') boxes.push(c);
            else find(c);
        }
    })(node);
    if (boxes.length) {
        if (!ctx.boxes) ctx.boxes = [];
        for (const b of boxes) {
            const saved = ctx.boxes; ctx.boxes = [];
            const inner = renderBlocks(elementChildren(b), ctx);
            ctx.boxes = saved;
            if (inner) ctx.boxes.push('<div class="word-textbox">' + inner + '</div>');
        }
        return '';
    }
    return imageFrom(node, ctx);
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
        else if (ln === 'tab') parts.push('\u00a0\u00a0\u00a0\u00a0');
        else if (ln === 'br') parts.push(attr(c, 'type') === 'page' ? '<hr class="word-pagebreak">' : '<br>');
        else if (ln === 'cr') parts.push('<br>');
        else if (ln === 'noBreakHyphen') parts.push('-');
        else if (ln === 'sym') {
            let code = attr(c, 'char'); if (code) { try { parts.push(escapeText(String.fromCharCode(parseInt(code, 16)))); } catch (_) { } }
        } else if (ln === 'drawing' || ln === 'pict' || ln === 'object') {
            const img = drawingHtml(c, ctx); if (img) parts.push(img);
        } else if (ln === 'AlternateContent') {
            // Word ghi cùng một hình 2 lần: Choice (DrawingML) + Fallback (VML) → chỉ lấy một nhánh để khỏi nhân đôi
            const pick = elementChildren(c).find((x) => local(x.name) === 'Choice') || elementChildren(c).find((x) => local(x.name) === 'Fallback');
            if (pick) for (const d of elementChildren(pick)) {
                const l2 = local(d.name);
                if (l2 === 'drawing' || l2 === 'pict' || l2 === 'object') { const img = drawingHtml(d, ctx); if (img) parts.push(img); }
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
    if (info.own.numId != null) return { list: true, info };
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
    const pct = maxCols ? Math.max(4, Math.floor(100 / maxCols)) : 100;
    const out = ['<table class="word-table" style="border-collapse:collapse;width:100%;table-layout:auto">'];
    for (const tr of rows) {
        const trPr = child(tr, 'trPr');
        const isHeader = !!(trPr && child(trPr, 'tblHeader') && truthy(valOf(child(trPr, 'tblHeader'))));
        out.push('<tr>');
        for (const tc of kids(tr, 'tc')) {
            const tcPr = child(tc, 'tcPr');
            const span = Math.max(1, num(valOf(child(tcPr || tc, 'gridSpan')), 1));
            const vMerge = child(tcPr || tc, 'vMerge');
            if (vMerge && /continue/i.test(String(valOf(vMerge) || ''))) continue;
            const tag = isHeader ? 'th' : 'td';
            const st = ['border:1px solid #94a3b8', 'padding:4px 7px', 'vertical-align:top'];
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

function renderBlocks(nodes, ctx) {
    const out = [];
    let listOpen = null, listNumId = null;
    const closeList = () => { if (listOpen) { out.push('</' + listOpen + '>'); listOpen = null; listNumId = null; } };
    for (const n of nodes) {
        const ln = local(n.name);
        if (ln === 'p') {
            const info = paragraphInfo(n, ctx);
            if (info.own.numId != null) {
                const isOrdered = !/^bullet$/i.test(ctx.numbering.fmt(info.own.numId, info.own.ilvl || 0));
                const tag = isOrdered ? 'ol' : 'ul';
                if (listOpen !== tag || listNumId !== info.own.numId) { closeList(); listOpen = tag; listNumId = info.own.numId; out.push(`<${tag}>`); }
                const inner = renderInline(n, ctx, info.run);
                const lvl = info.own.ilvl || 0;
                const st = lvl > 0 ? ` style="margin-left:${lvl * 24}px;list-style-type:${tag === 'ul' ? ['disc', 'circle', 'square'][lvl % 3] : ['decimal', 'lower-alpha', 'lower-roman'][lvl % 3]}"` : '';
                out.push(`<li${st}>${inner || '<br>'}</li>`);
                if (ctx.boxes && ctx.boxes.length) { closeList(); out.push(ctx.boxes.splice(0).join('')); }
                continue;
            }
            closeList();
            const r = renderParagraph(n, ctx);
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
    const ctx = {
        zip, rels: readRels(zip), styles: readStyles(zip), numbering: readNumbering(zip),
        images: new Map()
    };
    const html = renderBlocks(elementChildren(body), ctx);
    const page = pageSettings(body);
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
