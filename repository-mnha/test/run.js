// test/run.js — chạy lần lượt mọi test/*.js (bỏ file bắt đầu bằng "_" và chính file này), mỗi test một tiến trình riêng.
//   node test/run.js            chạy tất cả
//   node test/run.js html       chỉ test có tên chứa "html"
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'run.js' && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-r', path.join(__dirname, '_stubs.js'), path.join(__dirname, f)], { encoding: 'utf8', timeout: 5 * 60 * 1000, cwd: path.join(__dirname, '..') });
  const ok = r.status === 0;
  console.log(`${ok ? '✔' : '✘'} ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!ok) { failed++; console.log((r.stdout + r.stderr).split('\n').filter((l) => !/GITHUB_/.test(l)).slice(-25).join('\n')); }
}
console.log(failed ? `\n${failed}/${files.length} test LỖI` : `\nTất cả ${files.length} test đạt`);
process.exit(failed ? 1 : 0);
