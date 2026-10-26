// services/word/xml.js — XML parser nhỏ (không phụ thuộc thư viện) dùng để đọc DOCX.
// Chỉ cần đúng cho các file XML do Word sinh ra: thẻ lồng nhau, thuộc tính, text, CDATA, comment.
'use strict';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (m, key) => {
        if (key[0] === '#') {
            const code = key[1] === 'x' || key[1] === 'X' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
            if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF) return m;
            try { return String.fromCodePoint(code); } catch (_) { return m; }
        }
        const v = ENTITIES[key];
        return v == null ? m : v;
    });
}
function escapeText(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;');
}
function local(name) {
    const n = String(name || '');
    const i = n.indexOf(':');
    return i >= 0 ? n.slice(i + 1) : n;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
function parseAttrs(s) {
    const out = {};
    if (!s) return out;
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(s))) out[m[1]] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]);
    return out;
}

// Thẻ mở: tên + phần thuộc tính + "/" (tự đóng). Chấp nhận khoảng trắng trước ">".
const TAG_RE = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*(\/?)\s*>/g;

/**
 * parseXml(xml) → cây { name, attrs, children } (text là { text: '...' }).
 * Bỏ qua comment/khai báo; giữ CDATA thành text.
 */
function parseXml(xml) {
    const root = { name: '#root', attrs: {}, children: [] };
    const stack = [root];
    const src = String(xml == null ? '' : xml);
    let last = 0, m;
    TAG_RE.lastIndex = 0;
    const addText = (raw, cdata) => {
        if (!raw) return;
        const text = cdata ? String(raw) : decodeEntities(raw);
        if (!text) return;
        stack[stack.length - 1].children.push({ text });
    };
    while ((m = TAG_RE.exec(src))) {
        const between = src.slice(last, m.index);
        if (between) addText(between, false);
        last = TAG_RE.lastIndex;
        const closing = m[1] === '/', name = m[2], selfClose = m[4] === '/';
        if (closing) {
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name === name) { stack.length = i; break; }
            }
            continue;
        }
        const node = { name, attrs: parseAttrs(m[3]), children: [] };
        stack[stack.length - 1].children.push(node);
        if (!selfClose) stack.push(node);
    }
    if (last < src.length) addText(src.slice(last), false);
    return root;
}

/** Ghép text của mọi node con (giữ thứ tự). */
function textOf(node) {
    if (!node) return '';
    let out = '';
    for (const c of node.children || []) {
        if (c.text != null) out += c.text;
        else if (local(c.name) === 'tab') out += '\t';
        else if (local(c.name) === 'br') out += '\n';
        else out += textOf(c);
    }
    return out;
}

module.exports = { decodeEntities, escapeText, escapeAttr, local, parseAttrs, parseXml, textOf };
