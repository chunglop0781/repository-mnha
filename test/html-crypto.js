// test/html-crypto.js — mã hoá 2 chiều ảnh/âm thanh/video (services/code/mediaCrypto.js)
//   Chạy: node test/html-crypto.js
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const assert = require('assert');
const crypto = require('crypto');
const mc = require('../services/code/mediaCrypto');

(() => {
  // 1) round-trip 1 khối + nhiều khối ghép (mô phỏng gửi từng phần rồi ghép)
  const plain = crypto.randomBytes(100000);
  const f = mc.encryptBuffer(plain);
  assert(mc.isEncrypted(f)); assert(!mc.isEncrypted(plain)); assert(f.subarray(0, 8).toString() === 'MNHAENC1');
  assert(mc.decryptBuffer(f).equals(plain));
  const salt = mc.deriveSalt('upload-1');
  assert(salt.equals(mc.deriveSalt('upload-1')) && !salt.equals(mc.deriveSalt('upload-2')), 'salt dẫn xuất ổn định theo mã tải lên');
  const parts = [plain.subarray(0, 40000), plain.subarray(40000, 90000), plain.subarray(90000)];
  const merged = mc.assemble(salt, parts.map((p, i) => mc.encryptRecord(p, salt, i)));
  assert(mc.decryptBuffer(merged).equals(plain)); console.log('✔ mã hoá/giải mã 1 khối và nhiều khối ghép');

  // 2) bị sửa 1 bit / đảo thứ tự khối / cắt cụt → lỗi rõ ràng
  const bad = Buffer.from(f); bad[bad.length - 5] ^= 1;
  assert.throws(() => mc.decryptBuffer(bad), (e) => e.code === 'AUTH');
  const recs = parts.map((p, i) => mc.encryptRecord(p, salt, i));
  assert.throws(() => mc.decryptBuffer(mc.assemble(salt, [recs[1], recs[0], recs[2]])), (e) => e.code === 'AUTH');
  assert.throws(() => mc.decryptBuffer(f.subarray(0, f.length - 3)), (e) => e.code === 'BAD_FORMAT');
  assert.throws(() => mc.decryptBuffer(Buffer.from('không phải file mã hoá nào cả, chỉ là chữ thường thôi')), (e) => e.code === 'BAD_FORMAT');
  console.log('✔ phát hiện sửa/đảo/cắt cụt/không phải file mã hoá');

  // 3) đổi khoá chủ → không giải mã được
  process.env.MEDIA_ENC_KEY = 'z'.repeat(40); mc.resetKeys();
  assert.throws(() => mc.decryptBuffer(f), (e) => e.code === 'AUTH');
  delete process.env.MEDIA_ENC_KEY; mc.resetKeys();
  assert(mc.decryptBuffer(f).equals(plain)); console.log('✔ sai khoá chủ → báo lỗi, đúng khoá → giải mã lại được');

  // 4) HLS AES-128: khớp với openssl/ffmpeg (CBC, PKCS7, IV = số thứ tự) + khoá bọc 2 chiều
  const key = mc.hlsKey('u1', 'up1');
  assert.strictEqual(key.length, 16); assert(key.equals(mc.hlsKey('u1', 'up1'))); assert(!key.equals(mc.hlsKey('u2', 'up1')));
  const seg = crypto.randomBytes(5000), enc = mc.encryptHlsSegment(seg, key, 7);
  assert(mc.decryptHlsSegment(enc, key, 7).equals(seg));
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.concat([Buffer.alloc(15), Buffer.from([7])]));
  assert(Buffer.concat([d.update(enc), d.final()]).equals(seg), 'IV = 16 byte BE của số thứ tự đoạn (chuẩn HLS)');
  const w = mc.wrapKey(key); assert(!Buffer.from(w, 'base64').includes(key)); assert(mc.unwrapKey(w).equals(key));
  console.log('✔ HLS AES-128 (IV = số thứ tự) và khoá DRM bọc 2 chiều');

  // 5) biên nhận
  const r = mc.receipt('u1', 'up1', '_media/a/seg00000.mp3', 'abc', 10);
  assert(mc.verifyReceipt(r, 'u1', 'up1', '_media/a/seg00000.mp3', 'abc', 10));
  assert(!mc.verifyReceipt(r, 'u1', 'up1', '_media/a/seg00001.mp3', 'abc', 10));
  assert(!mc.verifyReceipt(r, 'u2', 'up1', '_media/a/seg00000.mp3', 'abc', 10));
  assert(!mc.verifyReceipt('', 'u1', 'up1', 'x', 'abc', 10));
  console.log('✔ biên nhận gắn sha với đường dẫn + người dùng');
  console.log('OK html-crypto');
})();
