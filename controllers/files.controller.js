// controllers/files.controller.js — "Lưu trữ file" (/code/files): file Office (Word, Excel, PowerPoint…), PDF, ảnh. Xem services/code/fileStore.js
//   GET  /code/files?dir=                      thư mục & file của tôi
//   POST /code/files/upload/init               kiểm tra file, chọn web kết nối (phiếu tải lên) — như /code/html/upload/init
//   POST /code/files/upload/local/init, PUT /code/files/upload/part, POST /code/files/upload/finish   (localhost / web dữ liệu)
//        trên web chính: các phần đi THẲNG tới web kết nối (/api/node/files/* trong connect/vercel/index.js)
//   POST /code/files/download-token            xin link tải (phiếu ký 30 phút, trỏ tới web kết nối đang giữ dữ liệu)
//   GET  /code/files/download?t=               tải file (localhost / web dữ liệu); web kết nối dùng /api/node/files/download?t=
//   POST /code/files/folder | folder/delete | rename | delete
'use strict';
const crypto = require('crypto');
const store = require('../services/code/fileStore');
const nodes = require('../services/connect/nodes');
const uploadToken = require('../services/connect/uploadToken');
const locality = require('../services/connect/locality');
const { FILES, FILE_EXTS } = require('../config/codeConfig');
const { canUploadMedia, uploadDenyMessage } = require('../middleware/uploadAuth');

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
        dir: data.dir,
        canUpload: canUploadMedia(req.user),
        denyMessage: canUploadMedia(req.user) ? null : uploadDenyMessage(req.user),
        limits: { maxFile: FILES.MAX_FILE_BYTES, part: FILES.PART_BYTES },
        exts: FILE_EXTS,
        files: data.files
    };
    res.render('code/storage', {
        title: 'Lưu trữ file', user: req.user, dir: data.dir, folders: data.folders, files: data.files,
        exts: FILE_EXTS, limits: payload.limits, payloadJson: json(payload),
        canUpload: payload.canUpload, denyMessage: payload.denyMessage,
        accept: [].concat(...Object.values(FILE_EXTS)).map((e) => '.' + e).join(',')
    });
});

// ---------------------------------------------------------------- tải lên
exports.uploadInit = wrap(async (req, res) => {
    const uid = uidOf(req);
    if (!canUploadMedia(req.user)) return res.status(403).json({ error: uploadDenyMessage(req.user), code: 'UPLOAD_NOT_ALLOWED' });
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

/** Gửi file đã giải mã, từng phần một (đọc trước phần kế trong lúc gửi phần hiện tại). Quyền nằm ở phiếu `t`, không cần cookie. */
async function serveDownload(req, res) {
    const text = (status, msg) => res.status(status).set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(msg);
    let started = false;
    try {
        const p = store.verifyDownload(req.query.t);
        if (!p) return text(403, 'Link tải không hợp lệ hoặc đã hết hạn — hãy bấm "Tải" lại trên trang Lưu trữ file.');
        const o = await store.open(p.uid, p.dir, p.name);
        res.status(200).set({
            'Content-Type': o.mime, 'Content-Length': String(o.size), 'Content-Disposition': dispo(o.name),
            'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox'
        });
        started = true;
        let next = o.readPart(0);
        for (let i = 0; i < o.parts; i++) {
            const buf = await next;
            if (i + 1 < o.parts) { next = o.readPart(i + 1); next.catch(() => { /* lỗi được ném ở vòng sau */ }); }
            if (!res.write(buf)) await new Promise((ok) => res.once('drain', ok));
        }
        res.end();
    } catch (e) {
        if (!started) return text(e.status || 500, e.message || 'Lỗi');
        console.error('[files] tải dở dang:', e.message);
        res.destroy(e);                          // đã gửi một phần: ngắt kết nối để trình duyệt báo tải lỗi, không để file cụt trông như đủ
    }
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
