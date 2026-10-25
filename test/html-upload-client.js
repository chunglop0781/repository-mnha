// test/html-upload-client.js — chạy public/js/mediaUpload.js (code trình duyệt) trong Node, fetch giả nối thẳng vào mediaService + GitHub giả.
//   Kiểm: ảnh nhiều phần, mp3/mp4 cắt m3u8 song song, đứt giữa chừng rồi LÀM TIẾP, ghi đè, báo lỗi.
//   Chạy: node -r ./test/_stubs.js test/html-upload-client.js
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const files = new Map(), blobs = new Map();
const shaOf = (b) => crypto.createHash('sha1').update(b).digest('hex');
const put = (p, b) => { const s = shaOf(b); blobs.set(s, b); files.set(p, s); };
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map(files), truncated: false }; },
  async createBlob(b) { const s = shaOf(b); blobs.set(s, b); return s; },
  async getBlobBuffer(s) { return blobs.get(s) || null; },
  async commitFiles(ch) { for (const c of ch) { if (c.remove) files.delete(c.path); else if (c.sha) files.set(c.path, c.sha); else put(c.path, c.content); } return {}; },
  async writeBinaryFileBig(p, b) { put(p, b); }, async writeBinaryFile(p, b) { put(p, b); },
  async readBinaryFile(p) { const s = files.get(p); return s ? blobs.get(s) : null; },
  async readJsonFile(p) { const s = files.get(p); return s ? JSON.parse(blobs.get(s).toString()) : null; },
  async writeJsonFile(p, d) { put(p, Buffer.from(JSON.stringify(d))); }, async deleteFile(p) { files.delete(p); }
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };
const { MEDIA } = require(R + 'config/codeConfig');
MEDIA.DIRECT_MAX = 200 * 1024; MEDIA.PART_BYTES = 64 * 1024;
const ms = require(R + 'services/code/mediaService'), mc = require(R + 'services/code/mediaCrypto');

const UID = 'u9';
let failSegFrom = null, segCalls = 0, maxParallel = 0, parallel = 0, commits = [];
global.window = global;
global.TsMux = require(R + 'public/js/tsMux');
global.fetch = async (url, opt) => {
  const u = new URL(url, 'http://x'), q = Object.fromEntries(u.searchParams), route = opt.method + ' ' + u.pathname;
  const toBuf = async (b) => Buffer.from(await new Response(b).arrayBuffer());
  const reply = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
  try {
    let out;
    if (route === 'POST /code/html/upload/init') out = await ms.init(UID, JSON.parse(opt.body));
    else if (route === 'PUT /code/html/upload/part') out = await ms.putPart(UID, q, await toBuf(opt.body));
    else if (route === 'POST /code/html/upload/finish') out = await ms.finish(UID, JSON.parse(opt.body));
    else if (route === 'PUT /code/html/upload/seg') {
      parallel++; maxParallel = Math.max(maxParallel, parallel); segCalls++;
      try {
        if (failSegFrom !== null && Number(q.i) >= failSegFrom) throw Object.assign(new TypeError('fetch failed'), {});   // mất mạng (không có status)
        await new Promise((r) => setTimeout(r, 5));
        out = await ms.putSeg(UID, q, await toBuf(opt.body));
      } finally { parallel--; }
    } else if (route === 'POST /code/html/upload/commit') { const b = JSON.parse(opt.body); commits.push({ n: b.segs.length, final: b.final }); out = await ms.commit(UID, b); }
    else return reply(404, { error: 'route lạ ' + route });
    return reply(200, out);
  } catch (e) { if (!e.status) throw e; return reply(e.status, { error: e.message }); }
};
// tăng tốc thử lại
const realSetTimeout = setTimeout; global.setTimeout = (fn, ms2, ...a) => realSetTimeout(fn, Math.min(ms2 || 0, 20), ...a);

require(R + 'public/js/mediaUpload.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-'));
const asFile = (p, name) => { const b = fs.openAsBlob ? null : null; return null; };
async function fileOf(p, name) { const blob = await fs.openAsBlob(p); return Object.assign(blob, { name: name || path.basename(p), lastModified: 1700000000123 }); }
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const manifest = (dir = '') => { const s = files.get(`${UID}/codes/html/${dir ? dir + '/' : ''}mnha-media.json`); return s ? JSON.parse(blobs.get(s)).files : {}; };

(async () => {
  // ---- ảnh nhiều phần (mã hoá) + ảnh không mã hoá
  const img = crypto.randomBytes(150 * 1024); fs.writeFileSync(path.join(tmp, 'p.png'), img);
  const prog = [];
  let r = await MnhaUpload.upload(await fileOf(path.join(tmp, 'p.png')), { dir: '', onProgress: (t, f) => prog.push(f) });
  assert.strictEqual(r.plan, 'direct');
  assert(mc.isEncrypted(blobs.get(files.get(`${UID}/codes/html/p.png`))));
  assert(prog.every((x, i) => i === 0 || x >= prog[i - 1]), 'tiến độ không giảm');
  console.log('✔ ảnh 150KB: ' + Math.ceil(img.length / MEDIA.PART_BYTES) + ' phần → 1 file mã hoá');
  const small = crypto.randomBytes(20 * 1024); fs.writeFileSync(path.join(tmp, 's.jpg'), small);
  await MnhaUpload.upload(await fileOf(path.join(tmp, 's.jpg')), { dir: 'a', encrypt: false });
  assert(blobs.get(files.get(`${UID}/codes/html/a/s.jpg`)).equals(small));
  // ghi đè: từ chối → giữ file cũ
  await assert.rejects(MnhaUpload.upload(await fileOf(path.join(tmp, 's.jpg')), { dir: 'a', encrypt: false, confirmOverwrite: () => false }), (e) => e.cancelled === true);
  console.log('✔ ảnh không mã hoá; ghi đè bị từ chối → huỷ gọn');

  if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('⚠ không có ffmpeg — bỏ qua phần m3u8'); return; }
  // ---- mp3 lớn: song song + gom lô
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=120', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(tmp, 'a.mp3'));
  commits = [];
  r = await MnhaUpload.upload(await fileOf(path.join(tmp, 'a.mp3')), { dir: '', onProgress: () => { } });
  assert.strictEqual(r.plan, 'hls');
  let e = manifest()['a.mp3'];
  assert(e.state === 'ready' && e.done >= 10 && e.done === e.durs.length);
  assert(maxParallel >= 2 && maxParallel <= 3, 'tải đoạn song song tối đa 3, thực tế ' + maxParallel);
  assert(commits.length >= 2 && commits[commits.length - 1].final === true && commits.slice(0, -1).every((c) => c.n >= 8 && !c.final), 'gom lô ≥ 8 đoạn: ' + JSON.stringify(commits));
  assert(Math.abs(e.duration - 120) < 0.5);
  console.log('✔ mp3 120s → ' + e.done + ' đoạn, song song ≤ ' + maxParallel + ', ' + commits.length + ' lần ghi lô (đánh dấu tiến độ trong json)');

  // ---- đứt mạng giữa chừng rồi làm tiếp
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=150', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(tmp, 'b.mp3'));
  failSegFrom = 14; commits = []; segCalls = 0;
  const f1 = await fileOf(path.join(tmp, 'b.mp3'));
  await assert.rejects(MnhaUpload.upload(f1, { dir: 'a' }), /đoạn/);
  let m = manifest('a')['b.mp3'];
  assert(m && m.state === 'uploading' && m.done >= 8 && m.done <= 14, 'đã đánh dấu dở dang: ' + (m && m.done));
  const done1 = m.done;
  console.log('✔ mất mạng ở đoạn 14 → json ghi state=uploading, done=' + done1);
  failSegFrom = null; segCalls = 0;
  const msgs = [];
  r = await MnhaUpload.upload(await fileOf(path.join(tmp, 'b.mp3')), { dir: 'a', onProgress: (t) => msgs.push(t) });
  m = manifest('a')['b.mp3'];
  assert(m.state === 'ready' && m.done === m.durs.length && Math.abs(m.duration - 150) < 0.5, 'đủ 150s: ' + m.duration);
  assert(msgs.some((t) => /Làm tiếp từ đoạn/.test(t)), 'báo làm tiếp');
  assert(segCalls <= m.done - done1 + 1, 'chỉ gửi phần còn thiếu: ' + segCalls + ' lần (còn thiếu ' + (m.done - done1) + ')');
  console.log('✔ chọn lại đúng file → làm tiếp từ đoạn ' + (done1 + 1) + ', chỉ gửi ' + segCalls + ' đoạn còn thiếu, tổng ' + m.duration + 's');

  // ---- video mp4 lớn
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=40', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-b:v', '1200k', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(tmp, 'v.mp4'));
  r = await MnhaUpload.upload(await fileOf(path.join(tmp, 'v.mp4')), { dir: '' });
  e = manifest()['v.mp4']; assert(e.mode === 'hls-video' && e.state === 'ready' && e.drm.method === 'AES-128' && Math.abs(e.duration - 40) < 0.5);
  console.log('✔ mp4 40s → ' + e.done + ' đoạn AES-128, ' + e.duration + 's');

  // ---- video codec thế hệ mới (AV1) → fMP4: client gửi fmt=fmp4 + init, server lưu .m4s + init trong json; đứt mạng rồi tải lại vẫn ra kết quả đúng
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=40', '-c:v', 'libsvtav1', '-preset', '10', '-g', '50', '-pix_fmt', 'yuv420p', '-b:v', '900k', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(tmp, 'av1.mp4'));
  failSegFrom = 3; segCalls = 0;
  await assert.rejects(MnhaUpload.upload(await fileOf(path.join(tmp, 'av1.mp4')), { dir: 'n' }), /đoạn/);
  failSegFrom = null; segCalls = 0;
  const fmsgs = [];
  r = await MnhaUpload.upload(await fileOf(path.join(tmp, 'av1.mp4')), { dir: 'n', onProgress: (t) => fmsgs.push(t) });
  e = manifest('n')['av1.mp4'];
  assert(e.mode === 'hls-video' && e.state === 'ready' && e.segExt === 'm4s' && e.drm.method === 'AES-128' && Math.abs(e.duration - 40) < 0.5, 'fMP4 json: ' + JSON.stringify({ s: e.state, x: e.segExt, d: e.duration }));
  assert(/^av01\./.test(e.codecs) && Buffer.from(e.init, 'base64').toString('latin1', 4, 8) === 'ftyp', 'json có codecs + init');
  assert(files.has(`${UID}/codes/html/n/_media/av1_mp4/seg00000.m4s`) && ![...files.keys()].some((k) => k.includes('_media/av1_mp4/') && k.endsWith('.ts')), 'chỉ có đoạn .m4s');
  assert(fmsgs.some((t) => /fMP4/.test(t)), 'báo tiến độ có ghi fMP4');
  console.log('✔ AV1 40s → ' + e.done + ' đoạn .m4s AES-128 (đứt mạng rồi tải lại), json giữ codecs ' + e.codecs + ' + init.mp4');

  // ---- lỗi: định dạng không cắt được
  fs.writeFileSync(path.join(tmp, 'big.wav'), Buffer.alloc(300 * 1024, 1));
  await assert.rejects(MnhaUpload.upload(await fileOf(path.join(tmp, 'big.wav')), { dir: '' }), /chỉ cắt \(m3u8\) được/);
  fs.writeFileSync(path.join(tmp, 'bad.mp4'), Buffer.alloc(300 * 1024, 9));
  await assert.rejects(MnhaUpload.upload(await fileOf(path.join(tmp, 'bad.mp4')), { dir: '' }), /moov/);
  console.log('✔ wav lớn / mp4 hỏng → báo lỗi rõ ràng, không ghi gì');
  assert(!manifest()['bad.mp4'] && !manifest()['big.wav']);
})().then(() => { fs.rmSync(tmp, { recursive: true, force: true }); console.log('OK html-upload-client'); process.exit(0); })
  .catch((e) => { console.error('✘', e); process.exit(1); });

