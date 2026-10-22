// controllers/code.controller.js — ỨNG DỤNG "LẬP TRÌNH" (emu8086 + C++)
//   GET  /code                       menu chọn ngôn ngữ
//   GET  /code/:lang                 thư mục & file của tôi  (user_id/codes/:lang/...)
//   GET  /code/:lang/edit?dir=&file= trình soạn code + chạy + kết quả (mở tab mới)
//   POST /code/:lang/folder|file|save|delete
//   POST /code/:lang/run             → {sid}
//   GET  /code/session/:sid          trạng thái/đầu ra (polling)
//   POST /code/session/:sid/input|stop
//   GET  /code/:lang/results[/:ts]   lịch sử kết quả (user_id/result/:lang/timestamp.json)
// Không cần duyệt tài khoản: chỉ cần đăng nhập.
'use strict';
const store = require('../services/code/codeStore');
const sessions = require('../services/code/sessionManager');
const remote = require('../services/code/remoteRunner');
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
const langOf = (req) => { const l = LANGS[req.params.lang]; if (!l) throw Object.assign(new Error('Không có dạng code này'), { status: 404 }); return l; };

exports.hub = wrap(async (req, res) => {
    res.render('code/hub', { title: 'Lập trình', user: req.user, langs: Object.values(LANGS) });
});

exports.files = wrap(async (req, res) => {
    const lang = langOf(req);
    const data = await store.list(uidOf(req), lang.key, req.query.dir || '');
    res.render('code/files', { title: lang.name, user: req.user, lang, ...data });
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

exports.edit = wrap(async (req, res) => {
    const lang = langOf(req);
    const dir = store.cleanDir(req.query.dir || '').join('/');
    const file = store.cleanFileName(lang.key, req.query.file);
    const content = await store.readFile(uidOf(req), lang.key, dir, file);
    if (content === null) throw Object.assign(new Error('Không tìm thấy file'), { status: 404 });
    const runnable = file.toLowerCase().endsWith('.' + lang.runExt);
    const results = await store.listResults(uidOf(req), lang.key, 20).catch(() => []);
    const cppMode = lang.key === 'cpp' ? CPP_RUN_MODE : null;
    if (cppMode === 'browser') {      // clang WebAssembly (Wasmer SDK) cần trang được cô lập origin
        res.set('Cross-Origin-Opener-Policy', 'same-origin');
        res.set('Cross-Origin-Embedder-Policy', 'credentialless');
    }
    const payload = { lang: lang.key, dir, file, runnable, content, mode: lang.editorMode, results, cppMode };
    const githubUrl = store.githubUrl(uidOf(req), lang.key, dir, file);
    res.render('code/editor', { cppMode, title: file, user: req.user, lang, dir, file, runnable, githubUrl, payloadJson: JSON.stringify(payload).replace(/</g, '\\u003c') });
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
    const dir = store.cleanDir(req.body.dir || '').join('/');
    const file = store.cleanFileName(lang.key, req.body.file);
    if (!file.toLowerCase().endsWith('.' + lang.runExt)) throw Object.assign(new Error('File này không chạy được'), { status: 400 });
    const code = String(req.body.content == null ? '' : req.body.content);
    if (code.length > 200 * 1024) throw Object.assign(new Error('Code quá dài'), { status: 400 });
    // chạy đúng code đang soạn (kể cả chưa lưu); các .txt cùng thư mục nạp vào thư mục chạy
    // cả file .cpp được nhắc trong code ("input1.cpp") cũng nạp làm dữ liệu (đổi sang .txt khi chạy, in ra thì đổi ngược lại)
    const cppNames = [...code.matchAll(/"([A-Za-z0-9_\-]{1,60})\.cpp"/gi)].map((m) => m[1] + '.cpp');
    const siblingFiles = lang.key === 'cpp' ? await store.siblingTextFiles(uid, lang.key, dir, { cppNames, exclude: file }) : [];
    if (lang.key === 'cpp' && remote.enabled()) {      // chạy ở dịch vụ runner riêng
        const r = await remote.run(uid, { file, dir, code, files: siblingFiles });
        return res.json({ sid: r.sid });
    }
    const s = await sessions.create({ uid, lang: lang.key, code, file, dir, siblingFiles });
    res.json({ sid: s.id });
});

function view(s, since) {
    const v = s.impl.view(since);
    return { ...v, lang: s.lang, saved: s.savedPath, saveError: s.saveError };
}
exports.poll = wrap(async (req, res) => {
    const s = sessions.get(req.params.sid, uidOf(req));
    if (!s && remote.enabled()) {
        const v = await remote.poll(uidOf(req), req.params.sid, req.query.since);
        if (v.status === 'finished' && !v.saved && v.result && v.meta) {      // lưu kết quả lên GitHub (runner không giữ secret GitHub)
            try {
                v.saved = await store.saveResult(uidOf(req), 'cpp', { lang: 'cpp', file: v.meta.file, dir: v.meta.dir, source: v.meta.source, ...v.result });
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
    await store.writeFile(uidOf(req), lang.key, req.body.dir || '', req.body.name, req.body.content);
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
exports.saveClientResult = wrap(async (req, res) => {   // kết quả chạy trong trình duyệt → lưu lên GitHub như lần chạy ở server
    const lang = langOf(req);
    const b = req.body || {};
    const r = {
        lang: lang.key, file: String(b.file || ''), dir: String(b.dir || ''), source: String(b.source || '').slice(0, 200 * 1024),
        kind: 'cpp-browser', status: b.error ? 'error' : 'ok', console: String(b.console || '').slice(0, 1024 * 1024),
        inputs: Array.isArray(b.inputs) ? b.inputs.slice(0, 500).map((x) => String(x).slice(0, 2000)) : [],
        exitCode: b.exitCode == null ? null : Number(b.exitCode), error: b.error ? String(b.error).slice(0, 2000) : null,
        files: b.files && typeof b.files === 'object' ? b.files : {}, finishedAt: new Date().toISOString()
    };
    res.json({ ok: true, saved: await store.saveResult(uidOf(req), lang.key, r) });
});

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
