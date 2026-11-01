// test/cloudflare-usage.js — (1) kiểm tra MÃ HOÁ cấu hình Cloudflare thật (saveConfig → file → giải mã, hoán trường, sai khoá),
//   (2) đếm GB ghi lên R2 / ghi dự phòng và lưu theo tuần như Vercel, (3) đo dung lượng bucket và lưu vào json.
//   Chạy: node -r ./test/_stubs.js test/cloudflare-usage.js
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
            const xml = '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' + keys.map((k) => '<Contents><Key>' + k.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</Key><Size>' + r2.get(k).length + '</Size></Contents>').join('') + '</ListBucketResult>';
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


// ---------------- chuẩn bị ----------------
const cc = require(R + 'services/connect/crypto');
const cloudflare = require(R + 'services/connect/cloudflare');
const usage = require(R + 'services/connect/usage');
const AK = 'AKIAREALACCESSKEY0001', SK = 'REAL-SECRET-ACCESS-KEY-0123456789abcdef', TOK = 'ghp_REALFALLBACKTOKEN0123456789';
const raw = () => main.blobs.get(main.files.get('v-s/cloudflare.json')).toString('utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('saveConfig: khoá R2 + token dự phòng được mã hoá, file/summary không lộ bản rõ', async () => {
    // file cũ từng lưu 4 ký tự cuối của Secret → lưu lại phải bỏ đi
    main.put('v-s/cloudflare.json', Buffer.from(JSON.stringify({ v: 1, secretHint: 'cdef', fallback: { tokenHint: '6789' } })));
    const sum = await cloudflare.saveConfig({
        accountId: 'a'.repeat(32), bucket: 'mnha-media', accessKeyId: AK, secretAccessKey: SK, mode: 'proxy',
        fallbackOwner: 'fb-owner', fallbackRepo: 'fb-media', fallbackToken: TOK, fallbackPublic: true
    });
    const txt = raw();
    for (const secret of [AK, SK, TOK, 'cdef', '6789']) assert(!txt.includes(secret), 'file json lộ: ' + secret);
    assert(!/secretHint|tokenHint/.test(txt), 'còn hint của secret/token');
    const d = JSON.parse(txt);
    assert(/^v2\.[\w-]+\.[\w-]+\.[\w-]+$/.test(d.accessKeyIdEnc) && /^v2\./.test(d.secretAccessKeyEnc) && /^v2\./.test(d.fallback.tokenEnc));
    assert.strictEqual(cc.decrypt(d.accessKeyIdEnc, 'cloudflare|accessKeyId'), AK);
    assert.strictEqual(cc.decrypt(d.secretAccessKeyEnc, 'cloudflare|secretAccessKey'), SK);
    assert.strictEqual(cc.decrypt(d.fallback.tokenEnc, 'cloudflare|fallbackToken'), TOK);
    const out = JSON.stringify(sum);
    for (const secret of [AK, SK, TOK, d.secretAccessKeyEnc, d.accessKeyIdEnc, d.fallback.tokenEnc]) assert(!out.includes(secret), 'summary lộ khoá/ciphertext');
    assert(sum.secretSaved && sum.fallback.tokenSaved && sum.configured);
    // mỗi lần mã hoá IV khác nhau → cùng khoá cho ra ciphertext khác
    assert.notStrictEqual(cc.encrypt(AK, 'cloudflare|accessKeyId'), cc.encrypt(AK, 'cloudflare|accessKeyId'));
});

t('lưu lại để trống ô bí mật = giữ khoá cũ (không mất, không ghi đè bằng rỗng)', async () => {
    const before = JSON.parse(raw());
    await cloudflare.saveConfig({ accountId: 'a'.repeat(32), bucket: 'mnha-media', accessKeyId: '', secretAccessKey: '', fallbackToken: '', prefix: 'media' });
    const after = JSON.parse(raw());
    assert.strictEqual(after.secretAccessKeyEnc, before.secretAccessKeyEnc);
    assert.strictEqual(after.fallback.tokenEnc, before.fallback.tokenEnc);
    assert.strictEqual(after.prefix, 'media');
    const rt = await cloudflare.runtime({ force: true });
    assert(rt.storage && !rt.error);
});

t('chống tráo / sửa / sai khoá chủ: runtime báo lỗi, không ném, không lộ', async () => {
    const good = JSON.parse(raw());
    const put = (d) => { main.put('v-s/cloudflare.json', Buffer.from(JSON.stringify(d))); cloudflare.invalidate(); };
    // (a) tráo khối mã hoá Secret ↔ Access Key (AAD khác nhau)
    put({ ...good, secretAccessKeyEnc: good.accessKeyIdEnc });
    let rt = await cloudflare.runtime({ force: true });
    assert(!rt.storage && rt.error, 'tráo trường phải bị từ chối');
    // (b) sửa 1 byte ciphertext
    const p = good.secretAccessKeyEnc.split('.'); const ct = Buffer.from(p[3], 'base64url'); ct[0] ^= 1; p[3] = ct.toString('base64url');
    put({ ...good, secretAccessKeyEnc: p.join('.') });
    rt = await cloudflare.runtime({ force: true });
    assert(!rt.storage && rt.error, 'sửa ciphertext phải bị từ chối');
    // (c) sai CONNECT_ENC_KEY
    put(good);
    const old = process.env.CONNECT_ENC_KEY;
    process.env.CONNECT_ENC_KEY = 'wrong-master-key-0123456789-ABCDEFGHIJ'; cc.resetKeys(); cloudflare.invalidate();
    rt = await cloudflare.runtime({ force: true });
    assert(!rt.storage && rt.error, 'sai khoá chủ phải báo lỗi');
    await assert.rejects(() => cloudflare.putObject({ accountId: 'a'.repeat(32), bucket: 'mnha-media' }, 'x/y.bin', Buffer.from('z')));
    process.env.CONNECT_ENC_KEY = old; cc.resetKeys(); cloudflare.invalidate();
    rt = await cloudflare.runtime({ force: true });
    assert(rt.storage && !rt.error, 'đúng khoá chủ lại dùng được');
});

t('đếm GB: ghi/đọc R2 + ghi dự phòng → lưu theo tuần, cloudSummary cộng đúng', async () => {
    const st = (await cloudflare.runtime({ force: true })).storage;
    const fbSt = (await cloudflare.runtime()).fallback;
    const a = crypto.randomBytes(1000), b = crypto.randomBytes(2500);
    await cloudflare.putObject(st, 'u/1/a.bin', a, 'application/octet-stream');
    await cloudflare.putObject(st, 'u/1/b.bin', b, 'application/octet-stream');
    assert((await cloudflare.getObject(st, 'u/1/a.bin')).equals(a));
    await cloudflare.fallbackWriteBinary(fbSt, 'u/1/c.bin', crypto.randomBytes(700));
    const r = await usage.flush({ force: true });
    assert(r.ok, 'flush: ' + JSON.stringify(r));
    const wk = JSON.parse(main.blobs.get(main.files.get(usage.weekPath(usage.weekNo(Date.now())))).toString());
    const row = Object.values(wk.nodes)[0].days[new Date().toISOString().slice(0, 10)];
    assert.strictEqual(row.cfUp, 3500); assert.strictEqual(row.cfDown, 1000); assert.strictEqual(row.fbUp, 700);
    assert(row.cfReq >= 3);
    const cs = await usage.cloudSummary();
    assert.strictEqual(cs.today.cfUp, 3500); assert.strictEqual(cs.week.cfUp, 3500); assert.strictEqual(cs.all.cfUp, 3500);
    assert.strictEqual(cs.days30.cfDown, 1000); assert.strictEqual(cs.all.fbUp, 700);
    assert.strictEqual(cs.days.length, 7); assert.strictEqual(cs.days.find((d) => d.today).cfUp, 3500);
    // flush lần 2 không nhân đôi
    await usage.flush({ force: true });
    assert.strictEqual((await usage.cloudSummary()).all.cfUp, 3500);
    // GB làm tròn 2 số lẻ
    assert.strictEqual(usage.bytesToGb(5 * 1024 ** 3 + 512 * 1024 ** 2), 5.5);
});

t('đo dung lượng bucket: cộng size object thật và lưu vào v-s/cloudflare.json', async () => {
    r2.clear();
    r2.set('media/x/1.bin', crypto.randomBytes(4000)); r2.set('media/x/2.bin', crypto.randomBytes(1234)); r2.set('khac/3.bin', crypto.randomBytes(99));
    const m = await cloudflare.measure();                 // prefix đã lưu = "media"
    assert.strictEqual(m.bytes, 5234); assert.strictEqual(m.objects, 2);
    const d = JSON.parse(raw());
    assert.strictEqual(d.stored.bytes, 5234);
    assert(d.secretAccessKeyEnc && d.fallback.tokenEnc, 'đo xong không được mất khoá đã lưu');
    const sum = await cloudflare.summary();
    assert.strictEqual(sum.stored.objects, 2);
    assert(!JSON.stringify(sum).includes(SK));
    const list = await cloudflare.listObjects((await cloudflare.runtime()).storage, '');
    assert.strictEqual(list.length, 3);
});

t('xoá cấu hình: không còn bản mã hoá nào của khoá', async () => {
    await cloudflare.saveConfig({ clear: true });
    const txt = raw();
    assert(!/accessKeyIdEnc|secretAccessKeyEnc|tokenEnc|stored/.test(txt), txt);
    const rt = await cloudflare.runtime({ force: true });
    assert(!rt.storage);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('✔ ' + name); }
        catch (e) { failed++; console.log('✘ ' + name + '\n   ' + (e && e.stack || e)); }
    }
    if (failed) { console.log('LỖI ' + failed + '/' + tests.length); process.exit(1); }
    console.log('OK cloudflare-usage');
    process.exit(0);
})();
