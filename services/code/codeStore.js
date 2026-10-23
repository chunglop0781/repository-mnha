// services/code/codeStore.js — lưu code & kết quả chạy trên GitHub
//   {user_id}/codes/{dạng-code}/[thư-mục/...]/file      ← code (thư mục chỉ tạo được dưới đây)
//   {user_id}/result/{dạng-code}/{timestamp}.json       ← kết quả mỗi lần chạy (kể cả lỗi)
'use strict';
const gh = require('../githubService');
const ghCfg = require('../../config/github');
const { LANGS, LIMITS, NAME_RE, FILE_STEM_RE, MEDIA, EMPTY_TXT_PLACEHOLDER } = require('../../config/codeConfig');

const KEEP = '.keep';
const bad = (m) => Object.assign(new Error(m), { status: 400 });

function root(uid, lang) { return `${uid}/codes/${lang}`; }
function assertLang(lang) { if (!LANGS[lang]) throw bad('Dạng code không hợp lệ'); return LANGS[lang]; }

// "a/b/c" → ['a','b','c'] (kiểm tra chặt: không .., không ký tự lạ)
function cleanDir(dir) {
    const segs = String(dir || '').split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length > LIMITS.MAX_DEPTH) throw bad(`Thư mục lồng tối đa ${LIMITS.MAX_DEPTH} cấp`);
    for (const s of segs) {
        if (!NAME_RE.test(s)) throw bad('Tên thư mục chỉ gồm chữ, số, "-" và "_"');
        if (s === MEDIA.HIDDEN_DIR) throw bad('Tên thư mục "' + MEDIA.HIDDEN_DIR + '" dành riêng cho hệ thống (chứa media đã mã hoá).');
    }
    return segs;
}
// allowAssets: dạng 'web' (html) còn có file ảnh/âm thanh/video tải lên (cfg.assetExts) — chỉ để xoá/mở, không phải file sửa được
function cleanFileName(lang, name, allowAssets = false) {
    const cfg = assertLang(lang);
    let n = String(name || '').trim();
    if (!/\.[A-Za-z0-9]+$/.test(n)) n += '.' + cfg.runExt;
    const m = /^(.+)\.([A-Za-z0-9]+)$/.exec(n);
    const allowed = allowAssets && cfg.assetExts ? cfg.exts.concat(...Object.values(cfg.assetExts)) : cfg.exts;
    if (!m || !FILE_STEM_RE.test(m[1]) || !allowed.includes(m[2].toLowerCase())) {
        throw bad(`Tên file không hợp lệ (chữ, số, "-", "_" và dấu cách; đuôi cho phép: ${cfg.exts.map((e) => '.' + e).join(', ')})`);
    }
    const out = m[1] + '.' + m[2].toLowerCase();
    if (out.toLowerCase() === MEDIA.MANIFEST) throw bad('Tên file "' + MEDIA.MANIFEST + '" dành riêng cho hệ thống.');
    return out;
}
function filePath(uid, lang, dir, name, allowAssets = false) {
    const segs = cleanDir(dir);
    return [root(uid, lang), ...segs, cleanFileName(lang, name, allowAssets)].join('/');
}

/** Link trang GitHub (blob, KHÔNG phải raw) của 1 file code để chia sẻ: https://github.com/<owner>/<repo>/blob/<branch>/<đường dẫn>. Thiếu cấu hình → null. */
function githubUrl(uid, lang, dir, name) {
    if (!ghCfg.owner || !ghCfg.repo) return null;
    const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
    return `https://github.com/${encodeURIComponent(ghCfg.owner)}/${encodeURIComponent(ghCfg.repo)}/blob/${enc(ghCfg.branch || 'main')}/${enc(filePath(uid, lang, dir, name))}`;
}

/** Link trang GitHub (tree) của 1 THƯ MỤC code để chia sẻ — như githubUrl nhưng cho thư mục (dir rỗng = codes/<lang>). */
function githubFolderUrl(uid, lang, dir) {
    if (!ghCfg.owner || !ghCfg.repo) return null;
    const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
    const p = [root(uid, lang), ...cleanDir(dir)].join('/');
    return `https://github.com/${encodeURIComponent(ghCfg.owner)}/${encodeURIComponent(ghCfg.repo)}/tree/${enc(ghCfg.branch || 'main')}/${enc(p)}`;
}

async function list(uid, lang, dir) {
    const cfg = assertLang(lang);
    const web = cfg.kind === 'web';
    const segs = cleanDir(dir);
    const prefix = [root(uid, lang), ...segs].join('/') + '/';
    const tree = await gh.getRepoTree();
    const folders = new Set(); const files = [];
    for (const [p] of tree.files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i >= 0) { const f = rest.slice(0, i); if (!(web && f === MEDIA.HIDDEN_DIR)) folders.add(f); }
        else if (rest !== KEEP && !(web && rest === MEDIA.MANIFEST)) files.push(rest);
    }
    return { dir: segs.join('/'), folders: [...folders].sort(), files: files.sort() };
}

async function mkdir(uid, lang, dir, name) {
    assertLang(lang);
    const segs = [...cleanDir(dir), ...cleanDir(name)];
    if (segs.length > LIMITS.MAX_DEPTH) throw bad(`Thư mục lồng tối đa ${LIMITS.MAX_DEPTH} cấp`);
    const p = [root(uid, lang), ...segs, KEEP].join('/');
    await gh.writeBinaryFile(p, Buffer.from(''), `code: mkdir ${segs.join('/')}`);
    return segs.join('/');
}

async function readFile(uid, lang, dir, name) {
    const p = filePath(uid, lang, dir, name);
    const buf = await gh.readBinaryFile(p);
    return buf === null ? null : buf.toString('utf8');
}
// .txt trắng → hiện/ghi tạm EMPTY_TXT_PLACEHOLDER (chỉ cho .txt)
const isTxt = (name) => /\.txt$/i.test(String(name || ''));
const displayText = (name, content) => (isTxt(name) && !String(content == null ? '' : content).trim() ? EMPTY_TXT_PLACEHOLDER : String(content == null ? '' : content));
// opt.placeholder === false: giữ nguyên nội dung trắng (file chương trình ghi ra như output.txt)
async function writeFile(uid, lang, dir, name, content, opt = {}) {
    let text = String(content == null ? '' : content);
    const p = filePath(uid, lang, dir, name);
    if (opt.placeholder !== false) text = displayText(p, text);
    if (Buffer.byteLength(text) > LIMITS.MAX_FILE_BYTES) throw bad('File quá lớn (tối đa 200KB)');
    await gh.writeBinaryFile(p, Buffer.from(text, 'utf8'), `code: save ${p.split('/').slice(1).join('/')}`);
    return p;
}
async function removeFile(uid, lang, dir, name) {
    return gh.deleteFile(filePath(uid, lang, dir, name, true), 'code: delete file');
}
async function removeFolder(uid, lang, dir) {
    const segs = cleanDir(dir);
    if (!segs.length) throw bad('Không xoá được thư mục gốc');
    const prefix = [root(uid, lang), ...segs].join('/') + '/';
    const tree = await gh.getRepoTree({ force: true });
    const paths = [...tree.files.keys()].filter((p) => p.startsWith(prefix));
    const batch = typeof gh.commitFiles === 'function' && paths.length > 1;       // 1 commit cho cả thư mục (media m3u8 có hàng trăm đoạn)
    const max = batch ? 3000 : 100;
    if (paths.length > max) throw bad(`Thư mục quá nhiều file (>${max})`);
    if (batch) await gh.commitFiles(paths.map((p) => ({ path: p, remove: true })), 'code: delete folder');
    else for (const p of paths) await gh.deleteFile(p, 'code: delete folder');
    return paths.length;
}

/**
 * Đổi tên thư mục (đổi đoạn CUỐI của dir; vẫn cùng thư mục cha). 1 commit: chuyển mọi file (cả .keep, _media của HTML) sang đường dẫn mới
 * bằng sha blob có sẵn (không tải nội dung) rồi xoá đường dẫn cũ. Trả { dir: 'đường/dẫn/mới', moved: số file }.
 */
async function renameFolder(uid, lang, dir, newName) {
    assertLang(lang);
    const segs = cleanDir(dir);
    if (!segs.length) throw bad('Không đổi tên được thư mục gốc');
    const name = String(newName == null ? '' : newName).trim();
    if (!NAME_RE.test(name)) throw bad('Tên thư mục chỉ gồm chữ, số, "-" và "_" (tối đa 60 ký tự)');
    if (name === MEDIA.HIDDEN_DIR) throw bad('Tên thư mục "' + MEDIA.HIDDEN_DIR + '" dành riêng cho hệ thống.');
    const old = segs[segs.length - 1];
    const next = [...segs.slice(0, -1), name];
    if (name === old) return { dir: segs.join('/'), moved: 0 };
    const from = [root(uid, lang), ...segs].join('/') + '/', to = [root(uid, lang), ...next].join('/') + '/';
    const tree = await gh.getRepoTree({ force: true });
    if (tree.truncated) throw bad('Repo quá lớn để đổi tên thư mục an toàn.');
    const paths = [...tree.files.keys()];
    if (paths.some((p) => p.startsWith(to))) throw bad('Đã có thư mục tên "' + name + '" ở đây — hãy chọn tên khác.');
    const mine = paths.filter((p) => p.startsWith(from));
    if (!mine.length) throw bad('Không tìm thấy thư mục', 404);
    if (mine.length > 3000) throw bad('Thư mục quá nhiều file (>3000)');
    const changes = [];
    for (const p of mine) { changes.push({ path: to + p.slice(from.length), sha: tree.files.get(p) }); changes.push({ path: p, remove: true }); }
    await gh.commitFiles(changes, `code: rename folder ${segs.join('/')} -> ${next.join('/')}`);
    return { dir: next.join('/'), moved: mine.length };
}

/** Đổi tên 1 file code (cùng thư mục). Không gõ đuôi thì giữ đuôi cũ. 1 commit, giữ nguyên nội dung (chuyển sha blob). */
async function renameFile(uid, lang, dir, oldName, newName) {
    assertLang(lang);
    const from = filePath(uid, lang, dir, oldName);
    let n = String(newName == null ? '' : newName).trim();
    const oldExt = from.split('.').pop();
    if (n && !/\.[A-Za-z0-9]+$/.test(n)) n += '.' + oldExt;
    const to = filePath(uid, lang, dir, n);
    if (to === from) return { file: to.split('/').pop(), moved: 0 };
    const tree = await gh.getRepoTree({ force: true });
    if (!tree.files.has(from)) throw bad('Không tìm thấy file', 404);
    if (tree.files.has(to)) throw bad('Đã có file tên "' + to.split('/').pop() + '" ở đây — hãy chọn tên khác.');
    await gh.commitFiles([{ path: to, sha: tree.files.get(from) }, { path: from, remove: true }], `code: rename ${from.split('/').slice(1).join('/')} -> ${to.split('/').pop()}`);
    return { file: to.split('/').pop(), moved: 1 };
}

// các file .txt (hoặc đuôi cho phép khác .runExt) cùng thư mục → nạp vào thư mục chạy để freopen
// opt.cppNames: các file .cpp (làm file dữ liệu, vd freopen("input1.cpp")) mà code có nhắc tới → cũng nạp (runner đổi sang .txt)
async function siblingTextFiles(uid, lang, dir, opt = {}) {
    const cfg = assertLang(lang);
    const { files } = await list(uid, lang, dir);
    const want = new Set((opt.cppNames || []).map((n) => String(n).toLowerCase()));
    const skip = String(opt.exclude || '').toLowerCase();
    const txt = files.filter((f) => { const l = f.toLowerCase(); return l.endsWith('.txt') || (l.endsWith('.cpp') && l !== skip && want.has(l)); })
        .slice(0, LIMITS.MAX_FILES_PER_DIR_SYNC);
    if (!cfg.exts.includes('txt')) return [];
    const out = [];
    for (const f of txt) {
        const c = await readFile(uid, lang, dir, f);
        if (c !== null) out.push({ name: f, content: c.trim() === EMPTY_TXT_PLACEHOLDER.trim() ? '' : c });      // chỉ có dòng gợi ý → coi như file rỗng
    }
    return out;
}

// ---- file do chương trình ghi ra khi chạy code "xem trên mạng" (output.txt ...)
// Tự tạo trong {user_id}/codes/{lang}/tren-mang/ (thư mục tự có khi ghi file đầu tiên). Chỉ lưu file MỚI hoặc ĐÃ ĐỔI;
// trùng tên thì ghi đè bản cũ. Không bao giờ ném lỗi — trả {saved:[đường dẫn tương đối trong codes/lang], skipped:[{name,reason}]}.
async function saveOnlineOutputs(uid, lang, files) {
    const out = { saved: [], skipped: [] };
    const dir = LIMITS.ONLINE_OUT_DIR;
    if (!files || typeof files !== 'object') return out;
    let n = 0;
    for (const name of Object.keys(files)) {
        const f = files[name];
        if (!f || typeof f.content !== 'string' || !(f.isNew || f.changed)) continue;
        if (n >= LIMITS.ONLINE_OUT_MAX_FILES) { out.skipped.push({ name, reason: `quá ${LIMITS.ONLINE_OUT_MAX_FILES} file` }); continue; }
        try {
            const clean = cleanFileName(lang, name);
            await writeFile(uid, lang, dir, clean, f.content, { placeholder: false });
            out.saved.push(`${dir}/${clean}`); n++;
        } catch (e) { out.skipped.push({ name: String(name).slice(0, 80), reason: e.message }); }
    }
    return out;
}

// ---- kết quả chạy
async function saveResult(uid, lang, result) {
    assertLang(lang);
    let ts = Date.now();
    const tree = await gh.getRepoTree().catch(() => null);
    while (tree && tree.files.has(`${uid}/result/${lang}/${ts}.json`)) ts++;
    const p = `${uid}/result/${lang}/${ts}.json`;
    await gh.writeJsonFile(p, { timestamp: ts, ...result }, `code: result ${lang}`);
    return p;
}
async function listResults(uid, lang, limit = 30) {
    assertLang(lang);
    const prefix = `${uid}/result/${lang}/`;
    const tree = await gh.getRepoTree();
    return [...tree.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith('.json'))
        .map((p) => Number(p.slice(prefix.length, -5))).filter(Number.isFinite).sort((a, b) => b - a).slice(0, limit);
}
async function readResult(uid, lang, ts) {
    assertLang(lang);
    if (!/^\d{10,16}$/.test(String(ts))) throw bad('Mã kết quả không hợp lệ');
    return gh.readJsonFile(`${uid}/result/${lang}/${ts}.json`);
}

module.exports = { githubUrl, githubFolderUrl, displayText, renameFolder, renameFile, list, mkdir, readFile, writeFile, removeFile, removeFolder, siblingTextFiles, saveOnlineOutputs, saveResult, listResults, readResult, cleanDir, cleanFileName };
