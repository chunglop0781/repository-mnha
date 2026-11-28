// node -r ./test/_stubs.js test/code-isolation.js — controller thật: trang soạn C++ chạy bằng trình thông dịch JS (cppJs.js) nên KHÔNG gửi COOP/COEP (mọi trình duyệt như nhau),
// emu8086 cũng không bị ảnh hưởng; trang tự kiểm tra /code/cpp/iso-check (clang WASM, tuỳ chọn) vẫn gửi COOP/COEP theo trình duyệt và có JS hợp lệ.
process.env.CPP_RUN_MODE = 'browser'; delete process.env.CPP_RUNNER_URL; delete process.env.WASMER_SDK_URL;
const assert = require('assert'), vm = require('vm');
const store = require('../services/code/codeStore');
store.readFile = async () => 'int main(){}\n'; store.listResults = async () => []; store.githubUrl = () => 'https://github.com/x';
const ctrl = require('../controllers/code.controller');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const FF_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';

function call(fn, lang, ua, query = {}) {
    const out = { h: {}, vary: [], render: null, body: null };
    const res = { set(k, v) { if (typeof k === 'object') Object.assign(out.h, k); else out.h[k] = v; return this; }, vary(v) { out.vary.push(v); }, status() { return this; },
        render(view, locals) { out.render = { view, locals }; }, type() { return this; }, send(b) { out.body = b; }, json(b) { out.body = b; } };
    const req = { params: { lang }, query: Object.assign({ dir: '', file: lang === 'cpp' ? 'a.cpp' : 'a.asm' }, query), headers: { accept: 'text/html' }, method: 'GET', user: { _id: 'u1', name: 'T' }, get: (k) => (/user-agent/i.test(k) ? ua : undefined) };
    return Promise.resolve(fn(req, res)).then(() => out);
}

(async () => {
    for (const [name, ua] of [['Chrome', CHROME], ['Safari macOS', SAFARI], ['Chrome iPhone', IOS_CHROME], ['Firefox Android', FF_ANDROID]]) {
        const o = await call(ctrl.edit, 'cpp', ua);
        assert.strictEqual(o.render && o.render.view, 'code/editor', name + ': render editor (' + JSON.stringify(o.body) + ')');
        assert(!('Cross-Origin-Embedder-Policy' in o.h) && !('Cross-Origin-Opener-Policy' in o.h), name + ': trang C++ (JS thuần) không cần COOP/COEP');
        assert.strictEqual(o.render.locals.coep, null, name + ': view không có coep');
        assert.strictEqual(o.render.locals.cppMode, 'browser');
        const payload = JSON.parse(o.render.locals.payloadJson.replace(/\\u003c/g, '<'));
        assert.strictEqual(payload.coep, null); assert.strictEqual(payload.cppMode, 'browser');
    }
    let o;
    // emu8086 (JS thuần) không cần cô lập → không gửi COOP/COEP
    o = await call(ctrl.edit, 'emu8086', SAFARI); assert.strictEqual(o.render.view, 'code/editor');
    assert(!('Cross-Origin-Embedder-Policy' in o.h) && !('Cross-Origin-Opener-Policy' in o.h), 'emu8086 không bị gắn COOP/COEP'); assert.strictEqual(o.render.locals.coep, null);

    // trang tự kiểm tra
    for (const [name, ua, coep] of [['Chrome', CHROME, 'credentialless'], ['Safari', SAFARI, 'require-corp']]) {
        o = await call(ctrl.isoCheck, 'cpp', ua);
        assert.strictEqual(o.h['Cross-Origin-Embedder-Policy'], coep); assert(/<title>Kiểm tra C\+\+ WASM/.test(o.body));
        assert.strictEqual(/crossorigin="anonymous"/.test(o.body), coep === 'require-corp', name + ': script cùng origin gắn crossorigin chỉ khi require-corp');
        const scripts = [...o.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        assert(scripts.length === 2, 'có 2 script nội tuyến');
        scripts.forEach((s, i) => assert.doesNotThrow(() => new vm.Script(s), name + ': JS nội tuyến #' + i + ' hợp lệ'));
        assert(/hello MNHA/.test(o.body) && /cache=/.test(o.body));
        assert(/\/api\/wasmer\/registry/.test(o.body) && /netReport/.test(o.body), name + ': iso-check có báo cáo proxy registry');
    }
    console.log('code-isolation: trang C++ (JS thuần) không gắn COOP/COEP, emu8086 không đổi, trang iso-check (WASM) vẫn theo trình duyệt — đạt');
})().catch((e) => { console.error(e); process.exit(1); });
