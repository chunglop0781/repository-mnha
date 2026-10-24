// test/html-online.js — "xem code trên mạng": trang html + css + ảnh/âm thanh/video (mã hoá, m3u8) lấy từ repo GitHub/GitLab (fetch giả),
//   phục vụ qua /preview (HTTP thật), cùng "xem thư mục" (API liệt kê) và các giới hạn an toàn.
//   Chạy: node -r ./test/_stubs.js test/html-online.js
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert'), crypto = require('crypto'), http = require('http');

// ---- repo giả: map đường dẫn → Buffer. Dùng chính mediaCrypto để tạo ảnh mã hoá như app thật.
const mc = require(R + 'services/code/mediaCrypto');
const repo = new Map();
const png = crypto.randomBytes(5000);
repo.set('site/index.html', Buffer.from('<!doctype html><html><head><title>x</title><link rel="stylesheet" href="style.css"></head><body><img src="enc.png"><img src="plain.png"><audio src="song.mp3"></audio></body></html>'));
repo.set('site/style.css', Buffer.from('body{background:#eee}'));
repo.set('site/enc.png', mc.encryptBuffer(png));
repo.set('site/plain.png', png);
repo.set('site/broken.png', Buffer.concat([mc.encryptBuffer(png).subarray(0, 40), Buffer.from('xxxxxxxx')]));
// media m3u8 do app tạo: 3 đoạn .ts mã hoá 2 chiều + json
const hls = require(R + 'services/code/hlsPlaylist');
const tsSeg = (n) => { const b = Buffer.alloc(188 * 4, n); b[0] = 0x47; for (let i = 188; i < b.length; i += 188) b[i] = 0x47; return b; };
const segs = [tsSeg(1), tsSeg(2), tsSeg(3)];
segs.forEach((s, i) => repo.set(`site/_media/song_mp3/${hls.segName(i)}`, mc.encryptBuffer(s)));
repo.set('site/mnha-media.json', Buffer.from(JSON.stringify({ v: 1, files: { 'song.mp3': { name: 'song.mp3', id: 'song_mp3', kind: 'audio', mode: 'hls-audio', segExt: 'ts', state: 'ready', size: 99999999, durs: [10, 10, 5], sizes: segs.map((s) => s.length), done: 3, total: 3, duration: 25, playlist: '_media/song_mp3/index.m3u8' } } })));
repo.set('README.md', Buffer.from('# hi'));
repo.set('site/sub/page2.html', Buffer.from('<p>2</p>'));

let apiCalls = 0, rateLimited = false;
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  const u = new URL(url);
  if (u.hostname === 'raw.githubusercontent.com') {
    // /o/r/main/<path>
    const m = decodeURIComponent(u.pathname).split('/').slice(4).join('/');
    const b = repo.get(m);
    if (!b) return new Response('404', { status: 404 });
    return new Response(b, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(b.length) } });
  }
  if (u.hostname === 'api.github.com') {
    apiCalls++;
    assert(!(opt && opt.headers && (opt.headers.authorization || opt.headers.Authorization)), 'không gửi token tới API');
    if (rateLimited) return new Response('{}', { status: 403 });
    let m = /^\/repos\/o\/r\/contents\/?(.*)$/.exec(decodeURIComponent(u.pathname));
    if (m) {
      const dir = m[1].replace(/\/$/, ''), pre = dir ? dir + '/' : '', seen = new Map();
      for (const p of repo.keys()) { if (!p.startsWith(pre)) continue; const rest = p.slice(pre.length), i = rest.indexOf('/'); if (i >= 0) seen.set(rest.slice(0, i), { name: rest.slice(0, i), type: 'dir', size: 0 }); else seen.set(rest, { name: rest, type: 'file', size: repo.get(p).length }); }
      if (!seen.size) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify([...seen.values()]), { status: 200 });
    }
    if (u.pathname === '/repos/o/r') return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  }
  return new Response('khong cho phep ' + url, { status: 500 });
};

const rs = require(R + 'services/code/remoteSource');
const token = require(R + 'services/code/previewToken');
const preview = require(R + 'services/code/previewServer');

const handler = preview.createHandler({ mount: '/preview' });
const server = http.createServer((req, res) => { req.url = req.url.replace(/^\/preview/, '') || '/'; handler(req, res); });
let PORT;
const get = (u, headers = {}) => new Promise((ok, no) => { http.get({ host: '127.0.0.1', port: PORT, path: u, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }).on('error', no); });

(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); PORT = server.address().port;

  // ---- phân tích link thư mục
  assert.deepStrictEqual(rs.parseFolderUrl('https://github.com/o/r/tree/main/site'), { host: 'github', base: ['o', 'r'], ref: 'main', dirSegs: ['site'] });
  assert.deepStrictEqual(rs.parseFolderUrl('https://github.com/o/r/blob/main/site/index.html').dirSegs, ['site']);
  assert.strictEqual(rs.parseFolderUrl('https://github.com/o/r').ref, null);
  assert.deepStrictEqual(rs.parseFolderUrl('https://gitlab.com/g/s/p/-/tree/dev/a/b'), { host: 'gitlab', base: ['g', 's', 'p'], ref: 'dev', dirSegs: ['a', 'b'] });
  for (const bad of ['http://github.com/o/r/tree/main/x', 'https://evil.com/o/r/tree/main/x', 'https://github.com/o', 'https://user:pw@github.com/o/r', 'not a url', 'https://github.com/o/r/tree/main/a%2fb'])
    assert.throws(() => rs.parseFolderUrl(bad), /.+/, bad);
  console.log('✔ parseFolderUrl: github/gitlab, blob→thư mục cha, gốc repo; chặn http, host lạ, userinfo, %2F');

  // ---- liệt kê thư mục (ẩn _media và mnha-media.json), thư mục trước
  let f = await rs.resolveRef(rs.parseFolderUrl('https://github.com/o/r')); assert.strictEqual(f.ref, 'main');
  let list = await rs.listFolder(f); assert.deepStrictEqual(list.map((x) => x.name + ':' + x.type), ['site:dir', 'README.md:file']);
  f = rs.parseFolderUrl('https://github.com/o/r/tree/main/site'); list = await rs.listFolder(f);
  assert.deepStrictEqual(list.map((x) => x.name), ['sub', 'broken.png', 'enc.png', 'index.html', 'plain.png', 'style.css']);
  assert.strictEqual(rs.treeWeb(f, ['site', 'sub']), 'https://github.com/o/r/tree/main/site/sub');
  rateLimited = true; await assert.rejects(rs.listFolder(f), (e) => e.status === 429 && /giới hạn/.test(e.message)); rateLimited = false;
  await assert.rejects(rs.listFolder(rs.parseFolderUrl('https://github.com/o/r/tree/main/khong-co')), (e) => e.status === 404);
  console.log('✔ listFolder: ẩn _media/mnha-media.json, thư mục trước, 429 khi bị giới hạn, 404; không gửi token');

  // ---- xem trang từ GitHub kèm css/ảnh/media
  const tok = token.sign({ k: 'web', host: 'github', base: ['o', 'r'], ref: 'main' }), U = (p) => `/preview/${tok}/${p}`;
  let r = await get(U('site/index.html')); assert.strictEqual(r.status, 200); assert(r.body.toString().includes('<head><script>('), 'chèn shim');
  r = await get(U('site/style.css')); assert(r.status === 200 && r.body.toString() === 'body{background:#eee}');
  r = await get(U('site/plain.png')); assert(r.status === 200 && r.body.equals(png), 'ảnh bình thường: xem thẳng, không cần giải mã');
  // repo KHÔNG phải repo của app (o/r ≠ GITHUB_OWNER/REPO) → không có khoá chủ của app nào được mở: mọi giải mã đều bị từ chối (xem test/html-keys.js cho repo của app)
  r = await get(U('site/enc.png')); assert.strictEqual(r.status, 403, 'ảnh mã hoá ở repo lạ: không giải mã'); assert(/quyền|phạm vi/.test(JSON.parse(r.body).error));
  r = await get(U('site/enc.png?dl=1')); assert.strictEqual(r.status, 403);
  r = await get(U('site/khong-co.png')); assert.strictEqual(r.status, 404);
  console.log('✔ GitHub: html+css; ảnh thường xem thẳng; ảnh mã hoá ở repo lạ → 403 (không có khoá)');

  // ---- media m3u8 từ repo (đuôi gốc song.mp3 khai báo trong json)
  r = await get(U('site/song.mp3')); assert.strictEqual(r.status, 200); assert(/mpegurl/.test(r.headers['content-type']));
  const urls = r.body.toString().split('\n').filter((l) => l && !l.startsWith('#')); assert.strictEqual(urls.length, 3);
  for (let i = 0; i < 3; i++) { const s = await get(urls[i]); assert.strictEqual(s.status, 403, 'đoạn ' + i + ': repo lạ không được giải mã'); }
  r = await get(U('site/song.mp3?dl=1')); assert.strictEqual(r.status, 403);
  console.log('✔ GitHub: song.mp3 → m3u8 theo json; đoạn mã hoá ở repo lạ → 403');

  // ---- chặn SSRF / đường dẫn lạ
  r = await get(U('site/%2e%2e%2f%2e%2e%2fetc/passwd')); assert([400, 403, 404].includes(r.status));
  const evil = token.sign({ k: 'web', host: 'github', base: ['o', 'r'], ref: '..' }); r = await get(`/preview/${evil}/site/index.html`); assert([400, 404].includes(r.status), 'ref bất thường bị chặn: ' + r.status);
  const evil2 = token.sign({ k: 'web', host: 'evil.com', base: ['o', 'r'], ref: 'main' }); r = await get(`/preview/${evil2}/site/index.html`); assert([400, 403, 404].includes(r.status), 'host lạ bị chặn: ' + r.status);
  console.log('✔ chặn ref/host/đường dẫn bất thường');

  server.close(); global.fetch = realFetch;
})().then(() => { console.log('OK html-online'); process.exit(0); }).catch((e) => { console.error('✘', e); process.exit(1); });
