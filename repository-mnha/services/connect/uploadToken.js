// services/connect/uploadToken.js — phiếu tải lên ký HMAC để trình duyệt gửi THẲNG phần/đoạn file
// lên một "web dữ liệu" (Vercel khác) mà không cần cookie đăng nhập.
//
//   • Chỉ máy chủ web chính tạo phiếu (sau /code/html/upload/init), hạn 2 giờ.
//   • Phiếu gắn với: uid + uploadId + tên file + thư mục → web dữ liệu chỉ nhận đúng phiên đó.
//   • Khoá ký: CONNECT_HMAC_KEY (hoặc CONNECT_ENC_KEY / MEDIA_ENC_KEY / SESSION_ENC_KEY) — mọi web
//     dùng CHUNG .env nên kiểm tra được mà không phải gửi khoá qua mạng.
'use strict';
const crypto = require('crypto');
const cc = require('./crypto');

const TTL_MS = Number(process.env.UPLOAD_TOKEN_TTL_MS) > 0 ? Number(process.env.UPLOAD_TOKEN_TTL_MS) : 2 * 60 * 60 * 1000;

function secret() {
    const raw = process.env.CONNECT_HMAC_KEY || process.env.CONNECT_ENC_KEY || process.env.MEDIA_ENC_KEY || process.env.SESSION_ENC_KEY || '';
    if (String(raw).length < 32) throw new Error('Thiếu CONNECT_HMAC_KEY/CONNECT_ENC_KEY/MEDIA_ENC_KEY (≥ 32 ký tự) để ký phiếu tải lên.');
    return String(raw);
}
// nodeKey (khoá kết nối RIÊNG của web nhận) được trộn vào khoá ký: phiếu chỉ hợp lệ ở đúng web có đúng khoá.
function macKey(nodeKey) {
    const base = secret();
    if (!nodeKey) return base;
    return crypto.createHmac('sha256', base).update('upload-node|' + String(nodeKey)).digest();
}
function mac(data, nodeKey) { return crypto.createHmac('sha256', macKey(nodeKey)).update(data).digest('base64url'); }

/** { uid, uploadId, name, dir } → chuỗi phiếu (payload.sig). */
function sign(info = {}, nodeKey = null) {
    const p = {
        v: 1,
        uid: String(info.uid || ''),
        uploadId: String(info.uploadId || ''),
        name: String(info.name || ''),
        dir: String(info.dir || ''),
        nid: String(info.nid || ''),
        exp: Number(info.exp) > 0 ? Number(info.exp) : Date.now() + TTL_MS
    };
    if (!p.uid || !p.uploadId) throw new Error('uploadToken: thiếu uid/uploadId');
    const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
    return body + '.' + mac(body, nodeKey);
}

/** Phiếu hợp lệ → payload; sai/hết hạn → null. */
function verify(tok, nodeKey = null) {
    const parts = String(tok || '').split('.');
    if (parts.length !== 2) return null;
    if (!cc.safeEqual(mac(parts[0], nodeKey), parts[1])) return null;
    let p;
    try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { return null; }
    if (!p || p.v !== 1 || !p.uid || !p.uploadId) return null;
    if (!(Number(p.exp) > Date.now())) return null;
    return p;
}

/** Kiểm tra phiếu có đúng thư mục/tên file/phiên đang gửi không (chống dùng lại cho file khác). */
function matches(payload, { dir, name, uploadId } = {}) {
    if (!payload) return false;
    if (uploadId != null && String(uploadId) !== payload.uploadId) return false;
    if (name != null && String(name) !== payload.name) return false;
    if (dir != null && String(dir || '') !== payload.dir) return false;
    return true;
}

module.exports = { sign, verify, matches, TTL_MS };
