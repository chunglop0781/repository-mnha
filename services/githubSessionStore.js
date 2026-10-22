// services/githubSessionStore.js — express-session store lưu TẤT CẢ session trong MỘT file GitHub: cookies/index.json
//   { v:1, updatedAt, sessions: { "<HMAC(sid)>": { exp: <ms>, data: "<AES-256-GCM>" } } }
// • Đọc: tải index (cache ngắn trong bộ nhớ) → giải mã đúng session cần.   • Ghi: gom nhiều thay đổi thành 1 commit (khoá lạc quan SHA, tự thử lại).
// • Mỗi lần ghi còn dọn luôn session đã hết hạn. • touch() chỉ ghi lại khi hạn thật sự dài thêm (tránh commit liên tục).
'use strict';
const sc = require('./sessionCrypto');

let Base;
try { Base = require('express-session').Store; } catch (_) { Base = require('events').EventEmitter; }

const DAY = 24 * 60 * 60 * 1000;
const emptyIdx = () => ({ v: 1, updatedAt: new Date().toISOString(), sessions: {} });
const norm = (x) => (x && typeof x === 'object' && x.sessions && typeof x.sessions === 'object' ? x : emptyIdx());

function expOf(sess, fallbackTtl = DAY) {
    const c = sess && sess.cookie;
    if (c && c.expires) { const t = new Date(c.expires).getTime(); if (Number.isFinite(t)) return t; }
    if (c && Number.isFinite(c.originalMaxAge)) return Date.now() + c.originalMaxAge;
    return Date.now() + fallbackTtl;
}

class GithubSessionStore extends Base {
    constructor(opt = {}) {
        super();
        this.gh = opt.gh || require('./githubService');
        this.path = opt.path || process.env.SESSION_INDEX_PATH || 'cookies/index.json';
        this.cacheMs = opt.cacheMs ?? 5000;       // index nằm trong bộ nhớ tối đa chừng này ms
        this.flushMs = opt.flushMs ?? 300;        // gom thay đổi trong chừng này ms thành 1 commit
        this.touchExtendMs = opt.touchExtendMs ?? 6 * 60 * 60 * 1000;
        this.cache = null; this.pending = []; this.inflight = []; this.timer = null; this._flushing = false; this._loading = null;
        this.last = new Map();                    // id → JSON session đã ghi gần nhất (bỏ qua ghi trùng)
        sc.keys();                                // thiếu SESSION_ENC_KEY → báo lỗi ngay khi khởi động
    }

    // ---------- index
    _apply(idx, ops) {
        for (const o of ops) { if (o.op === 'set') idx.sessions[o.id] = { exp: o.exp, data: o.data }; else delete idx.sessions[o.id]; }
    }
    async _load({ maxAge = this.cacheMs } = {}) {
        if (this.cache && Date.now() - this.cache.at < maxAge) return this.cache.idx;
        if (this._loading) return this._loading;
        this._loading = (async () => {
            let idx = await this.gh.readJsonFile(this.path);
            if (!idx) { idx = emptyIdx(); await this.gh.writeJsonFile(this.path, idx, 'cookies: khởi tạo index'); }
            idx = norm(idx);
            this._apply(idx, this.inflight); this._apply(idx, this.pending.map((p) => p.op));   // giữ thay đổi chưa kịp lên GitHub
            this.cache = { idx, at: Date.now() };
            return idx;
        })().finally(() => { this._loading = null; });
        return this._loading;
    }
    _enqueue(op) {
        return new Promise((resolve, reject) => {
            this.pending.push({ op, resolve, reject });
            if (this.cache) this._apply(this.cache.idx, [op]);
            if (!this.timer) this.timer = setTimeout(() => this._flush(), this.flushMs);
        });
    }
    async _flush() {
        this.timer = null;
        if (this._flushing) { this.timer = setTimeout(() => this._flush(), this.flushMs); return; }
        const batch = this.pending.splice(0);
        if (!batch.length) return;
        this._flushing = true; this.inflight = batch.map((b) => b.op);
        try {
            await this._load();    // đảm bảo file index đã tồn tại
            const ops = this.inflight;
            await this.gh.updateJsonFile(this.path, (cur) => {
                const idx = norm(cur), now = Date.now();
                for (const [id, r] of Object.entries(idx.sessions)) if (!r || r.exp <= now) delete idx.sessions[id];   // dọn session hết hạn
                this._apply(idx, ops);
                idx.updatedAt = new Date().toISOString();
                return idx;
            }, `cookies: ${ops.length} thay đổi session`);
            batch.forEach((b) => b.resolve());
        } catch (e) {
            console.error('[session] ghi cookies/index.json lỗi:', e.message);
            this.cache = null;
            batch.forEach((b) => b.reject(e));
        } finally {
            this._flushing = false; this.inflight = [];
            if (this.pending.length && !this.timer) this.timer = setTimeout(() => this._flush(), this.flushMs);
        }
    }

    // ---------- giao diện express-session
    async _get(sid) {
        const id = sc.sidId(sid);
        let idx = await this._load();
        let rec = idx.sessions[id];
        if (!rec && Date.now() - this.cache.at > 1000) { idx = await this._load({ maxAge: 0 }); rec = idx.sessions[id]; }   // phiên mới tạo ở instance khác
        if (!rec) return null;
        if (rec.exp <= Date.now()) { this._enqueue({ op: 'del', id }).catch(() => {}); return null; }
        try { return sc.decrypt(rec.data, id); }
        catch (e) { console.warn('[session] không giải mã được 1 session (sai khoá hoặc bị sửa) — coi như chưa đăng nhập'); return null; }
    }
    get(sid, cb) { this._get(sid).then((s) => cb(null, s), (e) => cb(e)); }

    async _set(sid, sess) {
        const id = sc.sidId(sid), json = JSON.stringify(sess);
        if (this.last.get(id) === json && this.cache && this.cache.idx.sessions[id]) return;   // không đổi gì
        await this._enqueue({ op: 'set', id, exp: expOf(sess), data: sc.encrypt(sess, id) });
        this.last.set(id, json); if (this.last.size > 2000) this.last.delete(this.last.keys().next().value);
    }
    set(sid, sess, cb) { this._set(sid, sess).then(() => cb && cb(null), (e) => cb && cb(e)); }

    touch(sid, sess, cb) {
        const id = sc.sidId(sid), rec = this.cache && this.cache.idx.sessions[id], exp = expOf(sess);
        if (rec && exp - rec.exp > this.touchExtendMs) { this.last.delete(id); return this.set(sid, sess, cb); }
        if (rec) rec.exp = Math.max(rec.exp, exp);
        cb && cb(null);
    }
    destroy(sid, cb) {
        const id = sc.sidId(sid); this.last.delete(id);
        this._enqueue({ op: 'del', id }).then(() => cb && cb(null), (e) => cb && cb(e));
    }

    // ---------- dùng cho script migrate
    /** entries: [{sid, sess, exp}] → ghi cả lô trong 1 commit. force=false: bỏ qua sid đã có. Trả {added, skipped}. */
    async importSessions(entries, { force = false } = {}) {
        await this._load({ maxAge: 0 });
        let added = 0, skipped = 0;
        const prepared = entries.map((e) => { const id = sc.sidId(e.sid); return { op: 'set', id, exp: e.exp, data: sc.encrypt(e.sess, id) }; });
        await this.gh.updateJsonFile(this.path, (cur) => {
            const idx = norm(cur); added = 0; skipped = 0;
            for (const p of prepared) { if (!force && idx.sessions[p.id]) { skipped++; continue; } idx.sessions[p.id] = { exp: p.exp, data: p.data }; added++; }
            idx.updatedAt = new Date().toISOString();
            return idx;
        }, `cookies: nhập ${prepared.length} session từ MongoDB`);
        this.cache = null;
        return { added, skipped };
    }
    /** Đọc lại index mới nhất từ GitHub rồi giải mã 1 session (để kiểm chứng sau khi chuyển). */
    async verify(sid) { this.cache = null; const idx = await this._load({ maxAge: 0 }); const id = sc.sidId(sid); return idx.sessions[id] ? sc.decrypt(idx.sessions[id].data, id) : null; }
}

module.exports = GithubSessionStore;
module.exports.expOf = expOf;
