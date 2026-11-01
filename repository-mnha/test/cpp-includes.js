// test/cpp-includes.js — C++ #include "x.hpp" cùng thư mục: code của tôi (thư mục GitHub của người dùng) và code xem trên mạng (repo GitHub/GitLab).
//   Chạy: node test/cpp-includes.js   (giả lập GitHub + fetch; nếu máy có g++ thì chạy thật bằng g++ để kiểm tra biên dịch)
const path = require('path'); const assert = require('assert'); const { spawnSync } = require('child_process');
const R = path.join(__dirname, '..') + '/';
const repoFiles = new Map();           // "uid/codes/cpp/<dir>/<file>" → nội dung  (giả lập GitHub của người dùng)
const saved = [];
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map([...repoFiles.keys()].map((k) => [k, 'sha'])), truncated: false }; },
  async readBinaryFile(p) { return repoFiles.has(p) ? Buffer.from(repoFiles.get(p)) : null; },
  async writeJsonFile(p, d) { saved.push(d); }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };
const inc = require(R + 'services/code/includeResolver.js');
const rs = require(R + 'services/code/remoteSource.js');
const store = require(R + 'services/code/codeStore.js');

const MAIN = '#include <iostream>\n#include "DanhSachPhuongTien.hpp"\n#include "util/tien_ich.h"\nusing namespace std;\nint main(){ cout << ds() << " " << tien() << " " << mau() << endl; return 0; }\n';
const FILES = {            // "thư mục PhanA" trong repo / thư mục của người dùng
  'DanhSachPhuongTien.hpp': '#pragma once\n#include "PhuongTien.hpp"\nint ds();\ninline int mau(){ return 7; }\n',
  'DanhSachPhuongTien.cpp': '#include "DanhSachPhuongTien.hpp"\nint ds(){ return 42 + pt(); }\n',      // cài đặt đi kèm .hpp → biên dịch cùng
  'PhuongTien.hpp': '#pragma once\ninline int pt(){ return 1; }\n',
  'util/tien_ich.h': '#pragma once\ninline int tien(){ return 5; }\n',
  'util/tien_ich.cpp': 'int main(){ return 1; }\n',                                                               // có main → KHÔNG biên dịch cùng
};

(async () => {
  // 1) collect
  const read = async (segs) => FILES[segs.join('/')] ?? null;
  const { files, missing } = await inc.collect({ code: MAIN, readFile: read });
  const names = files.map((f) => f.name).sort();
  assert.deepStrictEqual(names, ['DanhSachPhuongTien.cpp', 'DanhSachPhuongTien.hpp', 'PhuongTien.hpp', 'util/tien_ich.h']);
  assert.deepStrictEqual(files.filter((f) => f.unit).map((f) => f.name), ['DanhSachPhuongTien.cpp']);
  assert(files.every((f) => f.src === true)); assert(!names.includes('util/tien_ich.cpp'));
  console.log('✔ collect: header đệ quy, thư mục con, x.cpp đi kèm, bỏ qua .cpp có main');
  assert.deepStrictEqual(inc.resolveInclude([], '../x.hpp'), null);
  assert.deepStrictEqual(inc.resolveInclude(['a'], '../x.hpp'), ['x.hpp']);
  assert.strictEqual(inc.resolveInclude([], 'bits/stdc++.h'), null); assert.strictEqual(inc.resolveInclude([], 'iostream'), null);
  const dn = inc.scanDataNames('freopen("input.txt","r",stdin); ifstream f("in1.cpp"); #include "DanhSachPhuongTien.hpp"', inc.includedNames('#include "in2.cpp"\n'));
  assert.deepStrictEqual(dn, { txt: ['input.txt'], cpp: ['in1.cpp'] });
  console.log('✔ resolveInclude + scanDataNames');

  // 2) code CỦA TÔI: đọc cùng thư mục trong GitHub của người dùng
  for (const [n, c] of Object.entries(FILES)) repoFiles.set('u1/codes/cpp/PhanA/' + n, c);
  repoFiles.set('u1/codes/cpp/PhanA/input.txt', '1 2\n');
  const dir = 'PhanA';
  const own = await inc.collect({ code: MAIN, readFile: (segs) => store.readFile('u1', 'cpp', [...store.cleanDir(dir), ...segs.slice(0, -1)].join('/'), segs[segs.length - 1]).catch(() => null) });
  assert.deepStrictEqual(own.files.map((f) => f.name).sort(), names);
  assert.strictEqual(store.cleanFileName('cpp', 'DanhSachPhuongTien.hpp'), 'DanhSachPhuongTien.hpp');
  console.log('✔ code của tôi: đọc header từ cùng thư mục GitHub của người dùng (đuôi .hpp hợp lệ)');

  // 3) code TRÊN MẠNG (GitHub + GitLab): đọc cùng thư mục trong repo qua raw
  for (const url of ['https://github.com/hoangmanhkhiem/BTL_CTDL_64_002/blob/master/PhanA/main.cpp', 'https://gitlab.com/g/p/-/blob/main/PhanA/main.cpp']) {
    const parsed = rs.parseSourceUrl(url); const asked = [];
    const o = global.fetch;
    global.fetch = async (u) => {
      asked.push(u); const rel = u.split('/PhanA/')[1];
      const body = rel && FILES[rel]; const ok = body != null;
      return { status: ok ? 200 : 404, ok, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/plain' : null) }, body: null, arrayBuffer: async () => Buffer.from(body || '') };
    };
    try {
      const r = await inc.collect({ code: MAIN, readFile: async (segs) => { try { return await rs.fetchText(rs.siblingOf(parsed, segs)); } catch (e) { if (e.status === 404) return null; throw e; } } });
      assert.deepStrictEqual(r.files.map((f) => f.name).sort(), names);
      assert(asked.every((u) => /^https:\/\/(raw\.githubusercontent\.com|gitlab\.com)\//.test(u)));
      assert(asked.some((u) => u.endsWith('/PhanA/DanhSachPhuongTien.hpp')) && asked.some((u) => u.endsWith('/PhanA/util/tien_ich.h')));
    } finally { global.fetch = o; }
  }
  console.log('✔ code trên mạng (GitHub + GitLab): đọc header cùng thư mục trong repo');

  // 4) chạy thật bằng g++ (nếu có)
  if (spawnSync('g++', ['--version']).status !== 0) { console.log('… bỏ qua bước g++ (máy không có g++)'); return process.exit(0); }
  const { CppSession } = require(R + 'services/code/cppRunner.js');
  const s = new CppSession({ code: MAIN, files: own.files });
  s.start();
  for (let i = 0; i < 300 && s.status !== 'finished'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(s.status, 'finished', 'xong'); assert(s.compileOk, 'biên dịch được: ' + (s.compileOutput || s.error));
  assert.strictEqual(s.consoleText.trim(), '43 5 7'); console.log('✔ g++ thật: biên dịch + chạy ra "' + s.consoleText.trim() + '"');
  // header chứa mã bị cấm → từ chối
  const bad = new CppSession({ code: MAIN, files: [{ name: 'DanhSachPhuongTien.hpp', content: 'int ds(){ system("ls"); return 1; }', src: true }] });
  bad.start(); for (let i = 0; i < 50 && bad.status !== 'finished'; i++) await new Promise((r) => setTimeout(r, 50));
  assert(/system\(\)/.test(bad.error || bad.consoleText || ''), 'header bị cấm phải bị chặn: ' + bad.error); console.log('✔ header chứa system() bị chặn như main.cpp');
  process.exit(0);
})().catch((e) => { console.error('✘', e); process.exit(1); });

