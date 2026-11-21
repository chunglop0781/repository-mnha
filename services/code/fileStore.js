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
//   • MÃ HOÁ NGAY TRONG TRÌNH DUYỆT: init trả khoá RIÊNG của file (+ salt) cho chủ file; trình duyệt mã hoá từng phần bằng WebCrypto (public/js/mnhaFiles.js encryptPart)
//     rồi mới gửi. putPart KHÔNG mã hoá — chỉ kiểm tra cấu trúc MNHAENC1 (salt, kích thước, 1 khối), giải thử phần 0 để bắt sớm sai khoá, rồi ghi bản mã lên GitHub.
//     Bản rõ không bao giờ đi qua mạng / web kết nối. Đường cũ (gửi bản rõ, máy chủ mã hoá) mặc định TẮT → 410; bật tạm bằng ALLOW_SERVER_ENCRYPT=1.
//     Mã tải lên (uploadId) dẫn xuất từ (uid, thư mục, tên, kích thước, ngày sửa) nên tải lại đúng file đó sẽ LÀM TIẾP — bỏ qua các phần đã lên.
//   • Tải về / xem: TRÌNH DUYỆT tự giải mã (public/js/mnhaFiles.js) — máy chủ chỉ trả khoá RIÊNG của file + địa chỉ GitHub raw của từng phần
//     (release()), trình duyệt tải các phần mã hoá THẲNG từ GitHub rồi giải mã bằng WebCrypto: không tốn băng thông máy chủ.
//     Mỗi file có 1 khoá RIÊNG (mc.filesKey: dẫn xuất từ khoá chủ + người dùng + mã tải lên); bản lưu trong mnha-files.json là bản MÃ HOÁ (`key`, mc.wrapBytes) nằm
//     ngay trong json của thư mục — cùng chỗ với cờ `public` (công khai hay không). Mỗi phần là 1 khối AES-256-GCM có AAD = số thứ tự phần (đảo/đổi chỗ phần → không giải mã được).
//   • TẢI LÊN THẲNG R2 (khi đã cấu hình Cloudflare R2 ở /connect, và FILES_DIRECT ≠ off): init trả thêm `direct.urls` = URL PUT ký sẵn (1 URL / 1 phần, đúng 1 key, hết hạn 2 giờ,
//     không lộ khoá R2); trình duyệt mã hoá từng phần rồi PUT THẲNG lên R2 — bản mã KHÔNG đi qua máy chủ/Vercel. finish({direct:true}) chỉ HEAD + đọc Range header (vài chục byte)
//     để kiểm tra kích thước/định dạng rồi ghi mnha-files.json (entry có `storage` = R2). Đọc: release() trả URL R2 (public / presign); xoá: xoá object R2. Chưa cấu hình R2 → luồng GitHub cũ như trước.
//     Dự phòng khi không tải thẳng được (repo riêng tư, MEDIA_DIRECT=off, trình duyệt cũ, file lưu bằng bản cũ): máy chủ giải mã và gửi nối tiếp (open/readPart + signDownload).
'use strict';
const crypto = require('crypto');
const gh = require('../githubService');
const mc = require('./mediaCrypto');
const { FILES, fileKind } = require('../../config/codeConfig');
const { NAME_RE } = require('../../config/codeConfig');
const keyService = require('./keyService');
const cloudflare = require('../connect/cloudflare');

const KEEP = '.keep';
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const root = (uid) => `${uid}/${FILES.ROOT}`;
const join = (...p) => p.filter(Boolean).join('/');
const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; };
const pad = (n) => String(n).padStart(4, '0');

const MIME = {
    txt: 'text/plain', pdf: 'application/pdf', doc: 'application/msword', dot: 'application/msword', rtf: 'application/rtf',
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
        throw bad('Chỉ nhận file Word, Excel, PowerPoint (và các file Office khác), PDF, ảnh và .txt — đuôi ".' + (extOf(n) || '?') + '" không được nhận.');
    }
    return n;
}
const manifestPath = (uid, segs) => join(root(uid), segs.join('/'), FILES.MANIFEST);
const dataPrefix = (uid, segs, id) => join(root(uid), segs.join('/'), FILES.DATA_DIR, id) + '/';
const partPath = (uid, segs, id, i) => dataPrefix(uid, segs, id) + pad(i + 1) + '.bin';

const hex32 = (s) => /^[a-f0-9]{32}$/.test(String(s || ''));
/** Mã tải lên cố định theo (uid, thư mục, tên, kích thước, ngày sửa) → tải lại đúng file thì làm tiếp được. */
function uploadIdFor(uid, segs, name, size, lastModified) {
    return crypto.createHmac('sha256', mc.signKey()).update(['files2', uid, segs.join('/'), name, size, Number(lastModified) || 0].join('|')).digest('hex').slice(0, 32);
}
/** Salt dùng chung cho mọi phần của 1 lần tải lên (→ 1 khoá file). Không bí mật; khoá thật = HKDF(khoá chủ, salt) chỉ ra khỏi máy chủ qua release(). */
const saltFor = (uid, uploadId) => mc.deriveSalt('files-salt|' + uid + '|' + uploadId);
const partsCount = (size) => Math.max(1, Math.ceil(size / FILES.PART_BYTES));
const ENC_OVERHEAD = mc.HEADER_LEN + 4 + 12 + 16;           // MNHAENC1 | ver | salt (25) + len u32 + iv + tag = 57 byte trên mỗi phần 1 khối
const plainOfPart = (size, i, n) => (i < n - 1 ? FILES.PART_BYTES : size - FILES.PART_BYTES * (n - 1));
const isCf = (st) => !!(st && st.provider === 'cloudflare');

/** Kho R2 đang dùng để nhận file tải lên thẳng từ trình duyệt (null = dùng luồng GitHub cũ). */
async function r2Status() {
    if (process.env.FILES_DIRECT === 'off') return { target: null, why: 'biến môi trường FILES_DIRECT=off đang tắt tải thẳng' };
    try {
        const rt = await cloudflare.runtime();
        if (rt && rt.storage) return { target: rt.storage, why: null };
        if (rt && rt.error) return { target: null, why: 'cấu hình Cloudflare R2 lỗi: ' + rt.error };
        if (rt && rt.doc && rt.doc.enabled === false) return { target: null, why: 'Cloudflare R2 đang TẮT ở trang /connect' };
        return { target: null, why: 'web này chưa đọc được cấu hình Cloudflare R2 (chưa lưu ở /connect, hoặc không đọc được v-s/cloudflare.json)' };
    } catch (e) { return { target: null, why: 'không đọc được cấu hình R2: ' + e.message }; }
}
async function r2Target() { return (await r2Status()).target; }

/** Cho trình duyệt đẩy bản mã thẳng lên GitHub? Cần GitHub App (token tạm, nhập ở /connect) và không đặt FILES_GH_DIRECT=off. */
const appTok = () => require('../githubAppToken');
const ghDirectOn = async () => process.env.FILES_GH_DIRECT !== 'off' && (await appTok().isConfigured());
/** Repo đang nhận file mới + TOKEN TẠM (installation token: 1 giờ, 1 repo, Contents:write) để TRÌNH DUYỆT gọi api.github.com (POST /git/blobs). PAT thật không rời máy chủ. */
async function ghTicket() {
    let rec = { owner: gh.owner, repo: gh.repo, branch: gh.branch };
    try { if (gh.pooled && gh.pool && typeof gh.pool.active === 'function') { const a = await gh.pool.active(); if (a && a.owner && a.repo) rec = { owner: a.owner, repo: a.repo, branch: a.branch || gh.branch }; } } catch (_) { /* dùng repo chính */ }
    if (!rec.owner || !rec.repo) throw bad('Chưa xác định được repo GitHub để nhận file.', 503);
    const t = await appTok().mintForRepo(rec.owner, rec.repo);
    return { owner: rec.owner, repo: rec.repo, branch: rec.branch || 'main', token: t.token, expiresAt: t.expiresAt };
}
async function pool(items, size, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }));
}

// ---------------------------------------------------------------- sổ file (mnha-files.json)
const pubCache = new Map();                       // trang thư mục công khai: uid|dir → { at, v } (giữ ngắn để đỡ gọi GitHub; mọi thay đổi sổ file xoá hết)
const PUB_TTL_MS = 15 * 1000;
const passCache = new Map();                      // uid|dir → { at, v } mật khẩu hiệu lực (xoá khi sổ file đổi)
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
            if (!Object.keys(next.files).length && next.shared !== true && !next.pass && cur) {
                await gh.commitFiles([{ path: p, remove: true }], message);      // hết file, không chia sẻ, không mật khẩu → bỏ luôn sổ
            } else if (Object.keys(next.files).length || next.shared === true || next.pass) {
                await gh.writeJsonFileIfSha(p, next, cur ? cur.sha : null, message);
            }
            pubCache.clear(); passCache.clear();
            return next;
        } catch (e) {
            last = e;
            if ((e.name === 'HttpError' || e.code !== 'SHA_CONFLICT')) throw e;
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
// ---------------------------------------------------------------- link GitHub (xem trên mạng): ĐỦ mọi repo của nhóm repo
const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const natKey = (repo, base) => { const m = /-(\d+)$/.exec(String(repo)); return String(repo) === base ? 0 : (m ? Number(m[1]) : 1e6); };
function repoOfPath(p) {
    try { if (gh.repoForSync) { const r = gh.repoForSync(p); if (r && r.owner && r.repo) return r; } } catch (_) { /* dùng repo chính */ }
    return gh.owner && gh.repo ? { owner: gh.owner, repo: gh.repo, branch: gh.branch } : null;
}
const treeUrl = (r, path) => `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/tree/${encodeURIComponent(r.branch || 'main')}/${encPath(path)}`;
/** Mọi repo đang chứa file trong thư mục (cả cây con) → [{ repo, owner, files, url }] theo thứ tự repo được tạo (repo chính trước, rồi -1, -2…). */
function folderRepos(tree, uid, segs) {
    const prefix = join(root(uid), segs.join('/'));
    const by = new Map();
    for (const [p] of tree.files) {
        if (!p.startsWith(prefix + '/')) continue;
        const r = repoOfPath(p); if (!r) continue;
        const k = r.owner + '/' + r.repo, c = by.get(k) || { r, n: 0 };
        c.n++; by.set(k, c);
    }
    const mainRepo = gh.repo;
    return [...by.values()].sort((a, b) => natKey(a.r.repo, mainRepo) - natKey(b.r.repo, mainRepo) || a.r.repo.localeCompare(b.r.repo))
        .map((c) => ({ repo: c.r.repo, owner: c.r.owner, files: c.n, url: treeUrl(c.r, prefix) }));
}
/** Các repo chứa các PHẦN của 1 file → [{ repo, parts, url }] (url = thư mục _data/<mã> trong repo đó). */
function fileRepos(uid, segs, e) {
    if (!e || !e.id) return [];
    const count = Array.isArray(e.parts) && e.parts.length ? e.parts.length : partsCount(e.size);
    const by = new Map(), mainRepo = gh.repo;
    for (let i = 0; i < count; i++) {
        const r = repoOfPath(partPath(uid, segs, e.id, i)); if (!r) continue;
        const c = by.get(r.owner + '/' + r.repo) || { r, n: 0 };
        c.n++; by.set(r.owner + '/' + r.repo, c);
    }
    const dir = dataPrefix(uid, segs, e.id).replace(/\/$/, '');
    return [...by.values()].sort((a, b) => natKey(a.r.repo, mainRepo) - natKey(b.r.repo, mainRepo))
        .map((c) => ({ repo: c.r.repo, parts: c.n, url: treeUrl(c.r, dir) }));
}
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
        name: e.name, kind: e.kind, size: e.size, mime: e.mime, public: e.public === true, parts: Array.isArray(e.parts) ? e.parts.length : 1,
        repos: [...new Set((e.parts || []).map((x) => x.repo).filter(Boolean))],
        github: isCf(e.storage) ? [] : fileRepos(uid, segs, e),
        storage: isCf(e.storage) ? 'r2' : 'github',
        createdAt: e.createdAt || null, updatedAt: e.updatedAt || null
    })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    return { dir: segs.join('/'), folders: [...folders].sort(), files, shared: m.shared === true, hasPass: !!(m.pass && m.pass.h), repos: folderRepos(tree, uid, segs) };
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
    // R2 đã cấu hình → trình duyệt PUT thẳng lên R2: các phần "đã có" tính theo object R2 (đúng kích thước), không theo GitHub
    let direct = null, directWhy = null;
    const st = await r2Status(), target = st.target;
    directWhy = st.why;
    if (target) {
        try {
            const objs = await cloudflare.listObjects(target, prefix);
            const have2 = new Map(objs.map((o) => [o.key, o.size]));
            const urls = {};
            have.length = 0;
            for (let i = 0; i < n; i++) {
                const key = partPath(uid, segs, id, i);
                if (have2.get(key) === ENC_OVERHEAD + plainOfPart(size, i, n)) have.push(i);
                else urls[i] = await cloudflare.presignPutUrl(target, key);
            }
            direct = { provider: 'r2', urls };
        } catch (e) { console.warn('[fileStore] R2 không sẵn sàng, dùng luồng GitHub:', e.message); direct = null; directWhy = 'R2 không phản hồi/không cho liệt kê (' + e.message + ')'; }
    }
    // Không có R2: nếu đã cấu hình GitHub App → trình duyệt tự đẩy thẳng lên GitHub bằng TOKEN TẠM (phần đã có tính theo cây GitHub như luồng cũ)
    let ghDirect = null;
    if (!direct) {
        if (await ghDirectOn()) {
            try { ghDirect = await ghTicket(); } catch (e) { directWhy = (directWhy ? directWhy + '; ' : '') + 'GitHub trực tiếp không dùng được: ' + e.message; }
        } else {
            directWhy = (directWhy ? directWhy + '. ' : '') + (process.env.FILES_GH_DIRECT === 'off' ? 'FILES_GH_DIRECT=off đang tắt đẩy thẳng lên GitHub' : 'Muốn đẩy thẳng lên GitHub (không qua Vercel): nhập GitHub App ở trang /connect (mục GitHub App) để cấp token tạm cho trình duyệt');
        }
    }
    return {
        ok: true, name, kind: fileKind(name), size, uploadId: id, partBytes: FILES.PART_BYTES, n, have, ...(direct ? { direct } : {}), ...(ghDirect ? { ghDirect } : {}), ...(!direct && !ghDirect ? { directWhy: directWhy || 'không rõ lý do' } : {}),
        exists: !!(ex && ex.state !== 'uploading'),
        // khoá RIÊNG của file này + salt ở header: để TRÌNH DUYỆT tự mã hoá (khoá chủ không rời máy chủ). Chỉ trả cho người đã qua kiểm quyền tải lên (cookie / phiếu).
        key: mc.filesKey(uid, id).toString('base64'), salt: saltFor(uid, id).toString('base64')
    };
}

/**
 * Bước 2: nhận 1 phần ĐÃ MÃ HOÁ Ở TRÌNH DUYỆT (1 file MNHAENC1 gồm đúng 1 khối AES-256-GCM, AAD = số thứ tự phần) và ghi thành _data/<mã>/NNNN.bin
 * (repo đang dùng của nhóm repo). Máy chủ KHÔNG mã hoá: chỉ kiểm tra cấu trúc rồi ghi nguyên bản mã.
 *   • header đúng MNHAENC1 v1, salt đúng của lần tải lên này; độ dài khối khớp độ dài body (không thừa/thiếu byte);
 *   • bản rõ ≤ PART_BYTES; phần không phải cuối phải ĐỦ PART_BYTES;
 *   • phần 0 được giải thử bằng khoá của file → bắt sớm trình duyệt mã hoá sai khoá / sai AAD (các phần sau cùng khoá nên không cần giải thêm).
 * Gửi bản rõ (trang cũ còn trong bộ nhớ đệm) → 410 trừ khi bật ALLOW_SERVER_ENCRYPT=1 (khi đó máy chủ mã hoá như trước).
 */
async function putPart(uid, q, body) {
    const segs = cleanDir(q.dir);
    const name = cleanName(q.name);
    if (!hex32(q.uploadId)) throw bad('Mã tải lên không hợp lệ.');
    const i = Number(q.i), n = Number(q.n);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 0 || i >= n) throw bad('Số thứ tự phần không hợp lệ.');
    if (n > partsCount(FILES.MAX_FILE_BYTES)) throw bad('Quá nhiều phần.');
    if (!Buffer.isBuffer(body) || !body.length) throw bad('Phần dữ liệu rỗng.');
    const uploadId = String(q.uploadId);
    const p = partPath(uid, segs, uploadId, i);
    const salt = saltFor(uid, uploadId);
    let data, plainLen;
    if (mc.isEncrypted(body)) {
        if (body.length > FILES.PART_BYTES + ENC_OVERHEAD) throw bad('Phần dữ liệu quá lớn.', 413);
        if (body.length < ENC_OVERHEAD + 1) throw bad('Phần mã hoá bị cắt cụt.');
        if (body[8] !== 1) throw bad('Phiên bản mã hoá không hỗ trợ.');
        if (!body.subarray(9, mc.HEADER_LEN).equals(salt)) throw bad('Phần mã hoá không thuộc lần tải lên này (sai salt).', 403);
        plainLen = body.readUInt32BE(mc.HEADER_LEN);
        if (body.length !== ENC_OVERHEAD + plainLen) throw bad('Phần mã hoá sai độ dài (cắt cụt hoặc thừa dữ liệu).');
        if (plainLen > FILES.PART_BYTES) throw bad('Phần dữ liệu quá lớn.', 413);
        if (i < n - 1 && plainLen !== FILES.PART_BYTES) throw bad('Các phần trước phần cuối phải đủ ' + FILES.PART_BYTES + ' byte.');
        if (i === 0) {
            try { mc.decryptBuffer(body, 0, mc.filesKey(uid, uploadId)); }
            catch (_) { throw bad('Phần đầu không giải mã được bằng khoá của file — trình duyệt mã hoá sai khoá/định dạng. Hãy tải lại trang rồi thử lại.', 422); }
        }
        data = body;
    } else {
        // đường cũ: bản rõ → máy chủ mã hoá (mặc định tắt)
        if (process.env.ALLOW_SERVER_ENCRYPT !== '1') {
            throw bad('Trang tải lên đã cũ (gửi file chưa mã hoá). Hãy tải lại trang (Ctrl+F5) để trình duyệt mã hoá file trước khi gửi.', 410);
        }
        if (body.length > FILES.PART_BYTES) throw bad('Phần dữ liệu quá lớn.', 413);
        if (i < n - 1 && body.length !== FILES.PART_BYTES) throw bad('Các phần trước phần cuối phải đủ ' + FILES.PART_BYTES + ' byte.');
        plainLen = body.length;
        data = mc.assemble(salt, [mc.encryptRecord(body, salt, i, mc.filesKey(uid, uploadId))]);
    }
    await gh.writeBinaryFileBig(p, data, `files: ${name} (phần ${i + 1}/${n})`);
    let repo = null;
    try { const r = await gh.repoFor(p); repo = r && r.repo ? r.repo : null; } catch (_) { /* không biết repo → bỏ qua */ }
    return { ok: true, i, size: plainLen, stored: data.length, repo };
}

/** Bước 3: kiểm tra đủ phần rồi ghi mục vào sổ file (thay file cùng tên nếu có, và dọn các phần của bản cũ). */
/**
 * Sau khi TRÌNH DUYỆT đã tự tạo blob (bản mã) trên GitHub: gom các phần thành MỘT commit tại đường dẫn _data/<mã>/NNNN.bin.
 *   b = { dir, name, uploadId, size, lastModified, parts: [{ i, sha }] }   — chỉ vài trăm byte, không mang dữ liệu file.
 * Máy chủ không đọc nội dung blob (không tốn băng thông); kích thước/định dạng được kiểm khi giải mã lúc tải về.
 */
async function commitBlobs(uid, b) {
    if (!(await ghDirectOn())) throw bad('Web này chưa bật tải thẳng lên GitHub (cần cấu hình GitHub App ở /connect và FILES_GH_DIRECT khác off).', 403);
    const segs = cleanDir(b.dir);
    const name = cleanName(b.name);
    if (!hex32(b.uploadId)) throw bad('Mã tải lên không hợp lệ.');
    const size = Number(b.size);
    if (!Number.isInteger(size) || size <= 0 || size > FILES.MAX_FILE_BYTES) throw bad('Kích thước file không hợp lệ.');
    const id = String(b.uploadId);
    if (uploadIdFor(uid, segs, name, size, b.lastModified) !== id) throw bad('Mã tải lên không khớp với file.', 403);
    const n = partsCount(size);
    const list = Array.isArray(b.parts) ? b.parts : [];
    if (!list.length || list.length > 64) throw bad('Danh sách phần không hợp lệ.');
    const seen = new Set();
    const changes = list.map((x) => {
        const i = Number(x && x.i), sha = String((x && x.sha) || '');
        if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) throw bad('Số thứ tự phần không hợp lệ.');
        if (!/^[0-9a-f]{40}$/.test(sha)) throw bad('Mã blob không hợp lệ.');
        seen.add(i);
        return { path: partPath(uid, segs, id, i), sha };
    });
    await gh.commitFiles(changes, `files: ${name} (${changes.length} phần)`);
    return { ok: true, committed: changes.length };
}

async function finish(uid, b) {
    const segs = cleanDir(b.dir);
    const name = cleanName(b.name);
    if (!hex32(b.uploadId)) throw bad('Mã tải lên không hợp lệ.');
    const size = Number(b.size);
    if (!Number.isInteger(size) || size <= 0 || size > FILES.MAX_FILE_BYTES) throw bad('Kích thước file không hợp lệ.');
    if (uploadIdFor(uid, segs, name, size, b.lastModified) !== String(b.uploadId)) throw bad('Mã tải lên không khớp với file.', 403);
    const n = partsCount(size);
    const parts = [];
    let target = null;
    if (b.direct === true) {
        // tải thẳng lên R2: kiểm tra từng object (HEAD + Range header ~29 byte), không tải bản mã về máy chủ
        target = await r2Target();
        if (!target) throw bad('Chưa cấu hình Cloudflare R2 nên không xác nhận được file tải thẳng.', 503);
        const salt = saltFor(uid, String(b.uploadId));
        const idx = Array.from({ length: n }, (_, i) => i);
        await pool(idx, 6, async (i) => {
            const key = partPath(uid, segs, String(b.uploadId), i);
            const plainLen = plainOfPart(size, i, n);
            const h = await cloudflare.headObject(target, key);
            if (!h) throw bad(`Thiếu phần ${i + 1}/${n} trên R2 — hãy tải lên lại (sẽ làm tiếp từ phần còn thiếu).`);
            if (h.size !== ENC_OVERHEAD + plainLen) {
                await cloudflare.deleteObject(target, key).catch(() => { });
                throw bad(`Phần ${i + 1}/${n} sai kích thước (${h.size} ≠ ${ENC_OVERHEAD + plainLen}) — đã xoá, hãy tải lên lại.`, 422);
            }
            const head = await cloudflare.readRange(target, key, 0, mc.HEADER_LEN + 4);
            if (!head || !mc.isEncrypted(head) || head[8] !== 1 || !head.subarray(9, mc.HEADER_LEN).equals(salt) || head.readUInt32BE(mc.HEADER_LEN) !== plainLen) {
                await cloudflare.deleteObject(target, key).catch(() => { });
                throw bad(`Phần ${i + 1}/${n} không đúng định dạng mã hoá của lần tải lên này — đã xoá, hãy tải lên lại.`, 422);
            }
        });
        for (let i = 0; i < n; i++) parts.push({ i, size: plainOfPart(size, i, n) });
    } else {
        // GitHub đôi khi chưa kịp hiện commit vừa tạo (nhất là khi tải hàng loạt, file nối file) → đọc lại cây vài lần trước khi báo thiếu phần
        let tree = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            tree = await gh.getRepoTree({ force: true });
            let all = true;
            for (let i = 0; i < n; i++) if (!tree.files.has(partPath(uid, segs, String(b.uploadId), i))) { all = false; break; }
            if (all) break;
            await new Promise((ok) => setTimeout(ok, 600 * (attempt + 1)));
        }
        for (let i = 0; i < n; i++) {
            const p = partPath(uid, segs, String(b.uploadId), i);
            if (!tree.files.has(p)) throw bad(`Thiếu phần ${i + 1}/${n} — hãy tải lên lại (sẽ làm tiếp từ phần còn thiếu).`, 409);
            let repo = null;
            try { const r = await gh.repoFor(p); repo = r && r.repo ? r.repo : null; } catch (_) { /* bỏ qua */ }
            parts.push({ i, size: plainOfPart(size, i, n), ...(repo ? { repo } : {}) });
        }
    }
    const now = new Date().toISOString();
    let old = null;
    await mutateManifest(uid, segs, (m) => {
        old = m.files[name] || null;
        m.files[name] = {
            name, kind: fileKind(name), mime: mimeOf(name), size, id: String(b.uploadId), key: mc.wrapBytes(mc.filesKey(uid, String(b.uploadId))), parts,
            ...(target ? { storage: target } : {}),
            ...(old && old.public === true ? { public: true } : {}),        // thay file cùng tên giữ nguyên chế độ công khai
            createdAt: old && old.createdAt ? old.createdAt : now, updatedAt: now
        };
        return m;
    }, `files: ${name}`);
    if (old && old.id && old.id !== String(b.uploadId)) {
        await dropData(uid, segs, old, `files: thay ${name}`).catch((e) => console.warn('[fileStore] dọn bản cũ:', e.message));
    }
    return { ok: true, name, size, parts: n, repos: [...new Set(parts.map((x) => x.repo).filter(Boolean))] };
}

// ---------------------------------------------------------------- xoá / đổi tên
/** Xoá dữ liệu (các phần) của 1 entry: R2 (nếu entry nằm ở R2) hoặc các file .bin trên GitHub. → số object/file đã xoá. */
async function dropData(uid, segs, entry, message) {
    if (!entry || !entry.id) return 0;
    if (isCf(entry.storage)) { const r = await cloudflare.deletePrefix(entry.storage, dataPrefix(uid, segs, entry.id)); return r.deleted || 0; }
    const paths = await treePathsUnder(dataPrefix(uid, segs, entry.id));
    if (paths.length) await gh.commitFiles(paths.map((p) => ({ path: p, remove: true })), message);
    return paths.length;
}
async function remove(uid, dir, name) {
    const segs = cleanDir(dir);
    const n = cleanName(name);
    let entry = null;
    await mutateManifest(uid, segs, (m) => { entry = m.files[n] || null; delete m.files[n]; return m; }, `files: xoá ${n}`);
    if (!entry) throw bad('Không tìm thấy file.', 404);
    const removed = await dropData(uid, segs, entry, `files: xoá ${n}`);
    return { ok: true, removed };
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
    // file nằm ở R2 thì không có trong cây GitHub: đọc các mnha-files.json trong cây con để xoá object R2 trước
    for (const mp of paths.filter((p) => p.endsWith('/' + FILES.MANIFEST))) {
        const rel = mp.slice(root(uid).length + 1, -(FILES.MANIFEST.length + 1)).split('/').filter(Boolean);
        const m = await readManifest(uid, rel).catch(() => null);
        for (const e of Object.values((m && m.files) || {})) if (e && isCf(e.storage)) await dropData(uid, rel, e, 'files: xoá thư mục').catch((err) => console.warn('[fileStore] xoá R2:', err.message));
    }
    if (paths.length) await gh.commitFiles(paths.map((p) => ({ path: p, remove: true })), 'files: xoá thư mục');
    pubCache.clear();
    return paths.length;
}

// ---------------------------------------------------------------- công khai / riêng tư
/** Bật/tắt công khai: name = tên 1 file, hoặc null = mọi file trong thư mục. Mặc định mọi file là RIÊNG TƯ. → số file đã đổi. */
async function setVisibility(uid, dir, name, isPublic) {
    const segs = cleanDir(dir);
    const only = name == null || name === '' ? null : cleanName(name);
    const want = isPublic === true;
    let changed = 0, missing = false;
    await mutateManifest(uid, segs, (m) => {
        const entries = only ? [m.files[only]] : Object.values(m.files);
        if (only && !entries[0]) { missing = true; return m; }
        for (const e of entries) {
            if (!e || (e.public === true) === want) continue;
            if (want) e.public = true; else delete e.public;
            changed++;
        }
        return m;
    }, `files: ${want ? 'công khai' : 'riêng tư'} ${only || segs.join('/') || '(thư mục gốc)'}`);
    if (missing) throw bad('Không tìm thấy file.', 404);
    return { ok: true, changed, public: want };
}

/** Mở file để XEM CÔNG KHAI (không cần đăng nhập): chỉ khi file đang ở chế độ công khai. Riêng tư / không có → cùng một lỗi 404 (không lộ file có tồn tại hay không). */
async function openPublic(uid, dir, name) {
    const id = String(uid || '');
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) throw bad('Không tìm thấy file hoặc file không công khai.', 404);
    let segs, n;
    try { segs = cleanDir(dir); n = cleanName(name); } catch (_) { throw bad('Không tìm thấy file hoặc file không công khai.', 404); }
    const m = await readManifest(id, segs);
    const e = m.files[n];
    if (!e || e.public !== true) throw bad('Không tìm thấy file hoặc file không công khai.', 404);
    return open(id, segs.join('/'), n);
}

// ---------------------------------------------------------------- chia sẻ THƯ MỤC (xem trên mạng)
/** Bật/tắt trang xem công khai của 1 thư mục (/f/d). Cờ `shared` nằm trong mnha-files.json của thư mục. Trang chỉ liệt kê file đã bật công khai trong CHÍNH thư mục đó. */
async function setFolderShared(uid, dir, shared) {
    const segs = cleanDir(dir);
    const want = shared === true;
    await mutateManifest(uid, segs, (m) => { if (want) m.shared = true; else delete m.shared; return m; }, `files: ${want ? 'chia sẻ' : 'thôi chia sẻ'} thư mục ${segs.join('/') || '(gốc)'}`);
    return { ok: true, shared: want };
}
/**
 * Trang XEM THƯ MỤC công khai — duyệt cả CÂY như "xem code trên mạng": thư mục con + file, gộp file của MỌI repo trong nhóm repo.
 * Xem được khi thư mục này HOẶC một thư mục cha đã bật "Chia sẻ thư mục". Chỉ hiện file đang CÔNG KHAI; thư mục con chỉ hiện nếu bên trong có file công khai.
 * Không có / chưa chia sẻ → cùng một 404 (không lộ thư mục có tồn tại hay không). rootDir = thư mục chia sẻ cao nhất (không cho đi lên quá đó).
 */
async function publicFolder(uid, dir) {
    const id = String(uid || '');
    const nf = () => bad('Không tìm thấy thư mục hoặc thư mục không được chia sẻ.', 404);
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) throw nf();
    let segs;
    try { segs = cleanDir(dir); } catch (_) { throw nf(); }
    const ck = id + '|' + segs.join('/'), hit = pubCache.get(ck);
    if (hit && Date.now() - hit.at < PUB_TTL_MS) return hit.v;
    // thư mục chia sẻ cao nhất trong chuỗi cha → con
    let rootAt = -1;
    for (let k = 0; k <= segs.length; k++) {
        const m = await readManifest(id, segs.slice(0, k));
        if (m.shared === true) { rootAt = k; break; }
    }
    if (rootAt < 0) throw nf();
    const m = await readManifest(id, segs);
    const files = Object.values(m.files).filter((e) => e && e.name && e.public === true && e.state !== 'uploading')
        .map((e) => ({ name: e.name, kind: e.kind || fileKind(e.name), size: e.size })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    // thư mục con (mọi độ sâu) có file công khai: đọc sổ của các thư mục con — tối đa 200 sổ, 6 luồng
    const prefix = join(root(id), segs.join('/')) + '/';
    const tree = await gh.getRepoTree();
    const mfDirs = [];
    for (const [p] of tree.files) {
        if (!p.startsWith(prefix)) continue;
        const parts = p.slice(prefix.length).split('/');
        if (parts.length < 2 || parts.includes(FILES.DATA_DIR) || parts[parts.length - 1] !== FILES.MANIFEST) continue;
        mfDirs.push(parts.slice(0, -1));
    }
    const count = new Map();
    let next = 0;
    const todo = mfDirs.slice(0, 200);
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
        while (next < todo.length) {
            const rel = todo[next++];
            const sm = await readManifest(id, [...segs, ...rel]).catch(() => null);
            const n = sm ? Object.values(sm.files).filter((e) => e && e.public === true && e.state !== 'uploading').length : 0;
            if (n) count.set(rel[0], (count.get(rel[0]) || 0) + n);
        }
    }));
    const folders = [...count].map(([name, n]) => ({ name, files: n })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    const v = {
        dir: segs.join('/'), name: segs[segs.length - 1] || 'Lưu trữ file', files, folders,
        rootDir: segs.slice(0, rootAt).join('/'), isRoot: segs.length === rootAt, truncated: mfDirs.length > 200
    };
    pubCache.set(ck, { at: Date.now(), v });
    if (pubCache.size > 300) pubCache.delete(pubCache.keys().next().value);
    return v;
}

/** Thư mục (hoặc thư mục cha) đang bật "Chia sẻ thư mục"? — để trang xem file hiện nút "Thư mục" (chỉ đọc vài sổ file, không quét cây). */
async function isFolderShared(uid, dir) {
    const id = String(uid || '');
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return false;
    let segs; try { segs = cleanDir(dir); } catch (_) { return false; }
    for (let k = 0; k <= segs.length; k++) { const m = await readManifest(id, segs.slice(0, k)); if (m.shared === true) return true; }
    return false;
}

// ---------------------------------------------------------------- giải mã Ở TRÌNH DUYỆT
const NOT_PUBLIC = 'Không tìm thấy file hoặc file không công khai.';
/** Mục trong sổ file (không kiểm cây GitHub). publicOnly: file riêng tư và file không có đều báo cùng một lỗi 404. */
async function entryOf(uid, dir, name, publicOnly) {
    const id = String(uid || '');
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) throw bad(publicOnly ? NOT_PUBLIC : 'Không tìm thấy file.', 404);
    let segs, n;
    try { segs = cleanDir(dir); n = cleanName(name); } catch (e) { throw publicOnly ? bad(NOT_PUBLIC, 404) : e; }
    const m = await readManifest(id, segs);
    const e = m.files[n];
    if (!e || e.state === 'uploading' || !e.id || (publicOnly && e.public !== true)) throw bad(publicOnly ? NOT_PUBLIC : 'Không tìm thấy file.', 404);
    return { id, segs, n, e };
}
/** Thông tin hiển thị của file công khai (trang xem). */
async function publicInfo(uid, dir, name) {
    const { n, e } = await entryOf(uid, dir, name, true);
    return { name: n, kind: e.kind || fileKind(n), size: e.size, mime: e.mime || mimeOf(n), parts: Array.isArray(e.parts) ? e.parts.length : 1 };
}
/**
 * Cách để TRÌNH DUYỆT tự mở file: { mode:'direct', key(b64), parts:[{i,url,size}], name,size,mime,kind } hoặc { mode:'server' } (không tải thẳng được → dùng đường qua máy chủ).
 * Khoá file chỉ ra khỏi máy chủ ở đây: chủ (đã đăng nhập) luôn được; người khác chỉ khi file đang CÔNG KHAI (publicOnly) — tắt công khai là ngừng cấp khoá.
 */
async function release(uid, dir, name, { publicOnly = false } = {}) {
    const { id, segs, n, e } = await entryOf(uid, dir, name, publicOnly);
    const count = Array.isArray(e.parts) && e.parts.length ? e.parts.length : partsCount(e.size);
    const base = { name: n, kind: e.kind || fileKind(n), size: e.size, mime: e.mime || mimeOf(n) };
    if (!e.key) return { mode: 'server', ...base };                                                  // file lưu bằng bản cũ (chưa có khoá riêng trong json) → giải mã ở máy chủ
    if (isCf(e.storage)) {
        // file ở R2: URL public hoặc presign (null = bucket chế độ proxy → đọc qua máy chủ)
        const parts = [];
        for (let i = 0; i < count; i++) {
            const url = await cloudflare.urlFor(e.storage, partPath(id, segs, e.id, i), { v: e.id });
            if (!url) return { mode: 'server', ...base };
            parts.push({ i, url, size: e.parts && e.parts[i] ? e.parts[i].size : undefined });
        }
        return { mode: 'direct', ...base, parts, key: mc.unwrapBytes(e.key, 32).toString('base64') };
    }
    const tree = await gh.getRepoTree();
    const parts = [];
    for (let i = 0; i < count; i++) {
        const p = partPath(id, segs, e.id, i);
        const sha = tree.files.get(p);
        if (!sha) throw bad(`File bị thiếu phần ${i + 1}/${count} trên GitHub.`, 410);
        const url = keyService.rawUrl(gh, p.split('/'), sha);
        if (!url) return { mode: 'server', ...base };                                              // tắt tải thẳng (MEDIA_DIRECT=off) hoặc chưa biết repo
        parts.push({ i, url, size: e.parts && e.parts[i] ? e.parts[i].size : undefined });
    }
    return { mode: 'direct', ...base, parts, key: mc.unwrapBytes(e.key, 32).toString('base64') };      // mở khoá bản mã hoá trong json — chỉ sau khi đã kiểm quyền ở trên
}


// ---------------------------------------------------------------- MẬT KHẨU chia sẻ công khai
// Mặc định công khai KHÔNG có mật khẩu. Chủ file có thể đặt / ĐỔI / xoá mật khẩu của một thư mục bất cứ lúc nào (kể cả khi quên mật khẩu cũ — chủ đã đăng nhập
// nên không cần mật khẩu cũ). Mật khẩu áp cho file công khai trong thư mục đó và mọi thư mục con (thư mục con có mật khẩu riêng thì dùng cái riêng).
// Lưu trong mnha-files.json: pass = { s: salt, h: scrypt, v: mã phiên bản }. Đổi / xoá mật khẩu → `v` đổi → mọi phiếu đã mở khoá trước đó mất hiệu lực.
const PASS_MIN = 4, PASS_MAX = 64, ACCESS_TTL_MS = 12 * 3600 * 1000;
const scryptHex = (pw, salt) => crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex');
async function setFolderPassword(uid, dir, password) {
    const segs = cleanDir(dir);
    const remove = password == null || password === '';
    if (!remove) {
        const pw = String(password);
        if (pw.length < PASS_MIN || pw.length > PASS_MAX) throw bad(`Mật khẩu dài ${PASS_MIN}–${PASS_MAX} ký tự.`);
    }
    await mutateManifest(uid, segs, (m) => {
        if (remove) delete m.pass;
        else { const salt = crypto.randomBytes(16).toString('hex'); m.pass = { s: salt, h: scryptHex(password, salt), v: crypto.randomBytes(6).toString('hex') }; }
        return m;
    }, `files: ${remove ? 'xoá' : 'đặt'} mật khẩu thư mục ${segs.join('/') || '(gốc)'}`);
    return { ok: true, hasPass: !remove };
}
/** Mật khẩu hiệu lực của thư mục: gần nhất trong chuỗi con → cha → gốc. → { at: 'thư/mục', pass } hoặc null (không có mật khẩu). */
async function effectivePass(uid, segs) {
    const id = String(uid || ''), ck = id + '|' + segs.join('/'), hit = passCache.get(ck);
    if (hit && Date.now() - hit.at < PUB_TTL_MS) return hit.v;
    let v = null;
    for (let k = segs.length; k >= 0; k--) {
        const m = await readManifest(id, segs.slice(0, k));
        if (m.pass && m.pass.h && m.pass.s) { v = { at: segs.slice(0, k).join('/'), pass: m.pass }; break; }
    }
    passCache.set(ck, { at: Date.now(), v });
    if (passCache.size > 300) passCache.delete(passCache.keys().next().value);
    return v;
}
const accessSig = (body) => crypto.createHmac('sha256', mc.signKey()).update('files-pw|' + body).digest('base64url');
/** Tên cookie mở khoá cho (người dùng, thư mục có mật khẩu). */
const accessCookieName = (uid, at) => 'fpw_' + crypto.createHash('sha1').update(String(uid) + '|' + at).digest('hex').slice(0, 12);
function signAccess(uid, at, v, ttlMs = ACCESS_TTL_MS) {
    const body = Buffer.from(JSON.stringify({ u: String(uid), a: at, v, e: Date.now() + ttlMs })).toString('base64url');
    return body + '.' + accessSig(body);
}
function verifyAccessToken(tok, uid, at, v) {
    const s = String(tok || ''), i = s.indexOf('.');
    if (i < 1 || s.length > 600) return false;
    const body = s.slice(0, i), sig = s.slice(i + 1), want = accessSig(body);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
    let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return false; }
    return !!p && p.u === String(uid) && p.a === at && p.v === v && p.e > Date.now();
}
/**
 * Kiểm quyền xem công khai của 1 thư mục. cookies = req.cookies (hoặc { pt } khi chuyển sang web kết nối).
 * → { locked:false } nếu không có mật khẩu / đã mở khoá; { locked:true, at } nếu cần nhập mật khẩu.
 */
async function publicAccess(uid, dir, cookies, ptToken) {
    const id = String(uid || '');
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return { locked: false };      // uid sai → để các hàm 404 xử lý như cũ
    let segs; try { segs = cleanDir(dir); } catch (_) { return { locked: false }; }
    const ep = await effectivePass(id, segs);
    if (!ep) return { locked: false };
    const tok = ptToken || (cookies && cookies[accessCookieName(id, ep.at)]);
    if (tok && verifyAccessToken(tok, id, ep.at, ep.pass.v)) return { locked: false, at: ep.at, pt: tok };
    return { locked: true, at: ep.at };
}
/** Đúng mật khẩu → trả phiếu (đặt vào cookie); sai → null. */
async function unlock(uid, dir, password) {
    const id = String(uid || '');
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return null;
    let segs; try { segs = cleanDir(dir); } catch (_) { return null; }
    const ep = await effectivePass(id, segs);
    if (!ep) return { token: null, at: null, name: null };                        // không có mật khẩu: không cần phiếu
    const got = Buffer.from(scryptHex(String(password || '').slice(0, PASS_MAX), ep.pass.s), 'hex'), want = Buffer.from(ep.pass.h, 'hex');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    return { token: signAccess(id, ep.at, ep.pass.v), at: ep.at, name: accessCookieName(id, ep.at), maxAge: ACCESS_TTL_MS };
}

/** Các file CÔNG KHAI cùng thư mục (để nút Trước / Sau khi xem file) — sắp theo tên, giống trang danh sách. */
async function publicSiblings(uid, dir) {
    const id = String(uid || '');
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return [];
    let segs; try { segs = cleanDir(dir); } catch (_) { return []; }
    const m = await readManifest(id, segs);
    return Object.values(m.files).filter((e) => e && e.name && e.public === true && e.state !== 'uploading' && e.id)
        .map((e) => ({ name: e.name, kind: e.kind || fileKind(e.name), size: e.size })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

// ---------------------------------------------------------------- tìm kiếm (mọi thư mục)
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
async function search(uid, query) {
    const q = fold(String(query || '').trim());
    if (q.length < 1) throw bad('Nhập từ khoá để tìm.');
    if (q.length > 80) throw bad('Từ khoá quá dài.');
    const prefix = root(uid) + '/';
    const tree = await gh.getRepoTree({ force: true });
    const folders = new Set(), manifests = [];
    for (const [p] of tree.files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const parts = rest.split('/');
        if (parts.includes(FILES.DATA_DIR)) continue;
        if (parts[parts.length - 1] === FILES.MANIFEST) manifests.push(parts.slice(0, -1).join('/'));
        for (let i = 0; i < parts.length - 1; i++) folders.add(parts.slice(0, i + 1).join('/'));
    }
    const foundFolders = [...folders].filter((f) => fold(f.split('/').pop()).includes(q)).sort().slice(0, 100);
    const files = [];
    const todo = manifests.slice(0, 200);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
        while (next < todo.length) {
            const d = todo[next++];
            const m = await readManifest(uid, d ? d.split('/') : []).catch(() => null);
            if (!m) continue;
            for (const e of Object.values(m.files)) {
                if (e && e.name && fold(e.name).includes(q)) files.push({ dir: d, name: e.name, kind: e.kind, size: e.size, public: e.public === true, parts: Array.isArray(e.parts) ? e.parts.length : 1 });
            }
        }
    }));
    files.sort((a, b) => (a.dir + '/' + a.name).localeCompare(b.dir + '/' + b.name, 'vi'));
    return { q: String(query).trim(), folders: foundFolders, files: files.slice(0, 300), truncated: files.length > 300 || manifests.length > 200 };
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
    const onR2 = isCf(e.storage);
    if (!onR2) {
        const t = await gh.getRepoTree();
        for (let i = 0; i < count; i++) if (!t.files.has(partPath(uid, segs, e.id, i))) throw bad(`File bị thiếu phần ${i + 1}/${count} trên GitHub.`, 410);
    }
    return {
        name: e.name, size: e.size, mime: e.mime || mimeOf(e.name), parts: count,
        async readPart(i) {
            const buf = onR2 ? await cloudflare.getObject(e.storage, partPath(uid, segs, e.id, i)) : await gh.readBinaryFileLarge(partPath(uid, segs, e.id, i));
            if (!buf) throw bad(`Không đọc được phần ${i + 1}/${count}.`, 502);
            try {
                // bản hiện tại: khoá riêng giải từ json (`key`), AAD = số thứ tự phần; bản trước (salt chung) khoá theo salt ở header, AAD = số thứ tự; bản đầu: mỗi phần 1 file riêng, khối số 0
                return e.key ? mc.decryptBuffer(buf, i, mc.unwrapBytes(e.key, 32)) : mc.decryptBuffer(buf, e.salt ? i : 0);
            }
            catch (err) { throw bad(`Không giải mã được phần ${i + 1}/${count}: ${err.message}`, 500); }
        }
    };
}

module.exports = {
    cleanDir, cleanName, manifestPath, partPath, uploadIdFor, partsCount, mimeOf,
    list, mkdir, init, putPart, commitBlobs, finish, remove, rename, removeFolder, signDownload, verifyDownload, open, readManifest,
    setVisibility, openPublic, search, fold, release, publicInfo, saltFor, setFolderShared, publicFolder,
    setFolderPassword, isFolderShared, publicAccess, unlock, publicSiblings, accessCookieName, signAccess, effectivePass
};
