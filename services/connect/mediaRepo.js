// services/connect/mediaRepo.js — xoay vòng repo GitHub cho ảnh / âm thanh / video.
//
//   • Mặc định TẮT (MEDIA_REPO_POOL=on để bật). Khi bật:
//       – v-s/media-repos.json (repo chính) ghi danh sách repo media + repo đang dùng.
//       – Repo chính đầy (~500MB, MEDIA_REPO_LIMIT_BYTES) → tự tạo repo mới
//         "<GITHUB_REPO>-media-N" bằng GITHUB_MEDIA_TOKEN (hoặc GITHUB_TOKEN) rồi ghi tiếp vào đó.
//       – mnha-media.json LUÔN nằm ở repo chính (một nguồn duy nhất), còn file/đoạn media
//         nằm ở repo đang dùng. Khi đọc, gộp cây thư mục của TẤT CẢ repo → media cũ vẫn phát được.
//   • Tắt pool → mọi thứ dùng client mặc định (giữ nguyên hành vi cũ + test).
//
//   GHI: file mới/đoạn mới → repo đang dùng. XOÁ: tìm đúng repo đang chứa file.
//   ĐỌC: gộp tree + blob của repo chính và mọi repo media.
'use strict';
const registryCrypto = require('./crypto');

const FILE = () => process.env.MEDIA_REPO_INDEX_PATH || 'v-s/media-repos.json';
const LIMIT = () => {
    const n = Number(process.env.MEDIA_REPO_LIMIT_BYTES);
    return n > 0 ? n : 500 * 1024 * 1024;
};
// Chỉ còn tải ảnh → luôn dùng 1 repo chính (không xoay vòng sang repo media khác).
const enabled = () => false;
const gh = () => require('../githubService');

const TREE_TTL_MS = 15 * 1000;
const DOC_TTL_MS = 10 * 1000;
const SIZE_TTL_MS = 10 * 60 * 1000;

let _doc = null, _docAt = 0, _docPromise = null;
let _tree = null, _treeAt = 0, _treePromise = null;
const _clients = new Map();          // "owner/repo@branch" → github client
const _sizes = new Map();            // id → { at, bytes }
let _pendingBytes = 0, _flushTimer = null, _flushing = null;

const now = () => Date.now();
const blank = () => ({ v: 1, limitBytes: LIMIT(), active: null, repos: [], updatedAt: null });

function normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    if (!Array.isArray(d.repos)) d.repos = [];
    if (!d.limitBytes) d.limitBytes = LIMIT();
    d.v = 1;
    return d;
}

function clientFor(repo) {
    if (!repo) return gh();
    const key = `${repo.owner}/${repo.repo}@${repo.branch || 'main'}`;
    if (!_clients.has(key)) {
        _clients.set(key, gh().createClient({ owner: repo.owner, repo: repo.repo, branch: repo.branch || 'main' }));
    }
    return _clients.get(key);
}

function mainBase() {
    const g = gh();
    return { id: 'main', owner: g.owner, repo: g.repo, branch: g.branch, main: true };
}

function repoOfId(doc, id) {
    if (!id || id === 'main') return mainBase();
    return doc.repos.find((r) => r && r.id === id) || null;
}

async function load({ force = false } = {}) {
    if (!force && _doc && now() - _docAt < DOC_TTL_MS) return _doc;
    if (_docPromise) return _docPromise;
    _docPromise = (async () => {
        const raw = await gh().readJsonFile(FILE()).catch(() => null);
        _doc = normalize(raw);
        _docAt = now();
        return _doc;
    })();
    try { return await _docPromise; } finally { _docPromise = null; }
}

async function mutate(fn) {
    let last = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await gh().readJsonFileWithSha(FILE());
        const doc = normalize(cur ? cur.data : {});
        if (!doc.createdAt) doc.createdAt = new Date().toISOString();
        const next = normalize((await fn(doc)) || doc);
        next.updatedAt = new Date().toISOString();
        try {
            await gh().writeJsonFileIfSha(FILE(), next, cur ? cur.sha : null, 'connect: cập nhật repo media');
            _doc = next; _docAt = now();
            return next;
        } catch (e) {
            last = e;
            if (e.code !== 'SHA_CONFLICT') throw e;
            await new Promise((ok) => setTimeout(ok, 220 * (attempt + 1)));
        }
    }
    throw last || new Error('Không ghi được sổ repo media (xung đột SHA).');
}

/** Kích thước repo (byte) — ưu tiên số đo của app, bổ sung bằng API GitHub. */
async function repoBytes(repo, { force = false } = {}) {
    const id = repo.id || repo.repo;
    const hit = _sizes.get(id);
    if (!force && hit && now() - hit.at < SIZE_TTL_MS) return Math.max(hit.bytes, Number(repo.bytes) || 0);
    let bytes = Number(repo.bytes) || 0;
    try {
        const g = repo.main ? gh() : clientFor(repo);
        const r = await g._octokit.repos.get({ owner: repo.owner, repo: repo.repo });
        bytes = Math.max(bytes, (Number(r.data && r.data.size) || 0) * 1024);
    } catch (_) { /* không có quyền/không có mạng → dùng số đo */ }
    _sizes.set(id, { at: now(), bytes });
    return bytes;
}

// {ts} trong GITHUB_MEDIA_REPO_PREFIX → dấu thời gian YYYYMMDD-HHmmss (giờ theo TZ của máy chủ).
function stamp(d = new Date()) {
    const z = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function pickName(base, doc) {
    const exists = new Set(doc.repos.map((r) => String(r.repo || '')));
    if (base.includes('{ts}')) {
        const clean = (x) => x.replace(/[^A-Za-z0-9._-]+/g, '-');
        const first = clean(base.replace(/\{ts\}/g, stamp()));
        if (!exists.has(first)) return first;
        for (let i = 2; i < 500; i++) { const n = `${first}-${i}`; if (!exists.has(n)) return n; }
        return `${first}-${Date.now()}`;
    }
    for (let i = 1; i < 500; i++) {
        const name = `${base}-${i}`;
        if (!exists.has(name)) return name;
    }
    return `${base}-${Date.now()}`;
}

async function createRepo(doc) {
    const token = process.env.GITHUB_MEDIA_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Thiếu GITHUB_MEDIA_TOKEN (hoặc GITHUB_TOKEN) để tạo repo media.');
    const owner = process.env.GITHUB_MEDIA_OWNER || process.env.GITHUB_OWNER;
    const base = (process.env.GITHUB_MEDIA_REPO_PREFIX || `${process.env.GITHUB_REPO || 'repository'}-media`).replace(/[^A-Za-z0-9._{}-]+/g, '-');
    const name = pickName(base, doc);
    const g = gh().createClient({ token, owner, repo: name });
    const priv = String(process.env.MEDIA_REPO_PRIVATE || '').toLowerCase() === 'on';
    let info = null;
    try {
        const me = await g._octokit.users.getAuthenticated();
        if (String(me.data.login).toLowerCase() === String(owner).toLowerCase()) {
            const r = await g._octokit.repos.createForAuthenticatedUser({ name, private: priv, auto_init: true, description: 'MNHA media (tự tạo) — ảnh/âm thanh/video đã mã hoá' });
            info = r.data;
        } else {
            const r = await g._octokit.repos.createInOrg({ org: owner, name, private: priv, auto_init: true, description: 'MNHA media (tự tạo) — ảnh/âm thanh/video đã mã hoá' });
            info = r.data;
        }
    } catch (e) {
        const status = e.status || e.response?.status;
        if (status !== 422) throw new Error('Không tạo được repo media "' + owner + '/' + name + '": ' + e.message);
        const r = await g._octokit.repos.get({ owner, repo: name });        // đã tồn tại → dùng
        info = r.data;
    }
    const branch = (info && info.default_branch) || 'main';
    const rec = {
        id: name, owner, repo: name, branch, createdAt: new Date().toISOString(),
        bytes: 0, full: false, fullAt: null, note: '', private: priv
    };
    _clients.delete(`${owner}/${name}@${branch}`);
    doc.repos.push(rec);
    doc.active = rec.id;
    return rec;
}

// Có GITHUB_MEDIA_OWNER khác GITHUB_OWNER (tài khoản GitHub mới chuyên chứa media) → KHÔNG ghi media vào repo chính.
const separateAccount = () => {
    const mo = String(process.env.GITHUB_MEDIA_OWNER || '').toLowerCase();
    return !!mo && mo !== String(process.env.GITHUB_OWNER || '').toLowerCase();
};

async function ensureActive(doc) {
    doc.limitBytes = doc.limitBytes || LIMIT();
    let active = repoOfId(doc, doc.active);
    if (!active && separateAccount()) {
        const rec = await createRepo(doc);           // repo đầu tiên của tài khoản media
        await mutate((d) => { d.repos = doc.repos; d.active = rec.id; return d; })
            .catch((e) => console.warn('[mediaRepo] lưu repo đầu:', e.message));
        return { doc, repo: rec, bytes: 0 };
    }
    if (!active) { active = mainBase(); doc.active = 'main'; }
    const bytes = await repoBytes(active);
    const full = bytes >= (Number(doc.limitBytes) || LIMIT());
    if (!full) return { doc, repo: active, bytes };

    // Repo đang dùng đã đầy → tạo repo mới (chỉ tạo 1 lần cho mỗi lần gọi).
    const rec = await createRepo(doc);
    await mutate((d) => {
        d.repos = doc.repos;
        d.active = rec.id;
        const old = d.repos.find((r) => r.id === (doc.active || 'main'));
        if (old && old.id !== 'main') { old.full = true; old.fullAt = new Date().toISOString(); old.bytes = bytes; }
        const n = d.repos.find((r) => r.id === rec.id);
        if (n) { n.full = false; n.bytes = 0; }
        return d;
    }).catch((e) => console.warn('[mediaRepo] lưu repo mới:', e.message));
    return { doc, repo: rec, bytes: 0 };
}

/** Repo đang dùng để GHI (null khi pool tắt). */
async function active() {
    if (!enabled()) return { repo: mainBase(), client: gh(), bytes: 0, enabled: false };
    const doc = await load();
    const a = await ensureActive(doc);
    return { repo: a.repo, client: a.repo.main ? gh() : clientFor(a.repo), bytes: a.bytes, enabled: true, doc };
}

/** Tất cả client để ĐỌC: repo chính trước, rồi các repo media (cũ → mới). */
function readClients(doc) {
    const out = [{ repo: mainBase(), client: gh() }];
    if (!enabled() || !doc) return out;
    for (const r of doc.repos) {
        if (!r || !r.owner || !r.repo) continue;
        out.push({ repo: r, client: clientFor(r) });
    }
    return out;
}

async function mergedTree({ force = false } = {}) {
    if (!force && _tree && now() - _treeAt < TREE_TTL_MS) return _tree;
    if (_treePromise) return _treePromise;
    _treePromise = (async () => {
        const doc = enabled() ? await load().catch(() => null) : null;
        const list = readClients(doc);
        const files = new Map();          // path → sha
        const owner = new Map();          // path → {repo, client}
        for (const { repo, client } of list) {
            let t;
            try { t = await client.getRepoTree({ force }); } catch (e) { console.warn('[mediaRepo] tree', repo.repo, e.message); continue; }
            for (const [p, sha] of t.files) { files.set(p, sha); owner.set(p, { repo, client }); }
        }
        _tree = { at: now(), files, owner };
        _treeAt = now();
        return _tree;
    })();
    try { return await _treePromise; } finally { _treePromise = null; }
}

function invalidateTree() { _tree = null; _treeAt = 0; }

async function findOwner(path) {
    if (enabled()) {
        const t = await mergedTree();
        if (t.owner.has(path)) return t.owner.get(path);
    }
    return { repo: mainBase(), client: gh() };
}

const isManifest = (p) => /(^|\/)mnha-media\.json$/i.test(String(p || ''));
// Dữ liệu hệ thống (sổ đăng ký, session, phiếu xem khoá) luôn ở repo CHÍNH.
const isSystemPath = (p) => isManifest(p) || /^(v-s|cookies)\//.test(String(p || '')) || /\/keys\//.test(String(p || '')) || /\.mnha-keys$/i.test(String(p || ''));

/**
 * Ghi nhiều thay đổi, tự chia về đúng repo:
 *   – mnha-media.json luôn ở repo chính
 *   – nội dung mới / sha blob mới → repo đang dùng
 *   – xoá → repo đang chứa file
 */
async function commitFiles(changes, message) {
    if (!Array.isArray(changes) || !changes.length) return { commitSha: null, skipped: true };
    if (!enabled()) return gh().commitFiles(changes, message);
    let a = null;
    const activeClient = async () => {
        if (!a) a = await active();
        return a.client;
    };
    const groups = new Map();           // client → {client, changes[]}
    const add = (client, c) => {
        let g = groups.get(client);
        if (!g) { g = { client, changes: [] }; groups.set(client, g); }
        g.changes.push(c);
    };
    for (const c of changes) {
        if (!c || !c.path) throw new Error('commitFiles: thiếu path');
        if (c.remove) add((await findOwner(c.path)).client, c);
        else if (isSystemPath(c.path)) add(gh(), c);
        else add(await activeClient(), c);
    }
    let first = null;
    for (const g of groups.values()) {
        const r = await g.client.commitFiles(g.changes, message);
        invalidateTree();
        if (r && r.commitSha && !first) first = r.commitSha;
    }
    return { commitSha: first };
}

function facade() {
    if (!enabled()) return gh();
    const proxy = {
        get isConfigured() { return gh().isConfigured; },
        get owner() { return gh().owner; },
        get repo() { return gh().repo; },
        get branch() { return gh().branch; },
        get _octokit() { return gh()._octokit; },

        getRepoTree: (o) => mergedTree(o),
        invalidateTree,
        getFileSha: async (p) => {
            const t = await mergedTree();
            return t.files.get(p) || null;
        },
        fileExists: async (p) => !!(await proxy.getFileSha(p)),
        getBlobBuffer: async (sha) => {
            const doc = enabled() ? await load().catch(() => null) : null;
            for (const { client } of readClients(doc)) {
                try { const b = await client.getBlobBuffer(sha); if (b) return b; } catch (_) { /* thử repo kế */ }
            }
            return null;
        },
        readBinaryFile: async (p) => {
            const own = await findOwner(p);
            return own.client.readBinaryFile(p);
        },
        readBinaryFileLarge: async (p) => {
            const own = await findOwner(p);
            return own.client.readBinaryFileLarge(p);
        },
        readJsonFile: async (...a) => gh().readJsonFile(...a),
        readJsonFileWithSha: async (...a) => gh().readJsonFileWithSha(...a),
        writeJsonFile: async (...a) => gh().writeJsonFile(...a),
        writeJsonFileIfSha: async (...a) => gh().writeJsonFileIfSha(...a),
        updateJsonFile: async (...a) => gh().updateJsonFile(...a),
        createBlob: async (buf) => (await active()).client.createBlob(buf),
        writeBinaryFile: async (p, buf, m) => { const r = await (await active()).client.writeBinaryFile(p, buf, m); invalidateTree(); return r; },
        writeBinaryFileBig: async (p, buf, m) => { const r = await (await active()).client.writeBinaryFileBig(p, buf, m); invalidateTree(); return r; },
        deleteFile: async (p, m) => {
            const own = await findOwner(p);
            const r = await own.client.deleteFile(p, m);
            invalidateTree();
            return r;
        },
        commitFiles,
        uniqueJsonPath: async (...a) => gh().uniqueJsonPath(...a),
        repoFor: async (path) => {
            if (!enabled()) return { owner: gh().owner, repo: gh().repo, branch: gh().branch };
            const t = await mergedTree();
            const o = t.owner.get(String(path));
            const r = o ? o.repo : (await active()).repo;
            return { owner: r.owner, repo: r.repo, branch: r.branch || 'main' };
        },
        // Bản đồng bộ (dùng ngay sau getRepoTree) — keyService.rawUrl cần URL của đúng repo.
        repoForSync: (path) => {
            if (!enabled()) return { owner: gh().owner, repo: gh().repo, branch: gh().branch };
            const o = _tree && _tree.owner && _tree.owner.get(String(path));
            const r = o ? o.repo : mainBase();
            return { owner: r.owner, repo: r.repo, branch: r.branch || 'main' };
        }
    };
    return proxy;
}

/** Cộng dồn byte đã ghi vào repo đang dùng (ghi lên GitHub định kỳ, không mỗi request). */
function addBytes(n) {
    const v = Number(n) || 0;
    if (!enabled() || v <= 0) return;
    _pendingBytes += v;
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => { _flushTimer = null; flush().catch(() => { /* đã log */ }); }, 15 * 1000);
    if (_flushTimer.unref) _flushTimer.unref();
}

async function flush() {
    if (!enabled() || _pendingBytes <= 0) return { skipped: true };
    if (_flushing) return _flushing;
    _flushing = (async () => {
        const n = _pendingBytes; _pendingBytes = 0;
        try {
            await mutate((d) => {
                const id = d.active || 'main';
                const r = d.repos.find((x) => x.id === id);
                if (!r) return d;                  // đang dùng repo chính
                r.bytes = (Number(r.bytes) || 0) + n;
                r.updatedAt = new Date().toISOString();
                if (r.bytes >= (d.limitBytes || LIMIT())) { r.full = true; r.fullAt = r.fullAt || r.updatedAt; }
                return d;
            });
        } catch (e) {
            _pendingBytes += n;
            console.warn('[mediaRepo] flush:', e.message);
        }
        return { ok: true };
    })().finally(() => { _flushing = null; });
    return _flushing;
}

/** Số liệu cho trang /connect. */
async function summary() {
    const doc = await load({ force: true }).catch(() => blank());
    const activeRec = repoOfId(doc, doc.active) || mainBase();
    const repos = [];
    for (const r of [mainBase(), ...doc.repos]) {
        const bytes = await repoBytes(r);
        const limit = Number(doc.limitBytes) || LIMIT();
        repos.push({
            id: r.id, owner: r.owner, repo: r.repo, branch: r.branch || 'main', main: !!r.main,
            bytes, limit, pct: Math.min(100, Math.round((bytes / limit) * 100)),
            full: !!r.full || bytes >= limit, active: r.id === (activeRec && activeRec.id),
            createdAt: r.createdAt || null, private: !!r.private
        });
    }
    return { enabled: enabled(), active: activeRec && activeRec.id, limit: Number(doc.limitBytes) || LIMIT(), repos, updatedAt: doc.updatedAt || null };
}

/** Đọc/ghi khoá kết nối dùng chung (helper nhỏ, tránh import vòng). */
function encryptKey(key, id) { return registryCrypto.encrypt(key, 'media|' + id); }

module.exports = {
    pickName, enabled, FILE, LIMIT, load, active, facade, commitFiles, mergedTree, invalidateTree,
    addBytes, flush, summary, repoBytes, readClients, encryptKey
};
