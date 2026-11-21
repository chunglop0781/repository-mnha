// test/files-password.js — mật khẩu chia sẻ (băm một chiều, đặt lại được khi quên), Trước/Sau khi xem ảnh, tải tất cả (nút) ở trang thư mục công khai.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
delete process.env.VERCEL; delete process.env.DATA_NODE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert'), crypto = require('crypto');
const { enc } = require('./_enc');
const { EventEmitter } = require('events');
const files = new Map();
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
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
const store = require(R + 'services/code/fileStore');

function mkRes() {
  const r = new EventEmitter(); r.code = 200; r.headers = {}; r.chunks = []; r.body = null; r.cookies = {}; r.location = null; r.headersSent = false;
  r.status = (c) => { r.code = c; return r; }; r.set = (a, b) => { if (typeof a === 'object') Object.assign(r.headers, a); else r.headers[a] = b; return r; };
  r.type = (t) => { r.headers['Content-Type'] = t; return r; };
  r.json = (o) => { r.body = o; return r; }; r.send = (t) => { r.body = t; return r; };
  r.cookie = (n, v, o) => { r.cookies[n] = { v, o }; return r; }; r.redirect = (c, u) => { r.code = c; r.location = u; return r; };
  r.render = (v, d) => { r.view = v; r.data = d; return r; };
  r.write = (b) => { r.headersSent = true; r.chunks.push(b); return true; }; r.end = () => r; r.destroy = () => { };
  return r;
}
const owner = (o = {}) => ({ user: { _id: 'u9', status: 'approved', role: 'student' }, headers: { host: 'localhost:3000', accept: 'application/json' }, hostname: 'localhost', query: {}, body: {}, method: 'POST', ...o });
const pub = (q, cookies, extra) => ({ query: q, headers: {}, cookies: cookies || {}, ip: '1.1.1.1', originalUrl: '/f?' + new URLSearchParams(q), ...(extra || {}) });

(async () => {
  const put = async (d, name, lm) => {
    const buf = crypto.randomBytes(60);
    let r = mkRes(); await ctl.uploadInit(owner({ body: { dir: d, name, size: buf.length, lastModified: lm } }), r); const ini = r.body;
    r = mkRes(); await ctl.uploadPart(owner({ method: 'PUT', query: { dir: d, name: ini.name, uploadId: ini.uploadId, i: 0, n: 1 }, body: await enc(ini, buf, 0) }), r);
    r = mkRes(); await ctl.uploadFinish(owner({ body: { dir: d, name: ini.name, uploadId: ini.uploadId, size: buf.length, lastModified: lm } }), r); assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    r = mkRes(); await ctl.visibility(owner({ body: { dir: d, name, public: true } }), r);
  };
  await put('anh', 'a.png', 1); await put('anh', 'b.png', 2); await put('anh', 'c.png', 3); await put('anh', 'tai-lieu.pdf', 4); await put('anh/con', 'd.png', 5);
  let r = mkRes(); await ctl.shareFolder(owner({ body: { dir: 'anh', shared: true } }), r);

  // ---- Trước / Sau: ảnh đi giữa các ảnh (bỏ qua PDF); ảnh đầu không có Trước, ảnh cuối không có Sau
  const q = (n, d = 'anh') => ({ u: 'u9', d, n });
  r = mkRes(); await ctl.publicPageAt('/f/raw')(pub(q('b.png')), r);
  assert.strictEqual(r.code, 200); assert(/id="aPrev"[^>]*href="\/f\?u=u9&amp;d=anh&amp;n=a\.png"/.test(r.body), 'có nút Trước → a.png'); assert(/id="aNext"[^>]*href="\/f\?u=u9&amp;d=anh&amp;n=c\.png"/.test(r.body), 'có nút Sau → c.png (bỏ qua PDF)');
  assert(/2 \/ 3/.test(r.body), 'hiện số thứ tự 2 / 3'); assert(/data-prev="\/f\?/.test(r.body) && /data-next="\/f\?/.test(r.body));
  r = mkRes(); await ctl.publicPageAt('/f/raw')(pub(q('a.png')), r); assert(!/id="aPrev"/.test(r.body) && /id="aNext"/.test(r.body), 'ảnh đầu: chỉ có Sau');
  r = mkRes(); await ctl.publicPageAt('/f/raw')(pub(q('c.png')), r); assert(/id="aPrev"/.test(r.body) && !/id="aNext"/.test(r.body), 'ảnh cuối: chỉ có Trước');

  r = mkRes(); await ctl.publicPageAt('/f/raw')(pub(q('b.png')), r);
  assert(/id="aFolder"[^>]*href="\/f\/d\?u=u9&amp;d=anh"/.test(r.body), 'có nút thoát ra thư mục (thư mục đã chia sẻ)');
  r = mkRes(); await ctl.publicFolderPage(pub({ u: 'u9', d: 'anh' }), r);
  assert(/\.bc a\.c\{display:inline/.test(r.body), 'breadcrumb hiển thị trên 1 dòng');

  // ---- mặc định KHÔNG mật khẩu
  r = mkRes(); await ctl.page(owner({ method: 'GET', query: { dir: 'anh' } }), r); assert.strictEqual(r.data.hasPass, false);
  r = mkRes(); await ctl.publicKey(pub(q('a.png')), r); assert.strictEqual(r.code, 200, 'công khai mặc định xem không cần mật khẩu');

  // ---- đặt mật khẩu: kiểm tra độ dài; lưu BĂM MỘT CHIỀU (không có bản rõ)
  r = mkRes(); await ctl.folderPassword(owner({ body: { dir: 'anh', password: 'abc' } }), r); assert.strictEqual(r.code, 400);
  r = mkRes(); await ctl.folderPassword(owner({ body: { dir: 'anh', password: 'mk1234' } }), r); assert.strictEqual(r.body.hasPass, true);
  const mf = [...files.entries()].find(([k]) => k.endsWith('anh/mnha-files.json'))[1].toString();
  assert(!mf.includes('mk1234'), 'không lưu mật khẩu rõ'); assert(/"pass":\{"s":"[0-9a-f]{32}","h":"[0-9a-f]{64}","v":"[0-9a-f]{12}"\}/.test(mf), 'lưu salt + scrypt + phiên bản');
  r = mkRes(); await ctl.page(owner({ method: 'GET', query: { dir: 'anh' } }), r); assert.strictEqual(r.data.hasPass, true);

  // ---- chưa nhập mật khẩu: trang xem / khoá / thư mục / raw đều bị chặn; trang nhập có nút Hiện/Ẩn
  r = mkRes(); await ctl.publicPageAt('/f/raw')(pub(q('a.png')), r);
  assert.strictEqual(r.code, 200); assert(/name="password"/.test(r.body) && /data-pw-toggle="pw"/.test(r.body) && /type="password"/.test(r.body), 'trang nhập mật khẩu có nút hiện/ẩn'); assert(!/a\.png<\/h1>/.test(r.body), 'chưa lộ nội dung');
  r = mkRes(); await ctl.publicKey(pub(q('a.png')), r); assert.strictEqual(r.code, 401); assert.strictEqual(r.body.code, 'LOCKED'); assert(!r.body.key, 'không cấp khoá giải mã');
  r = mkRes(); await ctl.publicFolderPage(pub({ u: 'u9', d: 'anh' }), r); assert(/name="password"/.test(r.body) && !/a\.png/.test(r.body));
  r = mkRes(); await ctl.publicRaw(pub(q('a.png')), r); assert.strictEqual(r.code, 401);
  r = mkRes(); await ctl.publicKey(pub(q('d.png', 'anh/con')), r); assert.strictEqual(r.code, 401, 'thư mục con thừa hưởng mật khẩu');

  // ---- nhập sai / đúng
  r = mkRes(); await ctl.publicUnlock({ body: { u: 'u9', d: 'anh', password: 'sai-roi', next: '/f?u=u9&d=anh&n=a.png' }, ip: '2.2.2.2' }, r);
  assert.strictEqual(r.code, 401); assert(/Sai mật khẩu/.test(r.body)); assert(!Object.keys(r.cookies).length);
  r = mkRes(); await ctl.publicUnlock({ body: { u: 'u9', d: 'anh', password: 'mk1234', next: 'https://evil.example/' }, ip: '2.2.2.2' }, r);
  assert.strictEqual(r.code, 303); assert.strictEqual(r.location, '/', 'next lạ bị bỏ (không open-redirect)');
  r = mkRes(); await ctl.publicUnlock({ body: { u: 'u9', d: 'anh', password: 'mk1234', next: '/f?u=u9&d=anh&n=a.png' }, ip: '2.2.2.2' }, r);
  assert.strictEqual(r.location, '/f?u=u9&d=anh&n=a.png'); const [cn, cv] = Object.entries(r.cookies)[0]; assert(cv.o.httpOnly && cv.o.maxAge > 0);
  const ck = { [cn]: cv.v };
  r = mkRes(); await ctl.publicPageAt('/f/raw')(pub(q('a.png'), ck), r); assert(/a\.png<\/h1>/.test(r.body), 'đã mở khoá → xem được');
  r = mkRes(); await ctl.publicKey(pub(q('a.png'), ck), r); assert.strictEqual(r.code, 200); assert(r.body.key);
  r = mkRes(); await ctl.publicKey(pub(q('d.png', 'anh/con'), ck), r); assert.strictEqual(r.code, 200, 'cookie của thư mục cha mở được thư mục con');
  r = mkRes(); await ctl.publicFolderPage(pub({ u: 'u9', d: 'anh' }, ck), r); assert(/a\.png/.test(r.body) && /id="btnZipAll"/.test(r.body) && /data-files="/.test(r.body), 'thư mục: có nút Tải tất cả');
  const pt = (await store.publicAccess('u9', 'anh', ck)).pt;
  r = mkRes(); await ctl.publicRaw(pub({ ...q('a.png'), pt }), r); assert.notStrictEqual(r.code, 401, 'chuyển sang web kết nối bằng phiếu pt');
  r = mkRes(); await ctl.publicRaw(pub({ ...q('a.png'), pt: pt.slice(0, -3) + 'xxx' }), r); assert.strictEqual(r.code, 401, 'phiếu giả bị chặn');

  // ---- QUÊN mật khẩu: chủ đặt mật khẩu MỚI (không cần cũ) → mật khẩu cũ và cookie cũ mất hiệu lực
  r = mkRes(); await ctl.folderPassword(owner({ body: { dir: 'anh', password: 'moi-9999' } }), r); assert.strictEqual(r.body.hasPass, true);
  r = mkRes(); await ctl.publicKey(pub(q('a.png'), ck), r); assert.strictEqual(r.code, 401, 'cookie cũ hết hiệu lực');
  r = mkRes(); await ctl.publicUnlock({ body: { u: 'u9', d: 'anh', password: 'mk1234', next: '/' }, ip: '3.3.3.3' }, r); assert.strictEqual(r.code, 401, 'mật khẩu cũ không còn dùng được');
  r = mkRes(); await ctl.publicUnlock({ body: { u: 'u9', d: 'anh', password: 'moi-9999', next: '/' }, ip: '3.3.3.3' }, r); assert.strictEqual(r.code, 303);

  // ---- xoá mật khẩu → công khai trở lại không cần mật khẩu
  r = mkRes(); await ctl.folderPassword(owner({ body: { dir: 'anh', remove: true } }), r); assert.strictEqual(r.body.hasPass, false);
  r = mkRes(); await ctl.publicKey(pub(q('a.png')), r); assert.strictEqual(r.code, 200);
  r = mkRes(); await ctl.folderPassword(owner({ body: { dir: 'anh' } }), r); assert.strictEqual(r.code, 400, 'thiếu mật khẩu mới');
  console.log('OK files-password');
})().catch((e) => { console.error('✘', e); process.exit(1); });
