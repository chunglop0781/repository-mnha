// services/code/remoteRunner.js — gọi dịch vụ runner C++ riêng (runner/server.js) từ web chính (vd Vercel).
'use strict';
const { CPP_RUNNER_URL, CPP_RUNNER_KEY } = require('../../config/codeConfig');

async function call(method, path, uid, body) {
    let r;
    try {
        r = await fetch(CPP_RUNNER_URL.replace(/\/+$/, '') + path, {
            method, signal: AbortSignal.timeout(8000),
            headers: { 'content-type': 'application/json', 'x-runner-key': CPP_RUNNER_KEY, 'x-uid': String(uid) },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (e) {
        throw Object.assign(new Error('Không kết nối được máy chạy code (runner): ' + (e.cause && e.cause.code || e.message) + '. Nếu dùng gói miễn phí, runner có thể đang khởi động lại — thử lại sau ~30 giây.'), { status: 502 });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Runner lỗi ' + r.status), { status: r.status === 401 ? 502 : r.status });
    return j;
}
// Runner gói free có thể đang "ngủ": thăm dò /health (1 yêu cầu GET, hết hạn nhanh) trước khi gửi lệnh chạy thật,
// để không tạo phiên chạy thừa khi yêu cầu bị treo lúc runner đang khởi động.
async function health(timeoutMs = 6000) {
    try {
        const r = await fetch(CPP_RUNNER_URL.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(timeoutMs) });
        return r.ok;
    } catch (_) { return false; }
}
// Runner có những khả năng nào (đọc từ /health). Runner bản cũ không có cờ srcFiles → không nhận header #include.
async function capabilities(timeoutMs = 6000) {
    try {
        const r = await fetch(CPP_RUNNER_URL.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(timeoutMs) });
        return r.ok ? await r.json().catch(() => ({})) : {};
    } catch (_) { return {}; }
}
async function run(uid, body) {
    if (!(await health())) throw Object.assign(new Error('Máy chạy code đang khởi động (gói miễn phí tự ngủ khi lâu không dùng)...'), { status: 503, wake: true });
    return call('POST', '/run', uid, body);
}
module.exports = {
    enabled: () => !!CPP_RUNNER_URL, health, capabilities,
    run,
    poll: (uid, sid, since) => call('GET', `/session/${sid}?since=${Number(since) || 0}`, uid),
    input: (uid, sid, text) => call('POST', `/session/${sid}/input`, uid, { text }),
    stop: (uid, sid) => call('POST', `/session/${sid}/stop`, uid, {}),
    markSaved: (uid, sid, path) => call('POST', `/session/${sid}/saved`, uid, { path })
};
