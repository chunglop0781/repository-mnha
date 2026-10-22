// Test: chạy code "xem trên mạng" → file chương trình ghi ra (output.txt...) tự lưu vào codes/cpp/tren-mang/
const Module = require('module'); const orig = Module._load;
const files = new Map();
const gh = {
  getRepoTree: async () => ({ files: new Map([...files.keys()].map((k) => [k, 'x'])) }),
  writeBinaryFile: async (p, b) => { files.set(p, b); },
  readBinaryFile: async (p) => files.get(p) || null,
  writeJsonFile: async (p, d) => { files.set(p, Buffer.from(JSON.stringify(d))); },
  readJsonFile: async (p) => files.has(p) ? JSON.parse(files.get(p)) : null,
  deleteFile: async (p) => { files.delete(p); },
};
Module._load = function (r, ...a) { if (/githubService$/.test(r)) return gh; return orig.call(this, r, ...a); };
const assert = require('assert');
const store = require('../services/code/codeStore');
const sm = require('../services/code/sessionManager');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const uid = 'u1', P = 'u1/codes/cpp/tren-mang/';
  // 1) saveOnlineOutputs: chỉ file mới/đã đổi, tên xấu & file quá lớn bị bỏ qua, không ném lỗi
  const r = await store.saveOnlineOutputs(uid, 'cpp', {
    'output.txt': { content: '11\n', isNew: true, changed: true },
    'input.txt': { content: '5 6\n', isNew: false, changed: false },
    '../evil.txt': { content: 'x', isNew: true },
    'big.txt': { content: 'a'.repeat(300 * 1024), isNew: true },
    'input1.cpp': { content: 'data', isNew: true }
  });
  assert.deepStrictEqual(r.saved.sort(), ['tren-mang/input1.cpp', 'tren-mang/output.txt']);
  assert.strictEqual(r.skipped.length, 2);
  assert.strictEqual(files.get(P + 'output.txt').toString(), '11\n');
  assert(!files.has(P + 'input.txt'));
  assert((await store.list(uid, 'cpp', '')).folders.includes('tren-mang'));
  assert.deepStrictEqual(await store.saveOnlineOutputs(uid, 'cpp', null), { saved: [], skipped: [] });
  console.log('saveOnlineOutputs OK');

  // 2) phiên chạy thật (cần g++): có origin → tự lưu; không origin (code của tôi) → KHÔNG tự lưu
  let hasGpp = true; try { require('child_process').execSync('g++ --version', { stdio: 'ignore' }); } catch (_) { hasGpp = false; }
  if (!hasGpp) return console.log('Bỏ qua phần chạy g++ (máy không có g++)');
  const code = '#include <bits/stdc++.h>\nint main(){freopen("input.txt","r",stdin);freopen("output.txt","w",stdout);int a,b;std::cin>>a>>b;std::cout<<a+b;}';
  const siblingFiles = [{ name: 'input.txt', content: '5 6\n' }];
  let s = await sm.create({ uid, lang: 'cpp', code, file: 'bai1.cpp', dir: '', siblingFiles, origin: 'https://github.com/a/b/blob/main/bai1.cpp' });
  while (s.impl.status !== 'finished') await sleep(100); await sleep(300);
  assert.deepStrictEqual(s.autoSaved.saved, ['tren-mang/output.txt']);
  assert.strictEqual(files.get(P + 'output.txt').toString(), '11');
  assert.deepStrictEqual(JSON.parse(files.get(s.savedPath)).autoSaved.saved, ['tren-mang/output.txt']);
  files.delete(P + 'output.txt');
  s = await sm.create({ uid, lang: 'cpp', code, file: 'bai1.cpp', dir: '', siblingFiles });
  while (s.impl.status !== 'finished') await sleep(100); await sleep(300);
  assert(!s.autoSaved && !files.has(P + 'output.txt'));
  console.log('session OK (có origin → tự lưu, không origin → không)');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
