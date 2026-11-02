// test/files-client.js — public/js/fileStorage.js: chọn file → init → từng phần → finish; làm tiếp; chặn đuôi sai; chuyển web khi web lỗi.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
delete process.env.VERCEL; delete process.env.DATA_NODE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert'), crypto = require('crypto'), fs = require('fs');
const files = new Map();
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async readJsonFileWithSha(p) { return files.has(p) ? { data: JSON.parse(files.get(p).toString()), sha: 'v' } : null; },
  async writeJsonFileIfSha(p, d) { files.set(p, Buffer.from(JSON.stringify(d))); },
  async writeBinaryFile(p, b) { files.set(p, b); }, async writeBinaryFileBig(p, b) { files.set(p, b); },
  async readBinaryFileLarge(p) { return files.get(p) || null; }, async commitFiles() { }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };
const ctl = require(R + 'controllers/files.controller');
const { FILES, FILE_EXTS } = require(R + 'config/codeConfig');

// ---- DOM giả tối thiểu
const el = (extra) => Object.assign({ classList: { add() { }, remove() { }, toggle() { } }, addEventListener(ev, fn) { (this._h = this._h || {})[ev] = fn; }, appendChild(c) { (this.children = this.children || []).push(c); return c; }, querySelector() { return { style: {}, className: '', textContent: '' }; }, querySelectorAll() { return []; } }, extra || {});
const shareBtn = { dataset: { shared: '0' }, disabled: false };
const els = {
  fileStorage: el(), payload: el({ textContent: JSON.stringify({ dir: 'tl', exts: FILE_EXTS, limits: { maxFile: FILES.MAX_FILE_BYTES, part: FILES.PART_BYTES, textEdit: FILES.TEXT_EDIT_MAX }, canUpload: true }) }),
  edBox: el(), edText: { value: '', readOnly: false, focus() { } }, edTitle: { textContent: '' }, edMsg: { textContent: '', className: '' }, edSave: el(), edClose: el(), btnShareFolder: shareBtn,
  upDrop: el(), upInput: el(), upList: el(), upNotice: el(), btnNewFolder: el(), btnDelFolder: null
};
const rows = [];
const dlBtn = { dataset: { dl: 'Giáo trình.pdf' }, textContent: 'Tải', disabled: false };
const edBtn = { dataset: { edit: 'Ghi chú.txt' }, textContent: 'Xem / Sửa', disabled: false };
const saved = [];
global.window = global;
global.document = {
  getElementById: (id) => els[id] || null,
  querySelectorAll: (sel) => (sel === '[data-dl]' ? [dlBtn] : sel === '[data-edit]' ? [edBtn] : []),
  createElement: () => { const r = el({ innerHTML: '', className: '', style: {}, remove() { }, click() { saved.push(this.download); } }); rows.push(r); return r; },
  body: el()
};
global.location = { reload() { global.reloaded = true; }, href: '' };
global.confirm = () => true; global.alert = (m) => { throw new Error('alert: ' + m); }; global.prompt = () => null;

// ---- fetch giả: gọi thẳng controller (localhost); web kết nối giả "node-a" luôn lỗi 500 để thử chuyển web
let calls = [];
function res(code, body) { return { ok: code < 400, status: code, json: async () => body }; }
global.fetch = async (url, opt) => {
  calls.push((opt.method) + ' ' + url.split('?')[0]);
  const u = new URL(url, 'http://localhost'); const q = Object.fromEntries(u.searchParams);
  const rq = { user: { _id: 'u9', status: 'approved', role: 'student' }, headers: { host: 'localhost', accept: 'application/json' }, hostname: 'localhost', query: q, method: opt.method, body: opt.body && typeof opt.body === 'string' ? JSON.parse(opt.body) : (opt.body ? Buffer.from(await opt.body.arrayBuffer()) : {}) };
  if (/node-a/.test(url)) return res(500, { error: 'node-a hỏng' });
  if (u.origin === 'https://raw.githubusercontent.com') {
    calls.push('RAW');
    if (global.rawDown) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = files.get(decodeURIComponent(u.pathname.replace(/^\/o\/r\/main\//, '')));
    return buf ? { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) } : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  const out = { code: 200, body: null, status(c) { this.code = c; return this; }, set() { return this; }, json(o) { this.body = o; return this; } };
  const map = { '/code/files/open': 'open', '/code/files/download-token': 'downloadToken', '/code/files/upload/init': 'uploadInit', '/code/files/upload/local/init': 'uploadLocalInit', '/code/files/upload/part': 'uploadPart', '/code/files/upload/finish': 'uploadFinish' };
  if (!map[u.pathname]) return res(404, { error: 'no route ' + u.pathname });
  await ctl[map[u.pathname]](rq, out);
  return res(out.code, out.body);
};
global.Blob = Blob;

require(R + 'public/js/mnhaFiles.js');
require(R + 'public/js/fileStorage.js');
const flush = () => new Promise((ok) => setTimeout(ok, 30));
const mkFile = (name, buf) => ({ name, size: buf.length, lastModified: 123, slice: (a, b) => new Blob([buf.subarray(a, b)]) });

(async () => {
  const big = crypto.randomBytes(FILES.PART_BYTES * 2 + 5);
  els.upInput.files = [mkFile('Giáo trình.pdf', big), mkFile('lạ.exe', Buffer.alloc(10))];
  els.upInput._h = els.upInput._h || {};
  els.upInput.onchange();
  for (let i = 0; i < 40 && !global.reloaded; i++) await flush();
  assert(global.reloaded, 'tải xong thì tải lại trang');
  assert(calls.includes('POST /code/files/upload/init'));
  assert.strictEqual(calls.filter((c) => c === 'PUT /code/files/upload/part').length, 3, 'chia 3 phần');
  assert.strictEqual(calls.filter((c) => c === 'POST /code/files/upload/finish').length, 1);
  const stored = [...files.keys()].filter((k) => k.includes('/_data/') && k.endsWith('.bin')).sort();
  assert.deepStrictEqual(stored.map((k) => k.slice(-8)), ['0001.bin', '0002.bin', '0003.bin']);
  const lastMsg = rows.map((r) => r.querySelector && '').join('');   // (hàng .exe bị chặn nên không gọi mạng — kiểm bằng calls)
  assert(!calls.some((c) => /exe/.test(c)));
  // tải lại đúng file → làm tiếp: không gửi lại phần nào, vẫn finish (ghi đè)
  global.reloaded = false; calls = [];
  els.upInput.files = [mkFile('Giáo trình.pdf', big)]; els.upInput.onchange();
  for (let i = 0; i < 40 && !global.reloaded; i++) await flush();
  assert.strictEqual(calls.filter((c) => c === 'PUT /code/files/upload/part').length, 0, 'phần đã có thì bỏ qua');

  // tải về: TRÌNH DUYỆT tự giải mã (xin khoá ở /code/files/open → tải thẳng GitHub raw → giải mã → lưu), KHÔNG gọi đường qua máy chủ
  calls = []; saved.length = 0;
  await dlBtn.onclick();
  for (let i = 0; i < 40 && !saved.length; i++) await flush();
  assert.deepStrictEqual(saved, ['Giáo trình.pdf'], 'đã lưu file đã giải mã');
  assert(calls.includes('POST /code/files/open')); assert(calls.filter((c) => c === 'RAW').length === 3, 'tải 3 phần thẳng từ GitHub');
  assert(!calls.includes('POST /code/files/download-token'), 'không đi qua máy chủ');
  assert.strictEqual(dlBtn.disabled, false);
  // GitHub raw không tải được (repo riêng tư) → tự quay về đường qua máy chủ
  calls = []; saved.length = 0; global.rawDown = true; let alerts = 0; global.alert = () => { alerts++; };
  await dlBtn.onclick();
  for (let i = 0; i < 40 && !saved.length; i++) await flush();
  assert(calls.includes('POST /code/files/download-token'), 'dự phòng qua máy chủ'); assert.strictEqual(alerts, 0);

  // xem / SỬA .txt: mở (giải mã trong trình duyệt) → sửa → Lưu = mã hoá lại và ghi đè cùng tên, không hỏi lại
  global.rawDown = false; calls = []; global.reloaded = false;
  const t0 = Buffer.from('Nội dung gốc\n', 'utf8');
  { const up = await (async () => { const rq = (b) => ({ user: { _id: 'u9', status: 'approved', role: 'student' }, headers: { host: 'localhost' }, hostname: 'localhost', query: {}, body: b, method: 'POST' });
      const o = { code: 200, body: null, status(c) { this.code = c; return this; }, set() { return this; }, json(x) { this.body = x; return this; } };
      await ctl.uploadInit(rq({ dir: 'tl', name: 'Ghi chú.txt', size: t0.length, lastModified: 1 }), o); const ini = o.body;
      const o2 = { ...o, body: null }; await ctl.uploadPart({ ...rq({}), method: 'PUT', query: { dir: 'tl', name: ini.name, uploadId: ini.uploadId, i: 0, n: 1 }, body: t0 }, o2);
      const o3 = { ...o, body: null }; await ctl.uploadFinish(rq({ dir: 'tl', name: ini.name, uploadId: ini.uploadId, size: t0.length, lastModified: 1 }), o3); return o3.body; })();
    assert.strictEqual(up.ok, true); }
  await edBtn.onclick();
  for (let i = 0; i < 40 && !els.edText.value; i++) await flush();
  assert.strictEqual(els.edText.value, 'Nội dung gốc\n', 'mở ra đúng nội dung đã giải mã');
  assert.strictEqual(els.edTitle.textContent, 'Ghi chú.txt'); assert.strictEqual(els.edText.readOnly, false);
  assert(calls.includes('POST /code/files/open') && !calls.includes('POST /code/files/download-token'));
  els.edText.value = 'Nội dung đã sửa — tiếng Việt\nDòng mới\n';
  global.confirm = () => { throw new Error('không được hỏi ghi đè khi sửa'); };
  calls = [];
  await els.edSave.onclick();
  for (let i = 0; i < 60 && !global.reloaded; i++) await flush();
  assert(global.reloaded, 'lưu xong thì tải lại trang');
  assert(calls.includes('POST /code/files/upload/init') && calls.includes('PUT /code/files/upload/part') && calls.includes('POST /code/files/upload/finish'), 'lưu = đi qua đường tải lên (mã hoá lại ở máy chủ)');
  assert.strictEqual(els.edMsg.textContent, 'Đã lưu ✓');
  // đọc lại bằng chính trình duyệt: ra nội dung mới
  const reread = await ctl.open({ user: { _id: 'u9', status: 'approved', role: 'student' }, headers: {}, body: { dir: '', name: 'Ghi chú.txt' }, method: 'POST' }, { set() { return this; }, json(x) { this.b = x; return this; }, status() { return this; } });
  // (đường dẫn thư mục của file sửa là gốc '' vì trang giả đang ở thư mục 'tl' → kiểm bằng store)
  const store = require(R + 'services/code/fileStore');
  const inf = await store.release('u9', 'tl', 'Ghi chú.txt');
  global.fetch = async (url) => { const u = new URL(url); const b = files.get(decodeURIComponent(u.pathname.replace(/^\/o\/r\/main\//, ''))); return { ok: !!b, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
  assert.strictEqual(Buffer.from(await (await global.MnhaFiles.toBlob(inf)).arrayBuffer()).toString('utf8'), 'Nội dung đã sửa — tiếng Việt\nDòng mới\n');
  // nội dung rỗng không lưu được
  els.edText.value = ''; calls = []; await els.edSave.onclick(); assert(/rỗng/.test(els.edMsg.textContent)); assert.strictEqual(calls.length, 0);
  console.log('OK files-client');
})().catch((e) => { console.error('✘', e); process.exit(1); });
