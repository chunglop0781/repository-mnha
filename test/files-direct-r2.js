// test/files-direct-r2.js — "Lưu trữ file" tải THẲNG lên R2: init cấp URL PUT ký sẵn → (trình duyệt PUT) → finish({direct:true}) kiểm HEAD + header → đọc / giải mã / xoá.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const files = new Map(), sha = new Map();
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, sha.get(k) || 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async readJsonFileWithSha(p) { return files.has(p) ? { data: JSON.parse(files.get(p).toString()), sha: sha.get(p) } : null; },
  async writeJsonFileIfSha(p, d) { files.set(p, Buffer.from(JSON.stringify(d))); sha.set(p, crypto.randomBytes(4).toString('hex')); },
  async writeBinaryFile(p, b) { files.set(p, b); },
  async writeBinaryFileBig() { throw new Error('direct upload KHÔNG được ghi GitHub'); },
  async readBinaryFileLarge(p) { return files.get(p) || null; },
  async commitFiles(ch) { for (const c of ch) if (c.remove) { files.delete(c.path); sha.delete(c.path); } },
  async repoFor() { return { repo: 'r' }; },
  repoForSync() { return { owner: 'o', repo: 'r', branch: 'main' }; }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };

// R2 giả trong RAM
const r2 = new Map();
const STORAGE = { provider: 'cloudflare', accountId: 'a', bucket: 'b', mode: 'presign' };
const urlToKey = (u) => decodeURIComponent(u.replace('https://r2.test/put/', ''));
const fakeCf = {
  async runtime() { return { storage: STORAGE, doc: { mode: 'presign' } }; },
  async listObjects(st, prefix) { return [...r2].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.length })); },
  async presignPutUrl(st, key) { return 'https://r2.test/put/' + encodeURIComponent(key); },
  async headObject(st, key) { return r2.has(key) ? { size: r2.get(key).length } : null; },
  async readRange(st, key, s, l) { return r2.has(key) ? r2.get(key).subarray(s, s + l) : null; },
  async getObject(st, key) { return r2.get(key) || null; },
  async deleteObject(st, key) { r2.delete(key); },
  async deletePrefix(st, prefix) { let n = 0; for (const k of [...r2.keys()]) if (k.startsWith(prefix)) { r2.delete(k); n++; } return { deleted: n }; },
  async urlFor(st, key) { return 'https://r2.test/get/' + encodeURIComponent(key); }
};
const cp = require.resolve(R + 'services/connect/cloudflare.js');
require.cache[cp] = { id: cp, filename: cp, loaded: true, exports: fakeCf };

const fs = require(R + 'services/code/fileStore');
const { FILES } = require(R + 'config/codeConfig');
const PART = FILES.PART_BYTES;
const { enc } = require('./_enc');

(async () => {
  const uid = 'u1', buf = crypto.randomBytes(PART * 2 + 12345);
  // 1) init: có URL PUT cho cả 3 phần
  const init = await fs.init(uid, { dir: '', name: 'bai.pdf', size: buf.length, lastModified: 1 });
  assert.strictEqual(init.n, 3);
  assert.ok(init.direct && init.direct.urls && Object.keys(init.direct.urls).length === 3, 'phải có 3 URL PUT');
  assert.strictEqual(init.directWhy, undefined, 'có tải thẳng thì không có lý do');
  // 1b) tắt tải thẳng → init nói RÕ lý do để giao diện báo "đang tốn băng thông Vercel vì …"
  process.env.FILES_DIRECT = 'off';
  const off = await fs.init(uid, { dir: '', name: 'bai-off.pdf', size: 1000, lastModified: 5 });
  delete process.env.FILES_DIRECT;
  assert.ok(!off.direct && /FILES_DIRECT=off/.test(off.directWhy), 'lý do: ' + off.directWhy);
  // 2) "trình duyệt" mã hoá + PUT thẳng lên R2 (phần 1 bỏ lại để thử làm tiếp)
  for (const i of [0, 2]) r2.set(urlToKey(init.direct.urls[i]), await enc(init, buf.subarray(i * PART, (i + 1) * PART), i));
  await assert.rejects(fs.finish(uid, { dir: '', name: 'bai.pdf', uploadId: init.uploadId, size: buf.length, lastModified: 1, direct: true }), /Thiếu phần 2/);
  // làm tiếp: init lại thấy 0 và 2 đã có, chỉ cấp URL cho phần 1
  const again = await fs.init(uid, { dir: '', name: 'bai.pdf', size: buf.length, lastModified: 1 });
  assert.deepStrictEqual(again.have, [0, 2]);
  assert.deepStrictEqual(Object.keys(again.direct.urls), ['1']);
  r2.set(urlToKey(again.direct.urls[1]), await enc(init, buf.subarray(PART, 2 * PART), 1));
  const fin = await fs.finish(uid, { dir: '', name: 'bai.pdf', uploadId: init.uploadId, size: buf.length, lastModified: 1, direct: true });
  assert.strictEqual(fin.parts, 3);
  // 3) manifest ghi storage R2, không có file .bin nào trên GitHub
  const list = await fs.list(uid, '');
  assert.strictEqual(list.files.length, 1); assert.strictEqual(list.files[0].storage, 'r2'); assert.deepStrictEqual(list.files[0].github, []);
  assert.ok(![...files.keys()].some((k) => k.endsWith('.bin')), 'không có .bin trên GitHub');
  // 4) release → URL R2; open/readPart giải mã đúng
  const rel = await fs.release(uid, '', 'bai.pdf');
  assert.strictEqual(rel.mode, 'direct'); assert.ok(rel.parts.every((p) => p.url.startsWith('https://r2.test/get/')));
  const o = await fs.open(uid, '', 'bai.pdf'); const out = [];
  for (let i = 0; i < o.parts; i++) out.push(await o.readPart(i));
  assert.ok(Buffer.concat(out).equals(buf), 'giải mã khớp bản gốc');
  // 5) phần sai kích thước bị từ chối + xoá
  const init2 = await fs.init(uid, { dir: '', name: 'x.pdf', size: 1000, lastModified: 2 });
  r2.set(urlToKey(init2.direct.urls[0]), Buffer.alloc(50, 1));
  await assert.rejects(fs.finish(uid, { dir: '', name: 'x.pdf', uploadId: init2.uploadId, size: 1000, lastModified: 2, direct: true }), /sai kích thước/);
  assert.strictEqual(r2.has(urlToKey(init2.direct.urls[0])), false);
  // 6) xoá file → xoá object R2
  await fs.remove(uid, '', 'bai.pdf');
  assert.strictEqual(r2.size, 0);
  console.log('OK files-direct-r2');
})().catch((e) => { console.error(e); process.exit(1); });
