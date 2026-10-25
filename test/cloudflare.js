// test/cloudflare.js — video/âm thanh lưu Cloudflare R2; R2 lỗi → tự ghi sang repo GitHub dự phòng.
//   Ảnh vẫn đi GitHub. Media cũ không có `storage` vẫn đọc như trước (xem test/html-media.js).
//   Chạy: node -r ./test/_stubs.js test/cloudflare.js
process.env.SESSION_ENC_KEY = 'k'.repeat(40);
process.env.CONNECT_ENC_KEY = 'connect-key-0123456789-abcdefghijklmnop';
delete process.env.MEDIA_DIRECT; delete process.env.MEDIA_RAW_BASE;
const R = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { resolveObjectURL } = require('buffer');

// ---------------- GitHub giả (repo chính + repo dự phòng qua createClient) ----------------
function store() {
    const files = new Map(), blobs = new Map();
    const shaOf = (b) => crypto.createHash('sha1').update(b).digest('hex');
    const put = (p, b) => { const s = shaOf(b); blobs.set(s, b); files.set(p, s); };
    const client = {
        async getRepoTree() { return { files: new Map(files), truncated: false }; },
        async createBlob(b) { const s = shaOf(b); blobs.set(s, b); return s; },
        async getBlobBuffer(s) { return blobs.get(s) || null; },
        async commitFiles(changes) {
            for (const c of changes) { if (c.remove) files.delete(c.path); else if (c.sha) files.set(c.path, c.sha); else put(c.path, c.content); }
            return { commitSha: 'c' + (++client.commits) };
        },
        async writeBinaryFileBig(p, b) { put(p, b); }, async writeBinaryFile(p, b) { put(p, b); },
        async readBinaryFile(p) { const s = files.get(p); return s ? blobs.get(s) : null; },
        async readBinaryFileLarge(p) { const s = files.get(p); return s ? blobs.get(s) : null; },
        async readJsonFile(p) { const s = files.get(p); return s ? JSON.parse(blobs.get(s).toString()) : null; },
        async readJsonFileWithSha(p) { const s = files.get(p); return s ? { sha: s, data: JSON.parse(blobs.get(s).toString()) } : null; },
        async writeJsonFile(p, d) { put(p, Buffer.from(JSON.stringify(d))); },
        async writeJsonFileIfSha(p, d) { put(p, Buffer.from(JSON.stringify(d))); return {}; },
        async deleteFile(p) { files.delete(p); },
        commits: 0
    };
    return { files, blobs, client, put };
}
const main = store(), fb = store();
main.client.isConfigured = true; main.client.owner = 'o'; main.client.repo = 'r'; main.client.branch = 'main';
main.client.createClient = (o = {}) => {
    if (String(o.owner) === 'fb-owner' && String(o.repo) === 'fb-media') return fb.client;
    return main.client;
};
const gp = require.resolve(R + 'services/githubService.js');
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: main.client };

// ---------------- R2 giả + CDN công khai ----------------
const r2 = new Map();
let failPut = false;
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
    const u = new URL(String(url));
    if (/\.r2\.cloudflarestorage\.com$/i.test(u.hostname)) {
        const parts = u.pathname.split('/').filter(Boolean);
        const key = decodeURIComponent(parts.slice(1).join('/'));
        const method = String((opt && opt.method) || 'GET').toUpperCase();
        if (method === 'PUT') {
            if (failPut) return new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
            const b = Buffer.from(await new Response(opt.body).arrayBuffer());
            r2.set(key, b);
            return new Response('', { status: 200 });
        }
        if (method === 'DELETE') { r2.delete(key); return new Response(null, { status: 204 }); }
        if (method === 'HEAD') { const b = r2.get(key); return b ? new Response('', { status: 200, headers: { 'content-length': String(b.length) } }) : new Response('', { status: 404 }); }
        if (method === 'GET' && u.searchParams.get('list-type') === '2') {
            const prefix = u.searchParams.get('prefix') || '';
            const keys = [...r2.keys()].filter((k) => k.startsWith(prefix));
            const xml = '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' + keys.map((k) => '<Contents><Key>' + k.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</Key></Contents>').join('') + '</ListBucketResult>';
            return new Response(xml, { status: 200 });
        }
        if (method === 'GET') { const b = r2.get(key); return b ? new Response(b, { status: 200 }) : new Response('', { status: 404 }); }
        return new Response('bad', { status: 400 });
    }
    if (u.hostname === 'cdn.example.com') {                    // địa chỉ công khai (mode public)
        const key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
        const b = r2.get(key);
        return b ? new Response(b, { status: 200 }) : new Response('', { status: 404 });
    }
    if (u.hostname === 'raw.githubusercontent.com') {          // GitHub dự phòng công khai
        const p = decodeURIComponent(u.pathname).split('/').slice(4).join('/');
        const s = fb.files.get(p);
        return s ? new Response(fb.blobs.get(s), { status: 200 }) : new Response('', { status: 404 });
    }
    return realFetch(url, opt);
};

// ---------------- cấu hình Cloudflare (mã hoá 2 chiều) ----------------
const cc = require(R + 'services/connect/crypto');
const cfg = {
    v: 1, enabled: true, accountId: 'a'.repeat(32), bucket: 'mnha-media', region: 'auto',
    endpoint: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
    prefix: '', publicBase: 'https://cdn.example.com', mode: 'public',
    accessKeyIdEnc: cc.encrypt('AKIA-TEST', 'cloudflare|accessKeyId'),
    secretAccessKeyEnc: cc.encrypt('SECRET-TEST', 'cloudflare|secretAccessKey'),
    keyHint: 'TEST', secretHint: 'TEST',
    fallback: {
        enabled: true, owner: 'fb-owner', repo: 'fb-media', branch: 'main', public: true,
        tokenEnc: cc.encrypt('gh-fallback-token', 'cloudflare|fallbackToken'), tokenHint: 'oken'
    }
};
main.put('v-s/cloudflare.json', Buffer.from(JSON.stringify(cfg)));

const { MEDIA } = require(R + 'config/codeConfig');
MEDIA.DIRECT_MAX = 120 * 1024; MEDIA.PART_BYTES = 64 * 1024;
const ms = require(R + 'services/code/mediaService');
const mc = require(R + 'services/code/mediaCrypto');
const token = require(R + 'services/code/previewToken');
const preview = require(R + 'services/code/previewServer');
const ks = require(R + 'services/code/keyService');
const MM = require(R + 'public/js/mnhaMedia.js');

// ---------------- HTTP preview ----------------
const handler = preview.createHandler({ gh: main.client, mount: '/preview' });
const server = http.createServer((req, res) => { req.url = req.url.replace(/^\/preview/, '') || '/'; handler(req, res); });
let PORT;
const get = (u) => new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: u, method: 'GET', agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
    r.on('error', no); r.end();
});
const json = (r) => JSON.parse(r.body.toString());
const UID = 'u1';
const OT = token.sign({ k: 'own', uid: UID });
const P = (p) => `/preview/${OT}/${p}`;
const upId = () => crypto.randomBytes(16).toString('hex');
const manifest = (dir) => {
    const p = `${UID}/codes/html/${dir ? dir + '/' : ''}mnha-media.json`;
    const s = main.files.get(p);
    return s ? JSON.parse(main.blobs.get(s).toString()) : null;
};

async function directUpload(dir, name, buf) {
    const init = await ms.init(UID, { dir, name, size: buf.length, encrypt: true });
    assert.strictEqual(init.plan, 'direct');
    const r = await ms.putPart(UID, { dir, name, uploadId: init.uploadId, i: 0, n: 1, encrypt: '1' }, buf);
    return { init, r };
}

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); PORT = server.address().port;

    // ============ 1) ảnh vẫn ở GitHub, KHÔNG vào R2
    const png = crypto.randomBytes(20 * 1024);
    const pi = await ms.init(UID, { dir: '', name: 'anh.png', size: png.length, encrypt: true });
    assert.strictEqual(pi.storage, 'github', 'ảnh: github');
    const pr = await ms.putPart(UID, { dir: '', name: 'anh.png', uploadId: pi.uploadId, i: 0, n: 1, encrypt: '1' }, png);
    assert(pr.done && mc.isEncrypted(main.blobs.get(main.files.get(`${UID}/codes/html/anh.png`))), 'ảnh mã hoá trên GitHub');
    assert.deepStrictEqual([...r2.keys()], [], 'R2 không nhận ảnh');
    console.log('✔ ảnh vẫn tải lên GitHub (mã hoá), R2 không nhận ảnh');

    // ============ 2) âm thanh nhỏ → R2; xem qua máy chủ + trình duyệt tự giải mã (URL công khai)
    const wav = crypto.randomBytes(50 * 1024);
    const du = await directUpload('', 'tieng.wav', wav);
    assert.strictEqual(du.init.storage, 'cloudflare');
    assert.strictEqual(du.r.provider, 'cloudflare');
    const e1 = manifest('').files['tieng.wav'];
    assert.strictEqual(e1.mode, 'direct'); assert.strictEqual(e1.storage.provider, 'cloudflare');
    assert(/^[a-f0-9]{32}$/.test(e1.enc.salt), 'json giữ salt (khoá suy ra từ khoá chủ)');
    assert(r2.has(`${UID}/codes/html/tieng.wav`), 'file mã hoá nằm trong R2');
    assert(!main.files.has(`${UID}/codes/html/tieng.wav`), 'không ghi file mới vào GitHub');
    let r = await get(P('tieng.wav')); assert.strictEqual(r.status, 200); assert(r.body.equals(wav), 'máy chủ đọc R2 + giải mã');
    let k = json(await get(P('__key/tieng.wav')));
    assert.strictEqual(k.mode, 'direct'); assert.strictEqual(k.raw, `https://cdn.example.com/${UID}/codes/html/tieng.wav?v=${e1.uploadId}`);
    const kb = Buffer.from(k.key, 'base64');
    let parts = await MM._t.decryptFile(new Uint8Array(r2.get(`${UID}/codes/html/tieng.wav`)), kb);
    assert(Buffer.concat(parts).equals(wav), 'trình duyệt giải mã file tải từ R2/CDN');
    console.log('✔ âm thanh nhỏ → R2, json có storage + salt; xem qua máy chủ và tự giải mã bằng link công khai');

    // ============ 3) HLS trên R2: đoạn + playlist cùng kho, playlist trỏ CDN, key.bin từ json
    const segsPlain = [];
    const size = MEDIA.DIRECT_MAX + 10 * 1024;
    const init = await ms.init(UID, { dir: 'hls', name: 'bai.mp3', size, lastModified: 1, srcName: 'bai.mp3' });
    const key16 = mc.hlsKey(UID, init.uploadId);
    assert.strictEqual(init.plan, 'hls'); assert.strictEqual(init.storage, 'cloudflare');
    for (let i = 0; i < 3; i++) {
        const b = Buffer.alloc(188 * 30, 0xaa); b[0] = 0x47; segsPlain.push(b);
        const sr = await ms.putSeg(UID, { dir: 'hls', name: 'bai.mp3', uploadId: init.uploadId, i }, b);
        assert.strictEqual(sr.provider, 'cloudflare');
        const recs = [{ i, dur: 6, plainSize: b.length, sha: sr.sha, ref: sr.ref, provider: sr.provider, size: sr.size, receipt: sr.receipt }];
        await ms.commit(UID, { dir: 'hls', name: 'bai.mp3', uploadId: init.uploadId, srcName: 'bai.mp3', src: { size, lastModified: 1 }, segs: recs, final: i === 2 });
    }
    const e2 = manifest('hls').files['bai.mp3'];
    assert(e2.state === 'ready' && e2.storage.provider === 'cloudflare' && e2.done === 3);
    assert(r2.has(`${UID}/codes/html/hls/_media/bai_mp3/seg00000.ts`) && r2.has(`${UID}/codes/html/hls/_media/bai_mp3/index.m3u8`), 'đoạn + m3u8 trong R2');
    assert(![...main.files.keys()].some((p) => p.includes('_media/bai_mp3/')), 'không ghi đoạn lên GitHub');
    r = await get(P('hls/bai.mp3')); assert.strictEqual(r.status, 200);
    const pl = r.body.toString(), urls = pl.split('\n').filter((l) => l && !l.startsWith('#'));
    assert(urls.length === 3 && urls.every((x) => x.startsWith(`https://cdn.example.com/${UID}/codes/html/hls/_media/bai_mp3/seg`)), urls.join(' '));
    const keyBody = (await get(pl.match(/URI="([^"]+)"/)[1].replace(/^https?:\/\/[^/]+/, ''))).body;
    assert(keyBody.equals(key16));
    for (let i = 0; i < 3; i++) {
        const seg = await get(P(`hls/_media/bai_mp3/seg${String(i).padStart(5, '0')}.ts`));
        assert.strictEqual(seg.status, 200);
        assert(mc.decryptHlsSegment(seg.body, key16, i).equals(segsPlain[i]), 'máy chủ đọc đoạn từ R2');
        const direct = r2.get(`${UID}/codes/html/hls/_media/bai_mp3/seg${String(i).padStart(5, '0')}.ts`);
        const ck = await MM._t.importCbc(new Uint8Array(keyBody));
        assert(Buffer.from(await MM._t.hlsDecrypt(ck, new Uint8Array(direct), i)).equals(segsPlain[i]), 'trình duyệt giải mã đoạn CDN');
    }
    console.log('✔ HLS: đoạn + m3u8 nằm trên R2, playlist trỏ CDN, key.bin mở từ json; máy chủ/trình duyệt đều giải mã đúng');

    // ============ 4) R2 lỗi khi ghi → tự chuyển sang repo GitHub dự phòng (không đụng tài khoản media)
    failPut = true;
    const fbBuf = crypto.randomBytes(40 * 1024);
    const du2 = await directUpload('', 'duphong.wav', fbBuf);
    assert.strictEqual(du2.r.provider, 'github-fallback');
    assert(/dự phòng/.test(du2.r.notice || ''), 'có thông báo dùng dự phòng');
    const e3 = manifest('').files['duphong.wav'];
    assert.strictEqual(e3.storage.provider, 'github-fallback');
    assert(fb.files.has(`${UID}/codes/html/duphong.wav`), 'file nằm trong repo dự phòng');
    assert(!main.files.has(`${UID}/codes/html/duphong.wav`) && !r2.has(`${UID}/codes/html/duphong.wav`), 'không ghi vào GitHub media/R2');
    r = await get(P('duphong.wav')); assert(r.status === 200 && r.body.equals(fbBuf), 'đọc lại từ repo dự phòng');
    k = json(await get(P('__key/duphong.wav')));
    assert.strictEqual(k.raw, `https://raw.githubusercontent.com/fb-owner/fb-media/main/${UID}/codes/html/duphong.wav?v=${e3.uploadId}`);
    failPut = false;
    console.log('✔ R2 lỗi khi ghi → tự ghi sang repo GitHub dự phòng, đọc/xem lại bình thường');

    // ============ 4b) file nhiều phần: R2 lỗi lúc ghép → file cuối cùng sang dự phòng
    failPut = true;
    const mbuf = crypto.randomBytes(80 * 1024);
    const mi = await ms.init(UID, { dir: '', name: 'nhieu-phan.wav', size: mbuf.length, encrypt: true });
    assert.strictEqual(mi.plan, 'direct');
    const half = mbuf.length >> 1;
    const mparts = [];
    for (let i = 0; i < 2; i++) {
        const body = i ? mbuf.slice(half) : mbuf.slice(0, half);
        const pr = await ms.putPart(UID, { dir: '', name: 'nhieu-phan.wav', uploadId: mi.uploadId, i, n: 2, encrypt: '1' }, body);
        assert.strictEqual(pr.provider, 'github-fallback');
        mparts.push({ i, sha: pr.sha, ref: pr.ref, provider: pr.provider, size: pr.size, receipt: pr.receipt });
    }
    const fin = await ms.finish(UID, { dir: '', name: 'nhieu-phan.wav', uploadId: mi.uploadId, parts: mparts });
    failPut = false;
    assert.strictEqual(fin.storage, 'github-fallback');
    assert(/dự phòng/.test(fin.notice || ''), 'ghép nhiều phần báo dùng dự phòng');
    assert.strictEqual(manifest('').files['nhieu-phan.wav'].storage.provider, 'github-fallback');
    assert(fb.files.has(`${UID}/codes/html/nhieu-phan.wav`), 'file ghép nằm trong repo dự phòng');
    r = await get(P('nhieu-phan.wav')); assert(r.status === 200 && r.body.equals(mbuf), 'đọc file nhiều phần từ dự phòng');
    console.log('✔ file nhiều phần: R2 lỗi lúc ghép → ghi cả file sang repo dự phòng');

    // ============ 5) HLS R2 lỗi → đoạn + m3u8 ghi dự phòng (segStorage), media cũ trên GitHub vẫn đọc
    main.put(`${UID}/codes/html/cu.mp3`, mc.encryptBuffer(Buffer.from('media cũ trên GitHub')));
    r = await get(P('cu.mp3')); assert.strictEqual(r.status, 200); assert(r.body.toString() === 'media cũ trên GitHub', 'media cũ không có storage vẫn qua GitHub');
    failPut = true;
    const init2 = await ms.init(UID, { dir: 'fh', name: 'fb.mp3', size, lastModified: 2, srcName: 'fb.mp3' });
    let last = null, lastCommit = null;
    for (let i = 0; i < 2; i++) {
        const b = Buffer.alloc(188 * 20, 0xbb); b[0] = 0x47;
        const sr = await ms.putSeg(UID, { dir: 'fh', name: 'fb.mp3', uploadId: init2.uploadId, i }, b);
        assert.strictEqual(sr.provider, 'github-fallback');
        last = { i, dur: 6, plainSize: b.length, sha: sr.sha, ref: sr.ref, provider: sr.provider, size: sr.size, receipt: sr.receipt };
        lastCommit = await ms.commit(UID, { dir: 'fh', name: 'fb.mp3', uploadId: init2.uploadId, srcName: 'fb.mp3', src: { size, lastModified: 2 }, segs: [last], final: i === 1 });
    }
    failPut = false;
    assert(/dự phòng/.test(lastCommit.notice || ''), 'commit báo chuyển dự phòng');
    const e4 = manifest('fh').files['fb.mp3'];
    assert.strictEqual(e4.storage.provider, 'github-fallback');
    assert(fb.files.has(`${UID}/codes/html/fh/_media/fb_mp3/seg00000.ts`) && fb.files.has(`${UID}/codes/html/fh/_media/fb_mp3/index.m3u8`), 'đoạn + m3u8 ghi dự phòng');
    assert(![...main.files.keys()].some((p) => p.includes('_media/fb_mp3/')), 'không ghi đoạn mới lên GitHub chính');
    r = await get(P('fh/fb.mp3')); assert.strictEqual(r.status, 200);
    const pl2 = r.body.toString(), urls2 = pl2.split('\n').filter((l) => l && !l.startsWith('#'));
    assert(urls2.length === 2 && urls2.every((x) => x.startsWith('https://raw.githubusercontent.com/fb-owner/fb-media/main/')), urls2.join(' '));
    r = await get(P('fh/_media/fb_mp3/seg00001.ts')); assert.strictEqual(r.status, 200, 'máy chủ đọc đoạn dự phòng');
    console.log('✔ HLS R2 lỗi → đoạn + m3u8 sang repo dự phòng; playlist trỏ raw dự phòng; media cũ trên GitHub vẫn chạy');

    // ============ 6) xoá media trên R2 (purge prefix) + kiểm tra không lộ khoá trong manifest
    await ms.deleteMedia(UID, { dir: 'hls', name: 'bai.mp3' });
    assert(![...r2.keys()].some((x) => x.includes('_media/bai_mp3/')), 'xoá sạch đoạn trên R2');
    const all = [...main.blobs.values()].map((b) => b.toString('utf8')).join('\n');
    assert(!all.includes('AKIA-TEST') && !all.includes('SECRET-TEST') && !all.includes('gh-fallback-token'), 'manifest không chứa khoá thật');
    const sum = await require(R + 'services/connect/cloudflare').summary();
    assert(!JSON.stringify(sum).includes('AKIA-TEST') && !JSON.stringify(sum).includes('SECRET-TEST'), 'summary chỉ trả gợi ý 4 ký tự');
    console.log('✔ xoá media dọn đoạn trên R2; json/summary không chứa khoá R2 hay token dự phòng');

    server.close(); console.log('OK cloudflare');
})().catch((e) => { console.error('✘', e); process.exit(1); });
