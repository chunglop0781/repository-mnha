// runner/server.js — dịch vụ chạy C++ riêng (Docker, có g++). Web chính (Vercel) gọi sang đây.
// Không phụ thuộc package ngoài (chỉ module có sẵn của Node) và dùng lại services/code/cppRunner.js.
//   POST /run                {uid, file, dir, code, files:[{name,content}]} → {sid}
//   GET  /session/:sid?since=N                                              → trạng thái + đầu ra (kèm result khi xong)
//   POST /session/:sid/input {text} | /stop | /saved {path}
//   GET  /health
// Mọi lời gọi (trừ /health) phải có header  x-runner-key = CPP_RUNNER_KEY  và  x-uid = id người dùng.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { CppSession } = require('../services/code/cppRunner');
const { LIMITS } = require('../config/codeConfig');

const KEY = process.env.CPP_RUNNER_KEY || '';
if (KEY.length < 16) { console.error('Thiếu CPP_RUNNER_KEY (≥ 16 ký tự). Dừng.'); process.exit(1); }
const PORT = Number(process.env.PORT) || 8080;
const MAX_ACTIVE_TOTAL = Number(process.env.RUNNER_MAX_ACTIVE) || 8;
const sessions = new Map();

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const active = (uid) => { let n = 0; for (const s of sessions.values()) if ((uid == null || s.uid === uid) && s.impl.status !== 'finished') n++; return n; };

function readBody(req) {
    return new Promise((resolve, reject) => {
        let d = '', n = 0;
        req.on('data', (c) => { n += c.length; if (n > 400 * 1024) { reject(Object.assign(new Error('Body quá lớn'), { status: 413 })); req.destroy(); } else d += c; });
        req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (_) { reject(Object.assign(new Error('JSON sai'), { status: 400 })); } });
        req.on('error', reject);
    });
}
function send(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); }

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/health') return send(res, 200, { ok: true, active: active() });
        if (!safeEq(req.headers['x-runner-key'] || '', KEY)) return send(res, 401, { error: 'Sai khoá runner' });
        const uid = String(req.headers['x-uid'] || '');
        if (!uid) return send(res, 400, { error: 'Thiếu x-uid' });

        if (req.method === 'POST' && url.pathname === '/run') {
            const b = await readBody(req);
            if (active(uid) >= LIMITS.MAX_SESSIONS_PER_USER) return send(res, 429, { error: 'Bạn đang chạy quá nhiều chương trình cùng lúc — hãy dừng bớt.' });
            if (active() >= MAX_ACTIVE_TOTAL) return send(res, 503, { error: 'Máy chạy code đang bận, thử lại sau ít giây.' });
            const code = String(b.code == null ? '' : b.code);
            if (code.length > 200 * 1024) return send(res, 400, { error: 'Code quá dài' });
            const files = (Array.isArray(b.files) ? b.files : []).slice(0, LIMITS.MAX_FILES_PER_DIR_SYNC)
                .map((f) => ({ name: String(f.name || ''), content: String(f.content || '').slice(0, LIMITS.MAX_FILE_BYTES) }));
            const impl = new CppSession({ code, files });
            const sid = crypto.randomBytes(12).toString('hex');
            sessions.set(sid, { id: sid, uid, impl, createdAt: Date.now(), savedPath: null, meta: { file: String(b.file || ''), dir: String(b.dir || ''), origin: String(b.origin || ''), source: code } });
            impl.start();
            return send(res, 200, { sid });
        }
        const m = url.pathname.match(/^\/session\/(\w+)(?:\/(input|stop|saved))?$/);
        if (m) {
            const s = sessions.get(m[1]);
            if (!s || s.uid !== uid) return send(res, 404, { error: 'Phiên chạy không còn (có thể runner đã khởi động lại).' });
            if (req.method === 'GET' && !m[2]) {
                const v = s.impl.view(Number(url.searchParams.get('since')) || 0);
                const out = { ...v, saved: s.savedPath };
                if (v.status === 'finished') { out.result = s.impl.result(); out.meta = s.meta; }
                return send(res, 200, out);
            }
            if (req.method === 'POST' && m[2] === 'input') { const b = await readBody(req); return send(res, 200, { ok: s.impl.sendInput(b.text) }); }
            if (req.method === 'POST' && m[2] === 'stop') { s.impl.stop(); return send(res, 200, { ok: true }); }
            if (req.method === 'POST' && m[2] === 'saved') { const b = await readBody(req); s.savedPath = String(b.path || ''); return send(res, 200, { ok: true }); }
        }
        send(res, 404, { error: 'Không có đường dẫn này' });
    } catch (e) { send(res, e.status || 500, { error: e.message }); }
});

setInterval(() => {      // dọn phiên xong > 10 phút, phiên bỏ quên > 30 phút
    const now = Date.now();
    for (const [id, s] of sessions) {
        const fin = s.impl.status === 'finished';
        if ((fin && now - (s.impl.finishedAt || s.createdAt) > 10 * 60000) || now - s.createdAt > 30 * 60000) {
            try { s.impl.stop(); } catch (_) { /* */ }
            sessions.delete(id);
        }
    }
}, 60000).unref();

server.listen(PORT, () => console.log('[runner] nghe cổng ' + PORT));
