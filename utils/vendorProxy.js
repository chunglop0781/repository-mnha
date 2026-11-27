// utils/vendorProxy.js — tải thư viện public từ CDN về qua server, sau đó trình duyệt chỉ tải same-origin.
// Mục đích: trang C++ có thể chạy COEP=require-corp (Safari/iOS, Firefox Android…); script CDN ngoài không còn là subresource cross-origin.
// Độ bền: gộp các request đồng thời (1 lần tải), có timeout, và nếu CDN lỗi thì dùng bản cũ trong bộ nhớ (kể cả đã hết hạn).
'use strict';

const SOURCES = Object.freeze({
    tailwind: process.env.VENDOR_TAILWIND_URL || 'https://cdn.tailwindcss.com/3.4.17',
    lucide: process.env.VENDOR_LUCIDE_URL || 'https://unpkg.com/lucide@latest/dist/umd/lucide.js'    // đặt VENDOR_LUCIDE_URL=…/lucide@<phiên bản>/… để ghim phiên bản
});
const TTL_MS = 24 * 60 * 60 * 1000, TIMEOUT_MS = 15000;
const cache = new Map(), inflight = new Map();

async function download(name, url) {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw Object.assign(new Error(`Không tải được vendor ${name}: HTTP ${r.status}`), { status: 502 });
    const out = {
        body: Buffer.from(await r.arrayBuffer()),
        contentType: r.headers.get('content-type') || 'application/javascript; charset=utf-8',
        at: Date.now(), source: r.url || url
    };
    cache.set(name, out);
    return out;
}

async function get(name) {
    const url = SOURCES[name];
    if (!url) throw Object.assign(new Error('Vendor không tồn tại'), { status: 404 });
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    if (!inflight.has(name)) inflight.set(name, download(name, url).finally(() => inflight.delete(name)));
    try { return await inflight.get(name); }
    catch (e) { if (hit) return hit; throw e; }      // CDN lỗi: dùng bản cũ còn hơn mất hết giao diện
}

function handler(name) {
    return async (req, res, next) => {
        try {
            const v = await get(name);
            res.set({
                'Content-Type': v.contentType,
                'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
                'Cross-Origin-Resource-Policy': 'same-origin',
                'X-Content-Type-Options': 'nosniff',
                'X-MNHA-Vendor-Source': v.source
            });
            res.send(v.body);
        } catch (e) { next(e); }
    };
}

module.exports = { handler, get, SOURCES, _cache: cache };
