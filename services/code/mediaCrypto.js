// services/code/mediaCrypto.js — mã hoá 2 CHIỀU cho ảnh / âm thanh / video tải lên ở dạng code "html".
//
//  • File mã hoá (ảnh, âm thanh/video ≤ 23MB, từng đoạn âm thanh m3u8): định dạng "MNHAENC1"
//        "MNHAENC1"(8) | ver=1 (1) | salt (16) | { độ-dài-ct u32 BE | iv (12) | tag (16) | ciphertext }…
//    Mỗi bản ghi là 1 khối AES-256-GCM độc lập (AAD = "MNHA" + số thứ tự khối) nên file lớn có thể gửi theo từng phần rồi ghép
//    (Vercel ≤ 4.5MB/request). Khoá = HKDF(khoá chủ, salt). Giải mã CHỈ ở Node (services/code/previewServer.js).
//    Phân biệt "đã mã hoá hay chưa" bằng đúng 8 byte đầu → file xem được thẳng (ảnh thường) thì KHÔNG cần giải mã.
//  • Đoạn video m3u8: AES-128-CBC chuẩn HLS (METHOD=AES-128, IV = số thứ tự đoạn). Khoá 16 byte dẫn xuất từ khoá chủ + mã tải lên;
//    bản ghi vào mnha-media.json là khoá đã MÃ HOÁ 2 CHIỀU (wrapKey/unwrapKey) — lộ file json cũng không có khoá thật.
//  • Khoá chủ: MEDIA_ENC_KEY (≥ 32 ký tự) hoặc, nếu không đặt, SESSION_ENC_KEY. MẤT/ĐỔI khoá = mọi media đã mã hoá không giải mã lại được.
'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('MNHAENC1', 'latin1');
const VER = 1;
const HEADER_LEN = MAGIC.length + 1 + 16;   // 25

class MediaCryptoError extends Error {
    constructor(message, code) { super(message); this.name = 'MediaCryptoError'; this.code = code; }
}

let _master = null;
function master() {
    if (_master) return _master;
    const raw = process.env.MEDIA_ENC_KEY || process.env.SESSION_ENC_KEY || '';
    if (raw.length < 32) throw new MediaCryptoError('Thiếu MEDIA_ENC_KEY (hoặc SESSION_ENC_KEY) ít nhất 32 ký tự — cần để mã hoá/giải mã ảnh, âm thanh, video.', 'NO_KEY');
    _master = crypto.scryptSync(raw, 'repo-mnha/media/v1', 32);
    return _master;
}
function resetKeys() { _master = null; }      // dùng trong test
const sub = (label, salt) => Buffer.from(crypto.hkdfSync('sha256', master(), salt || Buffer.alloc(0), label, 32));

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const aad = (index) => Buffer.concat([Buffer.from('MNHA', 'latin1'), u32(index)]);

function isEncrypted(buf) {
    return Buffer.isBuffer(buf) && buf.length >= HEADER_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Salt dẫn xuất (không cần lưu trạng thái): các phần của CÙNG một lần tải lên dùng chung salt. */
function deriveSalt(label) {
    return crypto.createHmac('sha256', sub('salt-derive')).update(String(label)).digest().subarray(0, 16);
}
function header(salt) {
    if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new MediaCryptoError('salt phải là 16 byte', 'BAD_ARG');
    return Buffer.concat([MAGIC, Buffer.from([VER]), salt]);
}

/** 1 bản ghi (khối) đã mã hoá — dùng khi gửi theo từng phần. */
function encryptRecord(plain, salt, index) {
    const key = sub('media-gcm', salt);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad(index));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([u32(ct.length), iv, c.getAuthTag(), ct]);
}

/** Mã hoá cả buffer thành 1 file MNHAENC1 (1 khối). */
function encryptBuffer(plain, salt) {
    const s = salt || crypto.randomBytes(16);
    return Buffer.concat([header(s), encryptRecord(plain, s, 0)]);
}

/** Ghép header + các bản ghi (đã đúng thứ tự 0,1,2…) thành 1 file. */
function assemble(salt, records) {
    return Buffer.concat([header(salt), ...records]);
}

/** Giải mã file MNHAENC1 → Buffer. Sai khoá / bị sửa / sai định dạng → MediaCryptoError (code BAD_FORMAT | AUTH | NO_KEY). */
function decryptBuffer(buf) {
    if (!isEncrypted(buf)) throw new MediaCryptoError('Không phải file mã hoá của hệ thống (thiếu MNHAENC1).', 'BAD_FORMAT');
    if (buf[MAGIC.length] !== VER) throw new MediaCryptoError('Phiên bản mã hoá không hỗ trợ: ' + buf[MAGIC.length], 'BAD_FORMAT');
    const salt = buf.subarray(MAGIC.length + 1, HEADER_LEN);
    const key = sub('media-gcm', salt);
    const out = [];
    let pos = HEADER_LEN, idx = 0;
    while (pos < buf.length) {
        if (pos + 4 + 12 + 16 > buf.length) throw new MediaCryptoError('File mã hoá bị cắt cụt.', 'BAD_FORMAT');
        const len = buf.readUInt32BE(pos);
        const iv = buf.subarray(pos + 4, pos + 16), tag = buf.subarray(pos + 16, pos + 32);
        const start = pos + 32, end = start + len;
        if (end > buf.length) throw new MediaCryptoError('File mã hoá bị cắt cụt.', 'BAD_FORMAT');
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAAD(aad(idx)); d.setAuthTag(tag);
        try { out.push(Buffer.concat([d.update(buf.subarray(start, end)), d.final()])); }
        catch (_) { throw new MediaCryptoError('Sai khoá hoặc file đã bị sửa/hỏng (không giải mã được khối ' + idx + ').', 'AUTH'); }
        pos = end; idx++;
    }
    if (!idx) throw new MediaCryptoError('File mã hoá rỗng.', 'BAD_FORMAT');
    return out.length === 1 ? out[0] : Buffer.concat(out);
}

// ---------------- HLS AES-128 (đoạn video) ----------------
/** Khoá 16 byte của 1 lần tải video (dẫn xuất — không cần lưu trạng thái giữa các request). */
function hlsKey(uid, uploadId) {
    return crypto.createHmac('sha256', sub('hls-key')).update(String(uid) + '|' + String(uploadId)).digest().subarray(0, 16);
}
/** IV mặc định của HLS = số thứ tự đoạn (media sequence) dạng 16 byte big-endian. */
function hlsIv(sn) {
    const b = Buffer.alloc(16); b.writeUInt32BE(Math.floor(sn / 4294967296) >>> 0, 8); b.writeUInt32BE(sn >>> 0, 12); return b;
}
function encryptHlsSegment(plain, key, sn) {
    const c = crypto.createCipheriv('aes-128-cbc', key, hlsIv(sn));
    return Buffer.concat([c.update(plain), c.final()]);
}
function decryptHlsSegment(enc, key, sn) {
    const d = crypto.createDecipheriv('aes-128-cbc', key, hlsIv(sn));
    return Buffer.concat([d.update(enc), d.final()]);
}
/** Khoá DRM ghi vào json: mã hoá 2 chiều (base64 của file MNHAENC1). */
function wrapKey(key16) { return encryptBuffer(key16).toString('base64'); }
function unwrapKey(b64) {
    const k = decryptBuffer(Buffer.from(String(b64 || ''), 'base64'));
    if (k.length !== 16) throw new MediaCryptoError('Khoá DRM trong json không hợp lệ.', 'BAD_FORMAT');
    return k;
}

// ---------------- biên nhận (chống nhét sha bất kỳ vào commit) ----------------
function receipt(uid, uploadId, path, sha, size) {
    return crypto.createHmac('sha256', sub('receipt')).update([uid, uploadId, path, sha, size].join('|')).digest('hex').slice(0, 40);
}
function verifyReceipt(r, uid, uploadId, path, sha, size) {
    const want = Buffer.from(receipt(uid, uploadId, path, sha, size)), got = Buffer.from(String(r || ''));
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Khoá bí mật ký token xem trước (previewToken.js). */
function signKey() { return sub('preview-token'); }

module.exports = {
    MediaCryptoError, MAGIC, HEADER_LEN, isEncrypted, deriveSalt, header, encryptRecord, encryptBuffer, assemble, decryptBuffer,
    hlsKey, hlsIv, encryptHlsSegment, decryptHlsSegment, wrapKey, unwrapKey, receipt, verifyReceipt, signKey, resetKeys
};
