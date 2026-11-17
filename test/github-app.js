// test/github-app.js — GitHub App: cấu hình MÃ HOÁ lưu repo chính (không cần .env) → token TẠM cho trình duyệt tải thẳng lên GitHub (PAT thật không lộ).
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
process.env.CONNECT_ENC_KEY = 'connect-key-0123456789-abcdefghijklmnop';
process.env.GITHUB_TOKEN = 'PAT_SECRET_KHONG_DUOC_LO';
delete process.env.GITHUB_APP_ID; delete process.env.GITHUB_APP_PRIVATE_KEY; delete process.env.GITHUB_APP_INSTALLATION_ID; delete process.env.FILES_GH_DIRECT;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert'), crypto = require('crypto');

const files = new Map(), shaOf = new Map(), commits = [];
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, shaOf.get(k) || 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async readJsonFileWithSha(p) { return files.has(p) ? { data: JSON.parse(files.get(p).toString()), sha: shaOf.get(p) } : null; },
  async writeJsonFileIfSha(p, d) { files.set(p, Buffer.from(JSON.stringify(d))); shaOf.set(p, crypto.randomBytes(4).toString('hex')); },
  async writeBinaryFile(p, b) { files.set(p, b); },
  async readBinaryFileLarge(p) { return files.get(p) || null; },
  async commitFiles(ch, msg) { commits.push({ ch, msg }); for (const c of ch) { if (c.remove) files.delete(c.path); else files.set(c.path, Buffer.from('blob:' + c.sha)); } return { commitSha: 'c1' }; },
  async repoFor() { return { repo: 'r' }; }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

// ---- api.github.com giả: kiểm JWT của App + yêu cầu quyền tối thiểu
const gcalls = []; let installed = true;
const realFetch = global.fetch;
global.fetch = async (url, opt = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== 'api.github.com') return realFetch(url, opt);
  const jwt = String((opt.headers || {}).Authorization || '').replace(/^Bearer /, '');
  const [h, b, s] = jwt.split('.');
  assert(crypto.createVerify('RSA-SHA256').update(h + '.' + b).verify(publicKey, Buffer.from(s, 'base64url')), 'JWT phải ký đúng bằng private key của App');
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.strictEqual(claims.iss, '12345'); assert(claims.exp - claims.iat <= 600 + 60, 'JWT sống ngắn');
  gcalls.push(opt.method + ' ' + u.pathname + (opt.body ? ' ' + opt.body : ''));
  if (u.pathname === '/repos/o/r/installation') return installed ? new Response(JSON.stringify({ id: 77 }), { status: 200 }) : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  if (u.pathname === '/app/installations/77/access_tokens') return new Response(JSON.stringify({ token: 'ghs_TAM_1h', expires_at: '2099-01-01T00:00:00Z' }), { status: 201 });
  return new Response('{}', { status: 404 });
};

const app = require(R + 'services/githubAppToken');
const cfg = require(R + 'services/connect/githubApp');
const fs = require(R + 'services/code/fileStore');
const { FILES } = require(R + 'config/codeConfig');
const { enc } = require('./_enc');

(async () => {
  // 1) chưa cấu hình → không tải thẳng GitHub được, init nói rõ phải nhập ở /connect
  assert.strictEqual(await app.isConfigured(), false);
  const i0 = await fs.init('u1', { dir: '', name: 'a.pdf', size: 1000, lastModified: 1 });
  assert.ok(!i0.ghDirect && /\/connect/.test(i0.directWhy), 'lý do: ' + i0.directWhy);

  // 2) lưu cấu hình: private key được MÃ HOÁ trong repo chính, không có bản rõ
  await assert.rejects(cfg.saveConfig({ appId: 'abc', privateKey: PEM }), /App ID phải là số/);
  await assert.rejects(cfg.saveConfig({ appId: '12345', privateKey: 'khong-phai-pem' }), /không đọc được/);
  const sum = await cfg.saveConfig({ appId: '12345', privateKey: PEM });
  assert.strictEqual(sum.source, 'repo'); assert.strictEqual(sum.keySaved, true); assert.strictEqual(sum.keyHint.length, 4);
  const raw = files.get(cfg.FILE()).toString();
  assert(!/BEGIN|PRIVATE|MII/.test(raw), 'file cấu hình không chứa private key dạng rõ');
  assert(!raw.includes(PEM.slice(40, 80)));
  assert.strictEqual((await cfg.runtime({ force: true })).privateKey.trim(), PEM.trim(), 'giải mã lại đúng key');
  // nhập dạng 1 dòng (\n) / base64 cũng nhận; để trống key khi sửa = giữ key cũ
  assert.strictEqual(cfg.parsePem(PEM.replace(/\n/g, '\\n')).fingerprint, sum.keyHint);
  assert.strictEqual(cfg.parsePem(Buffer.from(PEM).toString('base64')).fingerprint, sum.keyHint);
  assert.strictEqual((await cfg.saveConfig({ appId: '12345', installationId: '' })).keyHint, sum.keyHint);

  // 3) token tạm: quyền tối thiểu (1 repo, Contents:write), KHÔNG phải PAT
  const t = await app.mintForRepo('o', 'r');
  assert.strictEqual(t.token, 'ghs_TAM_1h');
  const post = gcalls.find((c) => c.startsWith('POST /app/installations/77/access_tokens'));
  assert.deepStrictEqual(JSON.parse(post.slice(post.indexOf('{'))), { repositories: ['r'], permissions: { contents: 'write' } });

  // 4) init: trình duyệt nhận token TẠM của repo đang ghi; PAT thật tuyệt đối không xuất hiện
  const init = await fs.init('u1', { dir: 'tl', name: 'bai.pdf', size: FILES.PART_BYTES + 5, lastModified: 2 });
  assert.ok(init.ghDirect && init.ghDirect.token === 'ghs_TAM_1h' && init.ghDirect.owner === 'o' && init.ghDirect.repo === 'r' && init.ghDirect.expiresAt);
  assert.strictEqual(init.directWhy, undefined);
  assert(!JSON.stringify(init).includes('PAT_SECRET'), 'PAT thật không được xuống trình duyệt');
  assert(!JSON.stringify(init).includes('BEGIN'), 'private key không được xuống trình duyệt');

  // 5) commitBlobs: gom blob (do trình duyệt tạo) vào MỘT commit đúng đường dẫn; từ chối dữ liệu sai
  const sha = (c) => c.repeat(40);
  const q = { dir: 'tl', name: 'bai.pdf', uploadId: init.uploadId, size: FILES.PART_BYTES + 5, lastModified: 2 };
  const r = await fs.commitBlobs('u1', { ...q, parts: [{ i: 0, sha: sha('a') }, { i: 1, sha: sha('b') }] });
  assert.strictEqual(r.committed, 2);
  const last = commits[commits.length - 1];
  assert.strictEqual(last.ch.length, 2);
  assert(/_data\/[a-f0-9]{32}\/0001\.bin$/.test(last.ch[0].path) && last.ch[0].sha === sha('a'));
  assert(/0002\.bin$/.test(last.ch[1].path));
  const n0 = commits.length;
  await assert.rejects(fs.commitBlobs('u1', { ...q, parts: [{ i: 2, sha: sha('a') }] }), /thứ tự/);          // vượt số phần
  await assert.rejects(fs.commitBlobs('u1', { ...q, parts: [{ i: 0, sha: 'zz' }] }), /blob/);                // sha sai
  await assert.rejects(fs.commitBlobs('u1', { ...q, parts: [{ i: 0, sha: sha('a') }, { i: 0, sha: sha('b') }] }), /thứ tự/); // trùng
  await assert.rejects(fs.commitBlobs('u1', { ...q, size: q.size + 1, parts: [{ i: 0, sha: sha('a') }] }), /không khớp/);     // uploadId của file khác
  await assert.rejects(fs.commitBlobs('u2', { ...q, parts: [{ i: 0, sha: sha('a') }] }), /không khớp/);                      // người khác không ghi vào mã của u1
  assert.strictEqual(commits.length, n0, 'không commit khi dữ liệu sai');
  // finish như luồng GitHub thường: đủ phần trên cây → ghi sổ file
  const fin = await fs.finish('u1', { dir: 'tl', name: 'bai.pdf', uploadId: init.uploadId, size: q.size, lastModified: 2 });
  assert.strictEqual(fin.parts, 2);

  // 6) tắt bằng FILES_GH_DIRECT=off / App chưa cài lên repo → quay về đường cũ kèm lý do rõ
  process.env.FILES_GH_DIRECT = 'off';
  const off = await fs.init('u1', { dir: '', name: 'b.pdf', size: 1000, lastModified: 3 });
  assert.ok(!off.ghDirect && /FILES_GH_DIRECT=off/.test(off.directWhy), off.directWhy);
  await assert.rejects(fs.commitBlobs('u1', { ...q, parts: [{ i: 0, sha: sha('a') }] }), /chưa bật/);
  delete process.env.FILES_GH_DIRECT;
  installed = false; app._reset();       // bỏ nhớ Installation ID đã dò
  const noInst = await fs.init('u1', { dir: '', name: 'c.pdf', size: 1000, lastModified: 4 });
  assert.ok(!noInst.ghDirect && /GitHub App/.test(noInst.directWhy), noInst.directWhy);
  installed = true;

  // 7) xoá cấu hình → không còn cấp token
  await cfg.saveConfig({ clear: '1' });
  assert.strictEqual(await app.isConfigured(), false);
  await assert.rejects(app.mintForRepo('o', 'r'), /Chưa cấu hình GitHub App/);

  // 8) dự phòng .env (nội dung .pem 1 dòng) vẫn dùng được khi chưa nhập ở /connect
  process.env.GITHUB_APP_ID = '12345'; process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, '\\n');
  assert.strictEqual(await app.isConfigured(), true);
  assert.strictEqual((await app.mintForRepo('o', 'r')).token, 'ghs_TAM_1h');

  console.log('OK github-app');
  process.exit(0);
})().catch((e) => { console.error('✘', e); process.exit(1); });
