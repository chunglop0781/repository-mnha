// node test/cpp-wasm.js — chạy NGUYÊN public/js/cppWasm.js (+ perfKit.js, cppShims.js) với Wasmer SDK GIẢ nạp bằng import() thật (data: URL).
// Kiểm: preload 1 lần · dịch lần đầu · cùng code → trúng cache (0 lần dịch) · code khác / header khác → dịch lại · lỗi dịch không bị cache ·
//       cache sống qua "tải lại trang" (Cache Storage) và tự dọn ≤ 6 bản · tự cứu cô lập (?coep=rc) cho Safari.
const assert = require('assert'), vm = require('vm'), fs = require('fs'), path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');

const SDK = `
export async function init() {}
export class Directory {
  constructor() { this.f = new Map(); this.d = new Set(); }
  async createDir(n) { if (this.d.has(n)) throw new Error('exists'); this.d.add(n); }
  async writeFile(n, c) { this.f.set(n, c); }
  async readFile(n) { const v = this.f.get(n); if (v === undefined) throw new Error('no file ' + n); return typeof v === 'string' ? new TextEncoder().encode(v) : v; }
  async readDir() { return [...this.f.keys()]; }
}
const C = () => globalThis.__counts;
export const Wasmer = {
  async fromRegistry() {
    C().registry++;
    return { entrypoint: { async run({ mount }) {
      C().compile++;
      const proj = mount['/project'], text = new TextDecoder().decode(await proj.readFile('main.cpp'));
      if (/SYNTAXERR/.test(text)) return { wait: async () => ({ ok: false, code: 1, stderr: '/project/main.cpp:1: error: boom', stdout: '' }) };
      proj.f.set('main.wasm', new TextEncoder().encode('WASM:' + text));
      return { wait: async () => ({ ok: true, code: 0, stderr: '', stdout: '' }) };
    } } };
  },
  async fromFile(bytes) {
    const prog = new TextDecoder().decode(bytes);
    return { entrypoint: { async run() {
      C().run++;
      const so = new TransformStream(), se = new TransformStream(), si = new TransformStream(), ws = so.writable.getWriter(), we = se.writable.getWriter();
      const done = (async () => {
        let input = '';
        if (/cin/.test(prog)) { const r = si.readable.getReader(); const x = await r.read(); input = new TextDecoder().decode(x.value); }
        await ws.write(new TextEncoder().encode('hello ' + input.trim())); await ws.close(); await we.close();
      })();
      return { stdout: so.readable, stderr: se.readable, stdin: si.writable, wait: async () => { await done; return { ok: true, code: 0 }; } };
    } } };
  }
};`;
const SDK_URL = 'data:text/javascript;base64,' + Buffer.from(SDK).toString('base64');

// Cache Storage giả (dùng chung giữa các "lần tải trang" để mô phỏng cache bền)
function fakeCaches() {
    const stores = new Map();
    const open = async (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const m = stores.get(name);
        return { match: async (req) => (m.has(req.url) ? new Response(m.get(req.url).slice(0)) : undefined), put: async (req, res) => { m.set(req.url, await res.arrayBuffer()); },
            keys: async () => [...m.keys()].map((u) => ({ url: u })), delete: async (req) => m.delete(req.url) };
    };
    return { open, size: (n) => (stores.get(n) ? stores.get(n).size : 0), stores };
}

// Một "tab trình duyệt" mới: nạp lại 3 file JS trong context riêng
function newPage({ caches, isolated = true, payload = { coep: 'credentialless' }, href = 'https://x.test/code/cpp/edit?dir=a&file=b.cpp', secure = true, preloadIdle = true, navigator = {} } = {}) {
    const replaced = [];
    const ctx = { console, TextDecoder, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URL, Map, Object, Array, JSON, Math, Date, Uint8Array, Request, Response, MessageChannel,
        crossOriginIsolated: isolated, isSecureContext: secure, caches, navigator, WASMER_SDK_URL: SDK_URL,
        document: { getElementById: (id) => (id === 'payload' ? { textContent: JSON.stringify(payload) } : null) },
        location: { href, replace: (u) => replaced.push(u) } };
    if (preloadIdle) ctx.requestIdleCallback = (fn) => setTimeout(fn, 0);
    ctx.window = ctx; vm.createContext(ctx);
    ['perfKit.js', 'cppShims.js', 'cppWasm.js'].forEach((f) => new vm.Script(read(f), { filename: f, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInContext(ctx));
    return { ctx, W: ctx.CppWasm, replaced };
}
async function run(W, code, { files = [], input = 'MNHA' } = {}) {
    let out = '', hit = null, compiledCb = false;
    const h = W.start({ code, files, onStatus() { }, onOut(t) { out += t; }, onCache(x) { hit = x; }, onCompiled() { compiledCb = true; } });
    setTimeout(() => h.send(input + '\n'), 5);
    const r = await h.done; return { r, out, hit, compiledCb };
}
const counts = () => (globalThis.__counts = { registry: 0, compile: 0, run: 0 });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const A = '#include <bits/stdc++.h>\nint main(){ std::string s; std::cin >> s; std::cout << s; }';

(async () => {
    // ── 1) tải trước + dịch lần đầu + cache bộ nhớ
    let c = counts(), caches = fakeCaches(), p = newPage({ caches });
    await tick(30); assert.strictEqual(c.registry, 1, 'preload: nạp SDK+clang ngay khi trang rảnh (chưa bấm Chạy)');
    let x = await run(p.W, A);
    assert.strictEqual(x.r.status, 'finished'); assert.strictEqual(x.out, 'hello MNHA'); assert.strictEqual(x.hit, false); assert.strictEqual(c.compile, 1); assert(x.compiledCb);
    assert.strictEqual(c.registry, 1, 'Chạy dùng lại clang đã tải trước, không tải lại');
    // ── 2) cùng code → trúng cache, KHÔNG dịch lại
    x = await run(p.W, A); assert.strictEqual(x.hit, true); assert.strictEqual(c.compile, 1, 'cùng code → 0 lần dịch'); assert.strictEqual(x.out, 'hello MNHA');
    // ── 3) code khác → dịch lại
    x = await run(p.W, A + '\n// khác'); assert.strictEqual(x.hit, false); assert.strictEqual(c.compile, 2);
    // ── 4) header đi kèm đổi nội dung → dịch lại (nếu không sẽ chạy bản cũ!)
    const H1 = [{ name: 'x.hpp', content: 'int f(){return 1;}', src: true }], H2 = [{ name: 'x.hpp', content: 'int f(){return 2;}', src: true }];
    await run(p.W, A, { files: H1 }); assert.strictEqual(c.compile, 3);
    x = await run(p.W, A, { files: H1 }); assert.strictEqual(x.hit, true); assert.strictEqual(c.compile, 3);
    x = await run(p.W, A, { files: H2 }); assert.strictEqual(x.hit, false); assert.strictEqual(c.compile, 4, 'header đổi → dịch lại');
    // file .txt (dữ liệu vào) KHÔNG làm mất cache vì không ảnh hưởng bản dịch
    x = await run(p.W, A, { files: H2.concat([{ name: 'input.txt', content: '123' }]) }); assert.strictEqual(x.hit, true); assert.strictEqual(c.compile, 4);
    // ── 5) lỗi biên dịch: báo lỗi, KHÔNG cache
    const BAD = 'int main(){ SYNTAXERR }';
    x = await run(p.W, BAD); assert.strictEqual(x.r.status, 'compile-error'); assert(/Lỗi biên dịch/.test(x.out) && /main\.cpp:1: error/.test(x.out) && !/\/project\//.test(x.out), 'lỗi hiện đúng, đã bỏ /project/');
    const before = c.compile; x = await run(p.W, BAD); assert.strictEqual(c.compile, before + 1, 'lỗi dịch không được cache');

    // ── 6) "tải lại trang" (context mới, cùng Cache Storage) → cache bền: không dịch lại
    c = counts(); p = newPage({ caches });
    x = await run(p.W, A); assert.strictEqual(x.hit, true, 'cache sống qua lần tải lại trang'); assert.strictEqual(c.compile, 0); assert.strictEqual(x.out, 'hello MNHA');
    // ── 7) cache tự dọn, giữ ≤ 6 bản
    for (let i = 0; i < 9; i++) await run(p.W, A + '\n// biến thể ' + i);
    await tick(20); assert(caches.size('mnha-wasm-v1') <= 6, 'Cache Storage giữ ≤ 6 bản, thực tế ' + caches.size('mnha-wasm-v1'));
    // ── 8) không có Cache Storage (Safari riêng tư/trình duyệt cũ) → vẫn chạy, cache bộ nhớ vẫn hoạt động
    c = counts(); p = newPage({ caches: undefined });
    await run(p.W, A); x = await run(p.W, A); assert.strictEqual(x.hit, true); assert.strictEqual(c.compile, 1);
    // ── 9) Tiết kiệm dữ liệu / mạng 2G → KHÔNG tải trước (vẫn dịch được khi bấm Chạy)
    c = counts(); p = newPage({ caches, navigator: { connection: { saveData: true } } }); await tick(30);
    assert.strictEqual(c.registry, 0, 'saveData → không preload'); x = await run(p.W, A); assert.strictEqual(x.r.status, 'finished'); assert.strictEqual(c.registry, 1, 'bấm Chạy mới tải clang');
    c = counts(); p = newPage({ caches, preloadIdle: true }); await tick(30); assert.strictEqual(c.registry, 1, 'mạng bình thường → preload đúng 1 lần/trang');

    // ── 10) Tự cứu cô lập (Safari bị đoán nhầm UA): chưa cô lập + server gửi credentialless → xin lại trang với ?coep=rc, giữ nguyên dir/file
    counts(); p = newPage({ caches, isolated: false, payload: { coep: 'credentialless' } });
    assert.strictEqual(p.replaced.length, 1); const u = new URL(p.replaced[0]);
    assert.strictEqual(u.searchParams.get('coep'), 'rc'); assert.strictEqual(u.searchParams.get('dir'), 'a'); assert.strictEqual(u.searchParams.get('file'), 'b.cpp');
    assert.strictEqual(p.W._isolationReload, true);
    await tick(30); assert.strictEqual(globalThis.__counts.registry, 0, 'đang chuyển trang → không tải trước clang vô ích');
    // đã ở require-corp mà vẫn không cô lập → đổi nữa cũng vô ích → không lặp
    p = newPage({ caches, isolated: false, payload: { coep: 'require-corp' } }); assert.strictEqual(p.replaced.length, 0);
    // đã thử ?coep=rc rồi → không lặp vô hạn
    p = newPage({ caches, isolated: false, href: 'https://x.test/code/cpp/edit?file=b.cpp&coep=rc' }); assert.strictEqual(p.replaced.length, 0);
    // http thường (không phải secure context) → không thể cô lập, đừng tải lại
    p = newPage({ caches, isolated: false, secure: false }); assert.strictEqual(p.replaced.length, 0);
    // đã cô lập → không làm gì
    p = newPage({ caches, isolated: true }); assert.strictEqual(p.replaced.length, 0);

    console.log('cpp-wasm: preload · cache bản dịch (bộ nhớ + Cache Storage, qua tải lại trang, dọn ≤ 6) · header/lỗi dịch · tự cứu cô lập Safari — đạt');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
