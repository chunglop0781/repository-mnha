// controllers/word.controller.js — dạng "Word (DOCX)" (/code/word/...), đặt TRƯỚC route /code/:lang chung
//   GET  /code/word                          thư mục & tài liệu của tôi
//   GET  /code/word/edit?dir=&file=          trình soạn kiểu Word
//   GET  /code/word/raw?dir=&file=           HTML đã giải mã (ghi từng khúc; trình soạn tải riêng)
//   GET  /code/word/media?dir=&file=&n=      ảnh đã tách khỏi HTML (giải mã, chỉ chủ tài liệu)
//   POST /code/word/file                     tạo tài liệu mới
//   POST /code/word/delete                   xoá tài liệu
//   POST /code/word/rename-file              đổi tên tài liệu
//   POST /code/word/visibility               bật/tắt công khai (link /w)
//   PUT  /code/word/save/part, POST /code/word/save/finish     lưu HTML theo từng phần ≤ 3.2MB
//   PUT  /code/word/upload/part, POST /code/word/upload/finish tải .docx lên theo từng phần → tự chuyển HTML
//   GET  /code/word/download?dir=&file=      HTML → .docx thật để tải về
// Công khai (không đăng nhập): GET /w, /w/raw, /w/media, /w/download (server.js gắn TRƯỚC session).
'use strict';
const store = require('../services/word/wordStore');
const codeStore = require('../services/code/codeStore');
const { LANGS } = require('../config/codeConfig');

const LANG = LANGS.word;
const uidOf = (req) => String(req.user._id);
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const httpErr = (msg, status = 400) => Object.assign(new Error(msg), { status });
const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        const status = e.status || (e.code === 'SHA_CONFLICT' ? 409 : 500);
        if (status === 500) console.error('[word]', e);
        if (req.method === 'GET' && !(req.headers.accept || '').includes('json')) {
            return res.status(status).render('error', { title: 'Lỗi', message: e.message, statusCode: status, stack: null, user: req.user });
        }
        res.set('Cache-Control', 'no-store');
        res.status(status).json({ error: e.message });
    }
};
// ảnh trả về dạng nhị phân → lỗi phải là text, không phải trang HTML
const wrapMedia = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        const status = e.status || 500;
        if (status === 500) console.error('[word]', e);
        res.set('Cache-Control', 'no-store').status(status).type('text/plain').send(String(e.message || 'Lỗi'));
    }
};

function publicPath(uid, dir, name) {
    return '/w?u=' + encodeURIComponent(uid) + '&p=' + encodeURIComponent([dir, name].filter(Boolean).join('/'));
}
function docPath(doc) { return [doc.dir, doc.name].filter(Boolean).join('/'); }

// ---------------------------------------------------------------- trang danh sách
exports.files = wrap(async (req, res) => {
    const uid = uidOf(req);
    const data = await store.list(uid, req.query.dir || '');
    const docs = data.docs.map((d) => ({
        ...d,
        publicPath: publicPath(uid, data.dir, d.name),
        editUrl: '/code/word/edit?dir=' + encodeURIComponent(data.dir) + '&file=' + encodeURIComponent(d.name),
        downloadUrl: '/code/word/download?dir=' + encodeURIComponent(data.dir) + '&file=' + encodeURIComponent(d.name)
    }));
    const payload = {
        dir: data.dir,
        limits: { maxFile: LANG.maxFileBytes, maxHtml: LANG.maxHtmlBytes, part: store.PART_MAX, maxParts: store.PART_MAX_PARTS },
        docs,
        urls: { create: '/code/word/file', del: '/code/word/delete', rename: '/code/word/rename-file', visibility: '/code/word/visibility', uploadPart: '/code/word/upload/part', uploadFinish: '/code/word/upload/finish' }
    };
    res.render('code/word-files', {
        title: LANG.name, user: req.user, lang: LANG, dir: data.dir,
        folders: data.folders, docs,
        shareUrl: codeStore.githubFolderUrl(uid, 'word', data.dir),
        payloadJson: json(payload)
    });
});

exports.createFile = wrap(async (req, res) => {
    const name = store.docName(req.body && req.body.name);
    const out = await store.createDoc(uidOf(req), (req.body && req.body.dir) || '', name, { title: req.body && req.body.title });
    res.json({ ok: true, file: out.file || out.name, name: out.name });
});

exports.remove = wrap(async (req, res) => {
    const b = req.body || {};
    const type = String(b.type || 'file');
    if (type === 'folder') {
        const n = codeStore.cleanDir(b.dir || '').length;
        if (!n) throw httpErr('Không xoá được thư mục gốc');
        const removed = await codeStore.removeFolder(uidOf(req), 'word', b.dir || '');
        return res.json({ ok: true, removed });
    }
    const uid = uidOf(req);
    await store.removeDoc(uid, b.dir || '', b.file);
    res.json({ ok: true });
});

exports.renameFile = wrap(async (req, res) => {
    const b = req.body || {};
    const out = await store.renameDoc(uidOf(req), b.dir || '', b.file, b.name);
    res.json({ ok: true, ...out });
});

exports.visibility = wrap(async (req, res) => {
    const b = req.body || {};
    const out = await store.setPublic(uidOf(req), b.dir || '', b.file, !!b.public);
    res.json({ ...out, publicPath: publicPath(uidOf(req), b.dir || '', out.name) });
});

// ---------------------------------------------------------------- trình soạn
exports.edit = wrap(async (req, res) => {
    const uid = uidOf(req);
    const dirSegs = codeStore.cleanDir(req.query.dir || '');
    const dir = dirSegs.join('/');
    const name = req.query.file;
    const doc = await store.stat(uid, dir, name);
    if (!doc) throw httpErr('Không tìm thấy tài liệu', 404);
    const base = 'dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(doc.name);
    const payload = {
        dir, file: doc.name, title: doc.title, page: doc.page, public: doc.public,
        rawUrl: '/code/word/raw?' + base,
        downloadUrl: '/code/word/download?' + base,
        visibilityUrl: '/code/word/visibility',
        savePartUrl: '/code/word/save/part?' + base,
        saveFinishUrl: '/code/word/save/finish',
        uploadPartUrl: '/code/word/upload/part',
        uploadFinishUrl: '/code/word/upload/finish',
        publicPath: publicPath(uid, dir, doc.name),
        maxHtmlBytes: LANG.maxHtmlBytes,
        backUrl: '/code/word' + (dir ? '?dir=' + encodeURIComponent(dir) : '')
    };
    res.render('code/word-editor', {
        title: doc.title || doc.name, user: req.user, lang: LANG, dir, file: doc.name, isPublic: doc.public,
        payloadJson: json(payload)
    });
});

exports.raw = wrap(async (req, res) => {
    const uid = uidOf(req);
    const doc = await store.readDoc(uid, req.query.dir || '', req.query.file);
    if (!doc) throw httpErr('Không tìm thấy tài liệu', 404);
    const html = store.inlineMediaUrls(doc.html, uid, doc.meta.dir, doc.meta.name);
    await sendChunked(res, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
});

exports.media = wrapMedia(async (req, res) => {
    const img = await store.readImage(uidOf(req), req.query.dir || '', req.query.file, req.query.n);
    if (!img) return res.status(404).type('text/plain').send('Không tìm thấy ảnh');
    sendImage(res, img, 'private, max-age=600');
});

exports.savePart = wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await store.putPart(uidOf(req), 'html', req.query, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
});
exports.saveFinish = wrap(async (req, res) => {
    const out = await store.finishSave(uidOf(req), req.body || {});
    res.json(out);
});
exports.uploadPart = wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await store.putPart(uidOf(req), 'docx', req.query, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
});
exports.uploadFinish = wrap(async (req, res) => {
    const out = await store.finishDocx(uidOf(req), req.body || {});
    res.json(out);
});

exports.download = wrap(async (req, res) => {
    const out = await store.toDocx(uidOf(req), req.query.dir || '', req.query.file);
    if (!out) throw httpErr('Không tìm thấy tài liệu', 404);
    if (out.multi) sendZip(res, out.buffer, out.zipName);
    else sendDocx(res, out.buffer, out.meta.name);
});

// ---------------------------------------------------------------- công khai (không đăng nhập)
function parsePublic(req) {
    const uid = String(req.query.u || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) throw httpErr('Liên kết không hợp lệ', 404);
    const segs = String(req.query.p || '').split('/').filter(Boolean);
    if (!segs.length || segs.length > 12) throw httpErr('Liên kết không hợp lệ', 404);
    const name = segs.pop();
    return { uid, dir: segs.join('/'), name };
}
const notFoundPage = (res) => res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Không tìm thấy</title><body style="font-family:system-ui;padding:40px;color:#334155"><h1 style="font-size:20px">Không tìm thấy tài liệu</h1><p>Tài liệu không tồn tại hoặc chủ sở hữu đã tắt công khai.</p></body>');

exports.publicView = wrap(async (req, res) => {
    const { uid, dir, name } = parsePublic(req);
    const doc = await store.stat(uid, dir, name);
    if (!doc || !doc.public) return notFoundPage(res);
    const base = 'u=' + encodeURIComponent(uid) + '&p=' + encodeURIComponent(docPath(doc));
    res.set('Cache-Control', 'no-store');
    res.render('code/word-public', {
        title: doc.title || 'Tài liệu Word', publicTitle: doc.title || name,
        rawUrl: '/w/raw?' + base, downloadUrl: '/w/download?' + base,
        page: doc.page, name: doc.name
    });
});

exports.publicRaw = wrap(async (req, res) => {
    const { uid, dir, name } = parsePublic(req);
    const doc = await store.getPublic(uid, dir, name);
    if (!doc) return notFoundPage(res);
    const html = store.publicMediaUrls(doc.html, uid, doc.meta.dir, doc.meta.name);
    await sendChunked(res, Buffer.from(publicDocument({ ...doc, html }), 'utf8'), 'text/html; charset=utf-8', {
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff'
    });
});

exports.publicMedia = wrapMedia(async (req, res) => {
    const { uid, dir, name } = parsePublic(req);
    const st = await store.stat(uid, dir, name);
    if (!st || !st.public) return res.status(404).type('text/plain').send('Không tìm thấy ảnh');
    const img = await store.readImage(uid, dir, name, req.query.n);
    if (!img) return res.status(404).type('text/plain').send('Không tìm thấy ảnh');
    sendImage(res, img, 'public, max-age=3600');
});

exports.publicDownload = wrap(async (req, res) => {
    const { uid, dir, name } = parsePublic(req);
    const st = await store.stat(uid, dir, name);
    if (!st || !st.public) return notFoundPage(res);
    const out = await store.toDocx(uid, dir, name);
    if (!out) return notFoundPage(res);
    if (out.multi) sendZip(res, out.buffer, out.zipName);
    else sendDocx(res, out.buffer, out.meta.name);
});

// ---------------------------------------------------------------- phụ trợ
function sendDocx(res, buf, name) {
    const safe = String(name || 'tai-lieu.docx').replace(/["\\\r\n]/g, '_');
    const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
    res.status(200).set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
        'Cache-Control': 'no-store',
        'Content-Length': String(buf.length)
    });
    const write = (o) => {
        if (o >= buf.length) return res.end();
        if (res.write(buf.subarray(o, o + 256 * 1024)) === false) res.once('drain', () => write(o + 256 * 1024));
        else write(o + 256 * 1024);
    };
    write(0);
}
/** Tài liệu lớn: nhiều .docx đặt trong 1 file ZIP (ten-1.docx, ten-2.docx…). */
function sendZip(res, buf, name) {
    const safe = String(name || 'tai-lieu.zip').replace(/["\\\r\n]/g, '_');
    const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
    res.status(200).set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
        'Cache-Control': 'no-store',
        'Content-Length': String(buf.length)
    });
    const write = (o) => {
        if (o >= buf.length) return res.end();
        if (res.write(buf.subarray(o, o + 256 * 1024)) === false) res.once('drain', () => write(o + 256 * 1024));
        else write(o + 256 * 1024);
    };
    write(0);
}
async function sendChunked(res, buf, type, extra) {
    res.status(200).set({
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Length': String(buf.length),
        ...(extra || {})
    });
    for (let o = 0; o < buf.length; o += 256 * 1024) {
        if (res.write(buf.subarray(o, o + 256 * 1024)) === false) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
}
function sendImage(res, img, cache) {
    res.status(200).set({
        'Content-Type': img.mime,
        'Content-Length': String(img.buffer.length),
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff',
        ...(/svg/i.test(String(img.mime)) ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {})
    });
    res.end(img.buffer);
}
function publicDocument(doc) {
    const p = doc.meta.page || {};
    const m = p.marginsPx || { top: 96, right: 96, bottom: 96, left: 96 };
    const w = p.widthPx || 794, h = p.heightPx || 1123;
    const title = esc(doc.meta.title || doc.meta.name || 'Tài liệu Word');
    return '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        `<title>${title}</title><link rel="stylesheet" href="/css/word-doc.css"><style>` +
        `html,body{margin:0;background:#e2e8f0}body{padding:22px 10px}` +
        `.wd-doc{width:${w}px;min-height:${h}px;margin:0 auto;background:#fff;box-sizing:border-box;padding:${m.top}px ${m.right}px ${m.bottom}px ${m.left}px;box-shadow:0 12px 34px rgba(15,23,42,.18);border-radius:2px}` +
        `.wd-doc>.wd-content{min-height:${Math.max(120, h - m.top - m.bottom)}px}` +
        `@media(max-width:900px){.wd-doc{width:100%;min-height:0;padding:28px 22px}.wd-doc>.wd-content{min-height:0}}` +
        `@media print{html,body{background:#fff}body{padding:0}.wd-doc{width:auto;min-height:0;box-shadow:none;border-radius:0;padding:0}}` +
        `</style></head><body><div class="wd-doc"><div class="wd-content">${doc.html}</div></div></body></html>`;
}
