// services/word/wordStore.js — lưu tài liệu Word trên GitHub: HTML đã mã hoá + mnha-word.json
//
//   {user_id}/file-word/[thư-mục/...]/ten.docx   ← HTML của tài liệu, MÃ HOÁ "MNHAENC1"
//   {user_id}/file-word/[thư-mục/...]/mnha-word.json  ← chỉ tiêu đề / khổ giấy / công khai / kích thước
//
// File .docx trong repo KHÔNG phải .docx thật: nó là HTML đã mã hoá AES-256-GCM (repo công khai cũng không đọc được).
// Tải lên .docx → chuyển sang HTML ngay trên máy chủ; tải về → chuyển HTML lại thành .docx thật.
'use strict';
const gh = require('../githubService');
const { LANGS } = require('../../config/codeConfig');
const mc = require('../code/mediaCrypto');
const { convertDocx } = require('./docxToHtml');
const { htmlToDocx } = require('./htmlToDocx');
const { sanitizeHtml } = require('./htmlSanitize');
const wi = require('./wordImages');
const { readZip } = require('./zip');
const store = require('../code/codeStore');

const LANG = LANGS.word;
const ROOT = LANG.root || 'file-word';
const MANIFEST = LANG.manifest || 'mnha-word.json';
const PART_MAX = 3.2 * 1024 * 1024;        // Vercel chặn request > 4.5MB
const PARTS_MAX = 64;

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const upId = (id) => { if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw bad('Mã lưu không hợp lệ.'); return String(id); };
const cleanDir = (dir) => store.cleanDir(Array.isArray(dir) ? dir.join('/') : dir);
const docName = (name) => {
    const n = String(name == null ? '' : name).trim();
    if (/\.doc$/i.test(n)) throw bad('Chỉ nhận tài liệu .docx. File .doc (Word 97-2003) hãy mở bằng Word rồi chọn "Save As" → .docx.');
    if (n.toLowerCase() === MANIFEST.toLowerCase()) throw bad('Tên file "' + MANIFEST + '" dành riêng cho hệ thống.');
    return store.cleanFileName('word', n);
};
const rootPath = (uid) => `${uid}/${ROOT}`;
const docPath = (uid, dir, name) => [rootPath(uid), ...(Array.isArray(dir) ? dir : cleanDir(dir)), docName(name)].join('/');
const manifestPath = (uid, dir) => [rootPath(uid), ...(Array.isArray(dir) ? dir : cleanDir(dir)), MANIFEST].join('/');
const stemOf = (name) => String(name || '').replace(/\.docx$/i, '');
// Thư mục ảnh của 1 tài liệu: {uid}/file-word/[thư-mục/...]/<tên-tài-liệu>/anh-001-....png
const imageDirPath = (uid, dir, name) => [rootPath(uid), ...(Array.isArray(dir) ? dir : cleanDir(dir)), stemOf(docName(name))].join('/');
const ownerMediaUrl = (uid, dir, name, img) => '/code/word/media?dir=' + encodeURIComponent(dir || '') + '&file=' + encodeURIComponent(name) +
    '&n=' + encodeURIComponent(img);
const publicMediaUrl = (uid, dir, name, img) => '/w/media?u=' + encodeURIComponent(uid) +
    '&p=' + encodeURIComponent([dir, name].filter(Boolean).join('/')) + '&n=' + encodeURIComponent(img);

const A4 = { widthPx: 794, heightPx: 1123 };
const LETTER = { widthPx: 816, heightPx: 1056 };
const MARGIN_PRESET = { normal: 96, narrow: 48, wide: 144 };
const clampMargin = (v) => Math.max(12, Math.min(288, Math.round(Number(v) || 0)));

/** Chuẩn hoá khổ giấy/lề do trình soạn gửi lên hoặc do .docx gốc khai báo. */
function normalizePage(page) {
    const p = page && typeof page === 'object' ? page : {};
    const size = String(p.size || '').toLowerCase() === 'letter' ? 'Letter' : 'A4';
    const orientation = String(p.orientation || '').toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
    const base = size === 'Letter' ? LETTER : A4;
    const widthPx = orientation === 'landscape' ? base.heightPx : base.widthPx;
    const heightPx = orientation === 'landscape' ? base.widthPx : base.heightPx;
    let margin = String(p.margin || '').toLowerCase();
    if (!['normal', 'narrow', 'wide', 'custom'].includes(margin)) margin = '';
    const raw = p.marginsPx && typeof p.marginsPx === 'object' ? p.marginsPx : null;
    const marginsPx = raw
        ? { top: clampMargin(raw.top), right: clampMargin(raw.right), bottom: clampMargin(raw.bottom), left: clampMargin(raw.left) }
        : null;
    if (!margin) {
        const v = marginsPx ? [marginsPx.top, marginsPx.right, marginsPx.bottom, marginsPx.left] : [];
        const close = (x) => v.length === 4 && v.every((n) => Math.abs(n - x) <= 6);
        margin = close(MARGIN_PRESET.normal) ? 'normal' : close(MARGIN_PRESET.narrow) ? 'narrow' : close(MARGIN_PRESET.wide) ? 'wide' : marginsPx ? 'custom' : 'normal';
    }
    if (margin !== 'custom') {
        const m = MARGIN_PRESET[margin] || MARGIN_PRESET.normal;
        return { size, orientation, margin, marginsPx: { top: m, right: m, bottom: m, left: m }, widthPx, heightPx };
    }
    return {
        size, orientation, margin,
        marginsPx: marginsPx || { top: 96, right: 96, bottom: 96, left: 96 },
        widthPx, heightPx
    };
}

async function readManifest(uid, dir) {
    let data = null;
    try { data = await gh.readJsonFile(manifestPath(uid, dir)); }
    catch (e) {
        if (e && e.status === 404) data = null;                        // chưa có manifest → coi như rỗng
        else if (e instanceof SyntaxError) data = null;                // manifest hỏng → không chặn việc đọc tài liệu
        else throw e;                                                  // lỗi mạng/quyền → báo lỗi, KHÔNG âm thầm coi là riêng tư
    }
    const docs = data && data.docs && typeof data.docs === 'object' ? data.docs : {};
    return { version: 1, docs };
}
async function writeManifest(uid, dir, manifest) {
    const out = { version: 1, docs: manifest && manifest.docs && typeof manifest.docs === 'object' ? manifest.docs : {} };
    await gh.writeJsonFile(manifestPath(uid, dir), out, 'word: manifest ' + (cleanDir(dir).join('/') || 'root'));
    return out;
}
async function patchEntry(uid, dir, name, patch, remove) {
    const m = await readManifest(uid, dir);
    if (remove) delete m.docs[name];
    else m.docs[name] = Object.assign({}, m.docs[name] || {}, patch || {});
    await writeManifest(uid, dir, m);
    return m.docs[name] || null;
}
function entryOf(manifest, name) {
    const x = manifest && manifest.docs ? manifest.docs[name] : null;
    return x && typeof x === 'object' ? x : {};
}
function titleOf(name) {
    return String(name || '').replace(/\.docx$/i, '').replace(/[_]+/g, ' ').trim() || 'Tài liệu Word';
}

/** Danh sách tài liệu trong thư mục (ẩn mnha-word.json và thư mục ảnh tách từ tài liệu). */
async function list(uid, dir) {
    const segs = cleanDir(dir);
    const prefix = [rootPath(uid), ...segs].join('/') + '/';
    const tree = await gh.getRepoTree();
    // đang ở trong thư mục ảnh của 1 tài liệu? (thư mục cùng tên, không đuôi .docx, nằm cạnh tài liệu)
    const last = segs[segs.length - 1];
    const insideImages = !!last && tree.files.has([rootPath(uid), ...segs.slice(0, -1), last + '.docx'].join('/'));
    const folders = new Set(), names = [], plainFolders = new Set();
    for (const [p] of tree.files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i >= 0) {
            const f = rest.slice(0, i);
            folders.add(f);
            // thư mục chỉ chứa ảnh do hệ thống tách ra mới bị ẩn; có file khác → vẫn là thư mục người dùng
            if (rest.slice(i + 1) !== '.keep' && !wi.isImageName(rest.slice(i + 1))) plainFolders.add(f);
        } else if (rest !== '.keep' && rest !== MANIFEST && !(insideImages && wi.isImageName(rest))) names.push(rest);
    }
    const docsInDir = new Set(names.filter((n) => /\.docx$/i.test(n)).map(stemOf));
    const manifest = await readManifest(uid, segs);
    const docs = names.filter((n) => /\.docx$/i.test(n)).sort().map((name) => {
        const e = entryOf(manifest, name);
        return {
            name,
            title: e.title || titleOf(name),
            size: Number(e.size) || 0,
            public: e.public === true,
            updatedAt: e.updatedAt || null,
            page: normalizePage(e.page || {})
        };
    });
    return {
        dir: segs.join('/'),
        folders: [...folders].filter((f) => f !== '.keep' && (!docsInDir.has(f) || plainFolders.has(f))).sort(),
        docs, manifest
    };
}

/** Thông tin 1 tài liệu (null nếu chưa có file). */
async function stat(uid, dir, name) {
    const segs = cleanDir(dir), file = docName(name);
    const p = [rootPath(uid), ...segs, file].join('/');
    const tree = await gh.getRepoTree();
    if (!tree.files.has(p)) return null;
    const m = await readManifest(uid, segs);
    const e = entryOf(m, file);
    return {
        dir: segs.join('/'), name: file, title: e.title || titleOf(file), size: Number(e.size) || 0,
        public: e.public === true, updatedAt: e.updatedAt || null, page: normalizePage(e.page || {})
    };
}

async function readBuffer(path) {
    const read = gh.readBinaryFileLarge || gh.readBinaryFile;
    try { return await read(path); }
    catch (e) { if (e && e.status === 404) return null; throw e; }
}

/** Đọc + giải mã tài liệu → { html, meta }. File .docx thật (do người dùng đặt tay) vẫn đọc được. */
async function readDoc(uid, dir, name) {
    const segs = cleanDir(dir), file = docName(name);
    const p = [rootPath(uid), ...segs, file].join('/');
    const buf = await readBuffer(p);
    if (!buf) return null;
    const m = await readManifest(uid, segs);
    const e = entryOf(m, file);
    let html;
    if (mc.isEncrypted(buf)) {
        try { html = mc.decryptBuffer(buf).toString('utf8'); }
        catch (err) { throw bad('Không giải mã được tài liệu (sai MEDIA_ENC_KEY hoặc file bị sửa): ' + err.message, 422); }
    } else if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
        const c = convertDocx(buf);
        html = sanitizeHtml(c.html);
    } else {
        throw bad('File Word không hợp lệ (không phải tài liệu của hệ thống).', 422);
    }
    return {
        html: html || '<p><br></p>',
        meta: {
            dir: segs.join('/'), name: file, title: e.title || titleOf(file), size: Number(e.size) || buf.length,
            public: e.public === true, updatedAt: e.updatedAt || null,
            page: normalizePage(e.page || {})
        }
    };
}

/**
 * Đọc 1 ảnh đã tách của tài liệu (giải mã nếu cần). null nếu không có.
 * Ảnh nằm ở {uid}/file-word/[dir]/<tên-tài-liệu>/<tên-ảnh>.
 */
async function readImage(uid, dir, name, img) {
    const segs = cleanDir(dir), file = docName(name);
    const image = String(img || '').trim();
    if (!wi.isImageName(image)) throw bad('Tên ảnh không hợp lệ.', 400);
    const buf = await readBuffer(imageDirPath(uid, segs, file) + '/' + image);
    if (!buf) return null;
    let data = buf;
    if (mc.isEncrypted(buf)) {
        try { data = mc.decryptBuffer(buf); }
        catch (err) { throw bad('Không giải mã được ảnh (sai MEDIA_ENC_KEY hoặc file bị sửa): ' + err.message, 422); }
    }
    if (!wi.magicOk(data, wi.extOf(image))) throw bad('Ảnh không hợp lệ (nội dung không khớp đuôi file).', 422);
    return { name: image, buffer: data, mime: wi.mimeOf(image) };
}

/** HTML lưu trong repo chỉ ghi tên ảnh → URL cho chủ tài liệu (đã đăng nhập). */
function inlineMediaUrls(html, uid, dir, name) {
    return wi.mapImageSrc(html, (img) => ownerMediaUrl(uid, dir, name, img));
}
/** HTML công khai → URL /w/media (kiểm tra công khai ở route). */
function publicMediaUrls(html, uid, dir, name) {
    return wi.mapImageSrc(html, (img) => publicMediaUrl(uid, dir, name, img));
}
/** Đổi tên ảnh → data: URI để nhúng lại vào .docx khi tải về (ảnh thiếu thì giữ nguyên). */
async function inlineImageData(uid, dir, name, html) {
    const names = wi.imageNames(html);
    if (!names.size) return html;
    const max = LANG.maxHtmlBytes || 32 * 1024 * 1024;
    const map = new Map();
    let total = 0;
    for (const img of names) {
        let got;
        try { got = await readImage(uid, dir, name, img); } catch (_) { continue; }   // ảnh hỏng → bỏ, vẫn tải được .docx
        if (!got) continue;
        total += got.buffer.length;
        if (total > max) break;
        map.set(img, wi.dataUriOf(wi.extOf(img), got.buffer));
    }
    return wi.mapImageSrc(html, (img) => map.get(img) || null);
}

/** Ghi HTML đã mã hoá, cập nhật manifest. public giữ nguyên nếu không chỉ định. */
async function writeDoc(uid, dir, name, html, opt = {}) {
    const segs = cleanDir(dir), file = docName(name);
    const m = await readManifest(uid, segs);
    const old = entryOf(m, file);
    // Làm sạch trước, rồi tách ảnh data: URI thành file riêng; tên ảnh (anh-001-...) được giữ trong HTML.
    const clean = sanitizeHtml(String(html == null ? '' : html));
    const plan = wi.planImages(clean, old.images, wi.MAX_IMAGES);
    const text = plan.html || '<p><br></p>';
    const size = Buffer.byteLength(text);
    const max = LANG.maxHtmlBytes || 32 * 1024 * 1024;
    if (size > max) throw bad('Tài liệu quá lớn (tối đa ' + Math.round(max / 1048576) + 'MB HTML). Hãy bớt ảnh hoặc chia nhỏ tài liệu.', 413);

    // Ảnh mới + ảnh không còn dùng: 1 commit, mỗi ảnh mã hoá AES-256-GCM như HTML.
    const imgDir = imageDirPath(uid, segs, file);
    const changes = plan.files.map((f) => ({ path: imgDir + '/' + f.name, content: mc.encryptBuffer(f.buffer) }));
    for (const n of plan.removed) changes.push({ path: imgDir + '/' + n, remove: true });
    if (changes.length) await gh.commitFiles(changes, 'word: images ' + [segs.join('/'), file].filter(Boolean).join('/'));

    const enc = mc.encryptBuffer(Buffer.from(text, 'utf8'));
    const p = [rootPath(uid), ...segs, file].join('/');
    const write = enc.length > 512 * 1024 && gh.writeBinaryFileBig ? gh.writeBinaryFileBig : gh.writeBinaryFile;
    await write(p, enc, 'word: save ' + [segs.join('/'), file].filter(Boolean).join('/'));
    const page = normalizePage(opt.page || old.page || {});
    const meta = {
        title: String(opt.title || old.title || titleOf(file)).slice(0, 200),
        public: opt.public === undefined ? old.public === true : !!opt.public,
        page,
        size,
        images: plan.images,
        updatedAt: new Date().toISOString()
    };
    await patchEntry(uid, segs, file, meta);
    return { ok: true, size, name: file, meta, images: Object.keys(plan.images).length };
}

async function createDoc(uid, dir, name, opt = {}) {
    const file = docName(name);
    // "Tài liệu mới" không ghi đè tài liệu đã có (tải .docx lên mới là đường ghi đè, có hỏi lại)
    if (await stat(uid, dir, file)) throw bad('Đã có tài liệu tên "' + file + '". Hãy mở tài liệu đó hoặc chọn tên khác.', 409);
    const html = opt.html || '<p><br></p>';
    const out = await writeDoc(uid, dir, file, html, { title: opt.title || titleOf(file), page: opt.page, public: false });
    return { file, name: file, ...out };
}

async function saveHtml(uid, dir, name, html, opt = {}) {
    return writeDoc(uid, dir, name, html, opt);
}

async function removeDoc(uid, dir, name) {
    const segs = cleanDir(dir), file = docName(name);
    const p = [rootPath(uid), ...segs, file].join('/');
    const tree = await gh.getRepoTree({ force: true });
    if (!tree.files.has(p)) throw bad('Không tìm thấy tài liệu', 404);
    const prefix = imageDirPath(uid, segs, file) + '/';
    const changes = [{ path: p, remove: true }];
    for (const q of tree.files.keys()) {
        // chỉ xoá ảnh do hệ thống tạo (anh-NNN-...), không đụng file khác người dùng đặt trong thư mục
        if (q.startsWith(prefix) && wi.isImageName(q.slice(prefix.length))) changes.push({ path: q, remove: true });
    }
    await gh.commitFiles(changes, 'word: delete ' + file);
    await patchEntry(uid, segs, file, null, true);
    return { ok: true };
}

async function renameDoc(uid, dir, oldName, newName) {
    const segs = cleanDir(dir), from = docName(oldName);
    let to = String(newName == null ? '' : newName).trim();
    if (to && !/\.[A-Za-z0-9]+$/.test(to)) to += '.docx';
    to = docName(to);
    if (to === from) return { file: from, moved: 0 };
    const m = await readManifest(uid, segs);
    const old = m.docs[from] || null;
    const hasImages = !!(old && old.images && Object.keys(old.images).length);
    const fromPath = [rootPath(uid), ...segs, from].join('/');
    const toPath = [rootPath(uid), ...segs, to].join('/');
    const tree = await gh.getRepoTree({ force: true });
    if (!tree.files.has(fromPath)) throw bad('Không tìm thấy tài liệu', 404);
    if (tree.files.has(toPath)) throw bad('Đã có tài liệu tên "' + to + '" ở đây — hãy chọn tên khác.', 409);
    const fromImg = imageDirPath(uid, segs, from), toImg = imageDirPath(uid, segs, to);
    // 1 commit: chuyển tài liệu + cả thư mục ảnh sang tên mới (giữ nguyên sha, không tải nội dung)
    const changes = [{ path: toPath, sha: tree.files.get(fromPath) }, { path: fromPath, remove: true }];
    let moved = 1;
    if (fromImg !== toImg && hasImages) {
        if (tree.truncated) throw bad('Repo quá lớn để đổi tên tài liệu an toàn.');
        const items = [...tree.files.keys()].filter((q) => q.startsWith(fromImg + '/'));
        if (items.length > 1000) throw bad('Tài liệu có quá nhiều ảnh (>1000) để đổi tên.');
        if ([...tree.files.keys()].some((q) => q.startsWith(toImg + '/'))) {
            throw bad('Đã có thư mục "' + stemOf(to) + '" ở đây — hãy chọn tên khác.', 409);
        }
        for (const q of items) {
            changes.push({ path: toImg + '/' + q.slice(fromImg.length + 1), sha: tree.files.get(q) });
            changes.push({ path: q, remove: true });
            moved++;
        }
    }
    await gh.commitFiles(changes, 'word: rename ' + [segs.join('/'), from].filter(Boolean).join('/') + ' -> ' + to);
    delete m.docs[from];
    if (old) m.docs[to] = Object.assign({}, old, { title: titleOf(to), updatedAt: new Date().toISOString() });
    await writeManifest(uid, segs, m);
    return { file: to, moved };
}

async function setPublic(uid, dir, name, isPublic) {
    const segs = cleanDir(dir), file = docName(name);
    const st = await stat(uid, segs, file);
    if (!st) throw bad('Không tìm thấy tài liệu', 404);
    await patchEntry(uid, segs, file, { public: !!isPublic, updatedAt: new Date().toISOString() });
    return { ok: true, public: !!isPublic, name: file };
}

/** Tài liệu công khai + HTML (null nếu không công khai / không có). */
async function getPublic(uid, dir, name) {
    const segs = cleanDir(dir), file = docName(name);
    const m = await readManifest(uid, segs);
    if (entryOf(m, file).public !== true) return null;
    return readDoc(uid, segs, file);
}

/** HTML → .docx thật để tải về (ảnh tách rời được nhúng lại dạng data: URI). */
async function toDocx(uid, dir, name) {
    const d = await readDoc(uid, dir, name);
    if (!d) return null;
    const html = await inlineImageData(uid, d.meta.dir, d.meta.name, d.html);
    const buf = htmlToDocx(html, { title: d.meta.title, page: d.meta.page });
    return { buffer: buf, meta: d.meta };
}

// ---------------------------------------------------------------- lưu/tải theo từng phần (≤ 3.2MB/request)
// Mỗi phần được MÃ HOÁ ngay trên máy chủ trước khi tạo blob GitHub: không có HTML/.docx rõ nào nằm trong kho blob.
function partSalt(uid, id, path, scope) {
    return mc.deriveSalt(`${uid}|${id}|${path}|${scope}`);
}
function scopeOf(kind) { return kind === 'docx' ? 'docx' : 'html'; }

async function putPart(uid, kind, q, body) {
    const segs = cleanDir(q.dir || ''), file = docName(q.file);
    const p = [rootPath(uid), ...segs, file].join('/');
    const id = upId(q.uploadId), scope = scopeOf(kind);
    const i = Number(q.i), n = Number(q.n);
    if (!Buffer.isBuffer(body) || !body.length) throw bad('Phần dữ liệu rỗng.');
    if (body.length > PART_MAX) throw bad('Phần dữ liệu quá lớn.', 413);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > PARTS_MAX || i < 0 || i >= n) throw bad('Số thứ tự phần không hợp lệ.');
    const salt = partSalt(uid, id, p, scope);
    const rec = mc.encryptRecord(body, salt, i);
    const sha = await gh.createBlob(rec);
    const size = rec.length;
    return { ok: true, sha, size, receipt: mc.receipt(uid, id, `${p}#${scope}#${i}`, sha, size) };
}

async function collectParts(uid, id, path, scope, parts, maxTotal) {
    if (!Array.isArray(parts) || !parts.length || parts.length > PARTS_MAX) throw bad('Số phần không hợp lệ.');
    const salt = partSalt(uid, id, path, scope);
    const records = [];
    let total = 0;
    for (let i = 0; i < parts.length; i++) {
        const x = parts[i] || {};
        if (Number(x.i) !== i) throw bad('Các phần phải đủ và đúng thứ tự.');
        const size = Number(x.size);
        if (!Number.isInteger(size) || size < 0 || size > PART_MAX + 1024) throw bad('Kích thước phần không hợp lệ.');
        if (!mc.verifyReceipt(x.receipt, uid, id, `${path}#${scope}#${i}`, String(x.sha), size)) throw bad('Biên nhận phần ' + (i + 1) + ' không hợp lệ.', 403);
        total += size;
        if (maxTotal && total > maxTotal) throw bad('Tài liệu quá lớn.', 413);
        const buf = await gh.getBlobBuffer(String(x.sha));
        if (!buf || buf.length !== size) throw bad('Không đọc lại được phần ' + (i + 1) + ' trên GitHub — hãy lưu lại.');
        records.push(buf);
    }
    return { salt, records, total };
}

async function finishSave(uid, b) {
    const segs = cleanDir(b.dir || ''), file = docName(b.file);
    const p = [rootPath(uid), ...segs, file].join('/');
    const id = upId(b.uploadId);
    const max = (LANG.maxHtmlBytes || 32 * 1024 * 1024) + 64 * 1024;
    const { salt, records } = await collectParts(uid, id, p, 'html', b.parts, max);
    let plain;
    try { plain = mc.decryptBuffer(mc.assemble(salt, records)); }
    catch (err) { throw bad('Không giải mã được nội dung đã gửi: ' + err.message, 422); }
    const out = await writeDoc(uid, segs, file, plain.toString('utf8'), {
        page: b.page, title: b.title
    });
    return out;
}

async function finishDocx(uid, b) {
    const segs = cleanDir(b.dir || ''), file = docName(b.file);
    const p = [rootPath(uid), ...segs, file].join('/');
    const id = upId(b.uploadId);
    const max = (LANG.maxFileBytes || 80 * 1024 * 1024) + 256 * 1024;
    const { salt, records } = await collectParts(uid, id, p, 'docx', b.parts, max);
    let docx;
    try { docx = mc.decryptBuffer(mc.assemble(salt, records)); }
    catch (err) { throw bad('Không giải mã được file Word đã gửi: ' + err.message, 422); }
    if (!(docx.length > 4 && docx[0] === 0x50 && docx[1] === 0x4b)) throw bad('File không phải .docx hợp lệ (hoặc đã hỏng).');
    const zip = readZip(docx);       // kiểm tra sớm: đúng ZIP + có word/document.xml
    if (!zip.has('word/document.xml')) throw bad('File không phải tài liệu Word .docx hợp lệ.');
    const c = convertDocx(docx);
    const out = await writeDoc(uid, segs, file, c.html, {
        page: c.page, title: String(b.title || c.title || titleOf(file)).slice(0, 200)
    });
    return { ...out, converted: true, page: normalizePage(c.page) };
}

module.exports = {
    ROOT, MANIFEST, PART_MAX, PART_MAX_PARTS: PARTS_MAX,
    normalizePage, readManifest, list, stat, readDoc, writeDoc, createDoc, saveHtml, removeDoc, renameDoc, setPublic, getPublic, toDocx,
    readImage, imageDirPath, inlineMediaUrls, publicMediaUrls, inlineImageData,
    putPart, finishSave, finishDocx, docName, titleOf
};
