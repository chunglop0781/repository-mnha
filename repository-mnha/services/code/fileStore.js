// services/code/fileStore.js — "Lưu trữ file": file Office (Word, Excel, PowerPoint…), PDF và ảnh.
//
//   {uid}/codes/files/[thư-mục/...]/mnha-files.json        ← danh sách file của thư mục (luôn ở repo CHÍNH, vì là .json)
//   {uid}/codes/files/[thư-mục/...]/_data/<mã>/0001.bin    ← các PHẦN của file, mỗi phần mã hoá riêng (MNHAENC1, AES-256-GCM)
//                                                              …/0002.bin, 0003.bin …
//
//   • File được chia thành các phần ≤ FILES.PART_BYTES (Vercel chặn request > 4.5MB): file nhẹ = 1 phần, file nặng = nhiều phần.
//   • Phần là file .bin (không phải file chữ) → nhóm repo (services/githubPool.js) ghi vào repo ĐANG DÙNG; repo đầy thì
//     tự tạo repo kế (…-1, -2, …) và các phần sau ghi sang đó, nên một file nặng có thể trải qua nhiều repo THEO THỨ TỰ repo được tạo.
//     Mỗi phần ghi lại repo đã chứa nó (`repo`) trong mnha-files.json; đọc thì gộp cây thư mục của mọi repo.
//   • Mỗi request chỉ mang MỘT phần, không giữ trạng thái giữa các request:  init → PUT part × n → finish.
//     Mã tải lên (uploadId) dẫn xuất từ (uid, thư mục, tên, kích thước, ngày sửa) nên tải lại đúng file đó sẽ LÀM TIẾP — bỏ qua các phần đã lên.
//   • Tải về: máy chủ đọc từng phần, giải mã, gửi nối tiếp (xem controllers/files.controller.js, token ký ở signDownload).
'use strict';
const crypto = require('crypto');
const gh = require('../githubService');
const mc = require('./mediaCrypto');
const { FILES, fileKind } = require('../../config/codeConfig');
const { NAME_RE } = require('../../config/codeConfig');

const KEEP = '.keep';
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const root = (uid) => `${uid}/${FILES.ROOT}`;
const join = (...p) => p.filter(Boolean).join('/');
const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; };
const pad = (n) => String(n).padStart(4, '0');

const MIME = {
    pdf: 'application/pdf', doc: 'application/msword', dot: 'application/msword', rtf: 'application/rtf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    docm: 'application/vnd.ms-word.document.macroEnabled.12',
    xls: 'application/vnd.ms-excel', xlt: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
    ppt: 'application/vnd.ms-powerpoint', pps: 'application/vnd.ms-powerpoint', pot: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
    pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
    vsd: 'application/vnd.visio', vsdx: 'application/vnd.ms-visio.drawing', pub: 'application/vnd.ms-publisher', mpp: 'application/vnd.ms-project', one: 'application/onenote',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic'
};
const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';

// ---------------------------------------------------------------- tên thư mục / file
/** "a/b/c" → ['a','b','c']. Giống codeStore.cleanDir nhưng chặn thêm thư mục hệ thống _data. */
function cleanDir(dir) {
    const segs = String(dir || '').split('/').map((s) => s.trim()).filter(Boolean);
    for (const s of segs) {
        if (!NAME_RE.test(s)) throw bad('Tên thư mục chỉ gồm chữ, số, "-", "_" và dấu ngoặc ( )');
        if (s === FILES.DATA_DIR) throw bad('Tên thư mục "' + FILES.DATA_DIR + '" dành riêng cho hệ thống (chứa các phần file đã mã hoá).');
    }
    return segs;
}
/**
 * Tên file hiển thị (có thể có tiếng Việt, dấu cách). Tên chỉ nằm trong mnha-files.json — đường dẫn thật trong repo là _data/<mã>/NNNN.bin
 * nên không lo ký tự lạ. Đuôi phải thuộc nhóm được nhận (Office / PDF / ảnh).
 */
function cleanName(name) {
    let n = String(name == null ? '' : name).normalize('NFC').replace(/[\\/]+/g, '_').trim();
    // eslint-disable-next-line no-control-regex
    if (!n || n.length > FILES.MAX_NAME || /[\u0000-\u001f<>:"|?*]/.test(n) || n.startsWith('.')) {
        throw bad(`Tên file không hợp lệ (1–${FILES.MAX_NAME} ký tự, không có < > : " | ? * và không bắt đầu bằng dấu chấm).`);
    }
    if (n.toLowerCase() === FILES.MANIFEST) throw bad('Tên file "' + FILES.MANIFEST + '" dành riêng cho hệ thống.');
    if (!fileKind(n)) {
        throw bad('Chỉ nhận file Word, Excel, PowerPoint (và các file Office khác), PDF và ảnh — đuôi ".' + (extOf(n) || '?') + '" không được nhận.');
    }
    return n;
}
const manifestPath = (uid, segs) => join(root(uid), segs.join('/'), FILES.MANIFEST);
const dataPrefix = (uid, segs, id) => join(root(uid), segs.join('/'), FILES.DATA_DIR, id) + '/';
const partPath = (uid, segs, id, i) => dataPrefix(uid, segs, id) + pad(i + 1) + '.bin';

const hex32 = (s) => /^[a-f0-9]{32}$/.test(String(s || ''));
/** Mã tải lên cố định theo (uid, thư mục, tên, kích thước, ngày sửa) → tải lại đúng file thì làm tiếp được. */
function uploadIdFor(uid, segs, name, size, lastModified) {
    return crypto.createHmac('sha256', mc.signKey()).update(['files', uid, segs.join('/'), name, size, Number(lastModified) || 0].join('|')).digest('hex').slice(0, 32);
}
const partsCount = (size) => Math.max(1, Math.ceil(size / FILES.PART_BYTES));

// ---------------------------------------------------------------- sổ file (mnha-files.json)
async function readManifest(uid, segs) {
    const m = await gh.readJsonFile(manifestPath(uid, segs)).catch(() => null);
    const out = m && typeof m === 'object' ? m : {};
    if (!out.files || typeof out.files !== 'object') out.files = {};
    out.v = 1;
    return out;
}
/** Sửa sổ file an toàn khi nhiều request cùng ghi (SHA đổi → đọc lại, làm lại). fn(manifest) sửa tại chỗ hoặc trả về sổ mới. */
async function mutateManifest(uid, segs, fn, message) {
    const p = manifestPath(uid, segs);
    let last = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        const cur = await gh.readJsonFileWithSha(p).catch(() => null);
        const m = cur && cur.data && typeof cur.data === 'object' ? cur.data : {};
        if (!m.files || typeof m.files !== 'object') m.files = {};
        m.v = 1;
        const next = (await fn(m)) || m;
        next.updatedAt = new Date().toISOString();
        try {
            if (!Object.keys(next.files).length && cur) {
                await gh.commitFiles([{ path: p, remove: true }], message);      // hết file → bỏ luôn sổ
            } else if (Object.keys(next.files).length) {
                await gh.writeJsonFileIfSha(p, next, cur ? cur.sha : null, message);
            }
            return next;
        } catch (e) {
            last = e;
            if (e.code !== 'SHA_CONFLICT') throw e;
            await new Promise((ok) => setTimeout(ok, 200 * (attempt + 1)));
        }
    }
    throw last || bad('Không ghi được sổ file (xung đột).', 409);
}

async function treePathsUnder(prefix) {
    const t = await gh.getRepoTree({ force: true });
    return [...t.files.keys()].filter((p) => p.startsWith(prefix));
}

// ---------------------------------------------------------------- danh sách
async function list(uid, dir) {
    const segs = cleanDir(dir);
    const prefix = join(root(uid), segs.join('/')) + '/';
    const tree = await gh.getRepoTree();
    const folders = new Set();
    for (const [p] of tree.files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length), i = rest.indexOf('/');
        if (i >= 0) { const f = rest.slice(0, i); if (f !== FILES.DATA_DIR) folders.add(f); }
    }
    const m = await readManifest(uid, segs);
    const files = Object.values(m.files).filter((e) => e && e.name && e.state !== 'uploading').map((e) => ({
        name: e.name, kind: e.kind, size: e.size, mime: e.mime, parts: Array.isArray(e.parts) ? e.parts.length : 1,
        repos: [...new Set((e.parts || []).map((x) => x.repo).filter(Boolean))],
        createdAt: e.createdAt || null, updatedAt: e.updatedAt || null
    })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    return { dir: segs.join('/'), folders: [...folders].sort(), files };
}

async function mkdir(uid, dir, name) {
    const segs = [...cleanDir(dir), ...cleanDir(name)];
    await gh.writeBinaryFile(join(root(uid), segs.join('/'), KEEP), Buffer.from(''), `files: mkdir ${segs.join('/')}`);
    return segs.join('/');
}

// ---------------------------------------------------------------- tải lên
/** Bước 1: kiểm tra tên/đuôi/kích thước, cho biết đã có file cùng tên chưa và những phần nào đã lên (để làm tiếp). */
async function init(uid, b) {
    const segs = cleanDir(b.dir);
    const name = cleanName(b.name);
    const size = Number(b.size);
    if (!Number.isInteger(size) || size <= 0) throw bad('File rỗng hoặc kích thước không hợp lệ.');
    if (size > FILES.MAX_FILE_BYTES) throw bad(`File quá lớn (tối đa ${Math.round(FILES.MAX_FILE_BYTES / 1048576)}MB).`);
    const id = uploadIdFor(uid, segs, name, size, b.lastModified);
    const n = partsCount(size);
    const m = await readManifest(uid, segs);
    const have = [];
    const prefix = dataPrefix(uid, segs, id);
    const tree = await gh.getRepoTree({ force: true });
    for (let i = 0; i < n; i++) if (tree.files.has(prefix + pad(i + 1) + '.bin')) have.push(i);
    const ex = m.files[name];
    return {
        ok: true, name, kind: fileKind(name), size, uploadId: id, partBytes: FILES.PART_BYTES, n, have,
        exists: !!(ex && ex.state !== 'uploading')
    };
}

/** Bước 2: nhận 1 phần (≤ PART_BYTES): mã hoá rồi ghi thành _data/<mã>/NNNN.bin (repo đang dùng của nhóm repo). */
async function putPart(uid, q, body) {
    const segs = cleanDir(q.dir);
    const name = cleanName(q.name);
    if (!hex32(q.uploadId)) throw bad('Mã tải lên không hợp lệ.');
    const i = Number(q.i), n = Number(q.n);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 0 || i >= n) throw bad('Số thứ tự phần không hợp lệ.');
    if (n > partsCount(FILES.MAX_FILE_BYTES)) throw bad('Quá nhiều phần.');
    if (!Buffer.isBuffer(body) || !body.length) throw bad('Phần dữ liệu rỗng.');
    if (body.length > FILES.PART_BYTES) throw bad('Phần dữ liệu quá lớn.', 413);
    if (i < n - 1 && body.length !== FILES.PART_BYTES) throw bad('Các phần trước phần cuối phải đủ ' + FILES.PART_BYTES + ' byte.');
    const p = partPath(uid, segs, String(q.uploadId), i);
    const data = mc.encryptBuffer(body);
    await gh.writeBinaryFileBig(p, data, `files: ${name} (phần ${i + 1}/${n})`);
    let repo = null;
    try { const r = await gh.repoFor(p); repo = r && r.repo ? r.repo : null; } catch (_) { /* không biết repo → bỏ qua */ }
    return { ok: true, i, size: body.length, stored: data.length, repo };
}

/** Bước 3: kiểm tra đủ phần rồi ghi mục vào sổ file (thay file cùng tên nếu có, và dọn các phần của bản cũ). */
async function finish(uid, b) {
    const segs = cleanDir(b.dir);
    const name = cleanName(b.name);
    if (!hex32(b.uploadId)) throw bad('Mã tải lên không hợp lệ.');
    const size = Number(b.size);
    if (!Number.isInteger(size) || size <= 0 || size > FILES.MAX_FILE_BYTES) throw bad('Kích thước file không hợp lệ.');
    if (uploadIdFor(uid, segs, name, size, b.lastModified) !== String(b.uploadId)) throw bad('Mã tải lên không khớp với file.', 403);
    const n = partsCount(size);
    const tree = await gh.getRepoTree({ force: true });
    const parts = [];
    for (let i = 0; i < n; i++) {
        const p = partPath(uid, segs, String(b.uploadId), i);
        if (!tree.files.has(p)) throw bad(`Thiếu phần ${i + 1}/${n} — hãy tải lên lại (sẽ làm tiếp từ phần còn thiếu).`);
        let repo = null;
        try { const r = await gh.repoFor(p); repo = r && r.repo ? r.repo : null; } catch (_) { /* bỏ qua */ }
        parts.push({ i, size: i < n - 1 ? FILES.PART_BYTES : size - FILES.PART_BYTES * (n - 1), ...(repo ? { repo } : {}) });
    }
    const now = new Date().toISOString();
    let old = null;
    await mutateManifest(uid, segs, (m) => {
        old = m.files[name] || null;
        m.files[name] = {
            name, kind: fileKind(name), mime: mimeOf(name), size, id: String(b.uploadId), parts,
            createdAt: old && old.createdAt ? old.createdAt : now, updatedAt: now
        };
        return m;
    }, `files: ${name}`);
    if (old && old.id && old.id !== String(b.uploadId)) {
        const paths = await treePathsUnder(dataPrefix(uid, segs, old.id));
        if (paths.length) await gh.commitFiles(paths.map((p) => ({ path: p, remove: true })), `files: thay ${name}`).catch((e) => console.warn('[fileStore] dọn bản cũ:', e.message));
    }
    return { ok: true, name, size, parts: n, repos: [...new Set(parts.map((x) => x.repo).filter(Boolean))] };
}

// ---------------------------------------------------------------- xoá / đổi tên
async function remove(uid, dir, name) {
    const segs = cleanDir(dir);
    const n = cleanName(name);
    let entry = null;
    await mutateManifest(uid, segs, (m) => { entry = m.files[n] || null; delete m.files[n]; return m; }, `files: xoá ${n}`);
    if (!entry) throw bad('Không tìm thấy file.', 404);
    const paths = entry.id ? await treePathsUnder(dataPrefix(uid, segs, entry.id)) : [];
    if (paths.length) await gh.commitFiles(paths.map((p) => ({ path: p, remove: true })), `files: xoá ${n}`);
    return { ok: true, removed: paths.length };
}

async function rename(uid, dir, oldName, newName) {
    const segs = cleanDir(dir);
    const from = cleanName(oldName), to = cleanName(newName);
    if (extOf(from) !== extOf(to)) throw bad('Không đổi được đuôi file (giữ ".' + extOf(from) + '").');
    let err = null;
    await mutateManifest(uid, segs, (m) => {
        const e = m.files[from];
        if (!e) { err = bad('Không tìm thấy file.', 404); return m; }
        if (from !== to && m.files[to]) { err = bad('Đã có file tên "' + to + '".', 409); return m; }
        delete m.files[from];
        m.files[to] = { ...e, name: to, updatedAt: new Date().toISOString() };
        return m;
    }, `files: đổi tên ${from} → ${to}`);
    if (err) throw err;
    return { ok: true, name: to };
}

async function removeFolder(uid, dir) {
    const segs = cleanDir(dir);
    if (!segs.length) throw bad('Không xoá được thư mục gốc');
    const prefix = join(root(uid), segs.join('/')) + '/';
    const paths = await treePathsUnder(prefix);
    if (paths.length > 3000) throw bad('Thư mục quá nhiều file (>3000)');
    if (paths.length) await gh.commitFiles(paths.map((p) => ({ path: p, remove: true })), 'files: xoá thư mục');
    return paths.length;
}

// ---------------------------------------------------------------- tải về
/** Phiếu tải về ký HMAC (không cần cookie — web kết nối khác origin nhận được). */
function signDownload(uid, dir, name, ttlMs = FILES.DOWNLOAD_TTL_MS) {
    const body = Buffer.from(JSON.stringify({ u: String(uid), d: cleanDir(dir).join('/'), n: cleanName(name), e: Date.now() + ttlMs })).toString('base64url');
    const sig = crypto.createHmac('sha256', mc.signKey()).update('files-dl|' + body).digest('base64url');
    return body + '.' + sig;
}
function verifyDownload(tok) {
    const s = String(tok || '');
    const i = s.indexOf('.');
    if (i < 1 || s.length > 1200) return null;
    const body = s.slice(0, i), sig = s.slice(i + 1);
    const want = crypto.createHmac('sha256', mc.signKey()).update('files-dl|' + body).digest('base64url');
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
    if (!p || !(p.e > Date.now()) || !/^[A-Za-z0-9_\-]{1,64}$/.test(String(p.u || ''))) return null;
    return { uid: p.u, dir: String(p.d || ''), name: String(p.n || '') };
}

/** Thông tin file + hàm đọc từng phần đã giải mã (theo thứ tự). */
async function open(uid, dir, name) {
    const segs = cleanDir(dir);
    const n = cleanName(name);
    const m = await readManifest(uid, segs);
    const e = m.files[n];
    if (!e || e.state === 'uploading' || !e.id) throw bad('Không tìm thấy file.', 404);
    const count = Array.isArray(e.parts) && e.parts.length ? e.parts.length : partsCount(e.size);
    const t = await gh.getRepoTree();
    for (let i = 0; i < count; i++) if (!t.files.has(partPath(uid, segs, e.id, i))) throw bad(`File bị thiếu phần ${i + 1}/${count} trên GitHub.`, 410);
    return {
        name: e.name, size: e.size, mime: e.mime || mimeOf(e.name), parts: count,
        async readPart(i) {
            const buf = await gh.readBinaryFileLarge(partPath(uid, segs, e.id, i));
            if (!buf) throw bad(`Không đọc được phần ${i + 1}/${count}.`, 502);
            try { return mc.decryptBuffer(buf); }
            catch (err) { throw bad(`Không giải mã được phần ${i + 1}/${count}: ${err.message}`, 500); }
        }
    };
}

module.exports = {
    cleanDir, cleanName, manifestPath, partPath, uploadIdFor, partsCount, mimeOf,
    list, mkdir, init, putPart, finish, remove, rename, removeFolder, signDownload, verifyDownload, open, readManifest
};
