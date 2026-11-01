// test/ts-mux.js — bộ cắt MPEG-TS ở trình duyệt (public/js/tsMux.js) kiểm bằng ffmpeg/ffprobe THẬT.
//   Chạy: node test/ts-mux.js        (cần ffmpeg + ffprobe; thiếu thì bỏ qua)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const TsMux = require('../public/js/tsMux');

const have = (c) => spawnSync(c, ['-version']).status === 0;
if (!have('ffmpeg') || !have('ffprobe')) { console.log('⚠ không có ffmpeg/ffprobe — bỏ qua test ts-mux'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmux-'));
const P = (n) => path.join(dir, n);
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (f, extra = []) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ...extra, f]).toString());
const SEG = 3.5 * 1024 * 1024;
let LIMIT = SEG;

function reader(file) {
  const fd = fs.openSync(file, 'r'), size = fs.statSync(file).size;
  return { size, read: async (a, b) => { const buf = Buffer.alloc(b - a); const n = fs.readSync(fd, buf, 0, b - a, a); return new Uint8Array(buf.buffer, buf.byteOffset, n); } };
}
async function cut(file, ext, opts = {}) {
  const f = await TsMux.open(reader(file), ext, { segSec: opts.segSec || 6, segBytes: opts.segBytes || SEG });
  const segs = []; for await (const s of f.segments(opts.skip || 0)) segs.push(s);
  return { f, segs };
}
function check(name, segs, expect) {
  const all = Buffer.concat(segs.map((s) => Buffer.from(s.bytes)));
  assert.strictEqual(all.length % 188, 0, name + ': độ dài TS phải chia hết 188');
  for (let o = 0; o < all.length; o += 188) assert.strictEqual(all[o], 0x47, name + ': mất đồng bộ 0x47 ở ' + o);
  segs.forEach((s) => assert(s.bytes.length <= LIMIT, name + ': đoạn ' + s.i + ' vượt ' + LIMIT + ' (' + s.bytes.length + ')'));
  segs.forEach((s, i) => assert.strictEqual(s.i, i + (expect.skip || 0)));
  const out = P(name + '.ts'); fs.writeFileSync(out, all);
  // giải mã toàn bộ: không được có lỗi
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.strictEqual(dec.stderr.trim(), '', name + ': ffmpeg báo lỗi giải mã TS:\n' + dec.stderr.slice(0, 600));
  const pr = probe(out);
  const dur = Number(pr.format.duration);
  assert(Math.abs(dur - expect.dur) < 0.35, name + ': thời lượng ' + dur + ' ≠ ' + expect.dur);
  const codecs = pr.streams.map((s) => s.codec_name).sort().join(',');
  assert.strictEqual(codecs, expect.codecs, name + ': codec ' + codecs);
  const sum = segs.reduce((a, s) => a + s.dur, 0);
  assert(Math.abs(sum - expect.dur) < 0.35, name + ': tổng dur các đoạn ' + sum);
  return { out, pr, all };
}
const frames = (f) => Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', f]).toString()).streams[0].nb_read_frames);

(async () => {
  // ---------------- âm thanh
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=45', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', '-metadata', 'title=Thu', P('a.mp3'));
  let r = await cut(P('a.mp3'), 'mp3', { segSec: 10 });
  assert(r.segs.length >= 4 && r.segs.length <= 5, 'mp3 ~45s/10s → 4-5 đoạn, có ' + r.segs.length);
  check('mp3', r.segs, { dur: 45, codecs: 'mp3' });
  console.log('✔ mp3 (ID3v2) → ' + r.segs.length + ' đoạn TS, ffmpeg giải mã sạch, đúng thời lượng');

  // mp3 nhiều kiểu: mono 22.05kHz (MPEG-2 LSF)
  ff('-f', 'lavfi', '-i', 'sine=frequency=300:duration=20', '-ar', '22050', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k', P('b.mp3'));
  r = await cut(P('b.mp3'), 'mp3', { segSec: 7 }); check('mp3lsf', r.segs, { dur: 20, codecs: 'mp3' });
  console.log('✔ mp3 MPEG-2 (22.05kHz mono)');

  ff('-f', 'lavfi', '-i', 'sine=frequency=500:duration=30', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', P('c.aac'));
  r = await cut(P('c.aac'), 'aac', { segSec: 10 }); check('aac', r.segs, { dur: 30, codecs: 'aac' });
  console.log('✔ aac (ADTS)');

  ff('-f', 'lavfi', '-i', 'sine=frequency=600:duration=30', '-c:a', 'aac', '-b:a', '128k', P('d.m4a'));
  r = await cut(P('d.m4a'), 'm4a', { segSec: 10 }); check('m4a', r.segs, { dur: 30, codecs: 'aac' });
  console.log('✔ m4a (mp4 âm thanh → ADTS trong TS)');

  // đoạn bị giới hạn kích thước: segBytes nhỏ ép cắt theo byte dù segSec rất lớn
  r = await cut(P('a.mp3'), 'mp3', { segSec: 1000, segBytes: 100 * 1024 });
  assert(r.segs.length > 10, 'cắt theo byte khi segSec rất lớn, có ' + r.segs.length);
  r.segs.forEach((s) => assert(s.bytes.length <= 100 * 1024, 'đoạn ' + s.i + ' vượt giới hạn byte: ' + s.bytes.length));
  console.log('✔ cắt theo giới hạn byte (' + r.segs.length + ' đoạn, đều ≤ 100KB)');

  // skip (tiếp tục sau khi đứt): đoạn k phải GIỐNG HỆT khi cắt từ đầu (PTS liên tục)
  const full = (await cut(P('a.mp3'), 'mp3', { segSec: 10 })).segs, part = (await cut(P('a.mp3'), 'mp3', { segSec: 10, skip: 2 })).segs;
  assert.strictEqual(part[0].i, 2);
  assert(Buffer.from(part[0].bytes).subarray(376 + 188).equals(Buffer.from(full[2].bytes).subarray(376 + 188)) || part[0].dur === full[2].dur);
  assert.strictEqual(part.length, full.length - 2);
  console.log('✔ tiếp tục từ đoạn k (skip) cho cùng dãy đoạn');

  // ---------------- video: H.264 + AAC, có B-frame (ctts), keyframe mỗi 2 giây
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=40',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p', '-b:v', '1500k',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-shortest', P('v.mp4'));
  r = await cut(P('v.mp4'), 'mp4', { segSec: 6 });
  assert.strictEqual(r.f.kind, 'video'); assert.strictEqual(r.f.total, r.segs.length);
  const c = check('video', r.segs, { dur: 40, codecs: 'aac,h264' });
  assert.strictEqual(frames(c.out), frames(P('v.mp4')), 'số khung hình sau khi cắt phải bằng bản gốc');
  console.log('✔ mp4 H.264+AAC (B-frame, faststart) → ' + r.segs.length + ' đoạn, khung hình khớp ' + frames(c.out));
  // từng đoạn độc lập: bắt đầu bằng keyframe và tự giải mã được
  for (const s of r.segs) {
    const f = P('seg' + s.i + '.ts'); fs.writeFileSync(f, s.bytes);
    const d = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.strictEqual(d.stderr.trim(), '', 'đoạn ' + s.i + ' không tự giải mã được: ' + d.stderr.slice(0, 300));
    const k = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-read_intervals', '%+#1', '-of', 'json', f]).toString());
    assert.strictEqual(k.frames[0].key_frame, 1, 'đoạn ' + s.i + ' phải bắt đầu ở keyframe');
  }
  console.log('✔ mỗi đoạn tự giải mã được và bắt đầu ở keyframe');

  // moov ở CUỐI file (không faststart) + video không có tiếng
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=20', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p', P('n.mp4'));
  r = await cut(P('n.mp4'), 'mp4', { segSec: 5 }); check('video-noaudio', r.segs, { dur: 20, codecs: 'h264' });
  console.log('✔ mp4 moov ở cuối, không có âm thanh');

  // giới hạn byte: bitrate cao → đoạn ngắn hơn nhưng vẫn ≤ giới hạn
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=30', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '6000k', '-pix_fmt', 'yuv420p', P('h.mp4'));
  r = await cut(P('h.mp4'), 'mp4', { segSec: 6 }); check('video-hi', r.segs, { dur: 30, codecs: 'h264' });
  assert(Math.max(...r.segs.map((s) => s.dur)) < 6.5);
  console.log('✔ video bitrate cao: ' + r.segs.length + ' đoạn, mỗi đoạn ≤ ' + (SEG / 1048576).toFixed(1) + 'MB (dài nhất ' + Math.max(...r.segs.map((s) => s.bytes.length)) + ' byte)');

  // GOP nặng hơn 1 đoạn → TỰ CHIA NHỎ (không báo lỗi): đoạn nào cũng ≤ giới hạn, đủ khung hình, ffmpeg giải mã sạch
  LIMIT = 600 * 1024;
  r = await cut(P('h.mp4'), 'mp4', { segSec: 6, segBytes: 600 * 1024 });
  const cs = check('video-split', r.segs, { dur: 30, codecs: 'h264' });
  assert.strictEqual(frames(cs.out), frames(P('h.mp4')), 'chia GOP: số khung hình phải bằng bản gốc');
  LIMIT = SEG;
  console.log('✔ GOP ~750KB, giới hạn đoạn 600KB → tự chia ' + r.segs.length + ' đoạn, khung hình khớp ' + frames(cs.out));
  await assert.rejects(TsMux.open(reader(P('h.mp4')), 'mp4', { segSec: 6, segBytes: 20 * 1024 }), /khung hình đơn lẻ/);
  console.log('✔ chỉ báo lỗi khi 1 khung hình đơn lẻ đã vượt giới hạn');

  // ---------------- video codec THẾ HỆ MỚI → fMP4 (init + moof/mdat), không chuyển mã
  const fm = async (name, vArgs, aArgs, expectCodecs, expectCodecString) => {
    const src = P(name + '.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=30', ...vArgs, ...aArgs, '-shortest', '-movflags', '+faststart', src);
    const f = await TsMux.open(reader(src), 'mp4', { segSec: 6 });
    assert.strictEqual(f.fmt, 'fmp4'); assert.strictEqual(f.kind, 'video');
    assert(expectCodecString.test(f.codecString), name + ': codecString ' + f.codecString);
    const segs = []; for await (const s of f.segments(0)) segs.push(s);
    assert.strictEqual(segs.length, f.total);
    segs.forEach((s) => { assert.strictEqual(Buffer.from(s.bytes).toString('latin1', 4, 8), 'moof'); assert(s.bytes.length <= SEG, name + ': đoạn vượt giới hạn'); });
    const out = P(name + '-cut.mp4'); fs.writeFileSync(out, Buffer.concat([Buffer.from(f.init), ...segs.map((s) => Buffer.from(s.bytes))]));
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.strictEqual(dec.stderr.trim(), '', name + ': ffmpeg báo lỗi giải mã fMP4:\n' + dec.stderr.slice(0, 500));
    assert.strictEqual(frames(out), frames(src), name + ': số khung hình phải bằng bản gốc');
    const pr = probe(out); assert(Math.abs(Number(pr.format.duration) - 30) < 0.5, name + ': thời lượng ' + pr.format.duration);
    assert.strictEqual(pr.streams.map((s) => s.codec_name).sort().join(','), expectCodecs, name + ': codec');
    const t = pr.streams.map((s) => Number(s.start_time)); assert(Math.abs(t[0] - t[1]) < 0.02, name + ': hình–tiếng lệch ' + t.join('/'));
    for (const s of segs) {                      // từng đoạn + init tự giải mã được
      const g = P(name + '-s' + s.i + '.mp4'); fs.writeFileSync(g, Buffer.concat([Buffer.from(f.init), Buffer.from(s.bytes)]));
      const d = spawnSync('ffmpeg', ['-v', 'error', '-i', g, '-f', 'null', '-'], { encoding: 'utf8' });
      assert.strictEqual(d.stderr.trim(), '', name + ' đoạn ' + s.i + ': ' + d.stderr.slice(0, 300));
    }
    const part = []; for await (const s of f.segments(2)) part.push(s);
    assert.strictEqual(part.length, segs.length - 2); assert(Buffer.from(part[0].bytes).equals(Buffer.from(segs[2].bytes)), name + ': skip phải cho đoạn giống hệt');
    console.log('✔ fMP4 ' + name + ' → ' + segs.length + ' đoạn, ' + f.codecString + ', khung hình khớp ' + frames(out) + ', ffmpeg giải mã sạch');
  };
  await fm('av1', ['-c:v', 'libsvtav1', '-preset', '10', '-g', '50', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac', '-b:a', '96k'], 'aac,av1', /^av01\.0\.\d\dM\.08,mp4a\.40\.2$/);
  await fm('hevc', ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=50:min-keyint=50:bframes=2:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac'], 'aac,hevc', /^hvc1\.1\.6\.L\d+\.[0-9A-F.]+,mp4a\.40\.2$/);
  await fm('vp9', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '50'], ['-c:a', 'libopus'], 'opus,vp9', /^vp09\.00\.\d\d\.08,opus$/);
  await fm('h264opus', ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-bf', '2', '-pix_fmt', 'yuv420p'], ['-c:a', 'libopus'], 'h264,opus', /^avc1\.[0-9A-F]{6},opus$/);
  // fMP4 với GOP lớn (keyframe thưa, bitrate cao) → tự chia, vẫn đủ khung hình
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=30', '-c:v', 'libsvtav1', '-preset', '10', '-g', '250', '-pix_fmt', 'yuv420p', '-b:v', '5000k', P('bigav1.mp4'));
  { const f = await TsMux.open(reader(P('bigav1.mp4')), 'mp4', { segSec: 6, segBytes: 500 * 1024 });
    const sg = []; for await (const x of f.segments(0)) sg.push(x);
    sg.forEach((x) => assert(x.bytes.length <= 500 * 1024, 'đoạn fMP4 vượt giới hạn ' + x.bytes.length));
    const o = P('bigav1-cut.mp4'); fs.writeFileSync(o, Buffer.concat([Buffer.from(f.init), ...sg.map((x) => Buffer.from(x.bytes))]));
    const d = spawnSync('ffmpeg', ['-v', 'error', '-i', o, '-f', 'null', '-'], { encoding: 'utf8' }); assert.strictEqual(d.stderr.trim(), '', d.stderr.slice(0, 400));
    assert.strictEqual(frames(o), frames(P('bigav1.mp4'))); console.log('✔ fMP4 AV1 GOP lớn (keyframe mỗi 10s) → tự chia ' + sg.length + ' đoạn ≤ 500KB, khung hình khớp'); }
  // H.264 + AAC vẫn đi đường MPEG-TS như cũ
  assert.strictEqual((await TsMux.open(reader(P('v.mp4')), 'mp4')).fmt, 'ts');

  // codec không hỗ trợ (ProRes / âm thanh lạ) → báo lỗi, nói rõ codec nào được
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', P('x.mov'));
  await assert.rejects(TsMux.open(reader(P('x.mov')), 'mov'), /AV1.*VP9|H\.264.*AV1/);
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', P('ac3.mp4'));
  await assert.rejects(TsMux.open(reader(P('ac3.mp4')), 'mp4'), /AAC.*MP3.*Opus/);
  fs.writeFileSync(P('junk.mp4'), Buffer.alloc(2000, 7));
  await assert.rejects(TsMux.open(reader(P('junk.mp4')), 'mp4'), /moov/);
  await assert.rejects(TsMux.open(reader(P('a.mp3')), 'wav'), /chưa hỗ trợ/);
  // mp4 phân mảnh
  ff('-i', P('v.mp4'), '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov', P('frag.mp4'));
  await assert.rejects(TsMux.open(reader(P('frag.mp4')), 'mp4'), /phân mảnh/);
  console.log('✔ ProRes / âm thanh AC-3 / file hỏng / đuôi lạ / mp4 phân mảnh → lỗi rõ ràng');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK ts-mux');
})().catch((e) => { console.error('✘', e); process.exit(1); });
