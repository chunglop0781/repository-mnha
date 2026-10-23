// Test: đổi tên thư mục (1 commit, giữ sha blob), file .txt trắng → dòng gợi ý, đọc file rỗng không còn lỗi 500
const Module = require('module'); const orig = Module._load;
const files = new Map();      // path -> Buffer
const shaOf = (b) => 'sha:' + b.toString('hex');
let commits = [];
const gh = {
  getRepoTree: async () => ({ truncated: false, files: new Map([...files].map(([k, v]) => [k, shaOf(v)])) }),
  writeBinaryFile: async (p, b) => { files.set(p, b); },
  readBinaryFile: async (p) => (files.has(p) ? files.get(p) : null),
  writeJsonFile: async () => { },
  readJsonFile: async () => null,
  deleteFile: async (p) => { files.delete(p); },
  commitFiles: async (changes) => {
    commits.push(changes);
    const byHex = new Map([...files].map(([k, v]) => [shaOf(v), v]));
    for (const c of changes) if (c.remove) files.delete(c.path);
    for (const c of changes) if (!c.remove) files.set(c.path, byHex.get(c.sha) || Buffer.from(''));
  }
};
Module._load = function (r, ...a) { if (/githubService$/.test(r)) return gh; return orig.call(this, r, ...a); };
const assert = require('assert');
const store = require('../services/code/codeStore');
const { EMPTY_TXT_PLACEHOLDER } = require('../config/codeConfig');

(async () => {
  const uid = 'u1', R = 'u1/codes/cpp/';
  // --- .txt trắng → dòng gợi ý (ghi + hiển thị); .cpp trắng giữ nguyên
  await store.writeFile(uid, 'cpp', 'bai1', 'input2.txt', '');
  assert.strictEqual(files.get(R + 'bai1/input2.txt').toString(), EMPTY_TXT_PLACEHOLDER);
  assert.strictEqual(EMPTY_TXT_PLACEHOLDER, '\nhap-du-lieu-input-vao-day');
  await store.writeFile(uid, 'cpp', 'bai1', 'input3.txt', '  \n ');
  assert.strictEqual(files.get(R + 'bai1/input3.txt').toString(), EMPTY_TXT_PLACEHOLDER);
  await store.writeFile(uid, 'cpp', 'bai1', 'input.txt', '5 6\n');
  assert.strictEqual(files.get(R + 'bai1/input.txt').toString(), '5 6\n');
  await store.writeFile(uid, 'cpp', 'bai1', 'output.txt', '', { placeholder: false });         // file chương trình ghi ra: giữ trắng
  assert.strictEqual(files.get(R + 'bai1/output.txt').length, 0);
  assert.strictEqual(store.displayText('output.txt', ''), EMPTY_TXT_PLACEHOLDER);               // file rỗng cũ (gây 500 trước đây) → hiện gợi ý khi mở
  assert.strictEqual(store.displayText('a.cpp', ''), '');
  assert.strictEqual(store.displayText('a.txt', '1 2'), '1 2');
  // đọc file rỗng không ném lỗi
  assert.strictEqual(await store.readFile(uid, 'cpp', 'bai1', 'output.txt'), '');
  // siblings: file chỉ có dòng gợi ý được nạp như file RỖNG
  const sib = await store.siblingTextFiles(uid, 'cpp', 'bai1');
  const byName = Object.fromEntries(sib.map((x) => [x.name, x.content]));
  assert.strictEqual(byName['input2.txt'], ''); assert.strictEqual(byName['input.txt'], '5 6\n');
  console.log('placeholder OK');

  // --- đổi tên thư mục
  await store.mkdir(uid, 'cpp', 'bai1', 'con');
  await store.writeFile(uid, 'cpp', 'bai1/con', 'a.cpp', 'int x;');
  await store.writeFile(uid, 'cpp', 'bai2', 'z.cpp', 'z');
  const r = await store.renameFolder(uid, 'cpp', 'bai1', 'bai_moi');
  assert.strictEqual(r.dir, 'bai_moi'); assert(r.moved >= 5);
  assert(!files.has(R + 'bai1/input.txt') && files.get(R + 'bai_moi/input.txt').toString() === '5 6\n');
  assert.strictEqual(files.get(R + 'bai_moi/con/a.cpp').toString(), 'int x;');
  assert(files.has(R + 'bai_moi/con/.keep'));
  assert(![...files.keys()].some((k) => k.startsWith(R + 'bai1/')));
  assert.strictEqual(commits.length, 1);                                                       // đúng 1 commit
  // đổi tên thư mục lồng nhau: chỉ đổi đoạn cuối
  const r2 = await store.renameFolder(uid, 'cpp', 'bai_moi/con', 'cap2');
  assert.strictEqual(r2.dir, 'bai_moi/cap2'); assert(files.has(R + 'bai_moi/cap2/a.cpp'));
  // lỗi
  await assert.rejects(() => store.renameFolder(uid, 'cpp', 'bai_moi', 'bai2'), /Đã có thư mục/);
  await assert.rejects(() => store.renameFolder(uid, 'cpp', 'bai_moi', '../x'), /Tên thư mục/);
  await assert.rejects(() => store.renameFolder(uid, 'cpp', 'bai_moi', 'a b'), /Tên thư mục/);
  await assert.rejects(() => store.renameFolder(uid, 'cpp', '', 'x'), /thư mục gốc/);
  await assert.rejects(() => store.renameFolder(uid, 'cpp', 'khong_co', 'x'), /Không tìm thấy/);
  await assert.rejects(() => store.renameFolder(uid, 'html', 'a', '_media'), /dành riêng/);
  assert.strictEqual((await store.renameFolder(uid, 'cpp', 'bai2', 'bai2')).moved, 0);       // cùng tên: không làm gì
  // 'abc' → 'abcd' không bị nhầm là trùng tiền tố
  await store.mkdir(uid, 'cpp', '', 'abc'); await store.mkdir(uid, 'cpp', '', 'abcd2');
  assert.strictEqual((await store.renameFolder(uid, 'cpp', 'abc', 'abcd')).dir, 'abcd');
  // link chia sẻ thư mục
  process.env.GITHUB_OWNER = 'o'; // (nếu chưa cấu hình thì trả null — không bắt buộc)
  const u = store.githubFolderUrl(uid, 'cpp', 'bai_moi/cap2');
  assert(u === null || /\/tree\/[^/]+\/u1\/codes\/cpp\/bai_moi\/cap2$/.test(u), u);
  // --- đổi tên file
  await store.writeFile(uid, 'cpp', 'bai_moi', 'a.cpp', 'int main(){}');
  assert.strictEqual((await store.renameFile(uid, 'cpp', 'bai_moi', 'a.cpp', 'b')).file, 'b.cpp');         // không gõ đuôi → giữ đuôi cũ
  assert(!files.has(R + 'bai_moi/a.cpp') && files.get(R + 'bai_moi/b.cpp').toString() === 'int main(){}');
  await assert.rejects(() => store.renameFile(uid, 'cpp', 'bai_moi', 'b.cpp', 'input.txt'), /Đã có file/);
  await assert.rejects(() => store.renameFile(uid, 'cpp', 'bai_moi', 'b.cpp', '../x.cpp'), /Tên file/);
  await assert.rejects(() => store.renameFile(uid, 'cpp', 'bai_moi', 'zzz.cpp', 'y'), /Không tìm thấy/);
  assert.strictEqual((await store.renameFile(uid, 'cpp', 'bai_moi', 'b.cpp', 'b.cpp')).moved, 0);
  console.log('renameFile OK');
  console.log('renameFolder OK');
})().catch((e) => { console.error(e); process.exit(1); });
