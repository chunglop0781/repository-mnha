// utils/isolation.js — "cô lập origin" (COOP + COEP) cho trang chạy C++ bằng WebAssembly.
// clang WASM (Wasmer SDK) cần SharedArrayBuffer, mà trình duyệt chỉ bật nó khi trang gửi COOP + COEP.
//   · Chrome/Edge/Opera/Samsung ≥ 96 và Firefox desktop ≥ 119: dùng  COEP: credentialless  (không bắt tài nguyên ngoài phải có CORP).
//   · Mọi trường hợp còn lại dùng  COEP: require-corp  (tài nguyên ngoài phải có CORS/CORP):
//       - Safari macOS và MỌI trình duyệt trên iPhone/iPad (đều là WebKit) — chưa hỗ trợ `credentialless`;
//       - Firefox cho Android — bảng tương thích MDN/caniuse ghi "không hỗ trợ" (bản desktop mới có từ 119);
//       - Chrome/Firefox quá cũ (< 96 / < 119).
//     Script bên thứ ba (Tailwind, Lucide) đã được proxy về cùng origin (utils/vendorProxy.js) nên không bị require-corp chặn.
// Ép tay bằng ?coep=rc (require-corp) hoặc ?coep=cl (credentialless) — client tự dùng ?coep=rc để tự cứu khi đoán sai UA.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_SDK_URL = 'https://unpkg.com/@wasmer/sdk@0.8.0-beta.1/dist/index.mjs';
const VENDOR_SDK_REL = 'vendor/wasmer/index.mjs';                 // do scripts/vendor-wasmer.js tạo ra (tự host SDK)

// true nếu UA là engine WebKit (không có COEP credentialless)
function isWebKit(ua) {
    ua = String(ua || '');
    if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;          // iOS/iPadOS: mọi trình duyệt đều là WebKit
    if (/\bAndroid\b|\bFirefox\/|\bChrome\/|\bChromium\/|\bEdg\/|\bEdgA\/|\bOPR\/|\bSamsungBrowser\//.test(ua)) return false;
    return /\bSafari\/\d/.test(ua) && /\bVersion\/\d/.test(ua);   // Safari macOS (cả iPad ở chế độ "desktop site")
}

// true nếu trình duyệt hiểu COEP: credentialless. Chỉ trả true khi biết chắc; UA lạ → true (giữ hành vi cũ, client tự cứu bằng ?coep=rc).
function supportsCredentialless(ua) {
    ua = String(ua || '');
    if (!ua) return true;
    if (isWebKit(ua)) return false;
    const android = /\bAndroid\b/.test(ua);
    const ff = ua.match(/\bFirefox\/(\d+)/);
    if (ff) return !android && +ff[1] >= 119;                                  // Firefox Android: chưa hỗ trợ; desktop: từ 119
    if (android && /\bGecko\/\d/.test(ua) && !/\bChrome\//.test(ua)) return false;   // vỏ GeckoView khác trên Android
    const cr = ua.match(/\bChrom(?:e|ium)\/(\d+)/);                              // Chrome, Edge, Opera, Samsung đều mang token Chrome/
    if (cr) return +cr[1] >= 96;
    return true;
}

function pickCoep(req) {
    const q = req && req.query && req.query.coep;
    if (q === 'rc') return 'require-corp';
    if (q === 'cl') return 'credentialless';
    const ua = req && (typeof req.get === 'function' ? req.get('user-agent') : (req.headers && req.headers['user-agent']));
    return supportsCredentialless(ua) ? 'credentialless' : 'require-corp';
}

// Gắn header cô lập vào response, trả về giá trị COEP đã dùng.
function apply(req, res) {
    const coep = pickCoep(req);
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Cross-Origin-Embedder-Policy', coep);
    if (typeof res.vary === 'function') res.vary('User-Agent');   // cùng URL, header khác nhau theo trình duyệt → đừng cho cache chung
    return coep;
}

// Địa chỉ SDK: biến môi trường > bản tự host (nếu đã chạy scripts/vendor-wasmer.js) > unpkg.
let _vend = { at: 0, ok: false };
function vendored() {
    const now = Date.now();
    if (now - _vend.at > 30000) {
        _vend = { at: now, ok: fs.existsSync(path.join(__dirname, '..', 'public', VENDOR_SDK_REL)) };
    }
    return _vend.ok;
}
function sdkUrl() {
    if (process.env.WASMER_SDK_URL) return process.env.WASMER_SDK_URL;
    return vendored() ? '/' + VENDOR_SDK_REL : DEFAULT_SDK_URL;
}

module.exports = { isWebKit, supportsCredentialless, pickCoep, apply, sdkUrl, DEFAULT_SDK_URL, VENDOR_SDK_REL };
