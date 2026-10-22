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
const { LANGS } = require('../config/codeConfig');

const uidOf = (req) => String(req.user._id);
const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        const status = e.status || (e.code === 'SHA_CONFLICT' ? 409 : 500);
        if (status === 500) console.error('[code]', e);
        if (req.method === 'GET' && !(req.headers.accept || '').includes('json')) {
            return res.status(status).render('error', { title: 'Lỗi', message: e.message, statusCode: status, stack: null, user: req.user });
        }
        res.status(status).json({ error: e.message });
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
    const payload = { lang: lang.key, dir, file, runnable, content, mode: lang.editorMode, results };
    res.render('code/editor', { title: file, user: req.user, lang, dir, file, runnable, payloadJson: JSON.stringify(payload).replace(/</g, '\\u003c') });
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
    const siblingFiles = lang.key === 'cpp' ? await store.siblingTextFiles(uid, lang.key, dir) : [];
    const s = await sessions.create({ uid, lang: lang.key, code, file, dir, siblingFiles });
    res.json({ sid: s.id });
});

function view(s, since) {
    const v = s.impl.view(since);
    return { ...v, lang: s.lang, saved: s.savedPath, saveError: s.saveError };
}
exports.poll = wrap(async (req, res) => {
    const s = sessions.get(req.params.sid, uidOf(req));
    if (!s) return res.status(404).json({ error: 'Phiên chạy không còn (có thể máy chủ đã khởi động lại).' });
    res.json(view(s, Number(req.query.since) || 0));
});
exports.input = wrap(async (req, res) => {
    const s = sessions.get(req.params.sid, uidOf(req));
    if (!s) return res.status(404).json({ error: 'Phiên chạy không còn' });
    const ok = s.impl.sendInput(req.body.text);
    res.json({ ok });
});
exports.stop = wrap(async (req, res) => {
    const s = sessions.get(req.params.sid, uidOf(req));
    if (!s) return res.status(404).json({ error: 'Phiên chạy không còn' });
    s.impl.stop(); res.json({ ok: true });
});
exports.saveOutputFile = wrap(async (req, res) => {   // lưu output.txt do chương trình ghi vào thư mục code
    const lang = langOf(req);
    if (lang.key !== 'cpp') throw Object.assign(new Error('Không hỗ trợ'), { status: 400 });
    await store.writeFile(uidOf(req), lang.key, req.body.dir || '', req.body.name, req.body.content);
    res.json({ ok: true });
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
