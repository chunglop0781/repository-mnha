// services/code/previewToken.js — token ký (HMAC) cho link xem trước trang HTML: /preview/<token>/<đường-dẫn-file>
// Iframe xem trước KHÔNG mang cookie đăng nhập (chạy trong sandbox, origin "null") nên quyền đọc nằm hết trong token:
//   { k:'own', uid }                    → đọc file của chính người dùng đó:  {uid}/codes/html/...   (GitHub của app)
//   { k:'web', host, base[], ref }      → đọc file trong 1 repo GitHub/GitLab công khai (xem code trên mạng)
// Token hết hạn sau MEDIA.PREVIEW_TTL_MS; chỉ được cấp cho người đã đăng nhập (controllers/html.controller.js).
'use strict';
const crypto = require('crypto');
const mc = require('./mediaCrypto');
const { MEDIA } = require('../../config/codeConfig');

const b64u = (b) => Buffer.from(b).toString('base64url');
const mac = (body) => crypto.createHmac('sha256', mc.signKey()).update(body).digest().subarray(0, 18);

function sign(payload, ttlMs = MEDIA.PREVIEW_TTL_MS) {
    const body = b64u(JSON.stringify({ ...payload, e: Date.now() + ttlMs }));
    return body + '.' + b64u(mac(body));
}
/** → payload (không gồm e) hoặc null nếu sai chữ ký / hết hạn / hỏng. */
function verify(tok) {
    const s = String(tok || '');
    const i = s.indexOf('.');
    if (i < 1 || s.length > 1500) return null;
    const body = s.slice(0, i);
    let given, want;
    const sigStr = s.slice(i + 1);
    try { given = Buffer.from(sigStr, 'base64url'); want = mac(body); } catch (_) { return null; }
    if (given.length !== want.length || b64u(given) !== sigStr || !crypto.timingSafeEqual(given, want)) return null;      // b64u(given) !== sigStr: chặn ký tự thừa ở cuối chữ ký
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
    if (!p || typeof p !== 'object' || !(p.e > Date.now())) return null;
    if (p.k === 'own' && /^[A-Za-z0-9_\-]{1,64}$/.test(String(p.uid || ''))) return { k: 'own', uid: String(p.uid) };
    if (p.k === 'web' && ['github', 'gitlab'].includes(p.host) && Array.isArray(p.base) && p.base.length && p.base.length <= 8
        && p.base.every((x) => typeof x === 'string') && typeof p.ref === 'string') return { k: 'web', host: p.host, base: p.base, ref: p.ref };
    return null;
}
module.exports = { sign, verify };
