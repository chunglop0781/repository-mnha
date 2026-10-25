// services/connect/usage.js — đếm lưu lượng của từng web (phục vụ trang /connect).
//
//   Fast Data Transfer      ≈ dữ liệu trình duyệt ⇄ web      (bytes vào + ra, đếm theo request)
//   Fast Origin Transfer    ≈ dữ liệu web ⇄ GitHub           (bytes ghi/đọc qua githubService)
//
//   Vercel không có API công khai cho 2 chỉ số này, nên đây là số ĐO THỰC TẾ của ứng dụng
//   (xấp xỉ, mỗi instance serverless giữ bộ đếm và ghi lên GitHub định kỳ). Số chính thức của
//   Vercel vẫn nhập tay ở /connect (lưu cùng sổ đăng ký).
//
//   File: v-s/usage.json  { nodes: { "<id>": { days: { "YYYY-MM-DD": {in,out,originIn,originOut,req} } } } }
'use strict';
const registry = require('./registry');

const FILE = () => process.env.CONNECT_USAGE_PATH || 'v-s/usage.json';
const KEEP_DAYS = 62;
const FLUSH_MS = Number(process.env.CONNECT_USAGE_FLUSH_MS) > 0 ? Number(process.env.CONNECT_USAGE_FLUSH_MS) : 45 * 1000;

function nodeId() {
    if (process.env.NODE_ID) return String(process.env.NODE_ID);
    if (process.env.NODE_URL) {
        try { return registry.idForUrl(registry.cleanUrl(process.env.NODE_URL)); } catch (_) {
            try { return registry.idForUrl(String(process.env.NODE_URL).replace(/\/+$/, '')); } catch (__) { /* ignore */ }
        }
    }
    return 'main';
}

const pending = { in: 0, out: 0, originIn: 0, originOut: 0, req: 0 };
let timer = null;
let flushing = null;
let lastError = null;

const day = () => new Date().toISOString().slice(0, 10);

function note({ in: bytesIn = 0, out: bytesOut = 0, req = 0 } = {}) {
    pending.in += Math.max(0, Number(bytesIn) || 0);
    pending.out += Math.max(0, Number(bytesOut) || 0);
    pending.req += Math.max(0, Number(req) || 0);
}
function noteOrigin({ in: read = 0, out: write = 0 } = {}) {
    pending.originIn += Math.max(0, Number(read) || 0);
    pending.originOut += Math.max(0, Number(write) || 0);
}
function hasPending() { return pending.in + pending.out + pending.originIn + pending.originOut > 0 || pending.req > 0; }
function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => { /* đã log */ }); }, FLUSH_MS);
    if (timer.unref) timer.unref();
}

function normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    if (!d.nodes || typeof d.nodes !== 'object') d.nodes = {};
    d.v = 1;
    return d;
}
function prune(d) {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    for (const n of Object.values(d.nodes)) {
        if (!n || !n.days) continue;
        for (const k of Object.keys(n.days)) if (k < cutoff) delete n.days[k];
    }
    return d;
}

/** Ghi bộ đếm đang giữ lên GitHub. force=false: bỏ qua nếu chưa có gì / vừa ghi xong. */
async function flush({ force = false } = {}) {
    if (!force && !hasPending()) return { skipped: true };
    if (flushing) return flushing;
    flushing = (async () => {
        const snapshot = { ...pending };
        const id = nodeId(), today = day();
        const gh = require('../githubService');
        let last = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            const cur = await gh.readJsonFileWithSha(FILE());
            const d = normalize(cur ? cur.data : {});
            const n = d.nodes[id] || (d.nodes[id] = { days: {} });
            if (!n.days) n.days = {};
            const row = n.days[today] || (n.days[today] = { in: 0, out: 0, originIn: 0, originOut: 0, req: 0 });
            row.in += snapshot.in; row.out += snapshot.out;
            row.originIn += snapshot.originIn; row.originOut += snapshot.originOut;
            row.req += snapshot.req;
            n.updatedAt = new Date().toISOString();
            d.updatedAt = n.updatedAt;
            prune(d);
            try {
                await gh.writeJsonFileIfSha(FILE(), d, cur ? cur.sha : null, 'connect: lưu lưu lượng ' + id);
                pending.in -= snapshot.in; pending.out -= snapshot.out;
                pending.originIn -= snapshot.originIn; pending.originOut -= snapshot.originOut;
                pending.req -= snapshot.req;
                lastError = null;
                return { ok: true, id, day: today, row };
            } catch (e) {
                last = e;
                if (e.code !== 'SHA_CONFLICT') break;
                await new Promise((ok) => setTimeout(ok, 200 * (attempt + 1)));
            }
        }
        lastError = last ? last.message : 'không ghi được';
        console.warn('[connect/usage]', lastError);
        return { ok: false, error: lastError };
    })().finally(() => { flushing = null; });
    return flushing;
}

const empty = () => ({ in: 0, out: 0, originIn: 0, originOut: 0, req: 0 });
function add(a, b) {
    for (const k of Object.keys(empty())) a[k] += Number(b && b[k]) || 0;
    return a;
}

/** Số liệu của 1 web: hôm nay / 30 ngày / tất cả + lần cuối. */
async function snapshot(id, { days = 30 } = {}) {
    const d = normalize(await require('../githubService').readJsonFile(FILE()).catch(() => null));
    const rows = d.nodes[id] && d.nodes[id].days ? d.nodes[id].days : {};
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10), today = day();
    const out = { id, today: empty(), month: empty(), all: empty(), updatedAt: (d.nodes[id] && d.nodes[id].updatedAt) || null, lastError };
    for (const [k, row] of Object.entries(rows)) {
        add(out.all, row);
        if (k >= from) add(out.month, row);
        if (k === today) add(out.today, row);
    }
    return out;
}

/** Dựng lịch sử từ các dòng ngày của 1 web: từng ngày (mới → cũ) + tuần này (thứ Hai → hôm nay) + tuần trước. Ngày theo UTC. */
function buildHistory(rows, days) {
    rows = rows || {};
    const DAY = 86400000;
    const now = new Date();
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const dow = (new Date(todayMs).getUTCDay() + 6) % 7;            // 0 = thứ Hai … 6 = Chủ nhật
    const weekStart = todayMs - dow * DAY;
    const list = [];
    for (let i = 0; i < Math.max(days, dow + 8); i++) {
        const k = iso(todayMs - i * DAY);
        list.push(Object.assign({ date: k, dow: (new Date(todayMs - i * DAY).getUTCDay() + 6) % 7 }, empty(), rows[k] || {}));
    }
    const sum = (from, to) => list.filter((r) => r.date >= iso(from) && r.date <= iso(to)).reduce((a, r) => add(a, r), empty());
    return {
        days: list.slice(0, days),
        week: Object.assign({ from: iso(weekStart), to: iso(todayMs) }, sum(weekStart, todayMs)),
        lastWeek: Object.assign({ from: iso(weekStart - 7 * DAY), to: iso(weekStart - DAY) }, sum(weekStart - 7 * DAY, weekStart - DAY)),
        keepDays: KEEP_DAYS
    };
}

/** Lịch sử của 1 web. */
async function history(id, { days = 14 } = {}) {
    const d = normalize(await require('../githubService').readJsonFile(FILE()).catch(() => null));
    return buildHistory(d.nodes[id] && d.nodes[id].days, days);
}

/** Lịch sử của nhiều web (đọc usage.json 1 lần): { id → history }. */
async function historyAll(ids, { days = 14 } = {}) {
    const d = normalize(await require('../githubService').readJsonFile(FILE()).catch(() => null));
    const res = {};
    for (const id of ids) res[id] = buildHistory(d.nodes[id] && d.nodes[id].days, days);
    return res;
}

async function snapshotAll(ids) {
    const gh = require('../githubService');
    const d = normalize(await gh.readJsonFile(FILE()).catch(() => null));
    const res = {};
    for (const id of ids) {
        const rows = d.nodes[id] && d.nodes[id].days ? d.nodes[id].days : {};
        const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), today = day();
        const s = { id, today: empty(), month: empty(), all: empty(), updatedAt: (d.nodes[id] && d.nodes[id].updatedAt) || null };
        for (const [k, row] of Object.entries(rows)) {
            add(s.all, row); if (k >= from) add(s.month, row); if (k === today) add(s.today, row);
        }
        res[id] = s;
    }
    return res;
}

/** Middleware đếm request/response (gắn ở web chính và web dữ liệu). */
function middleware() {
    return function usageCounter(req, res, next) {
        let wrote = 0;
        const inBytes = Number(req.headers && req.headers['content-length']) || 0;
        const w = res.write, e = res.end;
        res.write = function (chunk, ...rest) {
            if (chunk) wrote += typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk.length || 0);
            return w.call(this, chunk, ...rest);
        };
        res.end = function (chunk, ...rest) {
            if (chunk && typeof chunk !== 'function') wrote += typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk.length || 0);
            return e.call(this, chunk, ...rest);
        };
        res.on('finish', () => { note({ in: inBytes, out: wrote, req: 1 }); schedule(); });
        next();
    };
}

function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (Math.round(n * 10) / 10) + ' ' + u[i];
}
const bytesToGb = (n) => Math.round((Number(n) || 0) / (1024 ** 3) * 100) / 100;

module.exports = { note, noteOrigin, schedule, flush, snapshot, snapshotAll, history, historyAll, buildHistory, middleware, formatBytes, bytesToGb, nodeId, FILE, hasPending };
