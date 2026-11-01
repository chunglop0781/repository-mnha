// services/code/sessionManager.js — phiên chạy code (trong RAM của tiến trình Node)
// ⚠ Cần máy chủ chạy liên tục (VPS/Render/Railway/Docker). KHÔNG chạy được trên Vercel serverless
//   (không có g++, và phiên chạy tương tác không giữ được giữa các lần gọi).
'use strict';
const crypto = require('crypto');
const { Machine, AsmError } = require('../emu8086/machine');
const { CppSession } = require('./cppRunner');
const store = require('./codeStore');
const { LIMITS } = require('../../config/codeConfig');

const sessions = new Map();

class EmuSession {
    constructor({ code }) {
        this.code = code; this.status = 'running'; this.startedAt = Date.now();
        this.listeners = []; this.asmErrors = null; this.m = null; this.error = null;
        this.lastActive = Date.now();
    }
    onFinish(fn) { this.listeners.push(fn); }
    async start() {
        try { this.m = new Machine(this.code); }
        catch (e) {
            if (e instanceof AsmError) { this.asmErrors = e.errors; this.error = 'Lỗi dịch hợp ngữ'; }
            else this.error = 'Lỗi: ' + e.message;
            return this._finish();
        }
        this._pump();
    }
    _pump() {
        if (this.status === 'finished' || this._pumping) return;
        this._pumping = true;
        const tick = () => {
            if (this.status === 'finished') { this._pumping = false; return; }
            if (Date.now() - this.startedAt > LIMITS.RUN_WALL_MS * 4 + 0 && !this.m.waiting) { this.m.fault('Chạy quá thời gian cho phép.'); }
            const st = this.m.run(100000);
            if (st === 'running') return setImmediate(tick);
            this._pumping = false;
            if (st === 'halted' || st === 'error') this._finish();
        };
        setImmediate(tick);
    }
    get waiting() { return this.m && this.m.status === 'waiting' ? this.m.waiting : null; }
    sendInput(text) {
        if (!this.m || this.status === 'finished') return false;
        const w = this.m.waiting;
        const t = String(text).slice(0, 2000);
        if (w && w.mode === 'line') this.m.feed(t + '\r');
        else this.m.feed(t === '' ? '\r' : t);
        this.lastActive = Date.now(); this._pump(); return true;
    }
    stop() { if (this.status === 'finished') return; if (this.m) this.m.fault('Đã dừng bởi người dùng.'); this.error = 'Đã dừng bởi người dùng.'; this._finish(); }
    _finish() {
        if (this.status === 'finished') return;
        this.status = 'finished'; this.finishedAt = Date.now();
        if (this.m && this.m.error) this.error = this.error || this.m.error;
        for (const fn of this.listeners) { try { fn(this); } catch (_) { /* */ } }
    }
    view() {
        const snap = this.m ? this.m.snapshot() : null;
        return {
            status: this.status, waiting: !!this.waiting, waitMode: this.waiting ? this.waiting.mode : null,
            asmErrors: this.asmErrors, error: this.error,
            screen: snap ? snap.screen : [], cursor: snap ? snap.cursor : null, regs: snap ? snap.regs : null,
            flags: snap ? snap.flags : null, steps: snap ? snap.steps : 0, exitCode: snap ? snap.exitCode : null
        };
    }
    result() {
        const snap = this.m ? this.m.snapshot() : null;
        return {
            kind: 'emu8086', status: this.error ? 'error' : 'ok',
            assemble: { ok: !this.asmErrors, errors: this.asmErrors || [] },
            console: this.m ? this.m.screen.raw : '', screen: snap ? snap.screen : [],
            inputs: this.m ? this.m.inputLog : [], regs: snap ? snap.regs : null, flags: snap ? snap.flags : null,
            steps: snap ? snap.steps : 0, exitCode: snap ? snap.exitCode : null, error: this.error,
            startedAt: new Date(this.startedAt).toISOString(), finishedAt: new Date(this.finishedAt || Date.now()).toISOString(),
            durationMs: (this.finishedAt || Date.now()) - this.startedAt
        };
    }
}

function countActive(uid) { let n = 0; for (const s of sessions.values()) if (s.uid === uid && s.impl.status !== 'finished') n++; return n; }

async function create({ uid, lang, code, file, dir, siblingFiles, origin }) {
    if (countActive(uid) >= LIMITS.MAX_SESSIONS_PER_USER) throw Object.assign(new Error('Bạn đang chạy quá nhiều chương trình cùng lúc — hãy dừng bớt.'), { status: 429 });
    const impl = lang === 'emu8086' ? new EmuSession({ code }) : new CppSession({ code, files: siblingFiles || [] });
    const id = crypto.randomBytes(12).toString('hex');
    const s = { id, uid, lang, impl, file: file || null, dir: dir || '', savedPath: null, saveError: null, createdAt: Date.now() };
    sessions.set(id, s);
    impl.onFinish(async () => {
        try {
            const res = impl.result();
            // chạy code xem trên mạng (có origin): file chương trình ghi ra (output.txt...) tự lưu vào codes/cpp/tren-mang/ — làm TRƯỚC khi lưu kết quả để client thấy cả hai cùng lúc
            if (origin && lang === 'cpp') {
                s.autoSaved = await store.saveOnlineOutputs(uid, lang, res.outputFiles);
                res.autoSaved = s.autoSaved;
            }
            const p = await store.saveResult(uid, lang, { lang, file: s.file, dir: s.dir, ...(origin ? { origin } : {}), source: code, ...res });
            s.savedPath = p;
        } catch (e) { s.saveError = e.message; console.error('[code] lưu kết quả lỗi:', e.message); }
    });
    impl.start();
    return s;
}
function get(id, uid) { const s = sessions.get(id); return s && s.uid === uid ? s : null; }

setInterval(() => {            // dọn phiên đã xong > 10 phút, phiên bỏ quên > 30 phút
    const now = Date.now();
    for (const [id, s] of sessions) {
        const fin = s.impl.status === 'finished';
        if ((fin && now - (s.impl.finishedAt || s.createdAt) > 10 * 60000) || now - s.createdAt > 30 * 60000) {
            try { s.impl.stop && s.impl.stop(); } catch (_) { /* */ }
            sessions.delete(id);
        }
    }
}, 60000).unref();

module.exports = { create, get };
