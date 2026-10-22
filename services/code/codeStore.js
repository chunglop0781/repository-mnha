// services/code/codeStore.js — lưu code & kết quả chạy trên GitHub
//   {user_id}/codes/{dạng-code}/[thư-mục/...]/file      ← code (thư mục chỉ tạo được dưới đây)
//   {user_id}/result/{dạng-code}/{timestamp}.json       ← kết quả mỗi lần chạy (kể cả lỗi)
'use strict';
const gh = require('../githubService');
const ghCfg = require('../../config/github');
const { LANGS, LIMITS, NAME_RE } = require('../../config/codeConfig');

const KEEP = '.keep';
const bad = (m) => Object.assign(new Error(m), { status: 400 });

function root(uid, lang) { return `${uid}/codes/${lang}`; }
function assertLang(lang) { if (!LANGS[lang]) throw bad('Dạng code không hợp lệ'); return LANGS[lang]; }

// "a/b/c" → ['a','b','c'] (kiểm tra chặt: không .., không ký tự lạ)
function cleanDir(dir) {
    const segs = String(dir || '').split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length > LIMITS.MAX_DEPTH) throw bad(`Thư mục lồng tối đa ${LIMITS.MAX_DEPTH} cấp`);
    for (const s of segs) if (!NAME_RE.test(s)) throw bad('Tên thư mục chỉ gồm chữ, số, "-" và "_"');
    return segs;
}
function cleanFileName(lang, name) {
    const cfg = assertLang(lang);
    let n = String(name || '').trim();
    if (!/\.[A-Za-z0-9]+$/.test(n)) n += '.' + cfg.runExt;
    const m = /^(.+)\.([A-Za-z0-9]+)$/.exec(n);
    if (!m || !NAME_RE.test(m[1]) || !cfg.exts.includes(m[2].toLowerCase())) {
        throw bad(`Tên file không hợp lệ (đuôi cho phép: ${cfg.exts.map((e) => '.' + e).join(', ')})`);
    }
    return m[1] + '.' + m[2].toLowerCase();
}
function filePath(uid, lang, dir, name) {
    const segs = cleanDir(dir);
    return [root(uid, lang), ...segs, cleanFileName(lang, name)].join('/');
}

/** Link trang GitHub (blob, KHÔNG phải raw) của 1 file code để chia sẻ: https://github.com/<owner>/<repo>/blob/<branch>/<đường dẫn>. Thiếu cấu hình → null. */
function githubUrl(uid, lang, dir, name) {
    if (!ghCfg.owner || !ghCfg.repo) return null;
    const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
    return `https://github.com/${encodeURIComponent(ghCfg.owner)}/${encodeURIComponent(ghCfg.repo)}/blob/${enc(ghCfg.branch || 'main')}/${enc(filePath(uid, lang, dir, name))}`;
}

async function list(uid, lang, dir) {
    assertLang(lang);
    const segs = cleanDir(dir);
    const prefix = [root(uid, lang), ...segs].join('/') + '/';
    const tree = await gh.getRepoTree();
    const folders = new Set(); const files = [];
    for (const [p] of tree.files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i >= 0) folders.add(rest.slice(0, i));
        else if (rest !== KEEP) files.push(rest);
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
async function writeFile(uid, lang, dir, name, content) {
    const text = String(content == null ? '' : content);
    if (Buffer.byteLength(text) > LIMITS.MAX_FILE_BYTES) throw bad('File quá lớn (tối đa 200KB)');
    const p = filePath(uid, lang, dir, name);
    await gh.writeBinaryFile(p, Buffer.from(text, 'utf8'), `code: save ${p.split('/').slice(1).join('/')}`);
    return p;
}
async function removeFile(uid, lang, dir, name) {
    return gh.deleteFile(filePath(uid, lang, dir, name), 'code: delete file');
}
async function removeFolder(uid, lang, dir) {
    const segs = cleanDir(dir);
    if (!segs.length) throw bad('Không xoá được thư mục gốc');
    const prefix = [root(uid, lang), ...segs].join('/') + '/';
    const tree = await gh.getRepoTree({ force: true });
    const paths = [...tree.files.keys()].filter((p) => p.startsWith(prefix));
    if (paths.length > 100) throw bad('Thư mục quá nhiều file (>100)');
    for (const p of paths) await gh.deleteFile(p, 'code: delete folder');
    return paths.length;
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
        if (c !== null) out.push({ name: f, content: c });
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
            await writeFile(uid, lang, dir, clean, f.content);
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

module.exports = { githubUrl, list, mkdir, readFile, writeFile, removeFile, removeFolder, siblingTextFiles, saveOnlineOutputs, saveResult, listResults, readResult, cleanDir, cleanFileName };
