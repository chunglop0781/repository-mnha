// test/html-keys.js — trình duyệt TỰ giải mã: keyService (kiểm quyền, khoá riêng từng file, phiếu xem), playlist trỏ GitHub raw, thư viện public/js/mnhaMedia.js
//   Chạy: node -r ./test/_stubs.js test/html-keys.js
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
delete process.env.MEDIA_DIRECT; delete process.env.MEDIA_RAW_BASE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { resolveObjectURL } = require('buffer');

// ---------------- GitHub giả + "raw" giả (global.fetch)
const files = new Map(), blobs = new Map();
const shaOf = (b) => crypto.createHash('sha1').update(b).digest('hex');
const put = (p, b) => { const s = shaOf(b); blobs.set(s, b); files.set(p, s); };
let commits = 0;
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  async getRepoTree() { return { files: new Map(files), truncated: false }; },
  async createBlob(b) { const s = shaOf(b); blobs.set(s, b); return s; },
  async getBlobBuffer(s) { return blobs.get(s) || null; },
  async commitFiles(changes) { commits++; for (const c of changes) { if (c.remove) files.delete(c.path); else if (c.sha) files.set(c.path, c.sha); else put(c.path, c.content); } return { commitSha: 'c' + commits }; },
  async writeBinaryFileBig(p, b) { put(p, b); }, async writeBinaryFile(p, b) { put(p, b); },
  async readBinaryFile(p) { const s = files.get(p); return s ? blobs.get(s) : null; },
  async readJsonFile(p) { const s = files.get(p); return s ? JSON.parse(blobs.get(s).toString()) : null; },
  async writeJsonFile(p, d) { put(p, Buffer.from(JSON.stringify(d))); },
  async deleteFile(p) { files.delete(p); }
};
const gp = R + 'services/githubService.js';
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: fakeGh };

const realFetch = global.fetch;
let rawHits = 0;
global.fetch = async (url, opt) => {
  const u = new URL(String(url));
  if (u.hostname === 'raw.githubusercontent.com') {            // /o/r/main/<path>
    rawHits++;
    const m = decodeURIComponent(u.pathname).split('/').slice(4).join('/');
    const s = files.get(m);
    return s ? new Response(blobs.get(s), { status: 200 }) : new Response('404', { status: 404 });
  }
  return realFetch(url, opt);
};

const { MEDIA } = require(R + 'config/codeConfig');
const ms = require(R + 'services/code/mediaService');
const mc = require(R + 'services/code/mediaCrypto');
const ks = require(R + 'services/code/keyService');
const token = require(R + 'services/code/previewToken');
const preview = require(R + 'services/code/previewServer');
const MM = require(R + 'public/js/mnhaMedia.js');

const handler = preview.createHandler({ gh: fakeGh, mount: '/preview' });
const server = http.createServer((req, res) => { req.url = req.url.replace(/^\/preview/, '') || '/'; handler(req, res); });
let PORT;
const get = (u) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: u, method: 'GET', agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
  r.on('error', no); r.end();
});
const json = (r) => JSON.parse(r.body.toString());
const OWN = 'u1', VIEWER = 'u2';
const webTok = (o = {}) => token.sign({ k: 'web', host: 'github', base: ['o', 'r'], ref: 'main', uid: OWN, viewer: VIEWER, ...o });
const hex = (n) => crypto.randomBytes(n).toString('hex');
const base = (tok) => `http://127.0.0.1:${PORT}/preview/${tok}/`;
const text = async (url) => Buffer.from(await (await resolveObjectURL(url)).arrayBuffer());

async function putEnc(uid, name, plain, parts = 1) {
  const up = hex(16), n = parts, step = Math.ceil(plain.length / n), recs = [];
  for (let i = 0; i < n; i++) {
    const r = await ms.putPart(uid, { dir: '', name, uploadId: up, i, n, encrypt: '1' }, Buffer.from(plain.subarray(i * step, (i + 1) * step)));
    if (n === 1) return;
    recs.push({ i, sha: r.sha, size: r.size, receipt: r.receipt });
  }
  await ms.finish(uid, { dir: '', name, uploadId: up, parts: recs });
}

(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); PORT = server.address().port;
  const png = crypto.randomBytes(40 * 1024), big = crypto.randomBytes(180 * 1024), priv = crypto.randomBytes(9000);
  MEDIA.PART_BYTES = 64 * 1024;
  await putEnc(OWN, 'a.png', png);
  await putEnc(OWN, 'big.png', big, 3);
  await putEnc(OWN, 'priv.png', priv);
  await ms.setPublic(OWN, { dir: '', name: 'priv.png', public: false });
  put(`${OWN}/codes/html/plain.png`, png);
  const OT = token.sign({ k: 'own', uid: OWN });

  // ============ 1) khoá riêng từng file → trình duyệt giải mã đúng
  let r = await get(`/preview/${OT}/__key/a.png`); assert.strictEqual(r.status, 200); let k = json(r);
  assert.strictEqual(k.mode, 'direct'); assert(/^https:\/\/raw\.githubusercontent\.com\/o\/r\/main\/u1\/codes\/html\/a\.png\?v=[0-9a-f]{40}$/.test(k.raw), k.raw);
  const kb = Buffer.from(k.key, 'base64'); assert.strictEqual(kb.length, 32);
  const stored = blobs.get(files.get(`${OWN}/codes/html/a.png`));
  assert(kb.equals(mc.fileKey(mc.saltOf(stored))), 'khoá = HKDF(khoá chủ, salt trong header file)');
  const kBig = Buffer.from(json(await get(`/preview/${OT}/__key/big.png`)).key, 'base64');
  assert(!kBig.equals(kb), 'mỗi file một khoá riêng');
  assert(!r.body.toString().includes(Buffer.from(process.env.SESSION_ENC_KEY).toString('base64')), 'khoá chủ không có trong phản hồi');
  assert(/no-store/.test(r.headers['cache-control']));
  let parts = await MM._t.decryptFile(new Uint8Array(stored), kb); assert(Buffer.concat(parts).equals(png));
  const storedBig = blobs.get(files.get(`${OWN}/codes/html/big.png`));
  parts = await MM._t.decryptFile(new Uint8Array(storedBig), kBig); assert(Buffer.concat(parts).equals(big) && parts.length === 3);
  await assert.rejects(MM._t.decryptFile(new Uint8Array(stored), kBig), (e) => e.code === 'AUTH');
  const bent = Buffer.from(stored); bent[bent.length - 4] ^= 1; await assert.rejects(MM._t.decryptFile(new Uint8Array(bent), kb), (e) => e.code === 'AUTH');
  console.log('✔ __key: khoá riêng từng file; trình duyệt (WebCrypto) giải mã đúng 1 khối / 3 khối; sai khoá hoặc bị sửa → AUTH');

  // thư viện: open() = hỏi khoá → tải raw → giải mã → blob
  const rawBefore = rawHits;
  let o = await MM.open(base(OT) + 'a.png', 'a.png'); assert.strictEqual(o.type, 'blob'); assert((await text(o.url)).equals(png)); MM.revoke(o.url);
  o = await MM.open(base(OT) + 'plain.png', 'plain.png'); assert((await text(o.url)).equals(png), 'ảnh thường: tải thẳng, không giải mã');
  assert.strictEqual(rawHits - rawBefore, 2, 'file mã hoá tải từ raw (không qua máy chủ)');
  console.log('✔ MnhaMedia.open: hỏi khoá → tải GitHub raw → giải mã → blob (ảnh mã hoá và ảnh thường)');

  // giải mã LUỒNG (dùng cho tải về): cắt response thành mẩu ngẫu nhiên
  const chunky = (buf) => { let o2 = 0; return new ReadableStream({ pull(c) { if (o2 >= buf.length) return c.close(); const n = 1 + Math.floor(Math.random() * 20000); c.enqueue(new Uint8Array(buf.subarray(o2, o2 + n))); o2 += n; } }); };
  const got = []; for await (const b of MM._t.decryptStream(chunky(storedBig), kBig)) got.push(Buffer.from(b));
  assert(Buffer.concat(got).equals(big) && got.length === 3, 'giải mã luồng từng khối');
  await assert.rejects(async () => { for await (const _ of MM._t.decryptStream(chunky(storedBig.subarray(0, storedBig.length - 10)), kBig)); }, (e) => e.code === 'BAD_FORMAT');
  console.log('✔ giải mã LUỒNG theo từng khối (RAM chỉ giữ 1 khối); file bị cắt cụt → báo lỗi');

  // ============ 2) kiểm quyền
  const W = webTok(), P = (t, rel) => `/preview/${t}/${OWN}/codes/html/${rel}`;
  r = await get(P(W, '__key/a.png')); assert.strictEqual(r.status, 200, 'người khác xem file công khai');
  r = await get(P(W, '__key/priv.png')); assert.strictEqual(r.status, 403); assert(/tắt công khai/.test(json(r).error), 'file riêng tư: người khác bị từ chối');
  r = await get(P(W, 'priv.png')); assert.strictEqual(r.status, 403, 'đường dự phòng (Node giải mã) cũng từ chối file riêng tư');
  r = await get(P(W, 'a.png')); assert(r.status === 200 && r.body.equals(png), 'đường dự phòng: file công khai vẫn giải mã được');
  r = await get(P(webTok({ viewer: OWN }), '__key/priv.png')); assert.strictEqual(r.status, 200, 'chủ link xem file riêng tư của mình');
  r = await get(P(webTok({ uid: undefined }), '__key/a.png')); assert.strictEqual(r.status, 403, 'token web không có uid chủ → từ chối');
  r = await get(P(webTok({ base: ['x', 'y'] }), '__key/a.png')); assert.strictEqual(r.status, 403, 'repo không phải của app → từ chối');
  r = await get(`/preview/${W}/u3/codes/html/__key/a.png`); assert.strictEqual(r.status, 403, 'thư mục của người khác ngoài phạm vi link');
  r = await get(`/preview/${W}/${OWN}/result/__key/x.json`); assert.strictEqual(r.status, 403, 'ngoài {uid}/codes/html');
  r = await get(`/preview/${token.sign({ k: 'own', uid: VIEWER })}/__key/a.png`); assert.strictEqual(r.status, 404, 'token own của người khác không thấy file của u1');
  r = await get(`/preview/${W}x/__key/a.png`); assert.strictEqual(r.status, 403);
  console.log('✔ kiểm quyền: công khai/riêng tư, chủ vs người xem, repo lạ, uid khác, ngoài codes/html, token giả');

  // ============ 3) phiếu xem ở {viewer}/keys/
  assert(files.has(`${VIEWER}/keys/.mnha-keys`) && files.has(`${VIEWER}/keys/index.json`), 'có thư mục khoá + file đánh dấu');
  const idx = JSON.parse(blobs.get(files.get(`${VIEWER}/keys/index.json`)));
  assert(idx.views[`${OWN}/`] && idx.views[`${OWN}/`].owner === OWN);
  const dump = blobs.get(files.get(`${VIEWER}/keys/index.json`)).toString() + blobs.get(files.get(`${VIEWER}/keys/.mnha-keys`)).toString();
  assert(!dump.includes(k.key) && !dump.includes(mc.saltOf(stored).toString('hex')), 'phiếu xem chỉ có định danh, không có khoá');
  const c0 = commits; await get(P(W, '__key/big.png')); assert.strictEqual(commits, c0, 'đã có phiếu → không commit lại');
  assert(![...files.keys()].some((p) => p.startsWith(`${OWN}/keys/`)), 'chủ xem file của mình không sinh phiếu');
  console.log('✔ phiếu xem ghi vào {viewer}/keys/ (có .mnha-keys), không chứa khoá, không commit lặp');

  // ============ 4) playlist m3u8: AES-128 → đoạn tải thẳng GitHub raw; âm thanh cũ (MNHAENC1) → vẫn qua máy chủ
  const up = hex(16), key16 = mc.hlsKey(OWN, up);
  const segPlain = [0, 1, 2].map(() => { const b = Buffer.alloc(188 * 20, 0xaa); b[0] = 0x47; return b; });
  const dirp = `${OWN}/codes/html`;
  segPlain.forEach((s, i) => put(`${dirp}/_media/song_mp3/seg0000${i}.ts`, mc.encryptHlsSegment(s, key16, i)));
  segPlain.forEach((s, i) => put(`${dirp}/_media/old_mp3/seg0000${i}.ts`, mc.encryptBuffer(s)));
  const mk = (name, id, extra) => ({ name, id, kind: 'audio', mode: 'hls-audio', segExt: 'ts', state: 'ready', size: 99999999, durs: [6, 6, 6], sizes: segPlain.map((s) => s.length), uploadId: up, ...extra });
  put(`${dirp}/mnha-media.json`, Buffer.from(JSON.stringify({ v: 1, private: ['hidden.mp3'], files: {
    'song.mp3': mk('song.mp3', 'song_mp3', { drm: { method: 'AES-128', key: mc.wrapKey(key16) } }), 'old.mp3': mk('old.mp3', 'old_mp3'),
    'hidden.mp3': mk('hidden.mp3', 'song_mp3', { drm: { method: 'AES-128', key: mc.wrapKey(key16) } }) } })));
  r = await get(`/preview/${OT}/song.mp3`); assert.strictEqual(r.status, 200);
  let pl = r.body.toString(); const urls = pl.split('\n').filter((l) => l && !l.startsWith('#'));
  assert(urls.every((u2, i) => u2 === `https://raw.githubusercontent.com/o/r/main/u1/codes/html/_media/song_mp3/seg0000${i}.ts?v=${up}`), urls.join(' '));
  const kuri = pl.match(/URI="([^"]+)"/)[1]; assert(kuri.startsWith(`/preview/${OT}/_media/song_mp3/key.bin`) || kuri.includes('/key.bin'));
  const kr = await get(kuri.replace(/^https?:\/\/[^/]+/, '')); assert(kr.status === 200 && kr.body.equals(key16), 'key.bin = khoá thật mở từ json');
  const parsed = MM._t.parsePlaylist(pl, 'http://x/p'); assert.strictEqual(parsed.segs.length, 3); assert(parsed.keyUri);
  const ck = await MM._t.importCbc(new Uint8Array(kr.body));
  for (let i = 0; i < 3; i++) {
    const enc = (await (await fetch(urls[i])).arrayBuffer()); const plain = await MM._t.hlsDecrypt(ck, new Uint8Array(enc), i);
    assert(Buffer.from(plain).equals(segPlain[i]), 'trình duyệt giải mã đoạn ' + i + ' (AES-128-CBC, IV = số thứ tự)');
  }
  r = await get(`/preview/${OT}/old.mp3`); pl = r.body.toString();
  assert(!pl.includes('raw.githubusercontent') && !pl.includes('EXT-X-KEY') && pl.includes(`/preview/${OT}/_media/old_mp3/seg00000.ts`), 'âm thanh cũ: không có khoá DRM → đoạn vẫn qua máy chủ');
  r = await get(`/preview/${OT}/_media/old_mp3/seg00001.ts`); assert(r.status === 200 && r.body.equals(segPlain[1]), 'âm thanh cũ: Node giải mã đoạn');
  r = await get(P(W, '_media/old_mp3/seg00001.ts')); assert.strictEqual(r.status, 200, 'người khác + file công khai: đường dự phòng OK');
  // riêng tư: key.bin bị từ chối với người khác
  r = await get(P(W, '_media/song_mp3/key.bin')); assert.strictEqual(r.status, 200, 'song.mp3 công khai: key.bin cho người xem');
  r = await get(P(W, 'hidden.mp3')); assert.strictEqual(r.status, 200, 'playlist không chứa khoá');
  put(`${dirp}/sec/mnha-media.json`, Buffer.from(JSON.stringify({ v: 1, private: ['sec.mp3'], files: { 'sec.mp3': mk('sec.mp3', 'sec_mp3', { drm: { method: 'AES-128', key: mc.wrapKey(key16) } }) } })));
  r = await get(P(W, 'sec/_media/sec_mp3/key.bin')); assert.strictEqual(r.status, 403, 'media m3u8 riêng tư: người khác không lấy được key.bin');
  r = await get(`/preview/${OT}/sec/_media/sec_mp3/key.bin`); assert.strictEqual(r.status, 200, 'chủ vẫn lấy được');
  r = await get(P(W, 'sec/__key/sec.mp3')); assert.strictEqual(r.status, 403);
  r = await get(`/preview/${W}/${OWN}/codes/html/__key/song.mp3`); assert(r.status === 200 && json(r).mode === 'hls' && json(r).drm === true);
  console.log('✔ m3u8 AES-128: đoạn trỏ GitHub raw (?v=uploadId), key.bin do máy chủ trả, trình duyệt giải mã đúng; âm thanh cũ vẫn chạy qua máy chủ');

  // tắt tải thẳng → playlist + html quay về đường máy chủ
  process.env.MEDIA_DIRECT = 'off';
  r = await get(`/preview/${OT}/song.mp3`); assert(!r.body.toString().includes('raw.githubusercontent') && r.body.toString().includes(`/preview/${OT}/_media/song_mp3/seg00000.ts`));
  r = await get(`/preview/${OT}/__key/a.png`); assert.strictEqual(r.status, 200); assert.strictEqual(json(r).raw, null, 'MEDIA_DIRECT=off: không có địa chỉ raw');
  delete process.env.MEDIA_DIRECT;
  console.log('✔ MEDIA_DIRECT=off: mọi thứ quay về máy chủ');

  // ============ 5) HTML: src tương đối → data-mnha-src; shim + thư viện
  put(`${dirp}/site/index.html`, Buffer.from('<!DOCTYPE html><html><head><title>t</title></head><body><img src="../a.png" alt=x><img src=\'b.jpg\'><audio controls src="s.mp3"></audio><video><source src="v.mp4" type="video/mp4"></video><img src="https://x.com/e.png"><img src="/abs.png"><img src="data:image/png;base64,AA"><img src="icon.svg"><script src="main.js"></script></body></html>'));
  r = await get(`/preview/${OT}/site/index.html`); const html = r.body.toString();
  assert(/<head><script src="\/js\/mnhaMedia\.js"><\/script><script>\(/.test(html), 'thư viện giải mã + shim ngay sau <head>');
  for (const v of ['../a.png', 'b.jpg', 's.mp3', 'v.mp4']) assert(html.includes(`data-mnha-src="${v}"`) || html.includes(`data-mnha-src='${v}'`), v + ' → data-mnha-src');
  for (const v of ['https://x.com/e.png', '/abs.png', 'data:image/png;base64,AA', 'icon.svg', 'main.js']) assert(html.includes(`src="${v}"`), v + ' giữ nguyên');
  assert.strictEqual(preview.rewriteMedia('<p>src="a.png"</p>'), '<p>src="a.png"</p>');
  console.log('✔ HTML: src tương đối tới ảnh/âm thanh/video → data-mnha-src; link ngoài, tuyệt đối, data:, svg, js giữ nguyên');

  // ============ 5b) nút Tải trong iframe sandbox (origin "null"): không ghi đĩa được → nhờ trang cha; đứng một mình → máy chủ lo
  {
    const save = { location: globalThis.location, parent: globalThis.parent, document: globalThis.document };
    const posted = []; let click = null;
    const mkEv = (href) => { const a = { getAttribute: (k) => (k === 'href' ? href : k === 'download' ? 'phim.mp4' : null), href, textContent: '⬇ Tải' }; const ev = { target: { closest: () => a }, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} }; return ev; };
    globalThis.document = { baseURI: `http://127.0.0.1:${PORT}/preview/tok/` };
    globalThis.location = { origin: 'null', href: 'about:srcdoc' };
    globalThis.parent = { postMessage: (m, o) => posted.push([m, o]) };
    MM.bindDownloads({ addEventListener: (t, fn) => { click = fn; } }, {});
    const dl = `http://127.0.0.1:${PORT}/preview/tok/dir/phim.mp4?dl=1`;
    let ev = mkEv(dl); click(ev);
    assert(ev.prevented && posted.length === 1, 'iframe sandbox: chặn tải mặc định, gửi yêu cầu cho trang cha');
    assert.deepStrictEqual(posted[0][0], { mnha: 1, type: 'download', url: `http://127.0.0.1:${PORT}/preview/tok/dir/phim.mp4`, name: 'phim.mp4' });
    ev = mkEv(`http://127.0.0.1:${PORT}/other/phim.mp4?dl=1`); click(ev); assert(!ev.prevented && posted.length === 1, 'link ngoài /preview: bỏ qua');
    globalThis.parent = globalThis;           // mở thẳng /preview (không có trang cha) → không chặn, máy chủ tải như cũ
    ev = mkEv(dl); click(ev); assert(!ev.prevented && posted.length === 1, 'không có trang cha: để máy chủ lo');
    for (const k of Object.keys(save)) { if (save[k] === undefined) delete globalThis[k]; else globalThis[k] = save[k]; }
    console.log('✔ nút Tải trong iframe sandbox → nhờ trang cha tải (postMessage); đứng một mình → qua máy chủ như cũ');
  }

  // ============ 6) giới hạn tần suất
  assert.throws(() => { for (let i = 0; i < 700; i++) ks.throttle('t:test-spam'); }, (e) => e.status === 429);
  console.log('✔ giới hạn tần suất xin khoá theo token (429)');
  server.close(); console.log('OK html-keys');
})().catch((e) => { console.error(e); process.exit(1); });
