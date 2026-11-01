// test/files-store.js — "Lưu trữ file": chỉ nhận Office/PDF/ảnh, chia phần, mã hoá, làm tiếp, thay file, xoá, tải về, xoay repo.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const files = new Map(), repoOf = new Map(), sha = new Map();
let written = 0;
const fakeGh = {
  isConfigured: true,
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, sha.get(k) || 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async readJsonFileWithSha(p) { return files.has(p) ? { data: JSON.parse(files.get(p).toString()), sha: sha.get(p) } : null; },
  async writeJsonFileIfSha(p, d, s) { if ((files.has(p) ? sha.get(p) : null) !== (s || null)) throw Object.assign(new Error('conflict'), { code: 'SHA_CONFLICT' }); files.set(p, Buffer.from(JSON.stringify(d))); sha.set(p, crypto.randomBytes(4).toString('hex')); repoOf.set(p, 'main'); },
  async writeBinaryFile(p, b) { files.set(p, b); repoOf.set(p, 'main'); },
  async writeBinaryFileBig(p, b) { files.set(p, b); written += b.length; repoOf.set(p, written > 9 * 1024 * 1024 ? 'db-1' : 'db'); },   // giả lập: > 9MB thì sang repo kế
  async readBinaryFileLarge(p) { return files.get(p) || null; },
  async commitFiles(ch) { for (const c of ch) if (c.remove) { files.delete(c.path); sha.delete(c.path); } },
  async repoFor(p) { return { repo: repoOf.get(p) || 'main' }; }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };
const fs = require(R + 'services/code/fileStore');
const { FILES } = require(R + 'config/codeConfig');
const PART = FILES.PART_BYTES;

async function upload(uid, dir, name, buf, lastModified, skipParts = []) {
  const init = await fs.init(uid, { dir, name, size: buf.length, lastModified });
  const n = init.n;
  for (let i = 0; i < n; i++) {
    if (init.have.includes(i) || skipParts.includes(i)) continue;
    await fs.putPart(uid, { dir, name: init.name, uploadId: init.uploadId, i, n }, buf.subarray(i * PART, (i + 1) * PART));
  }
  return { init, n };
}
async function download(uid, dir, name) {
  const o = await fs.open(uid, dir, name); const out = [];
  for (let i = 0; i < o.parts; i++) out.push(await o.readPart(i));
  return Buffer.concat(out);
}

(async () => {
  // 1) đuôi được nhận / bị từ chối
  for (const ok of ['a.docx', 'Báo cáo tháng 10.DOCX', 'b.xlsx', 'c.pptx', 'd.pdf', 'e.png', 'f.vsdx']) assert.doesNotThrow(() => fs.cleanName(ok), ok);
  for (const no of ['a.exe', 'b.js', 'c.html', 'd.zip', 'e.txt', 'f.svg', 'g', '.docx', 'a:b.docx', 'mnha-files.json']) assert.throws(() => fs.cleanName(no), no);
  assert.throws(() => fs.cleanDir('_data'), /dành riêng/);
  assert.throws(() => fs.cleanDir('../x'), /Tên thư mục/);
  await assert.rejects(fs.init('u1', { dir: '', name: 'a.docx', size: FILES.MAX_FILE_BYTES + 1 }), /quá lớn/);
  await assert.rejects(fs.init('u1', { dir: '', name: 'a.docx', size: 0 }), /không hợp lệ/);

  // 2) file nhẹ = 1 phần, mã hoá (không lộ nội dung gốc)
  const small = crypto.randomBytes(100 * 1024);
  const r1 = await upload('u1', '', 'Báo cáo.docx', small, 111);
  assert.strictEqual(r1.n, 1);
  const f1 = await fs.finish('u1', { dir: '', name: 'Báo cáo.docx', uploadId: r1.init.uploadId, size: small.length, lastModified: 111 });
  assert.strictEqual(f1.parts, 1);
  const stored = [...files.entries()].find(([k]) => k.endsWith('/_data/' + r1.init.uploadId + '/0001.bin'));
  assert(stored, 'phần nằm ở _data/<mã>/0001.bin');
  assert(!stored[1].includes(small.subarray(0, 64)), 'phần đã mã hoá, không chứa bản rõ');
  assert(download('u1', '', 'Báo cáo.docx') instanceof Promise);
  assert(small.equals(await download('u1', '', 'Báo cáo.docx')));

  // 3) file nặng: chia nhiều phần, đúng thứ tự, trải qua nhiều repo, tải về khớp từng byte
  const big = crypto.randomBytes(PART * 3 + 12345);        // 4 phần
  const r2 = await upload('u1', 'tai-lieu', 'Bai giang.pptx', big, 222);
  assert.strictEqual(r2.n, 4);
  const f2 = await fs.finish('u1', { dir: 'tai-lieu', name: 'Bai giang.pptx', uploadId: r2.init.uploadId, size: big.length, lastModified: 222 });
  assert.strictEqual(f2.parts, 4);
  assert(f2.repos.length >= 2, 'các phần sang repo kế khi repo đầy: ' + f2.repos);
  const m = await fs.readManifest('u1', ['tai-lieu']);
  const e = m.files['Bai giang.pptx'];
  assert.deepStrictEqual(e.parts.map((x) => x.i), [0, 1, 2, 3]);
  assert.strictEqual(e.parts[3].size, 12345);
  assert.strictEqual(e.parts[0].repo, 'db', 'phần đầu ở repo đang dùng trước');
  assert.strictEqual(e.parts[3].repo, 'db-1', 'phần sau ở repo tạo sau');
  assert(big.equals(await download('u1', 'tai-lieu', 'Bai giang.pptx')));

  // 4) làm tiếp khi đứt giữa chừng: chỉ gửi các phần còn thiếu
  const big2 = crypto.randomBytes(PART * 2 + 10);
  await upload('u1', '', 'Dang do.pdf', big2, 333, [2]);            // thiếu phần cuối
  await assert.rejects(fs.finish('u1', { dir: '', name: 'Dang do.pdf', uploadId: fs.uploadIdFor('u1', [], 'Dang do.pdf', big2.length, 333), size: big2.length, lastModified: 333 }), /Thiếu phần 3\/3/);
  const re = await fs.init('u1', { dir: '', name: 'Dang do.pdf', size: big2.length, lastModified: 333 });
  assert.deepStrictEqual(re.have, [0, 1]);
  await fs.putPart('u1', { dir: '', name: 'Dang do.pdf', uploadId: re.uploadId, i: 2, n: 3 }, big2.subarray(2 * PART));
  await fs.finish('u1', { dir: '', name: 'Dang do.pdf', uploadId: re.uploadId, size: big2.length, lastModified: 333 });
  assert(big2.equals(await download('u1', '', 'Dang do.pdf')));

  // 5) chống gian lận: sai mã tải lên / sai kích thước / phần sai cỡ / phần quá lớn
  await assert.rejects(fs.finish('u1', { dir: '', name: 'x.pdf', uploadId: 'a'.repeat(32), size: 10, lastModified: 1 }), /không khớp/);
  await assert.rejects(fs.putPart('u1', { dir: '', name: 'x.pdf', uploadId: 'zz', i: 0, n: 1 }, Buffer.from('a')), /Mã tải lên/);
  await assert.rejects(fs.putPart('u1', { dir: '', name: 'x.pdf', uploadId: 'a'.repeat(32), i: 0, n: 2 }, Buffer.alloc(10)), /đủ/);
  await assert.rejects(fs.putPart('u1', { dir: '', name: 'x.pdf', uploadId: 'a'.repeat(32), i: 0, n: 1 }, Buffer.alloc(PART + 1)), /quá lớn/);
  await assert.rejects(fs.putPart('u1', { dir: '', name: 'x.exe', uploadId: 'a'.repeat(32), i: 0, n: 1 }, Buffer.alloc(5)), /không được nhận/);

  // 6) ghi đè cùng tên: bản cũ bị dọn
  const before = [...files.keys()].filter((k) => k.includes('/_data/')).length;
  const small2 = crypto.randomBytes(5000);
  const r3 = await upload('u1', '', 'Báo cáo.docx', small2, 444);
  assert.strictEqual((await fs.init('u1', { dir: '', name: 'Báo cáo.docx', size: small2.length, lastModified: 444 })).exists, true);
  await fs.finish('u1', { dir: '', name: 'Báo cáo.docx', uploadId: r3.init.uploadId, size: small2.length, lastModified: 444 });
  assert.strictEqual([...files.keys()].filter((k) => k.includes('/_data/')).length, before, 'phần của bản cũ đã xoá, thêm 1 phần mới');
  assert(small2.equals(await download('u1', '', 'Báo cáo.docx')));

  // 7) danh sách: file theo tên, thư mục, ẩn _data
  const ls = await fs.list('u1', '');
  assert.deepStrictEqual(ls.folders, ['tai-lieu']);
  assert.deepStrictEqual(ls.files.map((x) => x.name).sort(), ['Báo cáo.docx', 'Dang do.pdf']);
  assert(!ls.folders.includes('_data'));
  const lt = await fs.list('u1', 'tai-lieu');
  assert.strictEqual(lt.files[0].parts, 4); assert.deepStrictEqual(lt.files[0].repos, ['db', 'db-1']);

  // 8) đổi tên (giữ đuôi), xoá file, xoá thư mục, tạo thư mục
  await fs.rename('u1', '', 'Dang do.pdf', 'Hop dong.pdf');
  assert(big2.equals(await download('u1', '', 'Hop dong.pdf')));
  await assert.rejects(fs.rename('u1', '', 'Hop dong.pdf', 'Hop dong.docx'), /đuôi/);
  const tr = await upload('u1', '', 'Trung.pdf', Buffer.alloc(50, 7), 555);
  await fs.finish('u1', { dir: '', name: 'Trung.pdf', uploadId: tr.init.uploadId, size: 50, lastModified: 555 });
  await assert.rejects(fs.rename('u1', '', 'Hop dong.pdf', 'Trung.pdf'), /Đã có/);
  await fs.remove('u1', '', 'Trung.pdf');
  await fs.remove('u1', '', 'Hop dong.pdf');
  await assert.rejects(download('u1', '', 'Hop dong.pdf'), /Không tìm thấy/);
  await fs.mkdir('u1', 'tai-lieu', 'con');
  assert.deepStrictEqual((await fs.list('u1', 'tai-lieu')).folders, ['con']);
  await fs.removeFolder('u1', 'tai-lieu');
  assert.deepStrictEqual((await fs.list('u1', '')).folders, []);
  assert([...files.keys()].every((k) => !k.includes('tai-lieu')), 'xoá thư mục xoá cả các phần');

  // 9) phiếu tải về
  const t = fs.signDownload('u1', '', 'Báo cáo.docx');
  assert.deepStrictEqual(fs.verifyDownload(t), { uid: 'u1', dir: '', name: 'Báo cáo.docx' });
  assert.strictEqual(fs.verifyDownload(t.slice(0, -2) + 'xx'), null);
  assert.strictEqual(fs.verifyDownload(fs.signDownload('u1', '', 'Báo cáo.docx', -1)), null);
  assert.strictEqual(fs.verifyDownload('x.y'), null);
  console.log('OK files-store');
})().catch((e) => { console.error('✘', e); process.exit(1); });
