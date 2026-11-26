// test/files-tree-zip.js — tải THƯ MỤC MẸ thành .zip: cây gồm mọi thư mục con (kể cả thư mục mẹ không có file trực tiếp, thư mục rỗng) + zip giữ cấu trúc
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const files = new Map();
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async writeBinaryFile(p, b) { files.set(p, b); }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };
const fs = require(R + 'services/code/fileStore');
const { FILES } = require(R + 'config/codeConfig');
const man = (dir, obj, extra) => files.set(fs.manifestPath('u1', dir ? dir.split('/') : []), Buffer.from(JSON.stringify({ v: 1, files: obj, ...(extra || {}) })));
const ent = (name, pub) => ({ name, id: name, size: 5, kind: 'word', public: pub, state: 'done' });
(async () => {
  // gốc: không có file; a/ : không có file trực tiếp; a/b : 1 file; a/c : rỗng (chỉ .keep); d : 1 file riêng tư + 1 công khai
  man('', {}, { shared: true });
  man('a/b', { 'x.docx': ent('x.docx', true) });
  man('d', { 'p.docx': ent('p.docx', false), 'q.docx': ent('q.docx', true) });
  files.set(fs.manifestPath('u1', ['a', 'c']).replace(FILES.MANIFEST, FILES.KEEP || '.keep'), Buffer.from(''));
  files.set('x/ignored-data', Buffer.from(''));
  const t = await fs.tree('u1', '');
  assert.deepStrictEqual(t.files.map((f) => f.dir + '/' + f.name), ['a/b/x.docx', 'd/p.docx', 'd/q.docx']);   // thư mục mẹ "a" không có file trực tiếp vẫn lấy được file con
  assert.ok(t.folders.includes('a') && t.folders.includes('a/b') && t.folders.includes('a/c'));
  assert.deepStrictEqual(t.emptyDirs, ['a/c']);
  const sub = await fs.tree('u1', 'a');
  assert.deepStrictEqual(sub.files.map((f) => f.dir + '/' + f.name), ['b/x.docx']);
  const pub = await fs.publicTree('u1', '');
  assert.deepStrictEqual(pub.files.map((f) => f.dir + '/' + f.name), ['a/b/x.docx', 'd/q.docx']);               // chỉ file công khai
  files.delete(fs.manifestPath('u1', []));
  await assert.rejects(fs.publicTree('u1', 'a'), /không được chia sẻ/);                                          // chưa chia sẻ → 404

  // zip phía trình duyệt: giữ đường dẫn, thư mục gốc, thư mục rỗng
  global.window = global; global.self = global;
  const Z = require(R + 'public/js/mnhaFiles.js');
  global.MnhaZip = { zip: (e) => e };
  const r = await Z.zipAll([{ name: 'x.docx', dir: 'a/b' }, { name: 'x.docx', dir: 'd' }, { name: 'x.docx', dir: 'd' }], async () => ({ blob: new Blob(['hello']) }), { root: 'goc', emptyDirs: ['a/c'] });
  assert.deepStrictEqual(r.blob.map((e) => e.name), ['goc/', 'goc/a/b/x.docx', 'goc/d/x.docx', 'goc/d/x (2).docx', 'goc/a/c/']);
  assert.strictEqual(r.count, 3);
  console.log('files-tree-zip: đạt');
})().catch((e) => { console.error(e); process.exit(1); });
