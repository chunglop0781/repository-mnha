// controllers/code.controller.js — ỨNG DỤNG "LẬP TRÌNH" (emu8086 + C++)
//   GET  /code                       menu chọn ngôn ngữ
//   GET  /code/:lang                 thư mục & file của tôi  (user_id/codes/:lang/...)
//   GET  /code/:lang/edit?dir=&file= trình soạn code + chạy + kết quả (mở tab mới)
//   POST /code/:lang/folder|file|save|delete
//   POST /code/:lang/run             → {sid}
//   GET  /code/session/:sid          trạng thái/đầu ra (polling)
//   POST /code/session/:sid/input|stop
//   GET  /code/:lang/results[/:ts]   lịch sử kết quả (user_id/result/:lang/timestamp.json)
//   GET  /code/:lang/history         trang xem lịch sử chạy code (chỉ xem code + màn hình)
//   GET  /code/:lang/online[?url=]   "xem code trên mạng": dán link GitHub/GitLab → xem code (không sửa) + chạy xem màn hình
// Không cần duyệt tài khoản: chỉ cần đăng nhập.
'use strict';
const store = require('../services/code/codeStore');
const sessions = require('../services/code/sessionManager');
const remote = require('../services/code/remoteRunner');
const remoteSource = require('../services/code/remoteSource');
const includeResolver = require('../services/code/includeResolver');
const { LANGS, CPP_RUN_MODE } = require('../config/codeConfig');

const uidOf = (req) => String(req.user._id);
const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        const status = e.status || (e.code === 'SHA_CONFLICT' ? 409 : 500);
        if (status === 500) console.error('[code]', e);
        if (req.method === 'GET' && !(req.headers.accept || '').includes('json')) {
            return res.status(status).render('error', { title: 'Lỗi', message: e.message, statusCode: status, stack: null, user: req.user });
        }
        res.status(status).json({ error: e.message, wake: e.wake || undefined });
    }
};
const langOf = (req) => { const l = LANGS[req.params.lang]; if (!l || l.disabled) throw Object.assign(new Error('Không có dạng code này'), { status: 404 }); return l; };

exports.hub = wrap(async (req, res) => {
    res.render('code/hub', { title: 'Lập trình', user: req.user, langs: Object.values(LANGS).filter((l) => !l.disabled) });
});

exports.files = wrap(async (req, res) => {
    const lang = langOf(req);
    const data = await store.list(uidOf(req), lang.key, req.query.dir || '');
    res.render('code/files', { title: lang.name, user: req.user, lang, ...data, shareUrl: store.githubFolderUrl(uidOf(req), lang.key, data.dir) });
});

exports.renameFile = wrap(async (req, res) => {      // đổi tên file (cùng thư mục), mọi dạng code kể cả html
    const lang = langOf(req);
    const r = await store.renameFile(uidOf(req), lang.key, req.body.dir || '', req.body.file, req.body.name);
    res.json({ ok: true, ...r });
});

exports.renameFolder = wrap(async (req, res) => {      // đổi tên thư mục (đoạn cuối của dir); dùng chung cho mọi dạng code kể cả html
    const lang = langOf(req);
    const r = await store.renameFolder(uidOf(req), lang.key, req.body.dir || '', req.body.name);
    res.json({ ok: true, ...r });
});

exports.createFolder = wrap(async (req, res) => {
    const lang = langOf(req);
    const dir = await store.mkdir(uidOf(req), lang.key, req.body.dir || '', req.body.name);
    res.json({ ok: true, dir });
});

exports.createFile = wrap(async (req, res) => {
    const lang = langOf(req);
    const name = store.cleanFileName(lang.key, req.body.name);
    const content = name.endsWith('.txt') ? '' : lang.template;
    await store.writeFile(uidOf(req), lang.key, req.body.dir || '', name, content);
    res.json({ ok: true, file: name });
});

// Dựng trang trình soạn (dùng chung cho file của tôi và code xem trên mạng)
function renderEditor(req, res, { lang, dir, file, content, results, online, githubUrl, shareLabel, folderUrl }) {
    const runnable = file.toLowerCase().endsWith('.' + lang.runExt);
    const cppMode = lang.key === 'cpp' ? CPP_RUN_MODE : null;
    if (cppMode === 'browser') {      // clang WebAssembly (Wasmer SDK) cần trang được cô lập origin
        res.set('Cross-Origin-Opener-Policy', 'same-origin');
        res.set('Cross-Origin-Embedder-Policy', 'credentialless');
    }
    const payload = { lang: lang.key, dir, file, runnable, content, mode: lang.editorMode, results, cppMode, online: online || null };
    res.render('code/editor', { cppMode, title: file, user: req.user, lang, dir, file, runnable, online: online || null, githubUrl, shareLabel, folderUrl: folderUrl || null, payloadJson: JSON.stringify(payload).replace(/</g, '\\u003c') });
}

exports.edit = wrap(async (req, res) => {
    const lang = langOf(req);
    const dir = store.cleanDir(req.query.dir || '').join('/');
    const file = store.cleanFileName(lang.key, req.query.file);
    let content = await store.readFile(uidOf(req), lang.key, dir, file);
    if (content === null) throw Object.assign(new Error('Không tìm thấy file'), { status: 404 });
    content = store.displayText(file, content);      // .txt đang trắng → hiện tạm dòng gợi ý (không ghi lên GitHub cho tới khi bấm Lưu)
    const results = await store.listResults(uidOf(req), lang.key, 20).catch(() => []);
    renderEditor(req, res, { lang, dir, file, content, results, githubUrl: store.githubUrl(uidOf(req), lang.key, dir, file) });
});

// ---- xem code trên mạng (GitHub / GitLab)
function onlineFileName(lang, parsed) {       // tên file hiển thị/lưu lịch sử: lấy từ link, đã làm sạch cho hợp lệ
    const last = String(parsed.last || '');
    const dot = last.lastIndexOf('.');
    const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
    if (!lang.exts.includes(ext)) throw Object.assign(new Error(`Chỉ xem được file ${lang.exts.map((e) => '.' + e).join(', ')} (link của bạn là file "${last.slice(0, 60)}").`), { status: 400 });
    const base = last.slice(0, dot).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 60) || 'code';
    return store.cleanFileName(lang.key, base + '.' + ext);
}
async function loadOnline(lang, url) {
    const parsed = remoteSource.parseSourceUrl(url);
    const file = onlineFileName(lang, parsed);
    const content = await remoteSource.fetchText(parsed);
    return { parsed, file, content };
}
// Gom các file C++ cần khi chạy, đọc từ CÙNG THƯ MỤC với file đang chạy:
//   • file dữ liệu .txt (và .cpp dùng làm dữ liệu) — code của tôi: mọi .txt trong thư mục; code trên mạng: các tên code nhắc tới
//   • header/.cpp được #include "..." (đệ quy) + x.cpp đi kèm x.hpp
// online = kết quả remoteSource.parseSourceUrl (code xem trên mạng) hoặc null (code của tôi)
async function cppRunFiles({ uid, lang, dir, file, code, online }) {
    const data = includeResolver.scanDataNames(code, includeResolver.includedNames(code));
    let files = []; let readFile;
    if (online) {
        readFile = async (segs) => {
            try { return await remoteSource.fetchText(remoteSource.siblingOf(online, segs)); }
            catch (e) { if (e.status === 404) return null; throw e; }
        };
        for (const n of [...data.txt, ...data.cpp].slice(0, 10)) {
            const c = await readFile([n]).catch(() => null);
            if (c != null) files.push({ name: n, content: c });
        }
    } else {
        files = await store.siblingTextFiles(uid, lang.key, dir, { cppNames: data.cpp, exclude: file });
        readFile = (segs) => store.readFile(uid, lang.key, [...store.cleanDir(dir), ...segs.slice(0, -1)].join('/'), segs[segs.length - 1]);
    }
    const { files: src, missing } = await includeResolver.collect({ code, readFile });
    return { files: [...files, ...src], missing };
}
const originOf = (u) => { try { return u ? remoteSource.parseSourceUrl(u).web : undefined; } catch (_) { return undefined; } };

exports.online = wrap(async (req, res) => {
    const lang = langOf(req);
    const url = String(req.query.url || '').trim();
    const form = (error, status = 200) => res.status(status).render('code/online', { title: 'Xem code trên mạng', user: req.user, lang, url, folderUrl: '', error, errorFor: error ? 'file' : null });
    if (!url) return form(null);
    let o;
    try { o = await loadOnline(lang, url); }
    catch (e) { if (e.status && e.status < 500) return form(e.message, e.status === 404 ? 404 : 400); throw e; }
    renderEditor(req, res, {
        lang, dir: '', file: o.file, content: o.content, results: [], online: o.parsed.web, githubUrl: o.parsed.web, shareLabel: o.parsed.host === 'gitlab' ? 'Nguồn (GitLab):' : 'Nguồn (GitHub):',
        folderUrl: `/code/${lang.key}/online/folder?url=` + encodeURIComponent(remoteSource.treeWeb(o.parsed, o.parsed.pathSegs.slice(0, -1)))      // nút "Đọc thư mục" cạnh file đang xem
    });
});

// ---- đọc thư mục trên mạng (GitHub / GitLab): chỉ liệt kê file LIÊN QUAN tới dạng code này (vd cpp: .cpp .txt .h .hpp...; emu8086: .asm)
// Thư mục con vẫn hiện để đi sâu vào; file không liên quan (ảnh, .md, .exe...) bị ẩn và chỉ đếm số lượng.
exports.onlineFolder = wrap(async (req, res) => {
    const lang = langOf(req);
    const base = '/code/' + lang.key;
    const url = String(req.query.url || '').trim();
    const form = (error, status = 400) => res.status(status).render('code/online', { title: 'Xem code trên mạng', user: req.user, lang, url: '', folderUrl: url, error, errorFor: 'folder' });
    if (!url) return form('Hãy dán link thư mục.');
    let f, items;
    try { f = await remoteSource.resolveRef(remoteSource.parseFolderUrl(url)); items = await remoteSource.listFolder(f); }
    catch (e) { if (e.status && e.status < 500) return form(e.message, e.status === 404 ? 404 : e.status === 429 ? 429 : 400); throw e; }
    const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; };
    const here = (segs) => base + '/online/folder?url=' + encodeURIComponent(remoteSource.treeWeb(f, segs));
    const list = []; let hidden = 0;
    for (const x of items) {
        const o = remoteSource.otherRepo(f, x), fx = o ? remoteSource.withRepo(f, o) : f, other = o ? o.repo : null;     // mục nằm ở repo khác của app → link repo đó
        if (x.type === 'dir') { list.push({ name: x.name, type: 'dir', href: base + '/online/folder?url=' + encodeURIComponent(remoteSource.treeWeb(fx, [...f.dirSegs, x.name])), other }); continue; }
        if (!lang.exts.includes(extOf(x.name))) { hidden++; continue; }
        const web = remoteSource.fromParts(fx, [...f.dirSegs, x.name]).web;
        list.push({ name: x.name, type: 'file', size: x.size, runnable: extOf(x.name) === lang.runExt, href: base + '/online?url=' + encodeURIComponent(web), web, other });
    }
    const crumbs = [{ name: f.base.join('/') + ' @ ' + f.ref, href: here([]) }];
    f.dirSegs.forEach((s, i) => crumbs.push({ name: s, href: here(f.dirSegs.slice(0, i + 1)) }));
    res.render('code/online-folder', {
        title: 'Đọc thư mục trên mạng', user: req.user, lang, crumbs, list, hidden, web: remoteSource.treeWeb(f, f.dirSegs),
        host: f.host === 'gitlab' ? 'GitLab' : 'GitHub', truncated: items.length >= 300, extList: lang.exts.map((e) => '.' + e).join(', ')
    });
});

exports.history = wrap(async (req, res) => {
    const lang = langOf(req);
    res.render('code/history', { title: 'Lịch sử chạy code', user: req.user, lang });
});

exports.compile = wrap(async (req, res) => {      // nút Compile của emu8086: chỉ dịch, báo lỗi, không chạy
    const lang = langOf(req);
    if (lang.key !== 'emu8086') throw Object.assign(new Error('Chỉ dùng cho emu8086'), { status: 400 });
    const { assemble, AsmError } = require('../services/emu8086/assembler');
    try {
        const prog = assemble(String(req.body.content == null ? '' : req.body.content));
        res.json({ ok: true, instructions: Array.isArray(prog.code) ? prog.code.length : null });
    } catch (e) {
        if (e instanceof AsmError) return res.json({ ok: false, errors: e.errors });
        throw e;
    }
});

exports.save = wrap(async (req, res) => {
    const lang = langOf(req);
    await store.writeFile(uidOf(req), lang.key, req.body.dir || '', req.body.file, req.body.content);
    res.json({ ok: true });
});

exports.remove = wrap(async (req, res) => {
    const lang = langOf(req);
    if (req.body.type === 'folder') await store.removeFolder(uidOf(req), lang.key, req.body.dir);
    else await store.removeFile(uidOf(req), lang.key, req.body.dir || '', req.body.file);
    res.json({ ok: true });
});

exports.run = wrap(async (req, res) => {
    const lang = langOf(req);
    const uid = uidOf(req);
    let dir, file, code, origin, onlineParsed = null;
    if (req.body.online) {      // chạy code từ link GitHub/GitLab: LUÔN tải lại code từ link (không tin nội dung client gửi) + ghi nguồn vào lịch sử
        const o = await loadOnline(lang, req.body.online);
        dir = ''; file = o.file; code = o.content; origin = o.parsed.web; onlineParsed = o.parsed;
    } else {
        dir = store.cleanDir(req.body.dir || '').join('/');
        file = store.cleanFileName(lang.key, req.body.file);
        code = String(req.body.content == null ? '' : req.body.content);
    }
    if (!file.toLowerCase().endsWith('.' + lang.runExt)) throw Object.assign(new Error('File này không chạy được'), { status: 400 });
    if (code.length > 200 * 1024) throw Object.assign(new Error('Code quá dài'), { status: 400 });
    // chạy đúng code đang soạn (kể cả chưa lưu); các .txt cùng thư mục nạp vào thư mục chạy
    // cả file .cpp được nhắc trong code ("input1.cpp") cũng nạp làm dữ liệu (đổi sang .txt khi chạy, in ra thì đổi ngược lại)
    // + header/.cpp được #include cùng thư mục; code xem trên mạng thì đọc cùng thư mục trong repo GitHub/GitLab
    const gathered = lang.key === 'cpp' ? await cppRunFiles({ uid, lang, dir, file, code, online: onlineParsed }) : { files: [], missing: [] };
    const siblingFiles = gathered.files, missing = gathered.missing;
    if (lang.key === 'cpp' && remote.enabled()) {      // chạy ở dịch vụ runner riêng
        if (siblingFiles.some((f) => f.src) && !(await remote.capabilities()).srcFiles) {      // runner bản cũ sẽ lờ header đi → báo rõ thay vì để g++ báo "No such file"
            throw Object.assign(new Error('Máy chạy C++ (runner) đang là BẢN CŨ nên chưa nhận file #include. Hãy deploy lại dịch vụ runner (Render) từ code mới, rồi chạy lại.'), { status: 503 });
        }
        const r = await remote.run(uid, { file, dir, code, files: siblingFiles, origin: origin || '' });
        return res.json({ sid: r.sid, missing });
    }
    const s = await sessions.create({ uid, lang: lang.key, code, file, dir, siblingFiles, origin });
    res.json({ sid: s.id, missing });
});

function view(s, since) {
    const v = s.impl.view(since);
    return { ...v, lang: s.lang, saved: s.savedPath, saveError: s.saveError, autoSaved: s.autoSaved };
}
exports.poll = wrap(async (req, res) => {
    const s = sessions.get(req.params.sid, uidOf(req));
    if (!s && remote.enabled()) {
        const v = await remote.poll(uidOf(req), req.params.sid, req.query.since);
        if (v.status === 'finished' && !v.saved && v.result && v.meta) {      // lưu kết quả lên GitHub (runner không giữ secret GitHub)
            try {
                const origin = originOf(v.meta.origin);
                if (origin) { v.autoSaved = await store.saveOnlineOutputs(uidOf(req), 'cpp', v.result.outputFiles); v.result.autoSaved = v.autoSaved; }      // code xem trên mạng: output.txt... → codes/cpp/tren-mang/
                v.saved = await store.saveResult(uidOf(req), 'cpp', { lang: 'cpp', file: v.meta.file, dir: v.meta.dir, ...(origin ? { origin } : {}), source: v.meta.source, ...v.result });
                await remote.markSaved(uidOf(req), req.params.sid, v.saved);
            } catch (e) { v.saveError = e.message; console.error('[code] lưu kết quả lỗi:', e.message); }
        }
        delete v.result; delete v.meta;
        return res.json({ ...v, lang: 'cpp' });
    }
    if (!s) return res.status(404).json({ error: 'Phiên chạy không còn (có thể máy chủ đã khởi động lại).' });
    res.json(view(s, Number(req.query.since) || 0));
});
exports.input = wrap(async (req, res) => {
    const s = sessions.get(req.params.sid, uidOf(req));
    if (!s && remote.enabled()) return res.json(await remote.input(uidOf(req), req.params.sid, req.body.text));
    if (!s) return res.status(404).json({ error: 'Phiên chạy không còn' });
    const ok = s.impl.sendInput(req.body.text);
    res.json({ ok });
});
exports.stop = wrap(async (req, res) => {
    const s = sessions.get(req.params.sid, uidOf(req));
    if (!s && remote.enabled()) return res.json(await remote.stop(uidOf(req), req.params.sid));
    if (!s) return res.status(404).json({ error: 'Phiên chạy không còn' });
    s.impl.stop(); res.json({ ok: true });
});
exports.saveOutputFile = wrap(async (req, res) => {   // lưu output.txt do chương trình ghi vào thư mục code
    const lang = langOf(req);
    if (lang.key !== 'cpp') throw Object.assign(new Error('Không hỗ trợ'), { status: 400 });
    await store.writeFile(uidOf(req), lang.key, req.body.dir || '', req.body.name, req.body.content, { placeholder: false });
    res.json({ ok: true });
});

exports.warmup = wrap(async (req, res) => {      // đánh thức runner (Render ngủ) khi mở trang code; client gọi thưa, mỗi lần 1 yêu cầu
    res.json({ ready: remote.enabled() ? await remote.health(5000) : true });
});
exports.siblings = wrap(async (req, res) => {     // các .txt cùng thư mục (để trình duyệt nạp vào thư mục ảo khi chạy C++)
    const lang = langOf(req);
    const dir = store.cleanDir(req.query.dir || '').join('/');
    res.json({ files: lang.key === 'cpp' ? await store.siblingTextFiles(uidOf(req), lang.key, dir) : [] });
});
exports.siblingsPost = wrap(async (req, res) => {    // như siblings nhưng theo code đang soạn (kể cả chưa lưu) + header #include; hỗ trợ code xem trên mạng
    const lang = langOf(req);
    if (lang.key !== 'cpp') return res.json({ files: [] });
    const b = req.body || {};
    let code = String(b.code == null ? '' : b.code).slice(0, 200 * 1024), dir = '', file = String(b.file || ''), online = null;
    if (b.online) { const o = await loadOnline(lang, b.online); code = o.content; file = o.file; online = o.parsed; }
    else dir = store.cleanDir(b.dir || '').join('/');
    res.json(await cppRunFiles({ uid: uidOf(req), lang, dir, file, code, online }));
});
exports.saveClientResult = wrap(async (req, res) => {   // kết quả chạy trong trình duyệt → lưu lên GitHub như lần chạy ở server
    const lang = langOf(req);
    const b = req.body || {};
    if (lang.key === 'emu8086') {      // emu8086 chạy ngay trong trình duyệt (không có phiên trên máy chủ) → chỉ nhận kết quả để lưu lịch sử
        const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
        const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v).slice(0, 4000)) : null);
        const errs = Array.isArray(b.asmErrors) ? b.asmErrors.slice(0, 50).map((e) => ({ line: num(e && e.line), message: String((e && e.message) || '').slice(0, 300) })) : [];
        const e8 = {
            lang: 'emu8086', file: String(b.file || ''), dir: String(b.dir || ''), ...(originOf(b.origin) ? { origin: originOf(b.origin) } : {}), source: String(b.source || '').slice(0, 200 * 1024),
            kind: 'emu8086', status: b.error ? 'error' : 'ok', assemble: { ok: !errs.length, errors: errs },
            console: String(b.console || '').slice(0, 1024 * 1024),
            screen: Array.isArray(b.screen) ? b.screen.slice(0, 200).map((l) => String(l).slice(0, 400)) : [],
            inputs: Array.isArray(b.inputs) ? b.inputs.slice(0, 500).map((x) => String(x).slice(0, 2000)) : [],
            regs: obj(b.regs), flags: obj(b.flags), steps: num(b.steps), exitCode: num(b.exitCode), error: b.error ? String(b.error).slice(0, 2000) : null,
            startedAt: b.startedAt ? String(b.startedAt).slice(0, 40) : null, finishedAt: new Date().toISOString(), durationMs: num(b.durationMs), runIn: 'browser'
        };
        return res.json({ ok: true, saved: await store.saveResult(uidOf(req), 'emu8086', e8) });
    }
    const r = {
        lang: lang.key, file: String(b.file || ''), dir: String(b.dir || ''), ...(originOf(b.origin) ? { origin: originOf(b.origin) } : {}), source: String(b.source || '').slice(0, 200 * 1024),
        kind: 'cpp-browser', status: b.error ? 'error' : 'ok', console: String(b.console || '').slice(0, 1024 * 1024),
        inputs: Array.isArray(b.inputs) ? b.inputs.slice(0, 500).map((x) => String(x).slice(0, 2000)) : [],
        exitCode: b.exitCode == null ? null : Number(b.exitCode), error: b.error ? String(b.error).slice(0, 2000) : null,
        files: b.files && typeof b.files === 'object' ? b.files : {}, finishedAt: new Date().toISOString()
    };
    // code xem trên mạng (có origin hợp lệ): file chương trình ghi ra → codes/cpp/tren-mang/ (tên/kích thước được kiểm lại ở saveOnlineOutputs)
    if (r.origin && lang.key === 'cpp') { r.autoSaved = await store.saveOnlineOutputs(uidOf(req), lang.key, r.files); }
    res.json({ ok: true, saved: await store.saveResult(uidOf(req), lang.key, r), autoSaved: r.autoSaved });
});

// Bộ máy emu8086 (assembler + machine) gửi cho trình duyệt: dùng lại ĐÚNG mã trong services/emu8086 (không nhân đôi) → window.Emu8086 = { Machine, AsmError, assemble }
let _emuBundle = null;
exports.emuEngine = (req, res) => {
    if (!_emuBundle) {
        const fs = require('fs'), path = require('path');
        const rd = (f) => fs.readFileSync(path.join(__dirname, '..', 'services', 'emu8086', f), 'utf8');
        _emuBundle = '(function (g) {\n"use strict";\nvar A = { exports: {} };\n(function (module, exports, require) {\n' + rd('assembler.js') + '\n})(A, A.exports, function () { throw new Error("require"); });\n'
            + 'var M = { exports: {} };\n(function (module, exports, require) {\n' + rd('machine.js') + '\n})(M, M.exports, function () { return A.exports; });\n'
            + 'g.Emu8086 = { Machine: M.exports.Machine, AsmError: M.exports.AsmError, assemble: A.exports.assemble };\n})(window);\n';
    }
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }).send(_emuBundle);
};

exports.results = wrap(async (req, res) => {
    const lang = langOf(req);
    res.json({ results: await store.listResults(uidOf(req), lang.key, 50) });
});
exports.resultOne = wrap(async (req, res) => {
    const lang = langOf(req);
    const r = await store.readResult(uidOf(req), lang.key, req.params.ts);
    if (!r) throw Object.assign(new Error('Không tìm thấy'), { status: 404 });
    res.json(r);
});
