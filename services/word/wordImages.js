// services/word/wordImages.js — ảnh trong tài liệu Word: tách data: URI ra file riêng
//   {user_id}/file-word/[thư-mục/...]/<tên-tài-liệu>/anh-001-<mô-tả>.<png|jpg|gif|webp|bmp>
// Ảnh được MÃ HOÁ "MNHAENC1" (cùng khoá với HTML) nên repo công khai cũng không xem được nội dung.
'use strict';
const crypto = require('crypto');
const { decodeEntities, escapeAttr } = require('./xml');

const NAME_RE = /^anh-\d{3,}(?:-[A-Za-z0-9_]+)*\.(png|jpe?g|gif|webp|bmp)$/i;
const DATA_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,([\s\S]+)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const MAX_IMAGES = 200;                              // quá số này thì giữ inline (vẫn nằm trong HTML đã mã hoá)

const isImageName = (v) => NAME_RE.test(String(v || ''));
const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dataUriOf = (ext, buf) => 'data:' + mimeOf('x.' + ext) + ';base64,' + Buffer.from(buf).toString('base64');

/** Kiểm tra nhanh chữ ký file để không ghi nhầm nội dung lạ thành ảnh. */
function magicOk(buf, ext) {
    if (!buf || !buf.length) return false;
    if (ext === 'png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (ext === 'jpg' || ext === 'jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (ext === 'gif') return buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8';
    if (ext === 'bmp') return buf.length > 2 && buf.toString('latin1', 0, 2) === 'BM';
    if (ext === 'webp') return buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
    return false;
}
function parseDataUri(src) {
    const m = DATA_RE.exec(String(src || ''));
    if (!m) return null;
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    let buf;
    try { buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); } catch (_) { return null; }
    if (!magicOk(buf, ext)) return null;
    return { ext, buffer: buf };
}

/** "Ảnh minh hoạ" → "anh-minh-hoa" (dùng cho tên file anh-001-anh-minh-hoa.png). */
function slugOf(alt) {
    let s = String(alt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
}

/** Tên ảnh đã quản lý, lấy từ chính tên file hoặc từ URL /code/word/media?...&n= / /w/media?...&n= (kể cả URL tuyệt đối). */
function nameFromSrc(v) {
    const s = String(v || '').trim();
    if (isImageName(s)) return s;
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+)?\/(?:code\/word|w)\/media\?/i.test(s) && /[?&]n=/.test(s)) {
        const m = /[?&]n=([^&#]+)/.exec(s);
        if (m) {
            let n = m[1];
            try { n = decodeURIComponent(n); } catch (_) { /* giữ nguyên */ }
            if (isImageName(n)) return n;
        }
    }
    return null;
}

function attrValue(tag, key) {
    const re = new RegExp('\\b' + key + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
    const m = re.exec(String(tag || ''));
    return m ? decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : '';
}
function replaceSrc(tag, m, value) {
    return tag.slice(0, m.index) + 'src="' + escapeAttr(value) + '"' + tag.slice(m.index + m[0].length);
}
function srcMatch(tag) {
    return /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
}
function srcValue(m) { return decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]); }

/** Đổi src của mọi <img> đang trỏ tới ảnh quản lý. fn(tên) → URL mới (null = giữ nguyên). */
function mapImageSrc(html, fn) {
    return String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
        const m = srcMatch(tag);
        if (!m) return tag;
        const name = nameFromSrc(srcValue(m));
        if (!name) return tag;
        const next = fn(name);
        return next ? replaceSrc(tag, m, next) : tag;
    });
}
/** Tập tên ảnh quản lý đang được dùng trong HTML. */
function imageNames(html) {
    const out = new Set();
    mapImageSrc(html, (n) => { out.add(n); return null; });
    return out;
}

/**
 * Quét <img> trong HTML rồi tách data:image/... thành file:
 *  - data URI → dùng lại ảnh cùng nội dung đã lưu, hoặc cấp tên mới anh-NNN-<mô-tả>.<ext>
 *  - tên file / URL media nội bộ → ghi nhận đang dùng
 *  - ảnh https ngoài → giữ nguyên
 * @param {string} html
 * @param {object} prevImages map tên→sha256 đã lưu trong mnha-word.json
 * @param {number} maxImages
 * @returns {{html:string, images:object, files:Array<{name:string,buffer:Buffer}>, removed:string[]}}
 */
function planImages(html, prevImages, maxImages = MAX_IMAGES) {
    const prev = prevImages && typeof prevImages === 'object' ? prevImages : {};
    const byHash = new Map();          // sha256 → tên file đã có
    let nextIdx = 1;
    for (const [n, h] of Object.entries(prev)) {
        if (!isImageName(n)) continue;
        if (h && !byHash.has(h)) byHash.set(h, n);
        const m = /^anh-(\d{3,})/.exec(n);
        if (m) nextIdx = Math.max(nextIdx, Number(m[1]) + 1);
    }
    const images = {};
    const files = [];
    let newCount = 0;

    const out = String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
        const m = srcMatch(tag);
        if (!m) return tag;
        const raw = srcValue(m);
        let name = nameFromSrc(raw);

        if (!name) {
            const d = parseDataUri(raw);
            if (!d) return tag;                                   // ảnh ngoài https / data URI lạ
            if (newCount >= maxImages) return tag;                // quá nhiều → giữ inline
            const hash = sha256(d.buffer);
            name = byHash.get(hash) || null;
            if (!name) {
                const slug = slugOf(attrValue(tag, 'alt'));
                name = 'anh-' + String(nextIdx++).padStart(3, '0') + (slug ? '-' + slug : '') + '.' + d.ext;
                files.push({ name, buffer: d.buffer });
                byHash.set(hash, name);
                newCount++;
            }
            images[name] = hash;
        } else {
            images[name] = prev[name] || '';
        }
        return replaceSrc(tag, m, name);
    });

    const removed = Object.keys(prev).filter((n) => isImageName(n) && images[n] == null);
    return { html: out, images, files, removed };
}

module.exports = {
    NAME_RE, MIME, MAX_IMAGES,
    isImageName, extOf, mimeOf, sha256, dataUriOf, parseDataUri, slugOf, nameFromSrc, magicOk,
    mapImageSrc, imageNames, planImages
};
