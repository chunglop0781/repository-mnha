// test/html-media.js — tải lên ảnh/âm thanh/video (mã hoá, cắt m3u8) + máy chủ xem trước (giải mã ở Node) — GitHub giả, HTTP thật, ffmpeg thật.
//   Chạy: node -r ./test/_stubs.js test/html-media.js
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------- GitHub giả (cây + blob + commit nhiều file)
const files = new Map(), blobs = new Map();
const shaOf = (b) => crypto.createHash('sha1').update(b).digest('hex');
const put = (p, b) => { const s = shaOf(b); blobs.set(s, b); files.set(p, s); };
let commits = 0;
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map(files), truncated: false }; },
  async createBlob(b) { const s = shaOf(b); blobs.set(s, b); return s; },
  async getBlobBuffer(s) { return blobs.get(s) || null; },
  async commitFiles(changes) {
    commits++;
    const seen = new Set();
    for (const c of changes) { assert(!seen.has(c.path), 'trùng đường dẫn trong 1 commit: ' + c.path); seen.add(c.path); }
    for (const c of changes) { if (c.remove) files.delete(c.path); else if (c.sha) { assert(blobs.has(c.sha), 'sha lạ'); files.set(c.path, c.sha); } else put(c.path, c.content); }
    return { commitSha: 'c' + commits };
  },
  async writeBinaryFileBig(p, b) { put(p, b); }, async writeBinaryFile(p, b) { put(p, b); },
  async readBinaryFile(p) { const s = files.get(p); return s ? blobs.get(s) : null; },
  async readJsonFile(p) { const s = files.get(p); return s ? JSON.parse(blobs.get(s).toString()) : null; },
  async writeJsonFile(p, d) { put(p, Buffer.from(JSON.stringify(d))); },
  async deleteFile(p) { files.delete(p); }
};
const gp = R + 'services/githubService.js';
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };

const { MEDIA } = require(R + 'config/codeConfig');
MEDIA.DIRECT_MAX = 200 * 1024; MEDIA.PART_BYTES = 64 * 1024;     // thu nhỏ để test nhanh
const ms = require(R + 'services/code/mediaService');
const mc = require(R + 'services/code/mediaCrypto');
const token = require(R + 'services/code/previewToken');
const preview = require(R + 'services/code/previewServer');
const TsMux = require(R + 'public/js/tsMux');

const have = (c) => spawnSync(c, ['-version']).status === 0;
const HAVE_FF = have('ffmpeg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmedia-'));
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });

// ---------------- HTTP: gắn handler như app.use('/preview', ...)
const handler = preview.createHandler({ gh: fakeGh, mount: '/preview' });
const server = http.createServer((req, res) => { req.url = req.url.replace(/^\/preview/, '') || '/'; handler(req, res); });
let PORT;
const get = (u, headers = {}, method = 'GET') => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: u, method, headers, agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
  r.on('error', no); r.end();
});
const json = (r) => JSON.parse(r.body.toString());

const UID = 'u1', TOK = token.sign({ k: 'own', uid: UID }), U = (p) => `/preview/${TOK}/${p}`;

// ---------------- mô phỏng trình duyệt tải lên
async function uploadDirect(dir, name, buf, { encrypt = true } = {}) {
  const init = await ms.init(UID, { dir, name, size: buf.length, encrypt });
  assert.strictEqual(init.plan, 'direct');
  const n = Math.ceil(buf.length / init.partBytes), parts = [];
  for (let i = 0; i < n; i++) {
    const body = buf.subarray(i * init.partBytes, (i + 1) * init.partBytes);
    const r = await ms.putPart(UID, { dir, name, uploadId: init.uploadId, i, n, encrypt: init.encrypt ? '1' : '0' }, Buffer.from(body));
    if (n === 1) return { init, r };
    parts.push({ i, sha: r.sha, size: r.size, receipt: r.receipt });
  }
  const fin = await ms.finish(UID, { dir, name, uploadId: init.uploadId, parts });
  return { init, r: fin, n };
}
async function uploadHls(dir, name, file, { batch = 3, stopAfter = null, uploadId = null } = {}) {
  const size = fs.statSync(file).size, lastModified = 1700000000000;
  const init = await ms.init(UID, { dir, name, size, lastModified, srcName: name });
  assert.strictEqual(init.plan, 'hls');
  const fd = fs.openSync(file, 'r');
  const reader = { size, read: async (a, b) => { const buf = Buffer.alloc(b - a); const n = fs.readSync(fd, buf, 0, b - a, a); return new Uint8Array(buf.buffer, buf.byteOffset, n); } };
  const f = await TsMux.open(reader, name.split('.').pop(), { segSec: init.segSec, segBytes: init.segBytes });
  const skip = init.resume ? init.resume.done : 0;
  let pending = [], sent = 0;
  const flush = async (final) => {
    const fm = f.fmt === 'fmp4' ? { fmt: 'fmp4', init: Buffer.from(f.init).toString('base64'), codecs: f.codecString } : {};
    await ms.commit(UID, { dir, name, uploadId: init.uploadId, srcName: name, src: { size, lastModified }, segs: pending, final, total: f.total || undefined, ...fm });
    pending = [];
  };
  for await (const seg of f.segments(skip)) {
    const r = await ms.putSeg(UID, { dir, name, uploadId: init.uploadId, i: seg.i, ...(f.fmt === 'fmp4' ? { fmt: 'fmp4' } : {}) }, Buffer.from(seg.bytes));
    pending.push({ i: seg.i, dur: seg.dur, plainSize: r.plainSize, sha: r.sha, size: r.size, receipt: r.receipt });
    sent++;
    if (stopAfter && sent >= stopAfter) { await flush(false); return { init, stopped: true }; }
    if (pending.length >= batch) await flush(false);
  }
  await flush(true);
  return { init, total: f.total };
}

(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); PORT = server.address().port;

  // ============ 1) ảnh: mã hoá trực tiếp, 1 phần và nhiều phần
  const png1 = crypto.randomBytes(30 * 1024), png2 = crypto.randomBytes(150 * 1024);
  let u = await uploadDirect('', 'Anh nho.png', png1);
  assert.strictEqual(u.r.name, 'Anh_nho.png');
  const stored1 = blobs.get(files.get(`${UID}/codes/html/Anh_nho.png`));
  assert(mc.isEncrypted(stored1) && !stored1.includes(png1.subarray(0, 64)), 'file trên GitHub phải được mã hoá');
  u = await uploadDirect('web', 'to.png', png2); assert(u.n >= 3);
  let r = await get(U('Anh_nho.png')); assert.strictEqual(r.status, 200); assert(r.body.equals(png1), 'giải mã ra đúng ảnh gốc'); assert.strictEqual(r.headers['content-type'], 'image/png');
  r = await get(U('web/to.png')); assert(r.body.equals(png2));
  console.log('✔ ảnh mã hoá (1 phần / ' + u.n + ' phần) → xem lại được đúng ảnh gốc');

  // ảnh KHÔNG mã hoá: trả nguyên, không động tới giải mã
  const jpg = crypto.randomBytes(20 * 1024);
  await uploadDirect('', 'plain.jpg', jpg, { encrypt: false });
  assert(blobs.get(files.get(`${UID}/codes/html/plain.jpg`)).equals(jpg));
  r = await get(U('plain.jpg')); assert(r.status === 200 && r.body.equals(jpg));
  // file thường (ảnh xem được sẵn) đặt thẳng vào repo/ nguồn khác → không giải mã, không cần khoá
  put(`${UID}/codes/html/raw.png`, png1);
  r = await get(U('raw.png')); assert(r.status === 200 && r.body.equals(png1));
  console.log('✔ ảnh xem được thẳng (không mã hoá) → trả nguyên, không giải mã');

  // ảnh mã hoá bị hỏng / sai khoá → 422 + JSON báo "không giải mã được"
  const bad = Buffer.from(stored1); bad[bad.length - 3] ^= 0xFF; put(`${UID}/codes/html/hong.png`, bad);
  r = await get(U('hong.png')); assert.strictEqual(r.status, 422); assert(/Không giải mã được/.test(json(r).error), r.body.toString());
  r = await get(U('hong.png'), { accept: 'text/html' }); assert.strictEqual(r.status, 422); assert(/Không giải mã được/.test(r.body.toString()));
  r = await get(`/preview/${TOK}x/Anh_nho.png`); assert.strictEqual(r.status, 403, 'token sai chữ ký');
  process.env.MEDIA_ENC_KEY = 'z'.repeat(40); mc.resetKeys();
  r = await get(U('Anh_nho.png')); assert.strictEqual(r.status, 403, 'đổi khoá chủ → token cũ cũng hết hiệu lực');
  r = await get(`/preview/${token.sign({ k: 'own', uid: UID })}/Anh_nho.png`); assert.strictEqual(r.status, 422, 'sai khoá chủ → không giải mã được');
  delete process.env.MEDIA_ENC_KEY; mc.resetKeys();
  r = await get(U('Anh_nho.png')); assert.strictEqual(r.status, 200);
  console.log('✔ ảnh mã hoá hỏng / sai khoá → HTTP 422 + thông báo "Không giải mã được"');

  // tải về giữ nguyên đuôi
  r = await get(U('Anh_nho.png?dl=1')); assert(/attachment; filename="Anh_nho\.png"/.test(r.headers['content-disposition'])); assert(r.body.equals(png1));
  console.log('✔ ?dl=1 → tải ảnh đã giải mã, giữ đuôi .png');

  // ============ 2) âm thanh/video nhỏ (≤ ngưỡng): mã hoá trực tiếp, Range chạy
  const wav = crypto.randomBytes(100 * 1024);
  await uploadDirect('', 'tiengdong.wav', wav);
  r = await get(U('tiengdong.wav')); assert(r.body.equals(wav));
  r = await get(U('tiengdong.wav'), { range: 'bytes=1000-1999' }); assert.strictEqual(r.status, 206); assert(r.body.equals(wav.subarray(1000, 2000)));
  assert.strictEqual(r.headers['content-range'], 'bytes 1000-1999/' + wav.length);
  console.log('✔ âm thanh nhỏ mã hoá trực tiếp, phát được kèm Range (seek)');

  // ============ 3) HTML + css cùng thư mục + shim
  put(`${UID}/codes/html/site/index.html`, Buffer.from('<!DOCTYPE html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><img src="../Anh_nho.png"></body></html>'));
  put(`${UID}/codes/html/site/style.css`, Buffer.from('body{color:red}'));
  r = await get(U('site/index.html')); assert.strictEqual(r.status, 200);
  const html = r.body.toString(); assert(html.includes('<head><script>(') && html.includes('href="style.css"'), 'chèn shim ngay sau <head>');
  assert(/sandbox/.test(r.headers['content-security-policy']) && r.headers['access-control-allow-origin'] === '*');
  r = await get(U('site/style.css')); assert(r.body.toString() === 'body{color:red}' && /text\/css/.test(r.headers['content-type']));
  r = await get(U('site/khong-co.css')); assert.strictEqual(r.status, 404);
  r = await get(`/preview/${TOK}x/site/index.html`); assert.strictEqual(r.status, 403);
  r = await get(`/preview/${TOK}/site/%2e%2e/%2e%2e/x`); assert([400, 403, 404].includes(r.status), 'URL chuẩn hoá bỏ ".." → không thoát được: ' + r.status);
  r = await get(`/preview/${TOK}/site%2F..%2F..%2Fx.txt`); assert.strictEqual(r.status, 400, '%2F trong đoạn đường dẫn bị chặn');
  const other = token.sign({ k: 'own', uid: 'u2' }); r = await get(`/preview/${other}/site/index.html`); assert.strictEqual(r.status, 404, 'token người khác không đọc được file của u1');
  console.log('✔ trang html + css cùng thư mục, shim, 404/403/400, cô lập theo người dùng');

  if (!HAVE_FF) { console.log('⚠ không có ffmpeg — bỏ qua phần cắt m3u8'); server.close(); return; }

  // ============ 4) âm thanh lớn → cắt m3u8 (đoạn .ts mã hoá 2 chiều), khai báo m3u8 là mp3
  const mp3 = path.join(tmp, 'song.mp3');
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-c:a', 'libmp3lame', '-b:a', '128k', mp3);
  assert(fs.statSync(mp3).size > MEDIA.DIRECT_MAX);
  const up = await uploadHls('', 'song.mp3', mp3, { batch: 4 });
  const man = JSON.parse(blobs.get(files.get(`${UID}/codes/html/mnha-media.json`)));
  const e = man.files['song.mp3'];
  assert(e && e.state === 'ready' && e.mode === 'hls-audio' && e.playlist === '_media/song_mp3/index.m3u8' && e.done === e.durs.length && e.segExt === 'ts');
  assert(!files.has(`${UID}/codes/html/song.mp3`), 'không có file trực tiếp song.mp3 — chỉ có m3u8 khai báo trong json');
  const stored = blobs.get(files.get(`${UID}/codes/html/_media/song_mp3/seg00000.ts`));
  assert(mc.isEncrypted(stored), 'đoạn .ts âm thanh mã hoá 2 chiều (MNHAENC1)');
  assert(files.has(`${UID}/codes/html/_media/song_mp3/index.m3u8`));
  console.log('✔ mp3 > ngưỡng → ' + e.done + ' đoạn .ts mã hoá + index.m3u8 + json đánh dấu (state=ready), tên gốc song.mp3 khai báo là m3u8');
  r = await get(U('song.mp3')); assert.strictEqual(r.status, 200); assert(/mpegurl/.test(r.headers['content-type']));
  let pl = r.body.toString(); assert(pl.startsWith('#EXTM3U') && !pl.includes('EXT-X-KEY') && pl.includes('#EXT-X-ENDLIST'));
  const segUrls = pl.split('\n').filter((l) => l && !l.startsWith('#')); assert.strictEqual(segUrls.length, e.done);
  assert(segUrls[0].startsWith(`/preview/${TOK}/_media/song_mp3/seg00000.ts`));
  const tsParts = []; for (const su of segUrls) { const x = await get(su); assert.strictEqual(x.status, 200, su); assert(!mc.isEncrypted(x.body) && x.body[0] === 0x47, 'Node đã giải mã đoạn'); tsParts.push(x.body); }
  fs.writeFileSync(path.join(tmp, 'a.ts'), Buffer.concat(tsParts));
  let dec = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(tmp, 'a.ts'), '-f', 'null', '-'], { encoding: 'utf8' }); assert.strictEqual(dec.stderr.trim(), '');
  console.log('✔ GET song.mp3 → playlist m3u8; từng đoạn được Node giải mã; ffmpeg giải mã sạch toàn bộ');
  r = await get(U('song.mp3?dl=1')); assert(/attachment; filename="song\.mp3"/.test(r.headers['content-disposition'])); assert(r.body[0] === 0x47 && r.body.length % 188 === 0);
  assert(r.body.equals(Buffer.concat(tsParts)), 'tải về = ghép các đoạn đã giải mã (mpegts), đuôi gốc .mp3');
  console.log('✔ ?dl=1 → ghép đoạn đã giải mã thành mpegts, tên giữ đuôi .mp3');

  // ============ 5) video lớn → AES-128 DRM; khoá trong json mã hoá 2 chiều; ffmpeg tự giải mã HLS bằng key.bin
  const mp4 = path.join(tmp, 'clip.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=30', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-b:v', '1200k', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', mp4);
  await uploadHls('web', 'clip.mp4', mp4, { batch: 2 });
  const man2 = JSON.parse(blobs.get(files.get(`${UID}/codes/html/web/mnha-media.json`))), v = man2.files['clip.mp4'];
  assert(v.state === 'ready' && v.mode === 'hls-video' && v.drm.method === 'AES-128');
  assert(!JSON.stringify(man2).includes(mc.hlsKey(UID, 'x').toString('base64')), 'sanity');
  const realKey = mc.unwrapKey(v.drm.key); assert.strictEqual(realKey.length, 16);
  assert(!Buffer.from(v.drm.key, 'base64').includes(realKey), 'khoá trong json phải là bản MÃ HOÁ, không phải khoá thật');
  const rawSeg0 = blobs.get(files.get(`${UID}/codes/html/web/_media/clip_mp4/seg00000.ts`));
  assert(rawSeg0[0] !== 0x47 && rawSeg0.length % 16 === 0, 'đoạn video trên GitHub là AES-CBC');
  r = await get(U('web/clip.mp4')); pl = r.body.toString();
  assert(/EXT-X-KEY:METHOD=AES-128,URI="[^"]*\/_media\/clip_mp4\/key\.bin"/.test(pl));
  const kr = await get(pl.match(/URI="([^"]+)"/)[1]); assert(kr.status === 200 && kr.body.equals(realKey), 'key.bin = khoá thật được mở khoá 2 chiều từ json');
  // dựng thư mục HLS cục bộ để ffmpeg giải mã bằng chính playlist + key do máy chủ trả
  const hd = path.join(tmp, 'hls'); fs.mkdirSync(hd);
  let local = pl.replace(/URI="[^"]*key\.bin"/, 'URI="key.bin"'); fs.writeFileSync(path.join(hd, 'key.bin'), kr.body);
  const vs = pl.split('\n').filter((l) => l && !l.startsWith('#'));
  for (let i = 0; i < vs.length; i++) { const x = await get(vs[i]); assert.strictEqual(x.status, 200); fs.writeFileSync(path.join(hd, `s${i}.ts`), x.body); local = local.replace(vs[i], `s${i}.ts`); assert(x.body.equals(blobs.get(files.get(`${UID}/codes/html/web/_media/clip_mp4/seg${String(i).padStart(5, '0')}.ts`))), 'đoạn video trả nguyên bản mã hoá để trình phát tự giải mã'); }
  fs.writeFileSync(path.join(hd, 'index.m3u8'), local);
  dec = spawnSync('ffmpeg', ['-v', 'error', '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data', '-i', path.join(hd, 'index.m3u8'), '-f', 'null', '-'], { encoding: 'utf8' });
  assert.strictEqual(dec.stderr.trim(), '', 'ffmpeg giải mã HLS AES-128 bằng key.bin: ' + dec.stderr.slice(0, 400));
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(hd, 'index.m3u8')]).toString());
  assert(Math.abs(dur - 30) < 0.5, 'thời lượng HLS ' + dur);
  console.log('✔ video lớn → ' + vs.length + ' đoạn AES-128, key trong json bọc 2 chiều; ffmpeg phát đủ ' + dur.toFixed(1) + 's bằng key.bin');
  r = await get(U('web/clip.mp4?dl=1')); assert(/filename="clip\.mp4"/.test(r.headers['content-disposition']));
  fs.writeFileSync(path.join(tmp, 'v.ts'), r.body);
  dec = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(tmp, 'v.ts'), '-f', 'null', '-'], { encoding: 'utf8' }); assert.strictEqual(dec.stderr.trim(), '');
  assert(r.body[0] === 0x47);
  console.log('✔ ?dl=1 video → giải mã AES từng đoạn rồi ghép thành mpegts hợp lệ, tên giữ đuôi .mp4');

  // ============ 5b) video codec THẾ HỆ MỚI (AV1 / HEVC) → đoạn fMP4 .m4s + init.mp4, vẫn AES-128; ffmpeg giải mã HLS bằng playlist + key + init do máy chủ trả
  for (const [cname, vArgs, want] of [
    ['av1', ['-c:v', 'libsvtav1', '-preset', '10', '-g', '50', '-pix_fmt', 'yuv420p', '-b:v', '900k'], /^av01\./],
    ['hevc', ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=50:min-keyint=50:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-b:v', '900k'], /^hvc1\./]]) {
    const src = path.join(tmp, cname + '.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=30', ...vArgs, '-c:a', 'aac', '-shortest', '-movflags', '+faststart', src);
    await uploadHls('web', cname + '.mp4', src, { batch: 2 });
    const man = JSON.parse(blobs.get(files.get(`${UID}/codes/html/web/mnha-media.json`))), e5 = man.files[cname + '.mp4'];
    assert(e5.state === 'ready' && e5.mode === 'hls-video' && e5.segExt === 'm4s' && e5.drm.method === 'AES-128', cname + ': json');
    assert(want.test(e5.codecs), cname + ': codecs ' + e5.codecs);
    assert(files.has(`${UID}/codes/html/web/_media/${cname}_mp4/seg00000.m4s`) && !files.has(`${UID}/codes/html/web/_media/${cname}_mp4/seg00000.ts`), cname + ': đoạn lưu dạng .m4s');
    const raw0 = blobs.get(files.get(`${UID}/codes/html/web/_media/${cname}_mp4/seg00000.m4s`));
    assert(raw0.toString('latin1', 4, 8) !== 'moof' && raw0.length % 16 === 0, cname + ': đoạn fMP4 trên GitHub là AES-CBC, không lộ moof');
    const pl5 = (await get(U('web/' + cname + '.mp4'))).body.toString();
    assert(/#EXT-X-VERSION:7/.test(pl5) && /#EXT-X-MAP:URI="[^"]*\/_media\/[a-z0-9]+_mp4\/init\.mp4"/.test(pl5), cname + ': playlist có EXT-X-MAP');
    assert(pl5.indexOf('#EXT-X-MAP') < pl5.indexOf('#EXT-X-KEY'), cname + ': MAP đặt trước KEY → init không bị mã hoá');
    const ir = await get(pl5.match(/#EXT-X-MAP:URI="([^"]+)"/)[1]); assert(ir.status === 200 && ir.headers['content-type'] === 'video/mp4' && ir.body.toString('latin1', 4, 8) === 'ftyp', cname + ': init.mp4');
    const key5 = (await get(pl5.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/)[1])).body;
    const hd5 = path.join(tmp, 'hls-' + cname); fs.mkdirSync(hd5);
    fs.writeFileSync(path.join(hd5, 'key.bin'), key5); fs.writeFileSync(path.join(hd5, 'init.mp4'), ir.body);
    let loc = pl5.replace(/URI="[^"]*key\.bin"/, 'URI="key.bin"').replace(/#EXT-X-MAP:URI="[^"]+"/, '#EXT-X-MAP:URI="init.mp4"');
    const segs5 = pl5.split('\n').filter((l) => l && !l.startsWith('#'));
    assert(segs5.every((l) => /seg\d{5}\.m4s$/.test(l)), cname + ': URL đoạn .m4s');
    for (let i = 0; i < segs5.length; i++) { const x = await get(segs5[i]); assert.strictEqual(x.status, 200); fs.writeFileSync(path.join(hd5, `s${i}.m4s`), x.body); loc = loc.replace(segs5[i], `s${i}.m4s`); }
    fs.writeFileSync(path.join(hd5, 'index.m3u8'), loc);
    const wl = ['-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data'];
    const d5 = spawnSync('ffmpeg', ['-v', 'error', ...wl, '-i', path.join(hd5, 'index.m3u8'), '-f', 'null', '-'], { encoding: 'utf8' });
    assert.strictEqual(d5.stderr.trim(), '', cname + ': ffmpeg giải mã HLS fMP4 AES-128: ' + d5.stderr.slice(0, 400));
    const du5 = Number(execFileSync('ffprobe', ['-v', 'error', ...wl, '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(hd5, 'index.m3u8')]).toString());
    assert(Math.abs(du5 - 30) < 0.6, cname + ': thời lượng HLS ' + du5);
    const dl5 = await get(U('web/' + cname + '.mp4?dl=1'));
    assert(dl5.headers['content-type'] === 'video/mp4' && /filename="/.test(dl5.headers['content-disposition']) && dl5.body.toString('latin1', 4, 8) === 'ftyp', cname + ': tải về = fMP4');
    fs.writeFileSync(path.join(tmp, cname + '-dl.mp4'), dl5.body);
    const dd5 = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(tmp, cname + '-dl.mp4'), '-f', 'null', '-'], { encoding: 'utf8' }); assert.strictEqual(dd5.stderr.trim(), '', cname + ': file tải về giải mã được');
    console.log('✔ ' + cname.toUpperCase() + ' lớn → ' + segs5.length + ' đoạn .m4s AES-128 + init.mp4 (không mã hoá); ffmpeg phát đủ ' + du5.toFixed(1) + 's bằng playlist/key/init do máy chủ trả; ?dl=1 = mp4 phân mảnh hợp lệ');
  }
  // bảo mật fMP4: đoạn không phải moof / init giả bị chặn; không trộn kiểu đoạn
  await assert.rejects(ms.putSeg(UID, { dir: '', name: 'x.mp4', uploadId: 'a'.repeat(32), i: 0, fmt: 'fmp4' }, Buffer.alloc(188, 0x47)), /fMP4/);
  await assert.rejects(ms.commit(UID, { dir: '', name: 'x.mp4', uploadId: 'c'.repeat(32), fmt: 'fmp4', init: Buffer.from('không phải init').toString('base64'), src: { size: MEDIA.DIRECT_MAX + 1 }, segs: [], final: false }), /Init segment|init segment/i);
  console.log('✔ fMP4: chặn đoạn không phải moof và init giả');

  // ============ 6) đứt giữa chừng → làm tiếp từ chỗ đã đánh dấu trong json
  const mp3b = path.join(tmp, 'dai.mp3');
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=90', '-c:a', 'libmp3lame', '-b:a', '128k', mp3b);
  const first = await uploadHls('', 'dai.mp3', mp3b, { batch: 3, stopAfter: 4 });
  assert(first.stopped);
  let m = JSON.parse(blobs.get(files.get(`${UID}/codes/html/mnha-media.json`))).files['dai.mp3'];
  assert(m.state === 'uploading' && m.done === 4);
  r = await get(U('dai.mp3')); assert.strictEqual(r.status, 409); assert(/dở dang/.test(json(r).error));
  const second = await uploadHls('', 'dai.mp3', mp3b, { batch: 3 });
  assert.strictEqual(second.init.uploadId, first.init.uploadId); assert.strictEqual(second.init.resume.done, 4);
  m = JSON.parse(blobs.get(files.get(`${UID}/codes/html/mnha-media.json`))).files['dai.mp3'];
  assert(m.state === 'ready' && m.done === m.durs.length && m.done > 4);
  r = await get(U('dai.mp3?dl=1')); fs.writeFileSync(path.join(tmp, 'dai.ts'), r.body);
  dec = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(tmp, 'dai.ts'), '-f', 'null', '-'], { encoding: 'utf8' }); assert.strictEqual(dec.stderr.trim(), '');
  const d2 = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(tmp, 'dai.ts')]).toString()); assert(Math.abs(d2 - 90) < 0.5, 'đủ 90s sau khi làm tiếp: ' + d2);
  console.log('✔ đứt sau 4 đoạn → mở lại làm tiếp từ đoạn 4 (đánh dấu trong json), kết quả đủ ' + d2.toFixed(1) + 's');

  // ============ 7) bảo mật tải lên
  const seg = await ms.putSeg(UID, { dir: '', name: 'x.mp3', uploadId: crypto.randomBytes(16).toString('hex'), i: 0 }, Buffer.from(TsMux ? tsParts[0] : ''));
  await assert.rejects(ms.putSeg(UID, { dir: '', name: 'x.mp3', uploadId: 'a'.repeat(32), i: 0 }, Buffer.from('không phải ts')), /MPEG-TS/);
  await assert.rejects(ms.commit(UID, { dir: '', name: 'x.mp3', uploadId: 'b'.repeat(32), src: { size: MEDIA.DIRECT_MAX + 1 }, segs: [{ i: 0, dur: 1, plainSize: 188, sha: seg.sha, size: seg.size, receipt: 'f'.repeat(40) }], final: true }), /Biên nhận/);
  await assert.rejects(ms.init(UID, { dir: '', name: 'x.wav', size: MEDIA.DIRECT_MAX + 5 }), /chỉ cắt \(m3u8\) được/);
  await assert.rejects(ms.init(UID, { dir: '', name: 'x.exe', size: 10 }), /Đuôi file/);
  await assert.rejects(ms.init(UID, { dir: '../..', name: 'x.png', size: 10 }), /Tên thư mục|không hợp lệ/);
  console.log('✔ chặn đoạn không phải TS, biên nhận giả, đuôi lạ (wav lớn), đuôi .exe, thoát thư mục');

  // ============ 8) trang trình phát + xoá
  r = await get(U('__view/Anh_nho.png')); assert(r.status === 200 && /Tải về/.test(r.body.toString()) && /<img/.test(r.body.toString()));
  r = await get(U('__view/song.mp3')); assert(/<audio/.test(r.body.toString()));
  const list = await ms.listMedia(UID, []); assert(list.some((x) => x.name === 'song.mp3' && x.state === 'ready'));
  const before = [...files.keys()].filter((p) => p.includes('_media/song_mp3/')).length; assert(before > 2);
  await ms.deleteMedia(UID, { dir: '', name: 'song.mp3' });
  assert.strictEqual([...files.keys()].filter((p) => p.includes('_media/song_mp3/')).length, 0, 'xoá hết đoạn');
  assert(!JSON.parse(blobs.get(files.get(`${UID}/codes/html/mnha-media.json`))).files['song.mp3']);
  // ghi file trực tiếp cùng tên → bỏ mục json cũ
  await uploadDirect('', 'dai.mp3', crypto.randomBytes(50 * 1024));
  const mj = files.get(`${UID}/codes/html/mnha-media.json`);
  assert(!mj || !JSON.parse(blobs.get(mj)).files['dai.mp3'], 'mục json cũ bị bỏ khi ghi trực tiếp (json rỗng thì xoá hẳn)');
  r = await get(U('dai.mp3')); assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-type'], 'audio/mpeg', 'file trực tiếp được ưu tiên');
  assert.strictEqual([...files.keys()].filter((p) => p.includes('_media/dai_mp3/')).length, 0);
  console.log('✔ trang trình phát, xoá media (đoạn + json), ghi trực tiếp thay mục m3u8');

  fs.rmSync(tmp, { recursive: true, force: true });
  server.close();
  console.log('OK html-media');
})().catch((e) => { console.error('✘', e); process.exit(1); });
