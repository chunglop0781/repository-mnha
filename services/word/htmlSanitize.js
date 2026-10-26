// services/word/htmlSanitize.js — làm sạch HTML của tài liệu Word trước khi lưu / hiển thị / chuyển lại .docx.
// Chỉ giữ các thẻ và thuộc tính cần cho văn bản Word; bỏ script/iframe/style/event handler/javascript: ...
'use strict';
const { decodeEntities, escapeText, escapeAttr } = require('./xml');
const { isImageName, nameFromSrc } = require('./wordImages');

const VOID = new Set(['br', 'hr', 'img', 'col', 'area', 'base', 'embed', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ALLOWED = new Set([
    'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del',
    'sub', 'sup', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'br', 'hr', 'a', 'img',
    'blockquote', 'pre', 'code', 'mark'
]);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'video', 'audio', 'canvas', 'template']);
const RENAME = { b: 'strong', i: 'em', strike: 's', del: 's' };
const ALLOWED_CLASS = new Set(['word-pagebreak', 'word-table', 'word-title', 'word-subtitle', 'word-pre', 'word-list']);
const STYLE_PROPS = new Set([
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'color', 'background-color',
    'text-align', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'text-indent', 'line-height',
    'vertical-align', 'width', 'height', 'max-width', 'min-height', 'padding', 'padding-left', 'padding-right',
    'border', 'border-collapse', 'border-bottom', 'border-top', 'white-space', 'list-style-type'
]);

function tokenize(html) {
    const re = /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<\s*(\/?)\s*([A-Za-z][\w:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*(\/?)\s*>|([^<]+)/g;
    const tokens = [];
    let m;
    while ((m = re.exec(html))) {
        if (m[5] != null) tokens.push({ text: decodeEntities(m[5]) });
        else if (m[2]) tokens.push({ closing: m[1] === '/', tag: m[2].toLowerCase(), attrs: parseAttrs(m[3]), self: m[4] === '/' });
        // comment / doctype / PI: bỏ
    }
    return tokens;
}
function parseAttrs(s) {
    const out = {};
    const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m;
    while ((m = re.exec(s || ''))) out[m[1].toLowerCase()] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]);
    return out;
}

function parseHtml(html) {
    const root = { tag: '#root', attrs: {}, children: [] };
    const stack = [root];
    const popTo = (tag) => {
        for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; return; }
    };
    const popIf = (tags) => {
        const cur = stack[stack.length - 1].tag;
        if (tags.includes(cur)) stack.pop();
    };
    for (const t of tokenize(String(html || ''))) {
        if (t.text != null) {
            if (t.text) stack[stack.length - 1].children.push({ text: t.text });
            continue;
        }
        const tag = t.tag;
        if (tag === 'li') popIf(['li']);
        if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'div' || tag === 'blockquote' || tag === 'pre') popIf(['p']);
        if (tag === 'td' || tag === 'th') popIf(['td', 'th']);
        if (tag === 'tr') { popIf(['td', 'th']); popIf(['tr']); }
        if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') { popIf(['td', 'th']); popIf(['tr']); }
        if (t.closing) { popTo(tag); continue; }
        const node = { tag, attrs: t.attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!VOID.has(tag) && !t.self) stack.push(node);
    }
    return root;
}

function safeStyle(style) {
    const out = [];
    for (const part of String(style || '').split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const prop = part.slice(0, i).trim().toLowerCase();
        let value = part.slice(i + 1).trim();
        if (!STYLE_PROPS.has(prop) || !value || value.length > 500) continue;
        if (/url\s*\(|expression|javascript:|@import|behavior|<|>/i.test(value)) continue;
        if (!/^[#a-zA-Z0-9(),.%\s'"/!-]+$/.test(value)) continue;
        out.push(prop + ':' + value);
        if (out.join(';').length > 1200) break;
    }
    return out.join(';');
}

function safeHref(v) {
    const s = String(v || '').trim();
    if (!s || /[\u0000-\u001f\s]/.test(s)) return null;
    return /^(https?:\/\/|mailto:|tel:|#)/i.test(s) ? s : null;
}
function safeSrc(v) {
    const s = String(v || '').trim();
    if (isImageName(s)) return s;                       // ảnh đã tách ra file riêng (anh-001-...)
    // trình soạn có thể gửi lại URL media nội bộ → vẫn nhận rồi đổi về tên file khi lưu
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+)?\/(?:code\/word|w)\/media\?/i.test(s) && nameFromSrc(s)) return s;
    if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
    if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
    return null;
}

function cleanNode(node, depth, out) {
    if (depth > 80) return;
    if (node.text != null) { out.push(escapeText(node.text)); return; }
    const tag0 = node.tag;
    if (DROP.has(tag0)) return;
    const tag = RENAME[tag0] || tag0;
    if (!ALLOWED.has(tag)) { for (const c of node.children) cleanNode(c, depth + 1, out); return; }
    const attrs = [];
    const a = node.attrs || {};
    if (a.style) { const s = safeStyle(a.style); if (s) attrs.push(`style="${escapeAttr(s)}"`); }
    if (a.class) {
        const cls = String(a.class).split(/\s+/).filter((c) => ALLOWED_CLASS.has(c));
        if (cls.length) attrs.push(`class="${escapeAttr(cls.join(' '))}"`);
    }
    if (tag === 'a') {
        const href = safeHref(a.href);
        if (!href) { for (const c of node.children) cleanNode(c, depth + 1, out); return; }
        attrs.push(`href="${escapeAttr(href)}"`, 'target="_blank"', 'rel="noopener noreferrer"');
    }
    if (tag === 'img') {
        const src = safeSrc(a.src);
        if (!src) return;
        attrs.push(`src="${escapeAttr(src)}"`, 'alt="' + escapeAttr(String(a.alt || '').slice(0, 300)) + '"');
        for (const k of ['width', 'height']) {
            if (a[k] && /^\d{1,5}(%|px)?$/.test(String(a[k]))) attrs.push(`${k}="${escapeAttr(a[k])}"`);
        }
    }
    if (tag === 'td' || tag === 'th') {
        for (const k of ['colspan', 'rowspan']) {
            const n = Number(a[k]);
            if (Number.isInteger(n) && n > 1 && n <= 50) attrs.push(`${k}="${n}"`);
        }
    }
    if (a.title && ['span', 'p', 'div', 'a', 'img', 'td', 'th'].includes(tag)) attrs.push(`title="${escapeAttr(String(a.title).slice(0, 300))}"`);
    const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    if (VOID.has(tag)) { out.push(open); return; }
    out.push(open);
    for (const c of node.children) cleanNode(c, depth + 1, out);
    out.push(`</${tag}>`);
}

/** sanitizeHtml(html) → HTML an toàn (fragment). */
function sanitizeHtml(html) {
    const root = parseHtml(html);
    const out = [];
    for (const c of root.children) cleanNode(c, 0, out);
    return out.join('').replace(/><(p|h[1-6]|div|ul|ol|table|blockquote|pre)><\/(p|h[1-6]|div|ul|ol|table|blockquote|pre)>/g, (m) => m);
}

module.exports = { sanitizeHtml, parseHtml };
