// services/sessionCrypto.js — mã hoá ĐẦU CUỐI 2 CHIỀU cho session/cookie lưu trên GitHub (cookies/index.json)
//   • Dữ liệu session (gồm cả cookie, user...) → AES-256-GCM: mã hoá ở server trước khi đẩy lên GitHub, chỉ server có khoá mới giải mã lại được.
//   • Khoá: SESSION_ENC_KEY (≥ 32 ký tự, giữ bí mật, KHÔNG commit). Mất/đổi khoá = mọi session cũ không giải mã được (người dùng phải đăng nhập lại).
//   • Mã session (sid) không bao giờ lưu nguyên văn: khoá tra cứu = HMAC-SHA256(sid) → lộ file index cũng không dựng lại được cookie hợp lệ.
//   • AAD = khoá tra cứu → không thể đem khối mã hoá của session này gán sang session khác.
'use strict';
const crypto = require('crypto');

let _k = null;
function keys() {
    if (_k) return _k;
    const raw = process.env.SESSION_ENC_KEY || '';
    if (raw.length < 32) throw new Error('Thiếu SESSION_ENC_KEY (ít nhất 32 ký tự) — cần để mã hoá session trước khi lưu lên GitHub.');
    const master = crypto.scryptSync(raw, 'repo-mnha/session/v1', 32);
    const sub = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
    _k = { enc: sub('aes-gcm'), idx: sub('index-id') };
    return _k;
}
function resetKeys() { _k = null; }   // dùng trong test

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

/** sid → khoá tra cứu trong index (không đảo ngược được). */
function sidId(sid) { return crypto.createHmac('sha256', keys().idx).update(String(sid)).digest('hex'); }

/** object → chuỗi "v1.<iv>.<tag>.<dữ liệu mã hoá>" */
function encrypt(obj, aad) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
    c.setAAD(Buffer.from(String(aad)));
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}

/** Giải mã lại thành object; sai khoá / bị sửa / sai aad → ném lỗi. */
function decrypt(token, aad) {
    const p = String(token).split('.');
    if (p.length !== 4 || p[0] !== 'v1') throw new Error('Định dạng session mã hoá không hợp lệ');
    const d = crypto.createDecipheriv('aes-256-gcm', keys().enc, unb64u(p[1]));
    d.setAAD(Buffer.from(String(aad)));
    d.setAuthTag(unb64u(p[2]));
    return JSON.parse(Buffer.concat([d.update(unb64u(p[3])), d.final()]).toString('utf8'));
}

module.exports = { sidId, encrypt, decrypt, keys, resetKeys };
