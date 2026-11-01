// test/connect-crypto.js — mã hoá 2 chiều của web kết nối: đúng kiểu, chống sửa/gán nhầm web, chữ ký theo khoá riêng.
process.env.CONNECT_ENC_KEY = 'k7Hq2Zr9Xw1Lp4Vn8Bt3Yc6Md5Fg0JsAeQuRi';
const assert = require('assert');
const crypto = require('crypto');
const cc = require('../services/connect/crypto');

// 1) vòng khứ hồi đúng kiểu — kể cả chuỗi toàn chữ số (bản v1 cũ làm hỏng)
for (const v of ['abc', '1234567890123456789012345678901234567890', '1e5', 'true', '{"a":1}', { a: [1, 2] }, 42]) {
    assert.deepStrictEqual(cc.decrypt(cc.encrypt(v, 'connect|n1'), 'connect|n1'), v);
}
// 2) không lộ bản rõ, mỗi lần mã hoá khác nhau
const key = cc.newKey();
const t1 = cc.encrypt(key, 'connect|n1'), t2 = cc.encrypt(key, 'connect|n1');
assert.notStrictEqual(t1, t2);
assert(!t1.includes(key) && !Buffer.from(t1.split('.')[3], 'base64url').toString('latin1').includes(key.slice(0, 16)));
// 3) gán khối của web này sang web khác → từ chối; sửa 1 byte → từ chối
assert.throws(() => cc.decrypt(t1, 'connect|n2'));
const p = t1.split('.'); p[3] = (p[3][0] === 'A' ? 'B' : 'A') + p[3].slice(1);
assert.throws(() => cc.decrypt(p.join('.'), 'connect|n1'));
// 4) tương thích bản v1 cũ
{
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cc.keys().enc, iv);
    c.setAAD(Buffer.from('connect|old'));
    const ct = Buffer.concat([c.update(Buffer.from(key)), c.final()]);
    const v1 = ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    assert.strictEqual(cc.decrypt(v1, 'connect|old'), key);
}
// 5) chữ ký theo khoá RIÊNG: biết khoá chủ nhưng sai khoá web → chữ ký khác
const k2 = cc.newKey(), msg = 'n1\n1\nPOST\n/api/node/status\nx';
assert.strictEqual(cc.hmacWithKey(key, msg), cc.hmacWithKey(key, msg));
assert.notStrictEqual(cc.hmacWithKey(key, msg), cc.hmacWithKey(k2, msg));
assert.notStrictEqual(cc.hmacWithKey(key, msg), cc.hmac(msg));
// 5b) phiếu tải lên gắn khoá riêng của web nhận: đúng khoá mới qua, sai khoá/không khoá/hết hạn thì không
process.env.CONNECT_HMAC_KEY = 'h8Jq3Zr0Xw2Lp5Vn9Bt4Yc7Md6Fg1JsAeQuRiT';
const ut = require('../services/connect/uploadToken');
const tk = ut.sign({ uid: 'u1', uploadId: 'up1', name: 'a.mp4', dir: 'd', nid: 'n1' }, key);
assert.strictEqual(ut.verify(tk, key).uid, 'u1');
assert.strictEqual(ut.verify(tk, k2), null, 'sai khoá kết nối → từ chối');
assert.strictEqual(ut.verify(tk, null), null, 'không khoá → từ chối');
assert.strictEqual(ut.verify(tk.slice(0, -2) + 'xx', key), null, 'phiếu bị sửa → từ chối');
assert.strictEqual(ut.verify(ut.sign({ uid: 'u1', uploadId: 'up1', exp: Date.now() - 1000 }, key), key), null, 'hết hạn');
assert(ut.matches(ut.verify(tk, key), { dir: 'd', name: 'a.mp4', uploadId: 'up1' }));
assert(!ut.matches(ut.verify(tk, key), { dir: 'd', name: 'b.mp4', uploadId: 'up1' }), 'phiếu không dùng cho file khác');

// 6) khoá chủ yếu bị từ chối
cc.resetKeys(); process.env.CONNECT_ENC_KEY = 'a'.repeat(40);
assert.throws(() => cc.encrypt('x'), /quá yếu/);
console.log('connect-crypto OK');
