// Test: tải file văn bản lên thư mục (trùng tên → ghi đè, 1 commit/lô, lọc tên/đuôi/nhị phân/quá lớn) + zip phía trình duyệt
const Module = require('module'); const orig = Module._load;
const files = new Map(); const commits = [];
const gh = {
  getRepoTree: async () => ({ files: new Map([...files.keys()].map((k) => [k, 'x'])) }),
  writeBinaryFile: async (p, b) => { files.set(p, b); },
  readBinaryFile: async (p) => files.get(p) || null,
  commitFiles: async (ch, msg) => { commits.push({ n: ch.length, msg }); for (const c of ch) files.set(c.path, c.content); },
  deleteFile: async (p) => { files.delete(p); },
};
Module._load = function (r, ...a) { if (/githubService$/.test(r)) return gh; return orig.call(this, r, ...a); };
const assert = require('assert');
const store = require('../services/code/codeStore');
(async () => {
  const uid = 'u1', P = 'u1/codes/cpp/';
  files.set(P + 'bai1.cpp', Buffer.from('cu'));
  // 1) tải lên: file mới + file trùng tên (ghi đè) trong 1 commit; file xấu bị bỏ qua
  const r = await store.saveUploads(uid, 'cpp', 'Bai(1)', [
    { name: 'bai1.cpp', content: 'int main(){}' }, { name: 'input.txt', content: '1 2\n' }, { name: 'ham.HPP', content: '#pragma once' },
    { name: 'blank.txt', content: '' }, { name: 'anh.png', content: 'x' }, { name: 'khong-duoi', content: 'x' },
    { name: '../evil.cpp', content: 'x' }, { name: 'bin.cpp', content: 'a\u0000b' }, { name: 'to.cpp', content: 'a'.repeat(300 * 1024) }, { name: 'sai.cpp', content: 5 }
  ]);
  assert.deepStrictEqual(r.saved.sort(), ['bai1.cpp', 'blank.txt', 'ham.hpp', 'input.txt']);
  assert.strictEqual(r.skipped.length, 6);
  assert.strictEqual(commits.length, 1); assert.strictEqual(commits[0].n, 4);
  assert.strictEqual(files.get(P + 'Bai(1)/input.txt').toString(), '1 2\n');
  assert.notStrictEqual(files.get(P + 'Bai(1)/blank.txt').toString(), '');      // .txt trắng → dòng gợi ý như file mới tạo
  assert.deepStrictEqual(r.overwritten, []);
  // 2) tải lại cùng tên → ghi đè bản cũ và báo overwritten
  const r2 = await store.saveUploads(uid, 'cpp', 'Bai(1)', [{ name: 'bai1.cpp', content: 'moi' }, { name: 'bai1.cpp', content: 'moi nhat' }]);
  assert.deepStrictEqual(r2.saved, ['bai1.cpp']); assert.deepStrictEqual(r2.overwritten, ['bai1.cpp']);
  assert.strictEqual(files.get(P + 'Bai(1)/bai1.cpp').toString(), 'moi nhat');      // trùng tên trong lô: file sau đè file trước
  // 3) lỗi toàn lô
  await assert.rejects(() => store.saveUploads(uid, 'cpp', '', []), /Chưa chọn/);
  await assert.rejects(() => store.saveUploads(uid, 'cpp', '../x', [{ name: 'a.cpp', content: '' }]));
  await assert.rejects(() => store.saveUploads(uid, 'cpp', '', Array.from({ length: 41 }, (_, i) => ({ name: 'f' + i + '.cpp', content: '' }))), /tối đa 40/);
  // 4) emu8086 chỉ nhận .asm
  const r3 = await store.saveUploads(uid, 'emu8086', '', [{ name: 'a.asm', content: 'nop' }, { name: 'b.cpp', content: 'x' }]);
  assert.deepStrictEqual(r3.saved, ['a.asm']); assert.strictEqual(r3.skipped.length, 1);
  console.log('saveUploads OK');

  // 5) zip phía trình duyệt: bóc hàm zip() từ textTransfer.js và kiểm tra bằng unzip
  const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
  const src = fs.readFileSync(path.join(__dirname, '../public/js/zipKit.js'), 'utf8');
  const a = src.indexOf('var crcT = null;'), b = src.indexOf('function save');
  const zip = new Function(src.slice(a, b) + '; return zip;')();
  const enc = new TextEncoder();
  const blob = zip([{ name: 'a.cpp', data: enc.encode('int main(){}\n') }, { name: 'input 1.txt', data: enc.encode('xin chào\n') }]);
  const tmp = path.join(os.tmpdir(), 'tt-' + process.pid + '.zip'); fs.writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()));
  try {
    assert.strictEqual(cp.execSync(`unzip -p "${tmp}" "input 1.txt"`).toString(), 'xin chào\n');
    assert.strictEqual(cp.execSync(`unzip -p "${tmp}" a.cpp`).toString(), 'int main(){}\n');
    cp.execSync(`unzip -tq "${tmp}"`);
    console.log('zip OK');
  } catch (e) { if (/unzip/.test(String(e.message)) && /not found|ENOENT/.test(String(e.message))) console.log('Bỏ qua kiểm tra zip (máy không có unzip)'); else throw e; }
  finally { fs.unlinkSync(tmp); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
