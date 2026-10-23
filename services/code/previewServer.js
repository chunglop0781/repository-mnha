// services/code/previewServer.js — máy chủ "xem trước" trang HTML:  GET /preview/<token>/<đường-dẫn-file>[?dl=1]
//   Phục vụ file như một web tĩnh nhỏ: trang .html và mọi file cùng thư mục (css, js, ảnh, âm thanh, video...) nên đường dẫn tương đối
//   trong HTML chạy bình thường. Nguồn: file của người dùng trên GitHub của app (k:'own') hoặc repo GitHub/GitLab công khai (k:'web').
//   • Ảnh/âm thanh/video MÃ HOÁ (8 byte đầu "MNHAENC1") → giải mã ở đây (Node). Xem được thẳng thì trả nguyên, KHÔNG giải mã.
//     Giải mã không được → HTTP 422 + JSON {error} (trang cha hiện "không giải mã được").
//   • Tên gốc không còn dạng file trực tiếp (media lớn đã cắt m3u8) → tra mnha-media.json cùng thư mục và trả PLAYLIST m3u8 (khai báo m3u8 là đuôi gốc):
//       âm thanh  → các đoạn .ts đã mã hoá 2 chiều; Node giải mã từng đoạn khi trình phát xin (…/_media/<id>/segNNNNN.ts)
//       video     → các đoạn .ts mã hoá AES-128 (DRM chuẩn HLS); khoá lấy từ json (giải mã 2 chiều) và trả ở …/_media/<id>/key.bin
//                   codec thế hệ mới (H.265/AV1/VP9) → đoạn fMP4 .m4s (cùng AES-128) + …/_media/<id>/init.mp4 (lấy từ json, không mã hoá)
//     <audio>/<video> trong trang khai báo đuôi gốc (mp3, mp4...) mà nhận m3u8 → previewShim tự gắn hls.js (Safari phát thẳng).
//   • ?dl=1 → tải về: giữ ĐUÔI NHƯ LÚC TẢI LÊN; ảnh/âm thanh/video nhỏ được giải mã về đúng file gốc; media đã cắt thì giải mã các đoạn
//     rồi ghép lại thành luồng MPEG-TS (mpegts) mang đuôi gốc.
//   • /…/__view/<tên> → trang trình phát (ảnh / audio / video) có nút Tải về.
//   Bảo mật: mọi phản hồi gắn CSP sandbox (origin "null": script của trang không đụng được cookie/phiên của app), CORS * không kèm cookie.
// Không phụ thuộc express: nhận (req, res) Node thuần, nên mount bằng app.use('/preview', handler) hoặc http.createServer đều được.
'use strict';
const mc = require('./mediaCrypto');
const token = require('./previewToken');
const shim = require('./previewShim');
const hls = require('./hlsPlaylist');
const remoteSource = require('./remoteSource');
const { MEDIA, ASSET_EXTS, mediaKind } = require('../../config/codeConfig');

const MOUNT = '/preview';
const MIME = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', xml: 'application/xml; charset=utf-8', map: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', m3u8: 'application/vnd.apple.mpegurl', m4s: 'video/iso.segment', ts: 'video/mp2t', wasm: 'application/wasm'
};
const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i < 0 ? '' : String(n).slice(i + 1).toLowerCase(); };
const mimeOf = (n) => MIME[extOf(n)] || 'application/octet-stream';
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

// ---------------- nguồn dữ liệu ----------------
const blobLru = new Map(); let blobBytes = 0;
const BLOB_CACHE_MAX = 96 * 1024 * 1024;
let lastForce = 0;
async function blobCached(gh, sha) {
    const hit = blobLru.get(sha);
    if (hit) { blobLru.delete(sha); blobLru.set(sha, hit); return hit; }
    const buf = await gh.getBlobBuffer(sha);
    if (!buf) return null;
    if (buf.length < 30 * 1024 * 1024) {
        blobLru.set(sha, buf); blobBytes += buf.length;
        while (blobBytes > BLOB_CACHE_MAX && blobLru.size > 1) { const k = blobLru.keys().next().value; blobBytes -= blobLru.get(k).length; blobLru.delete(k); }
    }
    return buf;
}
function ownSource(uid, gh) {
    const root = `${uid}/codes/html/`;
    return {
        kind: 'own',
        async read(segs) {
            if (!segs.every((s) => /^[A-Za-z0-9_.\- ]{1,100}$/.test(s))) return null;
            const p = root + segs.join('/');
            let sha = (await gh.getRepoTree()).files.get(p);
            if (!sha && Date.now() - lastForce > 2000) { lastForce = Date.now(); sha = (await gh.getRepoTree({ force: true })).files.get(p); }   // file vừa lưu < 15s
            return sha ? blobCached(gh, sha) : null;
        }
    };
}
function webSource(payload) {
    return {
        kind: 'web',
        async read(segs) {
            const link = remoteSource.fromParts(payload, segs);
            try { return await remoteSource.fetchBuffer(link); }
            catch (e) { if (e.status === 404) return null; throw e; }
        }
    };
}

// ---------------- tiện ích ----------------
function parseRange(h, size) {
    if (!h) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) return 'bad';
    return { start, end };
}
function baseHeaders(opts) {
    return {
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': SANDBOX,
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
        'Cross-Origin-Resource-Policy': 'cross-origin', 'Accept-Ranges': 'bytes',
        'Cache-Control': opts && opts.cache ? opts.cache : 'no-store'
    };
}
function sendJson(res, status, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
    res.end(b);
}
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function sendError(req, res, e) {
    const status = e.status || 500;
    if (status === 500) console.error('[preview]', e);
    const msg = status === 500 && !(e instanceof mc.MediaCryptoError) ? 'Lỗi máy chủ khi xem trước.' : e.message;
    if (res.headersSent) { try { res.destroy(); } catch (_) { /* */ } return; }
    if (/text\/html/.test(req.headers.accept || '') && !/^\/preview\/.*\.(png|jpe?g|gif|webp|css|js)(\?|$)/i.test(req.url || '')) {
        const b = Buffer.from(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:24px;color:#b91c1c"><b>${status}</b> — ${escHtml(msg)}</body>`);
        res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length });
        return res.end(req.method === 'HEAD' ? undefined : b);
    }
    sendJson(res, status, { error: msg, code: e.code || undefined });
}
const dispo = (name) => `attachment; filename="${String(name).replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function injectShim(html, script) {
    let m = /<head[^>]*>/i.exec(html);
    if (!m) m = /<html[^>]*>/i.exec(html);
    if (!m) m = /^\s*<!doctype[^>]*>/i.exec(html);
    if (!m) return script + html;
    const at = m.index + m[0].length;
    return html.slice(0, at) + script + html.slice(at);
}

// ---------------- manifest media ----------------
async function readManifest(source, dirSegs) {
    const buf = await source.read([...dirSegs, MEDIA.MANIFEST]);
    if (!buf) return null;
    try { const j = JSON.parse(buf.toString('utf8')); return j && typeof j === 'object' ? j : null; } catch (_) { return null; }
}
const segPath = (dirSegs, entry, i) => [...dirSegs, MEDIA.HIDDEN_DIR, entry.id, hls.segName(i, entry.segExt)];
const isFmp4 = (entry) => entry.segExt === 'm4s';
const initBuf = (entry) => { const b = isFmp4(entry) && entry.init ? Buffer.from(String(entry.init), 'base64') : null; if (!b || !b.length) throw new HttpError(404, `Thiếu init segment của "${entry.name}".`, 'MISSING_SEGMENT'); return b; };
async function readSegment(source, dirSegs, entry, i, key) {
    const buf = await source.read(segPath(dirSegs, entry, i));
    if (!buf) throw new HttpError(404, `Thiếu đoạn ${i + 1}/${entry.durs.length} của "${entry.name}" (file media chưa tải lên đủ hoặc đã bị xoá).`, 'MISSING_SEGMENT');
    let plain = buf;
    try {
        if (entry.mode === 'hls-video') plain = mc.decryptHlsSegment(buf, key, i);
        else if (mc.isEncrypted(buf)) plain = mc.decryptBuffer(buf);
    } catch (e) { throw new HttpError(422, `Không giải mã được đoạn ${i + 1} của "${entry.name}": ${e.message}`, 'DECRYPT'); }
    if (entry.sizes && entry.sizes[i] != null && entry.mode === 'hls-audio' && plain.length !== entry.sizes[i]) throw new HttpError(422, `Đoạn ${i + 1} của "${entry.name}" sai kích thước.`, 'DECRYPT');
    return plain;
}
function entryKey(entry) {
    if (entry.mode !== 'hls-video') return null;
    try { return mc.unwrapKey(entry.drm && entry.drm.key); }
    catch (e) { throw new HttpError(422, `Không giải mã được khoá DRM của "${entry.name}": ${e.message}`, 'DECRYPT'); }
}
function needReady(entry, name) {
    if (entry.state !== 'ready') throw new HttpError(409, `"${name}" đang được tải lên dở dang (${entry.done || 0}/${entry.total || '?'} đoạn). Hãy tải lên lại cùng file để làm tiếp.`, 'UPLOADING');
}

// ---------------- gửi buffer (Range) ----------------
function sendBuffer(req, res, body, type, opts) {
    const h = { ...baseHeaders(opts), 'Content-Type': type };
    if (opts.download) h['Content-Disposition'] = dispo(opts.download);
    const r = parseRange(req.headers.range, body.length);
    if (r === 'bad') { res.writeHead(416, { ...h, 'Content-Range': `bytes */${body.length}` }); return res.end(); }
    if (r && !opts.noRange) {
        res.writeHead(206, { ...h, 'Content-Range': `bytes ${r.start}-${r.end}/${body.length}`, 'Content-Length': r.end - r.start + 1 });
        return res.end(req.method === 'HEAD' ? undefined : body.subarray(r.start, r.end + 1));
    }
    res.writeHead(200, { ...h, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
}
const drain = (res) => (res.write('') === false || res.writableNeedDrain) ? new Promise((ok) => res.once('drain', ok)) : null;

// ---------------- phục vụ ----------------
// Tải về media đã cắt: giải mã từng đoạn rồi ghép = luồng MPEG-TS (hoặc fMP4 = init + các đoạn: file mp4 phân mảnh phát được), đặt tên theo đuôi gốc (chunked, không biết trước tổng kích thước)
async function serveHlsDownload(ctx, entry, name) {
    const { req, res, source, dirSegs } = ctx;
    needReady(entry, name);
    const key = entryKey(entry);
    const first = await readSegment(source, dirSegs, entry, 0, key);        // lỗi (thiếu/không giải mã được) → báo JSON TRƯỚC khi gửi header
    const fm = isFmp4(entry), head = fm ? initBuf(entry) : null;
    res.writeHead(200, { ...baseHeaders(ctx), 'Content-Type': fm ? 'video/mp4' : 'video/mp2t', 'Content-Disposition': dispo(name), 'X-Content-Note': fm ? 'fragmented MP4' : 'MPEG-TS' });
    if (req.method === 'HEAD') return res.end();
    if (head) res.write(head);
    for (let i = 0; i < entry.durs.length; i++) {
        res.write(i === 0 ? first : await readSegment(source, dirSegs, entry, i, key));
        const d = drain(res); if (d) await d;
    }
    res.end();
}
function playerPage(name, kind, downloadHref) {
    const el = kind === 'image' ? `<img src="../${encodeURIComponent(name)}" alt="${escHtml(name)}">`
        : kind === 'audio' ? `<audio controls autoplay src="../${encodeURIComponent(name)}"></audio>`
            : `<video controls autoplay playsinline src="../${encodeURIComponent(name)}"></video>`;
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(name)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b1220;color:#e2e8f0;font:14px system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px}
h1{margin:0;font-size:15px;font-weight:600;word-break:break-all;text-align:center}img,video{max-width:100%;max-height:78vh;background:#000;border-radius:8px}video{width:min(100%,1100px)}audio{width:min(100%,640px)}
a.dl{background:#4f46e5;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px}a.dl:hover{background:#4338ca}#err{display:none;max-width:640px;background:#450a0a;color:#fecaca;border:1px solid #991b1b;border-radius:8px;padding:10px 14px}</style></head>
<body><h1>${escHtml(name)}</h1>${el}<a class="dl" href="${downloadHref}" download>⬇ Tải về (${escHtml(name)})</a><div id="err"></div>
<script>window.addEventListener('message',function(e){var d=e.data;if(d&&d.mnha&&d.type==='error'){var b=document.getElementById('err');b.style.display='block';b.textContent='⚠ '+d.message}});</script></body></html>`;
}

async function serve(ctx) {
    const { req, res, source, segs } = ctx;
    const name = segs[segs.length - 1];
    const ext = extOf(name);
    const kind = mediaKind(name);

    if (segs.length >= 2 && segs[segs.length - 2] === '__view') {                  // trang trình phát
        const real = [...segs.slice(0, -2), name];
        if (!kind) throw new HttpError(404, 'Chỉ có trang trình phát cho ảnh, âm thanh, video.');
        const html = injectShim(playerPage(name, kind, encodeURIComponent(name) === name ? '../' + name + '?dl=1' : '../' + encodeURIComponent(name) + '?dl=1'), ctx.shimScript);
        return sendBuffer(req, res, Buffer.from(html), MIME.html, { ...ctx, noRange: true, real });
    }
    const hidden = segs.indexOf(MEDIA.HIDDEN_DIR);
    if (hidden >= 0 && name === 'key.bin' && segs.length === hidden + 3) {         // khoá DRM (giải mã 2 chiều từ json)
        const dirSegs = segs.slice(0, hidden);
        const m = await readManifest(source, dirSegs);
        const entry = m && m.files && Object.values(m.files).find((x) => x && x.id === segs[hidden + 1] && x.mode === 'hls-video');
        if (!entry) throw new HttpError(404, 'Không có khoá cho media này.');
        return sendBuffer(req, res, entryKey(entry), 'application/octet-stream', { ...ctx, noRange: true });
    }

    if (hidden >= 0 && name === 'init.mp4' && segs.length === hidden + 3) {         // init segment fMP4 (cấu hình codec, lấy từ json)
        const dirSegs = segs.slice(0, hidden);
        const m = await readManifest(source, dirSegs);
        const entry = m && m.files && Object.values(m.files).find((x) => x && x.id === segs[hidden + 1] && x.mode === 'hls-video' && isFmp4(x));
        if (!entry) throw new HttpError(404, 'Không có init segment cho media này.');
        return sendBuffer(req, res, initBuf(entry), 'video/mp4', { ...ctx, noRange: true });
    }

    const buf = await source.read(segs);
    if (buf) {
        let body = buf;
        if (mc.isEncrypted(buf)) {
            try { body = mc.decryptBuffer(buf); }
            catch (e) { throw new HttpError(e.code === 'NO_KEY' ? 500 : 422, `Không giải mã được "${name}": ${e.message}`, e.code === 'NO_KEY' ? 'NO_KEY' : 'DECRYPT'); }
        }
        if (/^(html?)$/.test(ext) && !ctx.download) body = Buffer.from(injectShim(body.toString('utf8'), ctx.shimScript));
        return sendBuffer(req, res, body, mimeOf(name), { ...ctx, download: ctx.download ? name : null });
    }

    if (kind === 'audio' || kind === 'video') {                                   // không có file trực tiếp → tra json
        const dirSegs = segs.slice(0, -1);
        const m = await readManifest(source, dirSegs);
        const entry = m && m.files && m.files[name];
        if (entry && (entry.mode === 'hls-audio' || entry.mode === 'hls-video')) {
            const c = { ...ctx, dirSegs };
            if (ctx.download) return serveHlsDownload(c, entry, name);
            needReady(entry, name);
            const dirUrl = ctx.base + dirSegs.map(encodeURIComponent).join('/') + (dirSegs.length ? '/' : '') + MEDIA.HIDDEN_DIR + '/' + entry.id + '/';
            const text = hls.build(entry, { seg: (i) => dirUrl + hls.segName(i, entry.segExt), key: dirUrl + 'key.bin', init: dirUrl + 'init.mp4' });
            return sendBuffer(req, res, Buffer.from(text), MIME.m3u8, { ...ctx, noRange: true });
        }
    }
    throw new HttpError(404, `Không tìm thấy "${segs.join('/')}".`, 'NOT_FOUND');
}

function parsePath(url) {
    let pathname;
    try { pathname = new URL(url, 'http://x').pathname; } catch (_) { throw new HttpError(400, 'Đường dẫn không hợp lệ.'); }
    const raw = pathname.split('/').slice(1);
    const tok = raw.shift();
    if (raw.length && raw[raw.length - 1] === '') throw new HttpError(404, 'Hãy mở một file cụ thể, không phải thư mục.');
    const segs = [];
    for (const r of raw) {
        let s;
        try { s = decodeURIComponent(r); } catch (_) { throw new HttpError(400, 'Đường dẫn có ký tự không hợp lệ.'); }
        if (!s || s === '.' || s === '..' || s.length > 200 || /[\\\/\x00-\x1f]/.test(s)) throw new HttpError(400, 'Đường dẫn không hợp lệ.');
        segs.push(s);
    }
    if (segs.length > 24) throw new HttpError(400, 'Đường dẫn quá sâu.');
    return { tok, segs };
}

/** @param {{gh?:object, mount?:string}} [opt]  mount: tiền tố đã mount (để dựng URL tuyệt đối trong playlist/shim). req.url phải đã bỏ tiền tố. */
function createHandler(opt = {}) {
    const mount = opt.mount || MOUNT;
    return async function previewHandler(req, res) {
        try {
            if (req.method === 'OPTIONS') { res.writeHead(204, { ...baseHeaders(), 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Content-Length': 0 }); return res.end(); }
            if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Chỉ hỗ trợ GET.');
            const { tok, segs } = parsePath(req.url);
            const payload = token.verify(tok);
            if (!payload) throw new HttpError(403, 'Link xem trước hết hạn hoặc không hợp lệ — hãy mở lại trang để lấy link mới.', 'TOKEN');
            if (!segs.length) throw new HttpError(404, 'Thiếu đường dẫn file.');
            const gh = opt.gh || require('../githubService');
            const source = payload.k === 'own' ? ownSource(payload.uid, gh) : webSource(payload);
            const base = `${mount}/${tok}/`;
            const download = new URL(req.url, 'http://x').searchParams.get('dl') === '1';
            await serve({ req, res, source, segs, base, download, cache: source.kind === 'web' ? 'private, max-age=30' : 'no-store', shimScript: shim.build(base, MEDIA.HLSJS_URL) });
        } catch (e) { sendError(req, res, e); }
    };
}

module.exports = { createHandler, MOUNT, MIME, mimeOf, injectShim, HttpError };
