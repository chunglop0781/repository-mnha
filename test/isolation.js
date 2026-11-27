// node test/isolation.js — chọn COEP theo trình duyệt (Chrome/Edge/Firefox: credentialless · Safari + mọi trình duyệt iOS: require-corp)
const assert = require('assert');
const iso = require('../utils/isolation');

const UA = {
    'Chrome Windows': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', false],
    'Chrome macOS': ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', false],
    'Edge': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', false],
    'Firefox': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', false],
    'Opera': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', false],
    'Chrome Android': ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', false],
    'Samsung Internet': ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', false],
    'Safari macOS': ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', true],
    'Safari iPhone': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', true],
    'Safari iPad': ['Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', true],
    'Chrome iPhone (WebKit)': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1', true],
    'Firefox iPhone (WebKit)': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15', true],
    'Edge iPhone (WebKit)': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 EdgiOS/130.0.0.0 Mobile/15E148 Safari/605.1.15', true],
    'iPad chế độ "desktop site"': ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', true],
};
for (const [name, [ua, webkit]] of Object.entries(UA)) assert.strictEqual(iso.isWebKit(ua), webkit, name + ': isWebKit');
assert.strictEqual(iso.isWebKit(''), false); assert.strictEqual(iso.isWebKit(undefined), false);

const mkRes = () => { const h = {}, varyList = []; return { h, varyList, set(k, v) { h[k] = v; return this; }, vary(v) { varyList.push(v); } }; };
const mkReq = (ua, query = {}) => ({ query, get: (k) => (k.toLowerCase() === 'user-agent' ? ua : undefined) });

for (const [name, [ua, webkit]] of Object.entries(UA)) {
    const res = mkRes(), v = iso.apply(mkReq(ua), res);
    assert.strictEqual(v, webkit ? 'require-corp' : 'credentialless', name);
    assert.strictEqual(res.h['Cross-Origin-Embedder-Policy'], v, name + ': header COEP');
    assert.strictEqual(res.h['Cross-Origin-Opener-Policy'], 'same-origin', name + ': header COOP');
    assert.deepStrictEqual(res.varyList, ['User-Agent'], name + ': Vary: User-Agent');
}
// credentialless theo phiên bản/nền tảng (MDN/caniuse: Firefox Android chưa hỗ trợ; Firefox desktop từ 119; Chrome từ 96)
const CL = {
    'Firefox Android 132': ['Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0', 'require-corp'],
    'Firefox Android tablet': ['Mozilla/5.0 (Android 14; Tablet; rv:132.0) Gecko/132.0 Firefox/132.0', 'require-corp'],
    'Firefox 118': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0', 'require-corp'],
    'Firefox 119': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0', 'credentialless'],
    'Firefox Linux 132': ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'credentialless'],
    'Chrome 95': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.0.0 Safari/537.36', 'require-corp'],
    'Chrome 96': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.0.0 Safari/537.36', 'credentialless'],
    'Chrome Android 130': ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'credentialless'],
    'Samsung Internet 26': ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'credentialless'],
    'Firefox iPhone': ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15', 'require-corp'],
};
for (const [name, [ua, want]] of Object.entries(CL)) assert.strictEqual(iso.pickCoep(mkReq(ua)), want, name);
assert.strictEqual(iso.supportsCredentialless(''), true, 'UA rỗng → giữ mặc định credentialless');
// ép tay
assert.strictEqual(iso.pickCoep(mkReq(UA['Chrome Windows'][0], { coep: 'rc' })), 'require-corp');
assert.strictEqual(iso.pickCoep(mkReq(UA['Safari macOS'][0], { coep: 'cl' })), 'credentialless');
assert.strictEqual(iso.pickCoep(mkReq(UA['Safari macOS'][0], { coep: 'bậy' })), 'require-corp', 'giá trị lạ → quay về đoán theo UA');
// req dạng headers thô (không có .get)
assert.strictEqual(iso.pickCoep({ query: {}, headers: { 'user-agent': UA['Safari iPhone'][0] } }), 'require-corp');
// nguồn SDK: mặc định unpkg; có ENV thì theo ENV
delete process.env.WASMER_SDK_URL;
assert.ok(/^https:\/\/unpkg\.com\/@wasmer\/sdk@/.test(iso.sdkUrl()) || iso.sdkUrl() === '/' + iso.VENDOR_SDK_REL);
process.env.WASMER_SDK_URL = '/x/sdk.mjs'; assert.strictEqual(iso.sdkUrl(), '/x/sdk.mjs'); delete process.env.WASMER_SDK_URL;

// regex /vendor của server.js khớp cả đường dẫn Linux lẫn Windows
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const m = src.match(/if \((\/\[[^\n]*?\/)\.test\(filePath\)\)/); assert(m, 'không tìm thấy regex vendor trong server.js');
const re = eval(m[1]);
assert(re.test('/app/public/vendor/wasmer/index.mjs')); assert(re.test('C:\\app\\public\\vendor\\wasmer\\x.wasm')); assert(!re.test('/app/public/js/cppWasm.js'));
console.log('isolation: ' + (Object.keys(UA).length + Object.keys(CL).length) + ' trình duyệt + ép tay + Vary + regex /vendor — đạt');
