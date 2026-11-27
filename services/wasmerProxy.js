// services/wasmerProxy.js — proxy GraphQL registry cho Wasmer SDK (trang cùng origin → không phụ thuộc CORS của registry.wasmer.io).
// Chỉ chuyển tiếp POST JSON {query: "..."} tới MỘT địa chỉ cố định (WASMER_REGISTRY_URL), không lưu gì vào GitHub/MongoDB.
// ⚠ Proxy này chỉ có tác dụng nếu SDK thật sự gửi truy vấn registry qua /api/wasmer/registry. Tài liệu Wasmer KHÔNG nêu tuỳ chọn
//   `registry` của init() → trang /code/cpp/iso-check đo thực tế (Resource Timing) và báo "đã đi qua proxy" hay chưa.
'use strict';

const REGISTRY = process.env.WASMER_REGISTRY_URL || 'https://registry.wasmer.io/graphql';
const MAX_BODY_BYTES = 16 * 1024;          // truy vấn registry rất nhỏ; chặn việc dùng proxy gửi dữ liệu lớn
const TIMEOUT_MS = 15000;
const WINDOW_MS = 60 * 1000, LIMIT = 120;  // ≤ 120 truy vấn / phút / IP (bộ nhớ từng instance — đủ chặn lạm dụng thô)

const seen = new Map();
function limited(ip, now) {
    now = now || Date.now();
    if (seen.size > 5000) for (const [k, v] of seen) if (now - v.at > WINDOW_MS) seen.delete(k);
    let e = seen.get(ip);
    if (!e || now - e.at > WINDOW_MS) { e = { at: now, n: 0 }; seen.set(ip, e); }
    return ++e.n > LIMIT;
}

function fail(status, message) { return Object.assign(new Error(message), { status }); }

async function graphql(req, res, next) {
    try {
        if (limited(req.ip || (req.socket && req.socket.remoteAddress) || '?')) throw fail(429, 'Quá nhiều truy vấn registry, thử lại sau ít phút.');
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.query !== 'string') throw fail(400, 'Cần JSON { query: "..." }.');
        const payload = JSON.stringify(body);
        if (Buffer.byteLength(payload) > MAX_BODY_BYTES) throw fail(413, 'Truy vấn registry quá lớn.');
        const headers = { 'content-type': 'application/json', 'accept': 'application/json' };
        const auth = req.get('authorization');
        if (auth) headers.authorization = auth;
        const r = await fetch(REGISTRY, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = await r.text();
        res.status(r.status);
        res.set({
            'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.send(text);
    } catch (e) {
        next(e.status ? e : Object.assign(new Error('Không kết nối được Wasmer Registry: ' + e.message), { status: 502 }));
    }
}
module.exports = { graphql, limited, REGISTRY, MAX_BODY_BYTES, LIMIT };
