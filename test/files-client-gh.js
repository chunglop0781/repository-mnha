// test/files-client-gh.js — public/js/fileStorage.js tải THẲNG GitHub: trình duyệt mã hoá → POST /git/blobs (token TẠM của GitHub App) → server chỉ commit (JSON nhỏ) → finish.
//   Lỗi GitHub (token hết hạn / hết quyền) → báo rõ rồi quay về đường qua web kết nối.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
process.env.CONNECT_ENC_KEY = 'connect-key-0123456789-abcdefghijklmnop';
process.env.GITHUB_TOKEN = 'PAT_SECRET_KHONG_DUOC_LO';
delete process.env.GITHUB_APP_ID; delete process.env.GITHUB_APP_PRIVATE_KEY; delete process.env.FILES_GH_DIRECT;
delete process.env.VERCEL; delete process.env.DATA_NODE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert'), crypto = require('crypto'), fs = require('fs');
const { enc } = require('./_enc');
const putBodies = [];       // mọi thân PUT …/part mà trình duyệt gửi đi
const files = new Map(), blobs = new Map();
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async readJsonFileWithSha(p) { return files.has(p) ? { data: JSON.parse(files.get(p).toString()), sha: 'v' } : null; },
  async writeJsonFileIfSha(p, d) { files.set(p, Buffer.from(JSON.stringify(d))); },
  async writeBinaryFile(p, b) { files.set(p, b); }, async writeBinaryFileBig(p, b) { files.set(p, b); },
  async readBinaryFileLarge(p) { return files.get(p) || null; },
  async commitFiles(ch) { for (const c of ch) { if (c.remove) files.delete(c.path); else files.set(c.path, c.content || blobs.get(c.sha)); } return { commitSha: 'c' }; },
  async repoFor() { return { repo: 'r' }; }
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
let ghMode = 'ok', apiBlobs = 0; const blobAuth = [];
global.fetch = async (url, opt) => {
  calls.push((opt.method) + ' ' + url.split('?')[0]);
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    const p = new URL(url).pathname;
    if (p === '/repos/o/r/installation') return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    if (p === '/app/installations/77/access_tokens') return new Response(JSON.stringify({ token: 'ghs_TAM_1h', expires_at: '2099-01-01T00:00:00Z' }), { status: 201 });
    if (p === '/repos/o/r/git/blobs') {                       // TRÌNH DUYỆT tạo blob thẳng trên GitHub
      blobAuth.push(opt.headers.Authorization);
      if (ghMode === 'cors') throw new TypeError('Failed to fetch');
      if (ghMode === '401') return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      const j = JSON.parse(opt.body); const buf = Buffer.from(j.content, 'base64');
      const sha = crypto.createHash('sha1').update(buf).digest('hex'); blobs.set(sha, buf); apiBlobs++;
      return new Response(JSON.stringify({ sha }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }
  const u = new URL(url, 'http://localhost'); const q = Object.fromEntries(u.searchParams);
  const rq = { user: { _id: 'u9', status: 'approved', role: 'student' }, headers: { host: 'localhost', accept: 'application/json' }, hostname: 'localhost', query: q, method: opt.method, body: opt.body && typeof opt.body === 'string' ? JSON.parse(opt.body) : (opt.body ? Buffer.from(opt.body instanceof Uint8Array ? opt.body : await opt.body.arrayBuffer()) : {}) };
  if (opt.method === 'PUT' && Buffer.isBuffer(rq.body)) putBodies.push(rq.body);
  if (/node-a/.test(url)) return res(500, { error: 'node-a hỏng' });
  if (u.origin === 'https://raw.githubusercontent.com') {
    calls.push('RAW');
    if (global.rawDown) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = files.get(decodeURIComponent(u.pathname.replace(/^\/o\/r\/main\//, '')));
    return buf ? { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) } : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  const out = { code: 200, body: null, status(c) { this.code = c; return this; }, set() { return this; }, json(o) { this.body = o; return this; } };
  const map = { '/code/files/open': 'open', '/code/files/download-token': 'downloadToken', '/code/files/upload/init': 'uploadInit', '/code/files/upload/local/init': 'uploadLocalInit', '/code/files/upload/part': 'uploadPart', '/code/files/upload/finish': 'uploadFinish', '/code/files/upload/commit': 'uploadCommit' };
  if (!map[u.pathname]) return res(404, { error: 'no route ' + u.pathname });
  await ctl[map[u.pathname]](rq, out);
  return res(out.code, out.body);
};
global.Blob = Blob;
// Node không có FileReader (trình duyệt thì có): giả lập readAsDataURL để putGithubBlob chạy được
global.FileReader = class { readAsDataURL(b) { b.arrayBuffer().then((ab) => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(ab).toString('base64'); this.onload && this.onload(); }, (e) => { this.error = e; this.onerror && this.onerror(); }); } };
const notice = els.upNotice;

require(R + 'public/js/mnhaFiles.js');
require(R + 'public/js/fileStorage.js');
const cfg = require(R + 'services/connect/githubApp');
const store = require(R + 'services/code/fileStore');
const PEM = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const flush = () => new Promise((ok) => setTimeout(ok, 30));
const mkFile = (name, buf) => ({ name, size: buf.length, lastModified: 123, slice: (a, b) => new Blob([buf.subarray(a, b)]) });


const wait = async (cond, n = 600) => { for (let i = 0; i < n && !cond(); i++) await flush(); };
const reset = (keepFiles) => { calls = []; putBodies.length = 0; blobAuth.length = 0; apiBlobs = 0; global.reloaded = false; if (keepFiles) return; blobs.clear(); for (const k of [...files.keys()]) if (k.includes('/_data/')) files.delete(k); };

(async () => {
  const big = crypto.randomBytes(FILES.PART_BYTES * 2 + 5);          // 3 phần
  await cfg.saveConfig({ appId: '12345', privateKey: PEM });          // GitHub App nhập ở /connect (mã hoá trong repo chính)

  // 1) đường thẳng GitHub: 3 blob tạo bằng TOKEN TẠM, KHÔNG có PUT …/part, 1 request commit, finish bình thường
  reset();
  els.upInput.files = [mkFile('Giao trinh.pdf', big)]; els.upInput.onchange();
  await wait(() => global.reloaded);
  assert(global.reloaded, 'xong thì tải lại trang');
  assert.strictEqual(apiBlobs, 3, '3 phần tạo blob thẳng trên GitHub');
  assert(blobAuth.every((a) => a === 'Bearer ghs_TAM_1h'), 'trình duyệt chỉ dùng token tạm, không dùng PAT: ' + blobAuth.join());
  assert(!calls.includes('PUT /code/files/upload/part'), 'không gửi dữ liệu qua máy chủ');
  assert.strictEqual(calls.filter((c) => c === 'POST /code/files/upload/commit').length, 1, 'gom 3 phần vào 1 commit');
  assert.strictEqual(calls.filter((c) => c === 'POST /code/files/upload/finish').length, 1);
  const stored = [...files.keys()].filter((k) => k.includes('/_data/') && k.endsWith('.bin')).sort();
  assert.deepStrictEqual(stored.map((k) => k.slice(-8)), ['0001.bin', '0002.bin', '0003.bin']);
  for (const k of stored) { const b = files.get(k); assert.strictEqual(b.subarray(0, 8).toString('latin1'), 'MNHAENC1'); assert(!b.includes(big.subarray(0, 64)), 'không lộ bản rõ'); }
  const ent = (await store.readManifest('u9', ['tl'])).files['Giao trinh.pdf'];
  assert(ent && !ent.storage && ent.parts.length === 3, 'file lưu ở GitHub');
  assert.strictEqual(notice.textContent, '', 'đi đường thẳng thì không có cảnh báo');

  // tải lại đúng file → làm tiếp: đủ phần trên GitHub nên không tạo blob nào nữa
  reset(true);
  els.upInput.files = [mkFile('Giao trinh.pdf', big)]; els.upInput.onchange();
  await wait(() => global.reloaded);
  assert.strictEqual(apiBlobs, 0, 'phần đã có thì bỏ qua');
  assert(calls.includes('POST /code/files/upload/finish'));

  // 2) token hết hạn / hết quyền (401) → báo rõ rồi quay về đường qua máy chủ, file vẫn lên được
  reset(); ghMode = '401';
  els.upInput.files = [mkFile('Bao cao.pdf', big)]; els.upInput.onchange();
  await wait(() => global.reloaded);
  assert(global.reloaded, 'đường dự phòng vẫn tải lên được');
  assert(/Không tải thẳng được/.test(notice.textContent) && /401/.test(notice.textContent), 'báo rõ: ' + notice.textContent);
  assert.strictEqual(calls.filter((c) => c === 'PUT /code/files/upload/part').length, 3, 'quay về đường cũ: 3 phần qua máy chủ');
  assert(putBodies.every((b) => b.subarray(0, 8).toString('latin1') === 'MNHAENC1'), 'đường dự phòng vẫn gửi bản mã');

  // 3) mất mạng / bị chặn (CORS) → cũng quay về đường cũ
  reset(); ghMode = 'cors';
  els.upInput.files = [mkFile('Slide.pdf', big)]; els.upInput.onchange();
  await wait(() => global.reloaded);
  assert(global.reloaded && calls.filter((c) => c === 'PUT /code/files/upload/part').length === 3);

  // 4) chưa cấu hình GitHub App → đi qua máy chủ và NÓI RÕ lý do (để người dùng biết đang tốn băng thông)
  reset(); ghMode = 'ok'; await cfg.saveConfig({ clear: '1' });
  els.upInput.files = [mkFile('Khong app.pdf', big)]; els.upInput.onchange();
  await wait(() => global.reloaded);
  assert(global.reloaded && apiBlobs === 0 && calls.filter((c) => c === 'PUT /code/files/upload/part').length === 3);
  assert(/QUA web kết nối/.test(notice.textContent) && /GitHub App/.test(notice.textContent), 'báo lý do: ' + notice.textContent);

  console.log('OK files-client-gh');
  process.exit(0);
})().catch((e) => { console.error('✘', e); process.exit(1); });
