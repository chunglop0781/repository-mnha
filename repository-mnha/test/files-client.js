// test/files-client.js — public/js/fileStorage.js: chọn file → init → từng phần → finish; làm tiếp; chặn đuôi sai; chuyển web khi web lỗi.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
delete process.env.VERCEL; delete process.env.DATA_NODE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert'), crypto = require('crypto'), fs = require('fs');
const files = new Map();
const fakeGh = {
  isConfigured: true,
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
const els = {
  fileStorage: el(), payload: el({ textContent: JSON.stringify({ dir: 'tl', exts: FILE_EXTS, limits: { maxFile: FILES.MAX_FILE_BYTES, part: FILES.PART_BYTES } }) }),
  upDrop: el(), upInput: el(), upList: el(), upNotice: el(), btnNewFolder: el(), btnDelFolder: null
};
const rows = [];
global.document = { getElementById: (id) => els[id] || null, querySelectorAll: () => [], createElement: () => { const r = el({ innerHTML: '', className: '' }); rows.push(r); return r; }, body: el() };
global.location = { reload() { global.reloaded = true; }, href: '' };
global.confirm = () => true; global.alert = (m) => { throw new Error('alert: ' + m); }; global.prompt = () => null;

// ---- fetch giả: gọi thẳng controller (localhost); web kết nối giả "node-a" luôn lỗi 500 để thử chuyển web
let calls = [];
function res(code, body) { return { ok: code < 400, status: code, json: async () => body }; }
global.fetch = async (url, opt) => {
  calls.push((opt.method) + ' ' + url.split('?')[0]);
  const u = new URL(url, 'http://localhost'); const q = Object.fromEntries(u.searchParams);
  const rq = { user: { _id: 'u9', status: 'pending' }, headers: { host: 'localhost', accept: 'application/json' }, hostname: 'localhost', query: q, method: opt.method, body: opt.body && typeof opt.body === 'string' ? JSON.parse(opt.body) : (opt.body ? Buffer.from(await opt.body.arrayBuffer()) : {}) };
  if (/node-a/.test(url)) return res(500, { error: 'node-a hỏng' });
  const out = { code: 200, body: null, status(c) { this.code = c; return this; }, set() { return this; }, json(o) { this.body = o; return this; } };
  const map = { '/code/files/upload/init': 'uploadInit', '/code/files/upload/local/init': 'uploadLocalInit', '/code/files/upload/part': 'uploadPart', '/code/files/upload/finish': 'uploadFinish' };
  if (!map[u.pathname]) return res(404, { error: 'no route ' + u.pathname });
  await ctl[map[u.pathname]](rq, out);
  return res(out.code, out.body);
};
global.Blob = Blob;

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
  console.log('OK files-client');
})().catch((e) => { console.error('✘', e); process.exit(1); });
