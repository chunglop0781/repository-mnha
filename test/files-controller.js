// test/files-controller.js — "Lưu trữ file": route handler (localhost) — init → part → finish → danh sách → xin link → tải về (stream) → xoá.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
delete process.env.VERCEL; delete process.env.DATA_NODE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
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
const req = (o = {}) => ({ user: { _id: 'u9', status: 'approved', role: 'student' }, headers: { host: 'localhost:3000', accept: 'application/json' }, hostname: 'localhost', query: {}, body: {}, method: 'POST', ...o });

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

  // công khai: xem không cần đăng nhập, chỉ file đã bật
  const img = crypto.randomBytes(3000), pdf = crypto.randomBytes(FILES.PART_BYTES + 10), docx = crypto.randomBytes(900);
  const putFile = async (name, buf, lm2) => {
    let rr = mkRes(); await ctl.uploadInit(req({ body: { dir: 'cong-khai', name, size: buf.length, lastModified: lm2 } }), rr); const ini = rr.body;
    for (let i = 0; i < ini.n; i++) { rr = mkRes(); await ctl.uploadPart(req({ method: 'PUT', query: { dir: 'cong-khai', name: ini.name, uploadId: ini.uploadId, i, n: ini.n }, body: buf.subarray(i * ini.partBytes, (i + 1) * ini.partBytes) }), rr); }
    rr = mkRes(); await ctl.uploadFinish(req({ body: { dir: 'cong-khai', name: ini.name, uploadId: ini.uploadId, size: buf.length, lastModified: lm2 } }), rr);
  };
  await putFile('anh.png', img, 1); await putFile('tai lieu.pdf', pdf, 2); await putFile('bien ban.docx', docx, 3);
  const Q = (n, extra) => ({ query: { u: 'u9', d: 'cong-khai', n, ...(extra || {}) }, headers: {} });
  r = mkRes(); await ctl.publicRaw(Q('anh.png'), r); assert.strictEqual(r.code, 404, 'mặc định riêng tư → 404'); assert(/không công khai/.test(r.body));
  r = mkRes(); await ctl.publicPageAt('/f/raw')(Q('anh.png'), r); assert.strictEqual(r.code, 404);
  r = mkRes(); await ctl.visibility(req({ body: { dir: 'cong-khai', name: 'anh.png', public: true } }), r); assert.strictEqual(r.body.changed, 1);
  r = mkRes(); await ctl.visibility(req({ body: { dir: 'cong-khai', name: 'anh.png' } }), r); assert.strictEqual(r.code, 400, 'thiếu trạng thái');
  r = mkRes(); await ctl.visibility(req({ body: { dir: 'cong-khai', all: true, public: true } }), r); assert.strictEqual(r.body.changed, 2);
  // ảnh: xem thẳng (inline), có sandbox
  r = mkRes(); await ctl.publicRaw(Q('anh.png'), r);
  assert.strictEqual(r.code, 200); assert.strictEqual(r.headers['Content-Type'], 'image/png'); assert.strictEqual(r.headers['Content-Disposition'], 'inline'); assert.strictEqual(r.headers['Content-Security-Policy'], 'sandbox');
  assert(Buffer.concat(r.chunks).equals(img));
  // PDF nhiều phần: xem thẳng, không sandbox (cần trình xem PDF), nối đủ byte
  r = mkRes(); await ctl.publicRaw(Q('tai lieu.pdf'), r);
  assert.strictEqual(r.headers['Content-Disposition'], 'inline'); assert(!r.headers['Content-Security-Policy']); assert(Buffer.concat(r.chunks).equals(pdf));
  // ?dl=1 → tải về; Word luôn tải về dù không có dl
  r = mkRes(); await ctl.publicRaw(Q('tai lieu.pdf', { dl: '1' }), r); assert(/^attachment/.test(r.headers['Content-Disposition']));
  r = mkRes(); await ctl.publicRaw(Q('bien ban.docx'), r); assert(/^attachment/.test(r.headers['Content-Disposition'])); assert(Buffer.concat(r.chunks).equals(docx));
  // trang xem công khai: HTML nhỏ + script giải mã trong trình duyệt (không nhúng dữ liệu, không <img>/<iframe> trỏ về máy chủ); tên được escape; CSP chặt
  r = mkRes(); await ctl.publicPageAt('/f/raw')(Q('anh.png'), r);
  assert.strictEqual(r.code, 200); assert(/data-key="\/f\/key\?/.test(r.body)); assert(/\/js\/mnhaFiles\.js/.test(r.body) && /\/js\/filePublic\.js/.test(r.body)); assert(/noindex/.test(r.body));
  assert(/script-src 'self'/.test(r.headers['Content-Security-Policy']) && /connect-src 'self' https:\/\/raw\.githubusercontent\.com/.test(r.headers['Content-Security-Policy']) && /default-src 'none'/.test(r.headers['Content-Security-Policy']));
  assert(/data-kind="image"/.test(r.body)); assert(!/<img|<iframe/.test(r.body));
  r = mkRes(); await ctl.publicPageAt('/f/raw')(Q('tai lieu.pdf'), r); assert(/data-kind="pdf"/.test(r.body)); assert(/data-srv-dl="\/f\/raw\?[^"]*dl=1/.test(r.body));
  r = mkRes(); await ctl.publicPageAt('/f/raw')(Q('bien ban.docx'), r); assert(/data-kind="word"/.test(r.body) && /Tải về/.test(r.body));
  // khoá công khai cho trình duyệt: có khoá riêng + địa chỉ raw từng phần; file riêng tư / không có → cùng 404
  r = mkRes(); await ctl.publicKey({ query: { u: 'u9', d: 'cong-khai', n: 'tai lieu.pdf' }, headers: {}, ip: '1.2.3.4' }, r);
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.mode, 'direct'); assert.strictEqual(r.body.parts.length, 2); assert(/^https:\/\/raw\.githubusercontent\.com\/o\/r\/main\/u9\//.test(r.body.parts[0].url));
  assert.strictEqual(Buffer.from(r.body.key, 'base64').length, 32);
  // chủ xin mở (đã đăng nhập): trình duyệt tự giải mã
  r = mkRes(); await ctl.open(req({ body: { dir: 'cong-khai', name: 'anh.png' } }), r); assert.strictEqual(r.body.mode, 'direct'); assert.strictEqual(r.body.parts.length, 1);
  r = mkRes(); await ctl.open(req({ body: { dir: 'cong-khai', name: 'khong-co.png' } }), r); assert.strictEqual(r.code, 404);
  // cổng ở web chính (localhost): trang xem phục vụ ngay; /f/raw tự phục vụ dự phòng
  r = mkRes(); await ctl.publicGate(false)({ ...Q('anh.png'), hostname: 'localhost' }, r); assert.strictEqual(r.code, 200); assert(/filePublic/.test(r.body));
  r = mkRes(); await ctl.publicGate(true)({ ...Q('anh.png'), hostname: 'localhost' }, r); assert(Buffer.concat(r.chunks).equals(img));
  // tắt công khai → 404 ngay; người khác (uid khác) không xem được
  r = mkRes(); await ctl.visibility(req({ body: { dir: 'cong-khai', name: 'anh.png', public: false } }), r);
  r = mkRes(); await ctl.publicRaw(Q('anh.png'), r); assert.strictEqual(r.code, 404);
  r = mkRes(); await ctl.publicRaw({ query: { u: 'u1', d: 'cong-khai', n: 'tai lieu.pdf' }, headers: {} }, r); assert.strictEqual(r.code, 404);
  r = mkRes(); await ctl.publicKey({ query: { u: 'u9', d: 'cong-khai', n: 'anh.png' }, headers: {}, ip: '1.2.3.4' }, r); assert.strictEqual(r.code, 404, 'tắt công khai → ngừng cấp khoá'); assert(/không công khai/.test(r.body.error));
  r = mkRes(); await ctl.publicPageAt('/f/raw')(Q('anh.png'), r); assert.strictEqual(r.code, 404);
  // tìm kiếm qua route
  r = mkRes(); await ctl.search(req({ method: 'GET', query: { q: 'BIEN BAN' } }), r);
  assert.deepStrictEqual(r.body.files.map((f) => f.name), ['bien ban.docx']); assert.strictEqual(r.body.files[0].public, true);
  r = mkRes(); await ctl.search(req({ method: 'GET', query: { q: '' } }), r); assert.strictEqual(r.code, 400);

  // quyền tải lên: chỉ admin + student đã duyệt; client / chưa duyệt / bị từ chối / vô hiệu hoá thì không
  const um = require(R + 'middleware/uploadAuth');
  const U = (role, status) => ({ _id: 'u7', role, status });
  assert.strictEqual(um.canUploadFiles(U('admin', 'approved')), true);
  assert.strictEqual(um.canUploadFiles(U('student', 'approved')), true);
  for (const [ro, st] of [['client', 'pending'], ['client', 'approved'], ['student', 'pending'], ['student', 'rejected'], ['student', 'disabled'], ['admin', 'disabled']]) assert.strictEqual(um.canUploadFiles(U(ro, st)), false, ro + '/' + st);
  assert.strictEqual(um.canUploadFiles(null), false);
  const body = { dir: '', name: 'x.pdf', size: 10, lastModified: 1 };
  for (const u of [U('client', 'pending'), U('student', 'pending')]) {
    r = mkRes(); await ctl.uploadInit(req({ user: u, body }), r); assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'UPLOAD_NOT_ALLOWED');
    r = mkRes(); await ctl.page(req({ user: u, method: 'GET', headers: { host: 'localhost' } }), r); assert.strictEqual(r.data.canUpload, false); assert(/chưa được duyệt/.test(r.data.denyMessage));
    let nextCalled = false; r = mkRes();
    um.requireFileUploader(req({ user: u, method: 'PUT' }), r, () => { nextCalled = true; });
    assert(!nextCalled && r.code === 403, 'middleware chặn cả 4 bước tải lên');
  }
  r = mkRes(); await ctl.uploadInit(req({ user: U('admin', 'approved'), body }), r); assert.strictEqual(r.code, 200);
  r = mkRes(); await ctl.uploadInit(req({ user: U('student', 'approved'), body }), r); assert.strictEqual(r.code, 200);
  let ok = false; um.requireFileUploader(req({ user: U('student', 'approved') }), mkRes(), () => { ok = true; }); assert(ok);
  // client vẫn xem danh sách được (không bị chặn đọc)
  r = mkRes(); await ctl.page(req({ user: U('client', 'pending'), method: 'GET', headers: { host: 'localhost' } }), r); assert.strictEqual(r.view, 'code/storage');

  // chia sẻ thư mục: trang /f/d chỉ liệt kê file CÔNG KHAI, chỉ khi chủ bật; tên file được escape
  r = mkRes(); await ctl.publicFolderPage({ query: { u: 'u9', d: 'cong-khai' }, headers: {} }, r); assert.strictEqual(r.code, 404, 'mặc định chưa chia sẻ → 404');
  r = mkRes(); await ctl.shareFolder(req({ body: { dir: 'cong-khai' } }), r); assert.strictEqual(r.code, 400);
  r = mkRes(); await ctl.shareFolder(req({ body: { dir: 'cong-khai', shared: true } }), r); assert.strictEqual(r.body.shared, true);
  r = mkRes(); await ctl.visibility(req({ body: { dir: 'cong-khai', name: 'bien ban.docx', public: true } }), r);
  r = mkRes(); await ctl.visibility(req({ body: { dir: 'cong-khai', name: 'tai lieu.pdf', public: false } }), r);
  r = mkRes(); await ctl.publicFolderPage({ query: { u: 'u9', d: 'cong-khai' }, headers: {} }, r);
  assert.strictEqual(r.code, 200); assert(/bien ban\.docx/.test(r.body)); assert(!/tai lieu\.pdf/.test(r.body), 'file riêng tư không hiện'); assert(!/anh\.png/.test(r.body));
  assert(/href="\/f\?u=u9&amp;d=cong-khai&amp;n=bien\+ban\.docx"/.test(r.body), 'link tới trang xem từng file'); assert(/default-src 'none'/.test(r.headers['Content-Security-Policy'])); assert(!/<script/.test(r.body));
  r = mkRes(); await ctl.page(req({ method: 'GET', query: { dir: 'cong-khai' }, headers: { host: 'localhost' } }), r); assert.strictEqual(r.data.shared, true); assert.strictEqual(r.data.limits.textEdit, FILES.TEXT_EDIT_MAX);
  r = mkRes(); await ctl.shareFolder(req({ body: { dir: 'cong-khai', shared: false } }), r);
  r = mkRes(); await ctl.publicFolderPage({ query: { u: 'u9', d: 'cong-khai' }, headers: {} }, r); assert.strictEqual(r.code, 404, 'thôi chia sẻ → 404');
  // .txt qua route: nhận, trang xem công khai có data-kind="text"
  r = mkRes(); await ctl.uploadInit(req({ body: { dir: '', name: 'ghi chu.txt', size: 12, lastModified: 5 } }), r); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.kind, 'text');

  // xem thư mục trên mạng = duyệt cả cây: thư mục con + file, có đường dẫn lên (không quá thư mục chia sẻ), breadcrumb
  const nest = async (d, name, buf, lm2) => {
    let rr = mkRes(); await ctl.uploadInit(req({ body: { dir: d, name, size: buf.length, lastModified: lm2 } }), rr); const ini = rr.body;
    rr = mkRes(); await ctl.uploadPart(req({ method: 'PUT', query: { dir: d, name: ini.name, uploadId: ini.uploadId, i: 0, n: 1 }, body: buf }), rr);
    rr = mkRes(); await ctl.uploadFinish(req({ body: { dir: d, name: ini.name, uploadId: ini.uploadId, size: buf.length, lastModified: lm2 } }), rr);
    rr = mkRes(); await ctl.visibility(req({ body: { dir: d, name, public: true } }), rr);
  };
  await nest('kho', 'a.pdf', crypto.randomBytes(50), 11); await nest('kho/lop-1', 'b.docx', crypto.randomBytes(50), 12); await nest('kho/lop-1/sau', 'c.txt', crypto.randomBytes(50), 13);
  r = mkRes(); await ctl.shareFolder(req({ body: { dir: 'kho', shared: true } }), r);
  const QD = (d) => ({ query: { u: 'u9', d }, headers: {} });
  r = mkRes(); await ctl.publicFolderPage(QD('kho'), r);
  assert.strictEqual(r.code, 200); assert(/📁 lop-1/.test(r.body)); assert(/href="\/f\/d\?u=u9&amp;d=kho%2Flop-1"/.test(r.body), 'bấm thư mục con để duyệt tiếp'); assert(/a\.pdf/.test(r.body)); assert(!/⬆/.test(r.body), 'gốc chia sẻ không có nút lên');
  r = mkRes(); await ctl.publicFolderPage(QD('kho/lop-1'), r);
  assert(/b\.docx/.test(r.body) && /📁 sau/.test(r.body) && !/a\.pdf/.test(r.body)); assert(/href="\/f\/d\?u=u9&amp;d=kho">⬆|href="\/f\/d\?u=u9&amp;d=kho"><span class="n">⬆/.test(r.body), 'có nút lên một cấp');
  assert(/class="c" href="\/f\/d\?u=u9&amp;d=kho">kho<\/a>/.test(r.body), 'breadcrumb dẫn về thư mục chia sẻ cao nhất'); assert(!/Lưu trữ file<\/a>/.test(r.body), 'không có đường lên trên thư mục chia sẻ');
  r = mkRes(); await ctl.publicFolderPage(QD(''), r); assert.strictEqual(r.code, 404, 'thư mục cha của thư mục chia sẻ không xem được');
  // trang quản lý: liệt kê link GitHub của các repo chứa dữ liệu thư mục
  r = mkRes(); await ctl.page(req({ method: 'GET', query: { dir: 'kho' }, headers: { host: 'localhost' } }), r);
  assert(Array.isArray(r.data.repos) && r.data.repos.length >= 1 && /^https:\/\/github\.com\/o\/r\/tree\/main\/u9\/codes\/files\/kho$/.test(r.data.repos[0].url), JSON.stringify(r.data.repos));
  assert(Array.isArray(r.data.files[0].github) && /_data\/[a-f0-9]{32}$/.test(r.data.files[0].github[0].url));
  console.log('OK files-controller');
})().catch((e) => { console.error('✘', e); process.exit(1); });
