// node test/vendor-proxy.js — proxy vendor (Tailwind/Lucide) + proxy GraphQL Wasmer: gộp request, dùng lại bản cũ khi CDN lỗi, kiểm tra đầu vào, giới hạn tần suất.
const assert = require('assert');
const vendor = require('../utils/vendorProxy');
const wasmer = require('../services/wasmerProxy');

const mkRes = () => { const o = { code: 200, h: {}, body: null }; return Object.assign(o, { status(c) { o.code = c; return o; }, set(k, v) { Object.assign(o.h, k); return o; }, send(b) { o.body = b; } }); };
const resp = (body, status = 200, ct = 'application/javascript') => ({ ok: status < 400, status, url: 'https://cdn.example/x.js', headers: { get: (k) => (/content-type/i.test(k) ? ct : null) }, arrayBuffer: async () => Buffer.from(body), text: async () => body });

(async () => {
    // 1) nhiều request đồng thời lúc nguội → chỉ 1 lần tải CDN
    let calls = 0, mode = 'ok';
    global.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); if (mode === 'fail') throw new Error('mạng lỗi'); if (mode === '500') return resp('', 500); return resp('console.log(1)'); };
    const rs = await Promise.all([1, 2, 3, 4].map(() => { const r = mkRes(); return vendor.handler('tailwind')({}, r, (e) => { throw e; }).then(() => r); }));
    assert.strictEqual(calls, 1, 'gộp 4 request đồng thời thành 1 lần tải');
    rs.forEach((r) => { assert.strictEqual(String(r.body), 'console.log(1)'); assert.strictEqual(r.h['Cross-Origin-Resource-Policy'], 'same-origin'); });
    // 2) CDN lỗi sau khi bản cache hết hạn → vẫn trả bản cũ
    vendor._cache.get('tailwind').at = 0; mode = 'fail';
    let r = mkRes(); await vendor.handler('tailwind')({}, r, (e) => { throw e; }); assert.strictEqual(String(r.body), 'console.log(1)', 'dùng bản cũ khi CDN lỗi'); assert.strictEqual(calls, 2);
    vendor._cache.get('tailwind').at = 0; mode = '500';
    r = mkRes(); await vendor.handler('tailwind')({}, r, (e) => { throw e; }); assert.strictEqual(String(r.body), 'console.log(1)', 'HTTP 500 cũng dùng bản cũ');
    // 3) chưa có bản cũ + CDN lỗi → lỗi 502 chuyển cho next (layout.pug sẽ tự lùi về CDN)
    let err = null; await vendor.handler('lucide')({}, mkRes(), (e) => { err = e; }); assert(err && err.status === 502, 'không có bản cũ → 502');
    err = null; await vendor.handler('khong-co')({}, mkRes(), (e) => { err = e; }); assert(err && err.status === 404);

    // 4) proxy GraphQL Wasmer
    let sent = null; global.fetch = async (url, o) => { sent = { url, o }; return resp('{"data":{}}', 200, 'application/json'); };
    const req = (body, ip = '1.1.1.1', auth) => ({ body, ip, get: (k) => (/authorization/i.test(k) ? auth : undefined) });
    r = mkRes(); await wasmer.graphql(req({ query: '{ getPackage(name:"clang/clang"){name} }' }, '9.9.9.9'), r, (e) => { throw e; });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body, '{"data":{}}'); assert.strictEqual(sent.url, wasmer.REGISTRY); assert.strictEqual(sent.o.method, 'POST'); assert(sent.o.signal, 'có timeout');
    for (const bad of [undefined, null, [], 'x', {}, { query: 5 }]) { err = null; await wasmer.graphql(req(bad), mkRes(), (e) => { err = e; }); assert(err && err.status === 400, 'body xấu → 400: ' + JSON.stringify(bad)); }
    err = null; await wasmer.graphql(req({ query: 'x'.repeat(wasmer.MAX_BODY_BYTES + 1) }), mkRes(), (e) => { err = e; }); assert(err && err.status === 413, 'quá lớn → 413');
    sent = null; err = null; await wasmer.graphql(req({ query: '{a}' }, '2.2.2.2', 'Bearer t'), mkRes(), (e) => { err = e; }); assert.strictEqual(sent.o.headers.authorization, 'Bearer t');
    global.fetch = async () => { throw new Error('down'); }; err = null; await wasmer.graphql(req({ query: '{a}' }, '3.3.3.3'), mkRes(), (e) => { err = e; }); assert(err && err.status === 502, 'registry sập → 502');
    // 5) giới hạn tần suất theo IP
    const t = 1e12; let n = 0; while (!wasmer.limited('7.7.7.7', t)) n++; assert.strictEqual(n, wasmer.LIMIT, 'chặn sau đúng ' + wasmer.LIMIT + ' truy vấn');
    assert.strictEqual(wasmer.limited('7.7.7.7', t + 61000), false, 'hết cửa sổ → cho lại'); assert.strictEqual(wasmer.limited('8.8.8.8', t), false, 'IP khác không bị ảnh hưởng');
    console.log('vendor-proxy: gộp request · bản cũ khi CDN lỗi · 502/404 · proxy GraphQL (kiểm tra đầu vào, kích thước, timeout, rate limit) — đạt');
})().catch((e) => { console.error(e); process.exit(1); });
