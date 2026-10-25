// controllers/html.controller.js — dạng code "HTML + CSS" (gắn trong /code/html/..., đặt TRƯỚC các route /code/:lang chung)
//   GET  /code/html                          thư mục & file của tôi (+ tải lên ảnh/âm thanh/video)
//   GET  /code/html/edit?dir=&file=[&view=1] soạn code ⇄ xem trang (iframe), link GitHub ở cuối trang
//   POST /code/html/file                     tạo file (html/css/js/json/svg/txt)
//   GET  /code/html/player?dir=[&file=]      trình phát ảnh / âm thanh / video của thư mục
//   POST /code/html/upload/init|finish|commit, PUT /code/html/upload/part|seg      tải lên (mã hoá, cắt m3u8)
//   POST /code/html/media/delete             xoá media đã cắt m3u8
//   POST /code/html/media/visibility         bật/tắt công khai 1 file ảnh/âm thanh/video (tắt → ảnh bị mã hoá, ẩn khỏi trang xem trên mạng)
//   POST /code/html/preview-token            xin token xem trước mới (token hết hạn sau 12 giờ)
//   GET  /code/html/online[?url=]            xem code trên mạng (link file GitHub/GitLab) + xem trang (kèm css/js/ảnh cùng thư mục)
//   GET  /code/html/online/folder?url=       xem thư mục trên mạng
//   GET  /code/html/online/player?url=&file= trình phát cho thư mục trên mạng
//   PUT  /code/html/save/part, POST /code/html/save/finish   lưu file chữ LỚN theo từng phần ≤ 3.5MB (Vercel chặn request > 4.5MB)
//   GET  /code/html/raw?dir=&file= , GET /code/html/online/raw?url=   tải nội dung file chữ lớn (ghi từng khúc, không nhúng vào trang)
// Việc đọc file khi xem trang nằm ở services/code/previewServer.js (/preview/<token>/...).
'use strict';
const crypto = require('crypto');
const store = require('../services/code/codeStore');
const media = require('../services/code/mediaService');
const remoteSource = require('../services/code/remoteSource');
const token = require('../services/code/previewToken');
const keys = require('../services/code/keyService');
const nodes = require('../services/connect/nodes');
const uploadToken = require('../services/connect/uploadToken');
const { canUploadMedia, uploadDenyMessage } = require('../middleware/uploadAuth');
const { LANGS, MEDIA, ASSET_EXTS, mediaKind } = require('../config/codeConfig');

const LANG = LANGS.html;
const uidOf = (req) => String(req.user._id);
const enc = (segs) => segs.map(encodeURIComponent).join('/');
const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; };
const isPage = (n) => LANG.runExts.includes(extOf(n));
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const BIG_INLINE = 1.5 * 1024 * 1024;     // file chữ > 1.5MB không nhúng vào HTML của trang soạn
const httpErr = (msg, status = 400) => Object.assign(new Error(msg), { status });

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        const status = e.status || (e.code === 'SHA_CONFLICT' ? 409 : 500);
        if (status === 500) console.error('[html]', e);
        if (req.method === 'GET' && !(req.headers.accept || '').includes('json')) {
            return res.status(status).render('error', { title: 'Lỗi', message: e.message, statusCode: status, stack: null, user: req.user });
        }
        res.status(status).json({ error: e.message });
    }
};

const ownToken = (uid) => token.sign({ k: 'own', uid });
// uid = chủ thư mục đang xem (đoạn đầu đường dẫn trong repo của app), viewer = người đang xem: keyService chỉ mở khoá media trong phạm vi này
const webPayload = (f, req) => ({ k: 'web', host: f.host, base: f.base, ref: f.ref, uid: (f.pathSegs || f.dirSegs || [])[0], viewer: uidOf(req) });
const webToken = (f, req) => token.sign(webPayload(f, req));
const directFlag = (payload) => { try { return keys.canDirect(payload, require('../services/githubService')); } catch (_) { return false; } };
const previewUrl = (tok, segs) => `/preview/${tok}/${enc(segs)}`;

const TEMPLATES = {
    html: () => LANG.template,
    htm: () => LANG.template,
    css: () => '/* CSS — nhúng vào html bằng: <link rel="stylesheet" href="style.css"> */\nbody {\n  font-family: system-ui, sans-serif;\n}\n',
    js: () => '// JavaScript — nhúng vào html bằng: <script src="main.js"></script>\nconsole.log("Xin chào, MNHA!");\n',
    json: () => '{\n}\n',
    svg: () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">\n  <circle cx="50" cy="50" r="40" fill="#6366f1"/>\n</svg>\n',
    txt: () => ''
};

// ---------------------------------------------------------------- file của tôi
exports.files = wrap(async (req, res) => {
    const uid = uidOf(req);
    const data = await store.list(uid, 'html', req.query.dir || '');
    const dirSegs = data.dir ? data.dir.split('/') : [];
    const hlsMedia = await media.listMedia(uid, dirSegs).catch(() => []);
    const names = new Set(data.files);
    const textFiles = [], assets = [];
    for (const f of data.files) {
        if (LANG.exts.includes(extOf(f))) textFiles.push(f);
        else if (mediaKind(f)) assets.push({ name: f, kind: mediaKind(f), cut: false });
    }
    for (const m of hlsMedia) if (!names.has(m.name)) assets.push({ name: m.name, kind: m.kind, cut: true, state: m.state, done: m.done, total: m.total, size: m.size });
    assets.sort((a, b) => a.name.localeCompare(b.name));
    const canUpload = canUploadMedia(req.user);
    const payload = {
        dir: data.dir,
        limits: { directMax: MEDIA.DIRECT_MAX, maxFile: MEDIA.MAX_FILE_BYTES, partBytes: MEDIA.PART_BYTES, hlsAudio: MEDIA.HLS_AUDIO_EXTS, hlsVideo: MEDIA.HLS_VIDEO_EXTS },
        exts: ASSET_EXTS, textExts: LANG.exts, canUpload
    };
    res.render('code/html-files', {
        title: LANG.name, user: req.user, lang: LANG, dir: data.dir,
        shareUrl: store.githubFolderUrl(uid, 'html', data.dir), folders: data.folders, textFiles, assets, isPage,
        canUpload, uploadMessage: canUpload ? null : uploadDenyMessage(req.user),
        payloadJson: json(payload)
    });
});

exports.createFile = wrap(async (req, res) => {
    const name = store.cleanFileName('html', req.body.name);
    const t = TEMPLATES[extOf(name)] || TEMPLATES.txt;
    await store.writeFile(uidOf(req), 'html', req.body.dir || '', name, t());
    res.json({ ok: true, file: name });
});

// ---------------------------------------------------------------- soạn code ⇄ xem trang
function renderEditor(req, res, o) {
    const canView = isPage(o.file);
    const payload = {
        dir: o.dir, file: o.file, content: o.content, canView, readOnly: !!o.online, online: o.online || null,
        contentUrl: o.contentUrl || null, previewUrl: o.previewUrl, tokenAt: Date.now(), startView: canView && o.startView, hlsjs: MEDIA.HLSJS_URL, mode: extOf(o.file)
    };
    res.render('code/html-editor', {
        title: o.file, user: req.user, lang: LANG, dir: o.dir, file: o.file, canView, online: o.online || null,
        githubUrl: o.githubUrl || null, shareLabel: o.shareLabel || 'Link GitHub:', playerUrl: o.playerUrl || null, folderUrl: o.folderUrl || null,
        payloadJson: json(payload)
    });
}

exports.edit = wrap(async (req, res) => {
    const uid = uidOf(req);
    const dirSegs = store.cleanDir(req.query.dir || '');
    const dir = dirSegs.join('/');
    const file = store.cleanFileName('html', req.query.file);
    let content = await store.readFile(uid, 'html', dir, file);
    if (content === null) throw httpErr('Không tìm thấy file', 404);
    content = store.displayText(file, content);      // .txt trắng → hiện dòng gợi ý
    const big = Buffer.byteLength(content) > BIG_INLINE;      // file lớn: không nhúng vào trang (Vercel chặn response > 4.5MB) → trình soạn tải riêng qua /code/html/raw
    renderEditor(req, res, {
        dir, file, content: big ? '' : content, contentUrl: big ? '/code/html/raw?dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(file) : null, previewUrl: previewUrl(ownToken(uid), [...dirSegs, file]), startView: req.query.view === '1',
        githubUrl: store.githubUrl(uid, 'html', dir, file), playerUrl: '/code/html/player?dir=' + encodeURIComponent(dir)
    });
});

// gửi chuỗi lớn theo từng khúc (không phải 1 response khổng lồ)
async function sendTextChunked(res, text) {
    const buf = Buffer.from(text, 'utf8');
    res.status(200).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(buf.length) });
    for (let o = 0; o < buf.length; o += 256 * 1024) {
        if (res.write(buf.subarray(o, o + 256 * 1024)) === false) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
}
exports.raw = wrap(async (req, res) => {
    const dirSegs = store.cleanDir(req.query.dir || '');
    const file = store.cleanFileName('html', req.query.file);
    const content = await store.readFile(uidOf(req), 'html', dirSegs.join('/'), file);
    if (content === null) throw httpErr('Không tìm thấy file', 404);
    await sendTextChunked(res, store.displayText(file, content));
});
exports.onlineRaw = wrap(async (req, res) => {
    const parsed = remoteSource.parseSourceUrl(String(req.query.url || '').trim());
    await sendTextChunked(res, await remoteSource.fetchText(parsed, { maxBytes: LANG.maxFileBytes }));
});
exports.savePart = wrap(async (req, res) => res.json(await store.putTextPart(uidOf(req), 'html', req.query, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))));
exports.saveFinish = wrap(async (req, res) => res.json(await store.finishText(uidOf(req), 'html', req.body || {})));

exports.previewToken = wrap(async (req, res) => {
    let tok;
    if (req.body && req.body.online) {
        const f = remoteSource.parseSourceUrl(req.body.online);
        tok = webToken(f, req);
    } else if (req.body && req.body.folder) {
        tok = webToken(await remoteSource.resolveRef(remoteSource.parseFolderUrl(req.body.folder)), req);
    } else tok = ownToken(uidOf(req));
    res.json({ token: tok });
});

// ---------------------------------------------------------------- trình phát (file của tôi)
function sortItems(items) {
    const order = { video: 0, audio: 1, image: 2 };
    return items.sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
}
exports.player = wrap(async (req, res) => {
    const uid = uidOf(req);
    const dirSegs = store.cleanDir(req.query.dir || '');
    const data = await store.list(uid, 'html', dirSegs.join('/'));
    const m = await media.readManifest(uid, dirSegs).catch(() => null);
    const hls = m ? media.listFrom(m) : [];
    const priv = new Set(m && Array.isArray(m.private) ? m.private : []);
    const tok = ownToken(uid);
    const base = (n) => previewUrl(tok, [...dirSegs, n]);
    const names = new Set();
    const items = [];
    for (const f of data.files) { const k = mediaKind(f); if (k) { names.add(f); items.push({ name: f, kind: k, url: base(f), dl: base(f) + '?dl=1', pub: !priv.has(f) }); } }
    for (const x of hls) if (!names.has(x.name)) items.push({ name: x.name, kind: x.kind, url: base(x.name), dl: base(x.name) + '?dl=1', cut: true, pending: x.state !== 'ready', pub: !priv.has(x.name) });
    const payload = { items: sortItems(items), start: String(req.query.file || ''), hlsjs: MEDIA.HLSJS_URL, direct: directFlag({ k: 'own', uid }), own: true, dir: dirSegs.join('/'), visUrl: '/code/html/media/visibility' };
    res.render('code/html-player', {
        title: 'Trình phát' + (dirSegs.length ? ' — ' + dirSegs.join('/') : ''), user: req.user, lang: LANG,
        backUrl: '/code/html' + (dirSegs.length ? '?dir=' + encodeURIComponent(dirSegs.join('/')) : ''), heading: 'Thư mục: ' + (dirSegs.join('/') || 'gốc'),
        payloadJson: json(payload)
    });
});
exports.mediaVisibility = wrap(async (req, res) => res.json(await media.setPublic(uidOf(req), req.body || {})));

// ---------------------------------------------------------------- tải lên
//
// Web chính KHÔNG tự nhận file nữa: /upload/init chỉ chọn web dữ liệu (kiểm tra
// LẦN LƯỢT cũ → mới), ký phiếu tải lên rồi trả địa chỉ web cho trình duyệt gửi
// thẳng. Không có web nào / tất cả lỗi → tuỳ CONNECT_FALLBACK_LOCAL mà báo lỗi
// hoặc tải lên máy chủ chính (kèm thông báo rõ).
const asBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.alloc(0));
const allowLocalFallback = () => String(process.env.CONNECT_FALLBACK_LOCAL || 'on').toLowerCase() !== 'off'
    && String(process.env.CONNECT_REQUIRED || '').toLowerCase() !== 'on';

exports.uploadInit = wrap(async (req, res) => {
    const uid = uidOf(req);
    const body = req.body || {};
    const dir = store.cleanDir(body.dir || '').join('/');
    const name = media.cleanAssetName(body.name);
    const base = { dir, name, lastModified: body.lastModified, srcName: body.srcName, size: body.size, encrypt: body.encrypt };

    // Web dữ liệu tự đăng nhập admin mặc định: dùng luôn máy chủ đó.
    if (String(process.env.DATA_NODE || '').toLowerCase() === 'on') {
        return res.json({ ok: true, mode: 'local', ...(await media.init(uid, base)) });
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    const plan = await nodes.pickForUpload({ uid, uploadId, name, dir }).catch((e) => ({ primary: null, candidates: [], checks: [], error: e.message }));
    if (plan.primary) {
        // Mỗi web có phiếu riêng (ký bằng khoá kết nối của web đó) — sai khoá thì web đó từ chối.
        return res.json({
            ok: true, mode: 'node', node: plan.primary, candidates: plan.candidates,
            token: plan.tokens[plan.primary.id], tokens: plan.tokens, uploadId, dir, name, ttl: uploadToken.TTL_MS, checks: plan.checks
        });
    }
    const error = plan.error || 'Không có web kết nối nào để tải lên.';
    if (!allowLocalFallback()) {
        throw Object.assign(new Error(error), { status: 503, code: 'NO_NODE' });
    }
    return res.json({
        ok: true, mode: 'local', notice: error + ' Tạm thời tải lên máy chủ chính.',
        checks: plan.checks || []
    });
});

// Tải lên máy chủ chính (fallback / web dữ liệu).
exports.uploadLocalInit = wrap(async (req, res) => res.json(await media.init(uidOf(req), req.body || {})));
exports.uploadPart = wrap(async (req, res) => res.json(await media.putPart(uidOf(req), req.query, asBuf(req.body))));
exports.uploadFinish = wrap(async (req, res) => res.json(await media.finish(uidOf(req), req.body || {})));
exports.uploadSeg = wrap(async (req, res) => res.json(await media.putSeg(uidOf(req), req.query, asBuf(req.body))));
exports.uploadCommit = wrap(async (req, res) => res.json(await media.commit(uidOf(req), req.body || {})));
exports.uploadNodeFail = wrap(async (req, res) => {
    const id = String((req.body && req.body.id) || req.query.id || '');
    if (id) nodes.markFailed(id);
    res.json({ ok: true });
});
exports.mediaDelete = wrap(async (req, res) => res.json(await media.deleteMedia(uidOf(req), req.body || {})));

// ---------------------------------------------------------------- xem code trên mạng
const onlineForm = (req, res, o = {}) => res.status(o.status || 200).render('code/html-online', {
    title: 'Xem code trên mạng', user: req.user, lang: LANG, url: o.url || '', folderUrl: o.folderUrl || '', error: o.error || null, errorFor: o.errorFor || null
});
const isUserErr = (e) => e.status && e.status < 500;

exports.online = wrap(async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return onlineForm(req, res);
    let parsed, content;
    try {
        parsed = remoteSource.parseSourceUrl(url);
        const last = String(parsed.last || '');
        if (!LANG.exts.includes(extOf(last))) throw httpErr(`Chỉ xem được file ${LANG.exts.map((e) => '.' + e).join(', ')} (link của bạn là "${last.slice(0, 60)}"). Muốn xem ảnh/âm thanh/video: dùng "Xem thư mục".`);
        content = await remoteSource.fetchText(parsed, { maxBytes: LANG.maxFileBytes });
    } catch (e) { if (isUserErr(e)) return onlineForm(req, res, { url, error: e.message, errorFor: 'file', status: e.status === 404 ? 404 : 400 }); throw e; }
    const dirSegs = parsed.pathSegs.slice(0, -1);
    const folderUrl = '/code/html/online/folder?url=' + encodeURIComponent(remoteSource.treeWeb(parsed, dirSegs));
    const big = Buffer.byteLength(content) > BIG_INLINE;
    renderEditor(req, res, {
        dir: '', file: parsed.last, content: big ? '' : content, contentUrl: big ? '/code/html/online/raw?url=' + encodeURIComponent(url) : null, online: parsed.web, previewUrl: previewUrl(webToken(parsed, req), parsed.pathSegs),
        githubUrl: parsed.web, shareLabel: parsed.host === 'gitlab' ? 'Nguồn (GitLab):' : 'Nguồn (GitHub):', folderUrl
    });
});

// Liệt kê thư mục trên mạng; cộng thêm media đã cắt m3u8 khai báo trong mnha-media.json (nếu có) để hiện đúng tên gốc
async function loadFolder(url) {
    let f = await remoteSource.resolveRef(remoteSource.parseFolderUrl(url));
    const items = await remoteSource.listFolder(f);
    let manifest = null;
    // Có mnha-media.json (kể cả khi thư mục chỉ có media đã cắt m3u8 → danh sách file rỗng) thì phải đọc để hiện video/âm thanh gốc
    if (items.hasManifest || items.some((x) => x.type === 'file' || x.type === 'dir')) {
        try { manifest = JSON.parse(await remoteSource.fetchText(remoteSource.fromParts(f, [...f.dirSegs, MEDIA.MANIFEST]), { maxBytes: 4 * 1024 * 1024 })); } catch (_) { manifest = null; }
    }
    return { f, items, manifest };
}
const privateSet = (manifest) => new Set(manifest && Array.isArray(manifest.private) ? manifest.private.map(String) : []);
const kindOfItem = (name) => (isPage(name) ? 'page' : LANG.exts.includes(extOf(name)) ? 'text' : mediaKind(name) || 'other');

exports.onlineFolder = wrap(async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return onlineForm(req, res, { status: 400, error: 'Hãy dán link thư mục.', errorFor: 'folder' });
    let d;
    try { d = await loadFolder(url); }
    catch (e) { if (isUserErr(e)) return onlineForm(req, res, { folderUrl: url, error: e.message, errorFor: 'folder', status: e.status === 404 ? 404 : e.status === 429 ? 429 : 400 }); throw e; }
    const { f, items, manifest } = d;
    const here = (segs) => '/code/html/online/folder?url=' + encodeURIComponent(remoteSource.treeWeb(f, segs));
    const fileLink = (name) => remoteSource.fromParts(f, [...f.dirSegs, name]).web;
    const priv = privateSet(manifest);           // file chủ sở hữu đã tắt công khai: không hiện, các file còn lại hiện bình thường
    const list = items.filter((x) => !(x.type === 'file' && priv.has(x.name))).map((x) => x.type === 'dir'
        ? { name: x.name, type: 'dir', href: here([...f.dirSegs, x.name]) }
        : { name: x.name, type: 'file', kind: kindOfItem(x.name), size: x.size, href: '/code/html/online?url=' + encodeURIComponent(fileLink(x.name)), web: fileLink(x.name) });
    const have = new Set(items.map((x) => x.name));
    if (manifest && manifest.files) for (const [name, e] of Object.entries(manifest.files)) {
        if (!have.has(name) && !priv.has(name) && e && e.state === 'ready' && mediaKind(name)) list.push({ name, type: 'file', kind: mediaKind(name), size: e.size, cut: true });
    }
    const playUrl = '/code/html/online/player?url=' + encodeURIComponent(remoteSource.treeWeb(f, f.dirSegs));
    const hasMedia = list.some((x) => x.type === 'file' && ['image', 'audio', 'video'].includes(x.kind));
    list.forEach((x) => { if (x.type === 'file' && ['image', 'audio', 'video'].includes(x.kind)) x.href = playUrl + '&file=' + encodeURIComponent(x.name); });
    list.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1));
    const crumbs = [{ name: f.base.join('/') + ' @ ' + f.ref, href: here([]) }];
    f.dirSegs.forEach((s, i) => crumbs.push({ name: s, href: here(f.dirSegs.slice(0, i + 1)) }));
    res.render('code/html-folder', {
        title: 'Xem thư mục trên mạng', user: req.user, lang: LANG, crumbs, list, hasMedia, playUrl, web: remoteSource.treeWeb(f, f.dirSegs),
        host: f.host === 'gitlab' ? 'GitLab' : 'GitHub', truncated: items.length >= 300
    });
});

exports.onlinePlayer = wrap(async (req, res) => {
    const url = String(req.query.url || '').trim();
    let d;
    try { d = await loadFolder(url); }
    catch (e) { if (isUserErr(e)) return onlineForm(req, res, { folderUrl: url, error: e.message, errorFor: 'folder', status: e.status === 404 ? 404 : 400 }); throw e; }
    const { f, items, manifest } = d;
    const tok = webToken(f, req);
    const mk = (name, extra) => ({ name, kind: mediaKind(name), url: previewUrl(tok, [...f.dirSegs, name]), dl: previewUrl(tok, [...f.dirSegs, name]) + '?dl=1', ...extra });
    const out = [], have = new Set();
    const priv = privateSet(manifest);
    for (const x of items) if (x.type === 'file' && mediaKind(x.name) && !priv.has(x.name)) { out.push(mk(x.name)); have.add(x.name); }
    if (manifest && manifest.files) for (const [name, e] of Object.entries(manifest.files)) if (!have.has(name) && !priv.has(name) && e && e.state === 'ready' && mediaKind(name)) out.push(mk(name, { cut: true }));
    const payload = { items: sortItems(out), start: String(req.query.file || ''), hlsjs: MEDIA.HLSJS_URL, direct: directFlag(webPayload(f, req)) };
    res.render('code/html-player', {
        title: 'Trình phát trên mạng', user: req.user, lang: LANG,
        backUrl: '/code/html/online/folder?url=' + encodeURIComponent(remoteSource.treeWeb(f, f.dirSegs)), heading: f.base.join('/') + (f.dirSegs.length ? ' / ' + f.dirSegs.join('/') : ''),
        payloadJson: json(payload)
    });
});
