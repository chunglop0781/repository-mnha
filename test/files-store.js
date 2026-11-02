// test/files-store.js — "Lưu trữ file": chỉ nhận Office/PDF/ảnh, chia phần, mã hoá, làm tiếp, thay file, xoá, tải về, xoay repo.
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const files = new Map(), repoOf = new Map(), sha = new Map();
let written = 0;
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map([...files.keys()].map((k) => [k, sha.get(k) || 's'])), truncated: false }; },
  async readJsonFile(p) { return files.has(p) ? JSON.parse(files.get(p).toString()) : null; },
  async readJsonFileWithSha(p) { return files.has(p) ? { data: JSON.parse(files.get(p).toString()), sha: sha.get(p) } : null; },
  async writeJsonFileIfSha(p, d, s) { if ((files.has(p) ? sha.get(p) : null) !== (s || null)) throw Object.assign(new Error('conflict'), { code: 'SHA_CONFLICT' }); files.set(p, Buffer.from(JSON.stringify(d))); sha.set(p, crypto.randomBytes(4).toString('hex')); repoOf.set(p, 'main'); },
  async writeBinaryFile(p, b) { files.set(p, b); repoOf.set(p, 'main'); },
  async writeBinaryFileBig(p, b) { files.set(p, b); written += b.length; repoOf.set(p, written > 9 * 1024 * 1024 ? 'db-1' : 'db'); },   // giả lập: > 9MB thì sang repo kế
  async readBinaryFileLarge(p) { return files.get(p) || null; },
  async commitFiles(ch) { for (const c of ch) if (c.remove) { files.delete(c.path); sha.delete(c.path); } },
  async repoFor(p) { return { repo: repoOf.get(p) || 'main' }; },
  repoForSync(p) { const k = repoOf.get(p) || 'main'; return { owner: 'o', repo: k === 'db-1' ? 'r-1' : k === 'db-2' ? 'r-2' : 'r', branch: 'main' }; }
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
  for (const ok of ['ghi chu.txt', 'NOTE.TXT', 'a.docx', 'Báo cáo tháng 10.DOCX', 'b.xlsx', 'c.pptx', 'd.pdf', 'e.png', 'f.vsdx']) assert.doesNotThrow(() => fs.cleanName(ok), ok);
  for (const no of ['a.exe', 'b.js', 'c.html', 'd.zip', 'e.md', 'f.svg', 'g.csv', 'h.html', 'g', '.docx', 'a:b.docx', 'mnha-files.json']) assert.throws(() => fs.cleanName(no), no);
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

  // 10) công khai / riêng tư: mặc định riêng tư; bật lẻ từng file; bật cả thư mục; thay file giữ chế độ; riêng tư → 404
  const pubData = crypto.randomBytes(2000), pubData2 = crypto.randomBytes(3000);
  for (const [n, b, lm] of [['Slide 1.pptx', pubData, 901], ['Slide 2.pptx', pubData2, 902]]) {
    const up = await upload('u1', 'chia-se', n, b, lm);
    await fs.finish('u1', { dir: 'chia-se', name: n, uploadId: up.init.uploadId, size: b.length, lastModified: lm });
  }
  assert((await fs.list('u1', 'chia-se')).files.every((f) => f.public === false), 'mặc định riêng tư');
  await assert.rejects(fs.openPublic('u1', 'chia-se', 'Slide 1.pptx'), /không công khai/);
  assert.strictEqual((await fs.setVisibility('u1', 'chia-se', 'Slide 1.pptx', true)).changed, 1);
  const o = await fs.openPublic('u1', 'chia-se', 'Slide 1.pptx');
  assert(pubData.equals(await o.readPart(0)));
  await assert.rejects(fs.openPublic('u1', 'chia-se', 'Slide 2.pptx'), /không công khai/, 'file kia vẫn riêng tư');
  await assert.rejects(fs.openPublic('u1', 'chia-se', 'khong-co.pptx'), /không công khai/, 'không lộ file có tồn tại hay không');
  await assert.rejects(fs.openPublic('../x', 'chia-se', 'Slide 1.pptx'), /không công khai/);
  await assert.rejects(fs.openPublic('u1', '_data', 'Slide 1.pptx'), /không công khai/);
  assert.strictEqual((await fs.setVisibility('u1', 'chia-se', null, true)).changed, 1, 'bật cả thư mục: chỉ đổi file chưa công khai');
  await assert.rejects(fs.setVisibility('u1', 'chia-se', 'khong-co.pptx', true), /Không tìm thấy/);
  const rep = crypto.randomBytes(1500);
  const up2 = await upload('u1', 'chia-se', 'Slide 1.pptx', rep, 903);
  await fs.finish('u1', { dir: 'chia-se', name: 'Slide 1.pptx', uploadId: up2.init.uploadId, size: rep.length, lastModified: 903 });
  assert.strictEqual((await fs.list('u1', 'chia-se')).files.find((f) => f.name === 'Slide 1.pptx').public, true, 'ghi đè giữ chế độ công khai');
  assert((await (await fs.openPublic('u1', 'chia-se', 'Slide 1.pptx')).readPart(0)).equals(rep));
  assert.strictEqual((await fs.setVisibility('u1', 'chia-se', null, false)).changed, 2);
  await assert.rejects(fs.openPublic('u1', 'chia-se', 'Slide 1.pptx'), /không công khai/, 'tắt → không xem được nữa');
  // người dùng khác không xem được file riêng của mình qua uid khác
  await assert.rejects(fs.openPublic('u2', 'chia-se', 'Slide 1.pptx'), /không công khai/);

  // 11) tìm kiếm: không phân biệt hoa thường / dấu tiếng Việt, mọi thư mục, kèm thư mục
  const s1 = await fs.search('u1', 'bao cao');
  assert(s1.files.some((f) => f.name === 'Báo cáo.docx' && f.dir === ''), 'tìm "bao cao" ra "Báo cáo.docx"');
  const s2 = await fs.search('u1', 'SLIDE');
  assert.deepStrictEqual(s2.files.map((f) => f.dir + '/' + f.name), ['chia-se/Slide 1.pptx', 'chia-se/Slide 2.pptx']);
  assert.deepStrictEqual((await fs.search('u1', 'chia')).folders, ['chia-se']);
  assert.deepStrictEqual((await fs.search('u1', 'khong-co-gi-het')).files, []);
  await assert.rejects(fs.search('u1', '  '), /từ khoá/);
  assert.strictEqual(fs.fold('Đỗ Văn ĐẠT'), 'do van dat');

  // 12) GIẢI MÃ Ở TRÌNH DUYỆT: máy chủ chỉ cấp khoá + địa chỉ raw; module trình duyệt tải thẳng các phần và giải mã (WebCrypto của Node)
  const MnhaFiles = require(R + 'public/js/mnhaFiles.js');
  const keyOf = (info) => info.key;
  const rawFetch = (tamper) => async (url) => {                       // giả GitHub raw: trả byte đã mã hoá của đúng đường dẫn
    const u = new URL(url); const path = decodeURIComponent(u.pathname.replace(/^\/o\/r(-\d+)?\/main\//, ''));
    assert.strictEqual(u.origin, 'https://raw.githubusercontent.com');
    let buf = files.get(path); if (!buf) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    if (tamper) buf = tamper(path, Buffer.from(buf));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  };
  const dBig = crypto.randomBytes(PART * 3 + 4321);
  const dUp = await upload('u1', 'tl', 'Giao trinh.docx', dBig, 7001);
  await fs.finish('u1', { dir: 'tl', name: 'Giao trinh.docx', uploadId: dUp.init.uploadId, size: dBig.length, lastModified: 7001 });
  const info = await fs.release('u1', 'tl', 'Giao trinh.docx');
  assert.strictEqual(info.mode, 'direct'); assert.strictEqual(info.parts.length, 4);
  assert(info.parts.every((p, i) => p.i === i && /^https:\/\/raw\.githubusercontent\.com\/o\/r(-1)?\/main\/u1\/codes\/files\/tl\/_data\/[a-f0-9]{32}\/000\d\.bin\?v=/.test(p.url)), 'địa chỉ raw đúng từng phần');
  assert.strictEqual(info.parts[3].size, 4321);
  assert.strictEqual(Buffer.from(info.key, 'base64').length, 32, 'khoá riêng của file (32 byte), KHÔNG phải khoá chủ');
  assert(!JSON.stringify(info).includes(process.env.SESSION_ENC_KEY), 'khoá chủ không lọt ra');
  global.fetch = rawFetch();
  let prog = 0;
  const blob = await MnhaFiles.toBlob(info, { onProgress: () => { prog++; } });
  assert(dBig.equals(Buffer.from(await blob.arrayBuffer())), 'trình duyệt giải mã ra đúng từng byte');
  assert.strictEqual(prog, 4); assert.strictEqual(blob.type, info.mime);
  // đảo 2 phần (GitHub/ai đó đổi chỗ) → xác thực thất bại, không ra file sai
  const [pA, pB] = info.parts.slice(1, 3).map((p) => decodeURIComponent(new URL(p.url).pathname.replace(/^\/o\/r(-\d+)?\/main\//, '')));
  global.fetch = rawFetch((path, b) => (path === pA ? files.get(pB) : path === pB ? files.get(pA) : b));
  await assert.rejects(MnhaFiles.toBlob(info), (e) => e.code === 'AUTH');
  // sửa 1 byte → AUTH; thiếu phần (404, repo riêng tư) → code RAW để quay về đường máy chủ
  global.fetch = rawFetch((path, b) => { if (path === pA) b[b.length - 1] ^= 1; return b; });
  await assert.rejects(MnhaFiles.toBlob(info), (e) => e.code === 'AUTH');
  global.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(MnhaFiles.toBlob(info), (e) => e.code === 'RAW' && e.status === 404);
  // đường dự phòng ở máy chủ vẫn ra đúng file
  assert(dBig.equals(await download('u1', 'tl', 'Giao trinh.docx')), 'dự phòng qua máy chủ cũng giải mã đúng (AAD theo số thứ tự phần)');
  // công khai: riêng tư thì không cấp khoá; bật mới cấp; tắt là ngừng cấp
  await assert.rejects(fs.release('u1', 'tl', 'Giao trinh.docx', { publicOnly: true }), /không công khai/);
  await fs.setVisibility('u1', 'tl', 'Giao trinh.docx', true);
  const pinfo = await fs.release('u1', 'tl', 'Giao trinh.docx', { publicOnly: true });
  global.fetch = rawFetch();
  assert(dBig.equals(Buffer.from(await (await MnhaFiles.toBlob(pinfo)).arrayBuffer())));
  assert.strictEqual((await fs.publicInfo('u1', 'tl', 'Giao trinh.docx')).parts, 4);
  await fs.setVisibility('u1', 'tl', 'Giao trinh.docx', false);
  await assert.rejects(fs.release('u1', 'tl', 'Giao trinh.docx', { publicOnly: true }), /không công khai/);
  await assert.rejects(fs.publicInfo('u1', 'tl', 'Giao trinh.docx'), /không công khai/);
  await assert.rejects(fs.release('u1', 'tl', 'khong-co.docx'), /Không tìm thấy/);
  // file lưu bằng bản cũ (json chưa có khoá riêng) → báo dùng đường máy chủ, không cấp khoá
  const mf = await fs.readManifest('u1', ['tl']); delete mf.files['Giao trinh.docx'].key;
  files.set(fs.manifestPath('u1', ['tl']), Buffer.from(JSON.stringify(mf)));
  assert.strictEqual((await fs.release('u1', 'tl', 'Giao trinh.docx')).mode, 'server');
  delete global.fetch;

  // 13) khoá file được MÃ HOÁ rồi lưu ngay trong mnha-files.json cùng thư mục với các phần mã hoá, cùng chỗ với cờ công khai/riêng tư
  const kUp = crypto.randomBytes(5000);
  const kr = await upload('u1', 'khoa', 'Hop dong.pdf', kUp, 8001);
  await fs.finish('u1', { dir: 'khoa', name: 'Hop dong.pdf', uploadId: kr.init.uploadId, size: kUp.length, lastModified: 8001 });
  await fs.setVisibility('u1', 'khoa', 'Hop dong.pdf', true);
  const jsonPath = fs.manifestPath('u1', ['khoa']);
  const raw = files.get(jsonPath).toString();
  const ent = JSON.parse(raw).files['Hop dong.pdf'];
  assert.strictEqual(ent.public, true, 'cờ công khai nằm trong json này');
  assert(ent.key && !ent.salt, 'json lưu khoá (đã mã hoá), không còn salt trần');
  const wrapped = Buffer.from(ent.key, 'base64');
  assert(wrapped.subarray(0, 8).toString('latin1') === 'MNHAENC1', 'khoá trong json là bản MÃ HOÁ (MNHAENC1), không phải khoá thô');
  const rawKey = require(R + 'services/code/mediaCrypto').filesKey('u1', kr.init.uploadId);
  assert(!raw.includes(rawKey.toString('base64')) && !raw.includes(rawKey.toString('hex')), 'json không chứa khoá thô');
  assert.strictEqual(jsonPath.slice(0, jsonPath.lastIndexOf('/')) + '/_data/', [...files.keys()].find((k) => k.includes('/_data/' + kr.init.uploadId + '/0001.bin')).replace(/_data\/.*$/, '_data/'), 'json cùng thư mục với _data chứa các phần mã hoá');
  assert.strictEqual(Buffer.from((await fs.release('u1', 'khoa', 'Hop dong.pdf')).key, 'base64').equals(rawKey), true, 'máy chủ mở khoá bản mã hoá rồi mới trao cho trình duyệt');
  assert(!JSON.stringify(await fs.list('u1', 'khoa')).includes(ent.key) && !JSON.stringify(await fs.search('u1', 'hop')).includes(ent.key), 'danh sách / tìm kiếm không lộ khoá');
  // đổi khoá chủ → khoá trong json không mở được nữa (đúng ý "mã hoá khoá")
  const mcx = require(R + 'services/code/mediaCrypto');
  process.env.SESSION_ENC_KEY = 'z'.repeat(40); mcx.resetKeys();
  await assert.rejects(fs.release('u1', 'khoa', 'Hop dong.pdf'));
  process.env.SESSION_ENC_KEY = 'k'.repeat(40); mcx.resetKeys();
  assert.strictEqual((await fs.release('u1', 'khoa', 'Hop dong.pdf')).mode, 'direct');

  // 14) .txt: tải lên, mở, SỬA (ghi đè cùng tên), giữ cờ công khai, xem công khai
  const MnhaFiles2 = require(R + 'public/js/mnhaFiles.js');
  const t1 = Buffer.from('Xin chào\nDòng 2 — tiếng Việt có dấu\n', 'utf8');
  const tu = await upload('u1', 'ghi-chu', 'Ghi chú.txt', t1, 9001);
  await fs.finish('u1', { dir: 'ghi-chu', name: 'Ghi chú.txt', uploadId: tu.init.uploadId, size: t1.length, lastModified: 9001 });
  assert.strictEqual((await fs.list('u1', 'ghi-chu')).files[0].kind, 'text');
  assert.strictEqual(fs.mimeOf('a.txt'), 'text/plain');
  await fs.setVisibility('u1', 'ghi-chu', 'Ghi chú.txt', true);
  const readTxt = async (pub) => {
    const inf = await fs.release('u1', 'ghi-chu', 'Ghi chú.txt', pub ? { publicOnly: true } : {});
    global.fetch = async (url) => { const u = new URL(url); const b = files.get(decodeURIComponent(u.pathname.replace(/^\/o\/r(-\d+)?\/main\//, ''))); return { ok: !!b, status: b ? 200 : 404, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
    return Buffer.from(await (await MnhaFiles2.toBlob(inf)).arrayBuffer()).toString('utf8');
  };
  assert.strictEqual(await readTxt(false), t1.toString('utf8'));
  const t2 = Buffer.from('Đã sửa nội dung\nThêm dòng mới\n', 'utf8');          // "sửa" = tải lên lại nội dung mới cùng tên (lastModified mới)
  const tu2 = await upload('u1', 'ghi-chu', 'Ghi chú.txt', t2, 9002);
  assert.strictEqual((await fs.init('u1', { dir: 'ghi-chu', name: 'Ghi chú.txt', size: t2.length, lastModified: 9002 })).exists, true);
  await fs.finish('u1', { dir: 'ghi-chu', name: 'Ghi chú.txt', uploadId: tu2.init.uploadId, size: t2.length, lastModified: 9002 });
  assert.strictEqual(await readTxt(false), t2.toString('utf8'), 'đọc lại ra nội dung đã sửa');
  assert.strictEqual(await readTxt(true), t2.toString('utf8'), 'vẫn công khai sau khi sửa');
  assert.strictEqual([...files.keys()].filter((k) => k.includes('/ghi-chu/_data/')).length, 1, 'phần của bản trước đã dọn');
  delete global.fetch;

  // 15) chia sẻ THƯ MỤC: mặc định không; bật thì chỉ liệt kê file đang công khai; tắt/không có → 404; giữ json khi thư mục trống
  await assert.rejects(fs.publicFolder('u1', 'ghi-chu'), /không được chia sẻ/);
  await fs.setVisibility('u1', 'ghi-chu', 'Ghi chú.txt', false);
  const e2 = crypto.randomBytes(300);
  const eu = await upload('u1', 'ghi-chu', 'Cong khai.pdf', e2, 9003);
  await fs.finish('u1', { dir: 'ghi-chu', name: 'Cong khai.pdf', uploadId: eu.init.uploadId, size: e2.length, lastModified: 9003 });
  await fs.setVisibility('u1', 'ghi-chu', 'Cong khai.pdf', true);
  assert.strictEqual((await fs.setFolderShared('u1', 'ghi-chu', true)).shared, true);
  assert.strictEqual((await fs.list('u1', 'ghi-chu')).shared, true);
  const pf = await fs.publicFolder('u1', 'ghi-chu');
  assert.deepStrictEqual(pf.files.map((x) => x.name), ['Cong khai.pdf'], 'file riêng tư không hiện trong thư mục chia sẻ');
  assert.strictEqual(pf.name, 'ghi-chu');
  await assert.rejects(fs.publicFolder('u1', 'khong-co'), /không được chia sẻ/);
  await assert.rejects(fs.publicFolder('../x', 'ghi-chu'), /không được chia sẻ/);
  await assert.rejects(fs.publicFolder('u1', '_data'), /không được chia sẻ/);
  await fs.remove('u1', 'ghi-chu', 'Cong khai.pdf'); await fs.remove('u1', 'ghi-chu', 'Ghi chú.txt');
  assert(files.has(fs.manifestPath('u1', ['ghi-chu'])), 'thư mục còn chia sẻ thì giữ json dù hết file');
  assert.deepStrictEqual((await fs.publicFolder('u1', 'ghi-chu')).files, []);
  await fs.setFolderShared('u1', 'ghi-chu', false);
  assert(!files.has(fs.manifestPath('u1', ['ghi-chu'])), 'hết file và thôi chia sẻ → bỏ json');
  await assert.rejects(fs.publicFolder('u1', 'ghi-chu'), /không được chia sẻ/);

  // 16) xem thư mục trên mạng = duyệt cả CÂY (thư mục con + file, mọi repo), như "xem code trên mạng" của HTML
  const mk = async (dir, name, size, lm, pub) => {
    const b = crypto.randomBytes(size); const up = await upload('u1', dir, name, b, lm);
    await fs.finish('u1', { dir, name, uploadId: up.init.uploadId, size: b.length, lastModified: lm });
    if (pub) await fs.setVisibility('u1', dir, name, true);
    return b;
  };
  await mk('kho', 'goc.pdf', 100, 100, true);
  await mk('kho', 'rieng tu.pdf', 100, 101, false);
  await mk('kho/lop-1', 'bai 1.docx', 100, 102, true);
  await mk('kho/lop-1/phu', 'sau.txt', 100, 103, true);
  await mk('kho/lop-2', 'chi rieng tu.pdf', 100, 104, false);        // thư mục con không có file công khai → không hiện
  await assert.rejects(fs.publicFolder('u1', 'kho'), /không được chia sẻ/, 'chưa chia sẻ → 404');
  await assert.rejects(fs.publicFolder('u1', 'kho/lop-1'), /không được chia sẻ/);
  await fs.setFolderShared('u1', 'kho', true);
  const tr0 = await fs.publicFolder('u1', 'kho');
  assert.deepStrictEqual(tr0.files.map((x) => x.name), ['goc.pdf'], 'file riêng tư không hiện');
  assert.deepStrictEqual(tr0.folders, [{ name: 'lop-1', files: 2 }], 'thư mục con (mọi độ sâu) có file công khai; lop-2 không có thì ẩn');
  assert.strictEqual(tr0.isRoot, true); assert.strictEqual(tr0.rootDir, 'kho');
  const tr1 = await fs.publicFolder('u1', 'kho/lop-1');                 // con của thư mục chia sẻ → xem được dù chưa bật riêng
  assert.deepStrictEqual(tr1.files.map((x) => x.name), ['bai 1.docx']); assert.deepStrictEqual(tr1.folders, [{ name: 'phu', files: 1 }]);
  assert.strictEqual(tr1.isRoot, false); assert.strictEqual(tr1.rootDir, 'kho', 'không đi lên quá thư mục chia sẻ cao nhất');
  assert.deepStrictEqual((await fs.publicFolder('u1', 'kho/lop-1/phu')).files.map((x) => x.name), ['sau.txt']);
  assert.deepStrictEqual((await fs.publicFolder('u1', 'kho/lop-2')).files, [], 'xem được nhưng trống');
  await assert.rejects(fs.publicFolder('u1', ''), /không được chia sẻ/, 'thư mục CHA của thư mục chia sẻ không tự xem được');
  await fs.setVisibility('u1', 'kho/lop-1', 'bai 1.docx', false);          // tắt công khai → danh sách cập nhật ngay (xoá bộ nhớ đệm)
  assert.deepStrictEqual((await fs.publicFolder('u1', 'kho/lop-1')).files, []);
  await fs.setFolderShared('u1', 'kho', false);
  await assert.rejects(fs.publicFolder('u1', 'kho/lop-1'), /không được chia sẻ/, 'thôi chia sẻ → cả cây con cũng 404');

  // 17) link GitHub ĐỦ mọi repo: thư mục liệt kê từng repo chứa dữ liệu; mỗi file nặng liệt kê từng repo chứa phần của nó
  written = 0;                                                       // giả lập: > 9MB thì sang repo kế (db-1)
  const spread = crypto.randomBytes(PART * 4 + 10);
  const sp = await upload('u1', 'dai', 'Sach.pdf', spread, 200);
  await fs.finish('u1', { dir: 'dai', name: 'Sach.pdf', uploadId: sp.init.uploadId, size: spread.length, lastModified: 200 });
  const ld = await fs.list('u1', 'dai');
  assert(ld.repos.length >= 2, 'thư mục liệt kê đủ các repo: ' + JSON.stringify(ld.repos.map((r) => r.repo)));
  assert.strictEqual(ld.repos[0].repo, 'r', 'repo chính trước, rồi repo tạo sau theo thứ tự'); assert.strictEqual(ld.repos[ld.repos.length - 1].repo, 'r-1');
  assert(ld.repos.every((r) => /^https:\/\/github\.com\/o\/r(-1)?\/tree\/main\/u1\/codes\/files\/dai$/.test(r.url)));
  assert.strictEqual(ld.repos.reduce((a, r) => a + r.files, 0), 5 + 1, '5 phần + mnha-files.json');
  const gf = ld.files[0].github;
  assert(gf.length >= 2 && gf[0].repo === 'r' && gf[gf.length - 1].repo === 'r-1', 'file nặng nằm trên nhiều repo');
  assert.strictEqual(gf.reduce((a, g) => a + g.parts, 0), 5);
  assert(gf.every((g) => /^https:\/\/github\.com\/o\/r(-1)?\/tree\/main\/u1\/codes\/files\/dai\/_data\/[a-f0-9]{32}$/.test(g.url)));
  console.log('OK files-store');
})().catch((e) => { console.error('✘', e); process.exit(1); });
