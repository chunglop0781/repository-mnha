// test/html-visibility.js — bật/tắt công khai ảnh/âm thanh/video: mã hoá bắt buộc, danh sách "private" trong mnha-media.json, nhúng vẫn dùng được (previewServer không chặn).
//   Chạy: node -r ./test/_stubs.js test/html-visibility.js
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');

const files = new Map(), blobs = new Map();
const shaOf = (b) => crypto.createHash('sha1').update(b).digest('hex');
const put = (p, b) => { const s = shaOf(b); blobs.set(s, b); files.set(p, s); };
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map(files), truncated: false }; },
  async createBlob(b) { const s = shaOf(b); blobs.set(s, b); return s; },
  async getBlobBuffer(s) { return blobs.get(s) || null; },
  async commitFiles(changes) { for (const c of changes) { if (c.remove) files.delete(c.path); else if (c.sha) files.set(c.path, c.sha); else put(c.path, c.content); } return { commitSha: 'c' }; },
  async writeBinaryFileBig(p, b) { put(p, b); }, async writeBinaryFile(p, b) { put(p, b); },
  async readBinaryFile(p) { const s = files.get(p); return s ? blobs.get(s) : null; },
  async readJsonFile(p) { const s = files.get(p); return s ? JSON.parse(blobs.get(s).toString()) : null; },
  async deleteFile(p) { files.delete(p); }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };

const ms = require(R + 'services/code/mediaService');
const mc = require(R + 'services/code/mediaCrypto');
const UID = 'u1';
const MJ = `${UID}/codes/html/test/mnha-media.json`;
const manifest = () => (files.has(MJ) ? JSON.parse(blobs.get(files.get(MJ)).toString()) : null);

(async () => {
  // ảnh KHÔNG mã hoá (công khai) → tắt công khai thì bị mã hoá
  const png = crypto.randomBytes(2000);
  await ms.putPart(UID, { dir: 'test', name: 'a.png', uploadId: 'a'.repeat(32), i: 0, n: 1, encrypt: '0' }, png);
  assert(!mc.isEncrypted(blobs.get(files.get(`${UID}/codes/html/test/a.png`))), 'ban đầu là bản rõ');
  let r = await ms.setPublic(UID, { dir: 'test', name: 'a.png', public: false });
  assert(r.ok && r.public === false && r.encryptedNow === true);
  const enc = blobs.get(files.get(`${UID}/codes/html/test/a.png`));
  assert(mc.isEncrypted(enc) && mc.decryptBuffer(enc).equals(png), 'đã mã hoá, giải mã lại đúng');
  assert.deepStrictEqual(manifest().private, ['a.png']);
  r = await ms.setPublic(UID, { dir: 'test', name: 'a.png', public: false }); assert.strictEqual(r.changed, false, 'tắt lần nữa: không đổi');

  // tải lại ảnh cùng tên không mã hoá khi đang riêng tư → vẫn bị mã hoá
  await ms.putPart(UID, { dir: 'test', name: 'a.png', uploadId: 'b'.repeat(32), i: 0, n: 1, encrypt: '0' }, png);
  assert(mc.isEncrypted(blobs.get(files.get(`${UID}/codes/html/test/a.png`))), 'ghi đè lúc riêng tư vẫn mã hoá');

  // file không tồn tại / tên lạ
  await assert.rejects(ms.setPublic(UID, { dir: 'test', name: 'nope.png', public: false }), /Không tìm thấy/);
  await assert.rejects(ms.setPublic(UID, { dir: 'test', name: 'x.exe', public: false }), /không hợp lệ/);

  // bật lại công khai; json còn mục files thì giữ, hết private thì bỏ khóa
  put(MJ, Buffer.from(JSON.stringify({ v: 1, files: {}, private: ['a.png'] })));
  r = await ms.setPublic(UID, { dir: 'test', name: 'a.png', public: true });
  assert(r.ok && r.public === true);
  assert(!files.has(MJ), 'json rỗng (không files, không private) thì xoá hẳn');
  console.log('OK html-visibility');
})().catch((e) => { console.error('✘', e); process.exit(1); });

