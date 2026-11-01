// test/files-controller.js — "Lưu trữ file": route handler (localhost) — init → part → finish → danh sách → xin link → tải về (stream) → xoá.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
delete process.env.VERCEL; delete process.env.DATA_NODE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const files = new Map();
const fakeGh = {
  isConfigured: true,
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async readJsonFileWithSha(p) { return files.has(p) ? { data: JSON.parse(files.get(p).toString()), sha: 'v' + files.get(p).length } : null; },
  async writeJsonFileIfSha(p, d) { files.set(p, Buffer.from(JSON.stringify(d))); },
  async writeBinaryFile(p, b) { files.set(p, b); }, async writeBinaryFileBig(p, b) { files.set(p, b); },
  async readBinaryFileLarge(p) { return files.get(p) || null; },
  async commitFiles(ch) { for (const c of ch) if (c.remove) files.delete(c.path); }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };
const ctl = require(R + 'controllers/files.controller');
const { FILES } = require(R + 'config/codeConfig');

function mkRes() {
  const r = new EventEmitter(); r.code = 200; r.headers = {}; r.chunks = []; r.body = null; r.ended = false; r.headersSent = false;
  r.status = (c) => { r.code = c; return r; }; r.set = (a, b) => { if (typeof a === 'object') Object.assign(r.headers, a); else r.headers[a] = b; return r; };
  r.type = (t) => { r.headers['Content-Type'] = t; return r; };
  r.json = (o) => { r.body = o; r.ended = true; return r; }; r.send = (t) => { r.body = t; r.ended = true; return r; };
  r.render = (v, d) => { r.view = v; r.data = d; r.ended = true; return r; };
  r.write = (b) => { r.headersSent = true; r.chunks.push(b); return true; }; r.end = () => { r.ended = true; return r; };
  r.destroy = (e) => { r.destroyed = e || true; };
  return r;
}
const req = (o = {}) => ({ user: { _id: 'u9', status: 'pending', role: 'client' }, headers: { host: 'localhost:3000', accept: 'application/json' }, hostname: 'localhost', query: {}, body: {}, method: 'POST', ...o });

(async () => {
  const data = crypto.randomBytes(FILES.PART_BYTES * 2 + 777);
  const lm = 1700000000000;
  // init (localhost → mode local, chạy luôn)
  let r = mkRes(); await ctl.uploadInit(req({ body: { dir: 'bao-cao', name: 'Tổng kết.xlsx', size: data.length, lastModified: lm } }), r);
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.mode, 'local'); assert.strictEqual(r.body.n, 3);
  const init = r.body;
  // đuôi sai bị chặn ngay ở init
  r = mkRes(); await ctl.uploadInit(req({ body: { dir: '', name: 'virus.exe', size: 10, lastModified: 1 } }), r);
  assert.strictEqual(r.code, 400); assert(/không được nhận/.test(r.body.error));
  // gửi từng phần
  for (let i = 0; i < init.n; i++) {
    r = mkRes(); await ctl.uploadPart(req({ method: 'PUT', query: { dir: 'bao-cao', name: init.name, uploadId: init.uploadId, i, n: init.n }, body: data.subarray(i * init.partBytes, (i + 1) * init.partBytes) }), r);
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  }
  r = mkRes(); await ctl.uploadFinish(req({ body: { dir: 'bao-cao', name: init.name, uploadId: init.uploadId, size: data.length, lastModified: lm } }), r);
  assert.strictEqual(r.body.parts, 3);
  // trang danh sách
  r = mkRes(); await ctl.page(req({ method: 'GET', query: { dir: 'bao-cao' }, headers: { host: 'localhost' } }), r);
  assert.strictEqual(r.view, 'code/storage'); assert.strictEqual(r.data.files[0].name, 'Tổng kết.xlsx'); assert.strictEqual(r.data.files[0].parts, 3);
  assert(r.data.canUpload); assert(/\.xlsx/.test(r.data.accept) && /\.pdf/.test(r.data.accept) && !/\.exe/.test(r.data.accept));
  // xin link → tải về
  r = mkRes(); await ctl.downloadToken(req({ body: { dir: 'bao-cao', name: 'Tổng kết.xlsx' } }), r);
  assert.strictEqual(r.code, 200); assert(/^\/code\/files\/download\?t=/.test(r.body.url), r.body.url);
  const t = decodeURIComponent(r.body.url.split('?t=')[1]);
  r = mkRes(); await ctl.download({ query: { t }, headers: {} }, r);
  assert.strictEqual(r.code, 200); assert(/attachment/.test(r.headers['Content-Disposition'])); assert(/filename\*=UTF-8''T%E1%BB%95ng/.test(r.headers['Content-Disposition']));
  assert.strictEqual(r.headers['Content-Length'], String(data.length));
  assert(Buffer.concat(r.chunks).equals(data), 'file tải về giống hệt bản gốc'); assert(r.ended);
  // phiếu sai
  r = mkRes(); await ctl.download({ query: { t: t.slice(0, -3) + 'abc' }, headers: {} }, r); assert.strictEqual(r.code, 403);
  // file không tồn tại → không cấp phiếu
  r = mkRes(); await ctl.downloadToken(req({ body: { dir: 'bao-cao', name: 'khong-co.pdf' } }), r); assert.strictEqual(r.code, 404);
  // phần bị mất → báo lỗi, ngắt kết nối (không gửi file cụt như đủ)
  const lost = [...files.keys()].find((k) => k.endsWith('/0002.bin')); const keep = files.get(lost); files.delete(lost);
  r = mkRes(); await ctl.download({ query: { t }, headers: {} }, r); assert.strictEqual(r.code, 410); files.set(lost, keep);
  // đổi tên, xoá file, xoá thư mục
  r = mkRes(); await ctl.rename(req({ body: { dir: 'bao-cao', name: 'Tổng kết.xlsx', newName: 'Tong ket 2026.xlsx' } }), r); assert.strictEqual(r.body.name, 'Tong ket 2026.xlsx');
  r = mkRes(); await ctl.remove(req({ body: { dir: 'bao-cao', name: 'Tong ket 2026.xlsx' } }), r); assert(r.body.removed >= 3);
  assert(![...files.keys()].some((k) => k.includes('/_data/')), 'không còn phần nào');
  r = mkRes(); await ctl.createFolder(req({ body: { dir: '', name: 'tmp' } }), r); assert.strictEqual(r.body.dir, 'tmp');
  r = mkRes(); await ctl.removeFolder(req({ body: { dir: 'tmp' } }), r); assert.strictEqual(r.code, 200);
  console.log('OK files-controller');
})().catch((e) => { console.error('✘', e); process.exit(1); });
