// test/html-bigfile.js — html lưu/đọc file lớn hơn 200KB (tối đa 3MB); các dạng code khác vẫn 200KB.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const files = new Map(), blobs = new Map(); let big = 0;
const fakeGh = {
  isConfigured: true,
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, 's'])), truncated: false }; },
  async createBlob(b) { const s = crypto.createHash('sha1').update(b).digest('hex'); blobs.set(s, b); return s; }, async getBlobBuffer(s) { return blobs.get(s) || null; },
  async writeBinaryFile(p, b) { files.set(p, b); }, async writeBinaryFileBig(p, b) { big++; files.set(p, b); },
  async readBinaryFile(p) { return files.get(p) || null; }, async readBinaryFileLarge(p) { return files.get(p) || null; }
};
const gp = R + 'services/githubService.js';
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };
const store = require(R + 'services/code/codeStore');
(async () => {
  const html = '<p>' + 'x'.repeat(1024 * 1024) + '</p>';
  await store.writeFile('u1', 'html', 'Cac_phuong_phap_toi_uu-1-1-26(N02)', 'trang.html', html);
  assert.strictEqual(big, 1, 'file lớn ghi bằng writeBinaryFileBig');
  assert.strictEqual(await store.readFile('u1', 'html', 'Cac_phuong_phap_toi_uu-1-1-26(N02)', 'trang.html'), html);
  await assert.rejects(store.writeFile('u1', 'html', '', 'qua.html', 'y'.repeat(50 * 1024 * 1024 + 1)), /tối đa 50MB/);
  // lưu theo phần (> 4.5MB): 3 phần, ghép đúng, có tiếng Việt/emoji
  const text = ('<p>Xin chào 😀 ' + 'é'.repeat(100) + '</p>\n').repeat(25000);       // ~ 6MB (3 phần ~ 2MB)
  const half = Math.floor(text.length / 3), cut = [text.slice(0, half), text.slice(half, 2 * half), text.slice(2 * half)];
  const id = 'a'.repeat(32), done = [];
  for (let i = 0; i < 3; i++) { const r = await store.putTextPart('u1', 'html', { dir: '', file: 'lon.html', uploadId: id, i, n: 3 }, Buffer.from(cut[i])); done.push({ i, sha: r.sha, size: r.size, receipt: r.receipt }); }
  await assert.rejects(store.finishText('u1', 'html', { dir: '', file: 'lon.html', uploadId: id, parts: [{ ...done[0], receipt: 'x'.repeat(40) }, done[1], done[2]] }), /Biên nhận/);
  await assert.rejects(store.finishText('u1', 'html', { dir: '', file: 'khac.html', uploadId: id, parts: done }), /Biên nhận/);
  const out = await store.finishText('u1', 'html', { dir: '', file: 'lon.html', uploadId: id, parts: done });
  assert(out.ok && out.size > 4.5 * 1024 * 1024);
  assert.strictEqual(await store.readFile('u1', 'html', '', 'lon.html'), text);
  await assert.rejects(store.writeFile('u1', 'cpp', '', 'a.cpp', 'z'.repeat(200 * 1024 + 1)), /tối đa 200KB/);
  console.log('OK html-bigfile');
})().catch((e) => { console.error('✘', e); process.exit(1); });
