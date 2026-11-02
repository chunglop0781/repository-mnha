// controllers/files.controller.js — "Lưu trữ file" (/code/files): file Office (Word, Excel, PowerPoint…), PDF, ảnh. Xem services/code/fileStore.js
//   GET  /code/files?dir=                      thư mục & file của tôi
//   POST /code/files/upload/init               kiểm tra file, chọn web kết nối (phiếu tải lên) — như /code/html/upload/init
//   POST /code/files/upload/local/init, PUT /code/files/upload/part, POST /code/files/upload/finish   (localhost / web dữ liệu)
//        trên web chính: các phần đi THẲNG tới web kết nối (/api/node/files/* trong connect/vercel/index.js)
//   POST /code/files/open                      TRÌNH DUYỆT tự giải mã: trả khoá riêng của file + địa chỉ GitHub raw từng phần (≈ vài KB) — dữ liệu KHÔNG qua máy chủ
//   POST /code/files/download-token            (dự phòng) xin link tải qua máy chủ: phiếu ký 30 phút, web kết nối giải mã và gửi nối tiếp
//   GET  /code/files/download?t=               tải file (localhost / web dữ liệu); web kết nối dùng /api/node/files/download?t=
//   POST /code/files/visibility                bật/tắt CÔNG KHAI 1 file (hoặc mọi file của thư mục); mặc định riêng tư
//   POST /code/files/folder/share              bật/tắt trang XEM THƯ MỤC công khai (/f/d) — chỉ liệt kê file đã bật công khai trong thư mục đó
//   GET  /code/files/search?q=                 tìm file/thư mục theo tên trong mọi thư mục của tôi
//   Công khai (không đăng nhập, gắn ở server.js TRƯỚC session): GET /f?u=&d=&n= (trang xem — ảnh, PDF xem thẳng; Word/Excel/PowerPoint có nút Tải),
//        GET /f/key?u=&d=&n= (khoá + địa chỉ raw nếu file đang công khai; trình duyệt tự giải mã), GET /f/raw (dự phòng qua máy chủ → chuyển sang web kết nối)
//   POST /code/files/folder | folder/delete | rename | delete
'use strict';
const crypto = require('crypto');
const store = require('../services/code/fileStore');
const keyService = require('../services/code/keyService');
const nodes = require('../services/connect/nodes');
const uploadToken = require('../services/connect/uploadToken');
const locality = require('../services/connect/locality');
const { FILES, FILE_EXTS, fileKind } = require('../config/codeConfig');
const { canUploadFiles, filesDenyMessage } = require('../middleware/uploadAuth');

const uidOf = (req) => String(req.user._id);
const asBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.alloc(0));
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        const status = e.status || (e.code === 'SHA_CONFLICT' ? 409 : 500);
        if (status === 500) console.error('[files]', e);
        if (req.method === 'GET' && !(req.headers.accept || '').includes('json')) {
            return res.status(status).render('error', { title: 'Lỗi', message: e.message, statusCode: status, stack: null, user: req.user });
        }
        res.set('Cache-Control', 'no-store');
        res.status(status).json({ error: e.message, code: e.code || undefined });
    }
};

// ---------------------------------------------------------------- trang danh sách
exports.page = wrap(async (req, res) => {
    const data = await store.list(uidOf(req), req.query.dir || '');
    const payload = {
        uid: uidOf(req),
        dir: data.dir,
        canUpload: canUploadFiles(req.user),
        denyMessage: canUploadFiles(req.user) ? null : filesDenyMessage(req.user),
        shared: data.shared === true,
        limits: { maxFile: FILES.MAX_FILE_BYTES, part: FILES.PART_BYTES, textEdit: FILES.TEXT_EDIT_MAX },
        exts: FILE_EXTS,
        files: data.files
    };
    res.render('code/storage', {
        title: 'Lưu trữ file', user: req.user, uid: uidOf(req), dir: data.dir, repos: data.repos || [], folders: data.folders, files: data.files,
        exts: FILE_EXTS, limits: payload.limits, payloadJson: json(payload),
        canUpload: payload.canUpload, denyMessage: payload.denyMessage, shared: payload.shared,
        accept: [].concat(...Object.values(FILE_EXTS)).map((e) => '.' + e).join(',')
    });
});

// ---------------------------------------------------------------- tải lên
exports.uploadInit = wrap(async (req, res) => {
    const uid = uidOf(req);
    if (!canUploadFiles(req.user)) return res.status(403).json({ error: filesDenyMessage(req.user), code: 'UPLOAD_NOT_ALLOWED' });
    const body = req.body || {};
    const dir = store.cleanDir(body.dir || '').join('/');
    const name = store.cleanName(body.name);
    const base = { dir, name, size: body.size, lastModified: body.lastModified };

    // Web dữ liệu / localhost: dùng luôn máy chủ này.
    const dm = locality.dataMode(req);
    if (dm === 'self' || dm === 'local') {
        return res.json({ ok: true, mode: 'local', where: dm === 'self' ? 'self' : 'localhost', ...(await store.init(uid, base)) });
    }
    // Kiểm tra file ngay ở web chính để báo lỗi sớm (đuôi/kích thước) trước khi dò web kết nối.
    if (!Number.isInteger(Number(base.size)) || Number(base.size) <= 0) throw Object.assign(new Error('File rỗng hoặc kích thước không hợp lệ.'), { status: 400 });
    if (Number(base.size) > FILES.MAX_FILE_BYTES) throw Object.assign(new Error(`File quá lớn (tối đa ${Math.round(FILES.MAX_FILE_BYTES / 1048576)}MB).`), { status: 400 });

    const uploadId = crypto.randomBytes(16).toString('hex');
    const plan = await nodes.pickForUpload({ uid, uploadId, name, dir }).catch((e) => ({ primary: null, candidates: [], checks: [], error: e.message }));
    if (plan.primary) {
        return res.json({
            ok: true, mode: 'node', node: plan.primary, candidates: plan.candidates,
            token: plan.tokens[plan.primary.id], tokens: plan.tokens, uploadId, dir, name, ttl: uploadToken.TTL_MS, checks: plan.checks
        });
    }
    throw Object.assign(new Error(plan.error || 'Không có web kết nối nào để tải lên.'), { status: 503, code: 'NO_NODE' });
});
exports.uploadLocalInit = wrap(async (req, res) => res.json(await store.init(uidOf(req), req.body || {})));
exports.uploadPart = wrap(async (req, res) => res.json(await store.putPart(uidOf(req), req.query, asBuf(req.body))));
exports.uploadFinish = wrap(async (req, res) => res.json(await store.finish(uidOf(req), req.body || {})));

// ---------------------------------------------------------------- tải về
const dispo = (name) => `attachment; filename="${String(name).replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** Xin link tải: phiếu ký + địa chỉ web kết nối đang giữ dữ liệu (web chính không phát dữ liệu). */
exports.downloadToken = wrap(async (req, res) => {
    const b = req.body || {};
    await store.open(uidOf(req), b.dir || '', b.name);                          // có file thật mới cấp phiếu
    const t = await locality.dataTarget(req);
    if (t.mode === 'none') throw Object.assign(new Error(t.error), { status: 503, code: 'NO_NODE' });
    const tok = store.signDownload(uidOf(req), b.dir || '', b.name);
    const path = t.mode === 'node' ? '/api/node/files/download' : '/code/files/download';
    res.set('Cache-Control', 'no-store').json({ ok: true, url: `${t.base || ''}${path}?t=${encodeURIComponent(tok)}`, node: t.node || null });
});

/** Chủ file xin cách mở: trình duyệt tự tải các phần mã hoá từ GitHub raw và giải mã (mode 'direct'), hoặc 'server' nếu không tải thẳng được. */
exports.open = wrap(async (req, res) => {
    const b = req.body || {};
    keyService.throttle('files-open:' + uidOf(req), 600);
    res.set('Cache-Control', 'no-store').json({ ok: true, ...(await store.release(uidOf(req), b.dir || '', b.name)) });
});

/** Gửi file đã giải mã, từng phần một (đọc trước phần kế trong lúc gửi phần hiện tại). Phần đầu đọc xong mới gửi header → lỗi ở phần đầu vẫn trả được lỗi chữ đúng. */
async function streamFile(res, o, headers) {
    let buf = await o.readPart(0);
    res.status(200).set({
        'Content-Type': o.mime, 'Content-Length': String(o.size), 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', ...headers
    });
    for (let i = 0; i < o.parts; i++) {
        let next = null;
        if (i + 1 < o.parts) { next = o.readPart(i + 1); next.catch(() => { /* lỗi được ném khi tới lượt */ }); }
        if (!res.write(buf)) await new Promise((ok) => res.once('drain', ok));
        if (next) buf = await next;
    }
    res.end();
}
const textErr = (res, status, msg) => res.status(status).set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(msg);
// Lỗi giữa chừng: chưa gửi gì → trả lỗi chữ; đã gửi một phần → ngắt kết nối để trình duyệt báo tải lỗi (không để file cụt trông như đủ).
function failStream(res, e, started) {
    if (!started) return textErr(res, e.status || 500, e.message || 'Lỗi');
    console.error('[files] tải dở dang:', e.message);
    return res.destroy(e);
}

/** Tải file của chủ: quyền nằm ở phiếu `t`, không cần cookie. */
async function serveDownload(req, res) {
    try {
        const p = store.verifyDownload(req.query.t);
        if (!p) return textErr(res, 403, 'Link tải không hợp lệ hoặc đã hết hạn — hãy bấm "Tải" lại trên trang Lưu trữ file.');
        const o = await store.open(p.uid, p.dir, p.name);
        await streamFile(res, o, { 'Content-Disposition': dispo(o.name), 'Content-Security-Policy': 'sandbox' });
    } catch (e) { failStream(res, e, res.headersSent); }
}
exports.serveDownload = serveDownload;
exports.download = serveDownload;

// ---------------------------------------------------------------- thư mục / xoá / đổi tên
exports.createFolder = wrap(async (req, res) => {
    const b = req.body || {};
    res.json({ ok: true, dir: await store.mkdir(uidOf(req), b.dir || '', b.name) });
});
exports.removeFolder = wrap(async (req, res) => res.json({ ok: true, removed: await store.removeFolder(uidOf(req), (req.body || {}).dir) }));
exports.remove = wrap(async (req, res) => { const b = req.body || {}; res.json(await store.remove(uidOf(req), b.dir || '', b.name)); });
exports.rename = wrap(async (req, res) => { const b = req.body || {}; res.json(await store.rename(uidOf(req), b.dir || '', b.name, b.newName)); });

// ---------------------------------------------------------------- công khai / riêng tư + tìm kiếm
exports.visibility = wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.public !== 'boolean') throw Object.assign(new Error('Thiếu trạng thái công khai/riêng tư.'), { status: 400 });
    res.json(await store.setVisibility(uidOf(req), b.dir || '', b.all ? null : b.name, b.public));
});
exports.shareFolder = wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.shared !== 'boolean') throw Object.assign(new Error('Thiếu trạng thái chia sẻ.'), { status: 400 });
    res.json(await store.setFolderShared(uidOf(req), b.dir || '', b.shared));
});
exports.search = wrap(async (req, res) => { res.set('Cache-Control', 'no-store').json({ ok: true, ...(await store.search(uidOf(req), req.query.q)) }); });

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const pubQuery = (q, extra) => new URLSearchParams({ u: String(q.u || ''), d: String(q.d || ''), n: String(q.n || ''), ...(extra || {}) }).toString();
const NOT_FOUND = 'Không tìm thấy file hoặc file không công khai.';

/** Khoá + địa chỉ raw của file CÔNG KHAI (không cần đăng nhập). Riêng tư / không có → cùng lỗi 404. Tắt công khai là ngừng cấp khoá. */
exports.publicKey = async (req, res) => {
    try {
        keyService.throttle('files-pub:' + (req.ip || (req.headers && req.headers['x-forwarded-for']) || 'x'), 300);
        const info = await store.release(req.query.u, req.query.d || '', req.query.n, { publicOnly: true });
        res.set('Cache-Control', 'no-store').json({ ok: true, ...info });
    } catch (e) {
        res.set('Cache-Control', 'no-store').status(e.status || 500).json({ error: e.status === 404 ? NOT_FOUND : (e.message || 'Lỗi'), code: e.code || undefined });
    }
};

/**
 * Trang xem công khai: chỉ là HTML nhỏ + public/js/filePublic.js. Script xin khoá ở /f/key, tải các phần mã hoá THẲNG từ GitHub raw rồi giải mã trong trình duyệt
 * (ảnh / PDF xem ngay; Word, Excel, PowerPoint có nút Tải về). Không tải thẳng được → nút dự phòng qua máy chủ (rawPath).
 */
exports.publicPageAt = (rawPath) => async (req, res) => {
    try {
        const o = await store.publicInfo(req.query.u, req.query.d || '', req.query.n);
        const kind = fileKind(o.name);
        const keyUrl = `/f/key?${pubQuery(req.query)}`, srvView = `${rawPath}?${pubQuery(req.query)}`, srvDl = `${rawPath}?${pubQuery(req.query, { dl: '1' })}`;
        let rawOrigin = '';
        try { if (process.env.MEDIA_RAW_BASE) rawOrigin = ' ' + new URL(process.env.MEDIA_RAW_BASE).origin; } catch (_) { /* bỏ qua */ }
        res.status(200).set({
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': `default-src 'none'; script-src 'self'; connect-src 'self' https://raw.githubusercontent.com${rawOrigin}; img-src 'self' blob:; frame-src blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`
        }).send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(o.name)}</title><style>
body{margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a}header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;background:#fff;border-bottom:1px solid #e2e8f0}
h1{font-size:16px;margin:0;flex:1;min-width:10rem;word-break:break-all}.meta{font-size:12px;color:#64748b}.btn{background:#4f46e5;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-size:14px;border:0;cursor:pointer}.btn.alt{background:#fff;color:#4f46e5;border:1px solid #c7d2fe}.hide{display:none}
main{padding:16px;text-align:center}img{max-width:100%;height:auto;border-radius:8px}iframe{width:100%;height:calc(100vh - 90px);border:1px solid #e2e8f0;border-radius:8px;background:#fff}.note{color:#475569}#msg.err{color:#b91c1c}
</style></head><body data-key="${esc(keyUrl)}" data-kind="${esc(kind || '')}" data-size="${esc(o.size)}" data-name="${esc(o.name)}" data-srv-view="${esc(srvView)}" data-srv-dl="${esc(srvDl)}">
<header><h1>${esc(o.name)}</h1><span class="meta">${esc(fmtSize(o.size))}</span><button id="btnDl" class="btn" type="button">Tải về</button><a id="aSrv" class="btn alt hide" href="${esc(srvDl)}">Tải qua máy chủ</a></header>
<main><p id="msg" class="note">Đang tải và giải mã ngay trong trình duyệt…</p><div id="view"></div></main>
<script src="/js/mnhaFiles.js"></script><script src="/js/filePublic.js"></script></body></html>`);
    } catch (e) { textErr(res, e.status || 500, e.status === 404 ? NOT_FOUND : (e.message || 'Lỗi')); }
};

/**
 * Trang XEM THƯ MỤC công khai (/f/d?u=&d=) — duyệt cả cây như "xem code trên mạng": thư mục con + file (gộp mọi repo của nhóm repo).
 * Xem được khi thư mục này hoặc thư mục cha đã "Chia sẻ thư mục"; chỉ hiện file đang công khai; không đi lên quá thư mục chia sẻ cao nhất.
 */
exports.publicFolderPage = async (req, res) => {
    try {
        const f = await store.publicFolder(req.query.u, req.query.d || '');
        const KIND = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', office: 'Office', pdf: 'PDF', text: 'Văn bản', image: 'Ảnh' };
        const u = String(req.query.u || '');
        const folderHref = (d) => `/f/d?${new URLSearchParams({ u, d }).toString()}`;
        const segs = f.dir ? f.dir.split('/') : [], rootLen = f.rootDir ? f.rootDir.split('/').length : 0;
        const crumbs = [];
        for (let k = rootLen; k <= segs.length; k++) {
            const name = k === 0 ? 'Lưu trữ file' : segs[k - 1];
            crumbs.push(k === segs.length ? `<b>${esc(name)}</b>` : `<a class="c" href="${esc(folderHref(segs.slice(0, k).join('/')))}">${esc(name)}</a>`);
        }
        const up = !f.isRoot ? `<li><a href="${esc(folderHref(segs.slice(0, -1).join('/')))}"><span class="n">⬆ ..</span><span class="m">lên một cấp</span></a></li>` : '';
        const folders = f.folders.map((x) => `<li><a href="${esc(folderHref((f.dir ? f.dir + '/' : '') + x.name))}"><span class="n">📁 ${esc(x.name)}</span><span class="m">${x.files} file công khai</span></a></li>`).join('');
        const rows = f.files.map((x) => `<li><a href="/f?${esc(pubQuery({ u, d: f.dir, n: x.name }))}"><span class="n">${esc(x.name)}</span><span class="m">${esc(KIND[x.kind] || 'File')} · ${esc(fmtSize(x.size))}</span></a></li>`).join('');
        const body = up + folders + rows;
        res.status(200).set({
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
        }).send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(f.name)}</title><style>
body{margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a}header{padding:14px 16px;background:#fff;border-bottom:1px solid #e2e8f0}h1{font-size:18px;margin:0;word-break:break-all}.meta{font-size:12px;color:#64748b;margin-top:4px}
.bc{font-size:13px;margin-top:6px;color:#475569;word-break:break-all}.bc a.c{color:#4f46e5;text-decoration:none}.bc a.c:hover{text-decoration:underline}.bc i{font-style:normal;margin:0 4px;color:#94a3b8}
main{max-width:760px;margin:16px auto;padding:0 16px}ul{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}li+li{border-top:1px solid #f1f5f9}
a{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;padding:12px 14px;color:#0f172a;text-decoration:none}li a:hover{background:#f8fafc}.n{word-break:break-all;font-weight:500}.m{font-size:12px;color:#64748b}.empty{padding:24px;text-align:center;color:#64748b}
</style></head><body><header><h1>${esc(f.name)}</h1><div class="bc">${crumbs.join('<i>/</i>')}</div><div class="meta">${f.folders.length} thư mục · ${f.files.length} file công khai — bấm để mở; file giải mã ngay trong trình duyệt${f.truncated ? ' · (cây lớn — chỉ quét 200 thư mục đầu)' : ''}</div></header>
<main>${body ? `<ul>${body}</ul>` : '<div class="empty">Thư mục này chưa có file nào công khai.</div>'}</main></body></html>`);
    } catch (e) { textErr(res, e.status || 500, e.status === 404 ? 'Không tìm thấy thư mục hoặc thư mục không được chia sẻ.' : (e.message || 'Lỗi')); }
};

/** Byte của file công khai: ảnh / PDF xem thẳng (inline), mọi loại khác (và ?dl=1) tải về. */
exports.publicRaw = async (req, res) => {
    try {
        const o = await store.openPublic(req.query.u, req.query.d || '', req.query.n);
        const kind = fileKind(o.name);
        const inline = req.query.dl !== '1' && (kind === 'image' || kind === 'pdf');
        await streamFile(res, o, inline
            ? { 'Content-Disposition': 'inline', ...(kind === 'image' ? { 'Content-Security-Policy': 'sandbox' } : {}) }      // PDF cần trình xem PDF của trình duyệt nên không đặt sandbox
            : { 'Content-Disposition': dispo(o.name), 'Content-Security-Policy': 'sandbox' });
    } catch (e) { failStream(res, e, res.headersSent); }
};

/** Cổng công khai ở WEB CHÍNH: trang xem + khoá chỉ là dữ liệu nhỏ nên phục vụ ngay tại đây; chỉ đường DỰ PHÒNG /f/raw (web chính không phát dữ liệu) mới chuyển hướng sang web kết nối; localhost / web dữ liệu tự phục vụ. */
exports.publicGate = (raw) => async (req, res) => {
    if (!raw) return exports.publicPageAt('/f/raw')(req, res);
    try {
        const t = await locality.dataTarget(req);
        if (t.mode === 'node') {
            const extra = req.query.dl === '1' ? { dl: '1' } : undefined;
            return res.redirect(302, `${t.base}/api/node/files/public/raw?${pubQuery(req.query, extra)}`);
        }
        if (t.mode === 'none') return textErr(res, 503, 'Hiện chưa có web kết nối nào hoạt động để xem file — hãy thử lại sau.');
        return exports.publicRaw(req, res);
    } catch (e) { textErr(res, e.status || 500, e.message || 'Lỗi'); }
};
