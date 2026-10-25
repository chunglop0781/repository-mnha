// services/code/keyService.js — CỬA DUY NHẤT để khoá giải mã media rời khỏi máy chủ (trình duyệt tự giải mã, tải file mã hoá thẳng từ GitHub raw).
//
//   Khoá chủ (MEDIA_ENC_KEY)  : KHÔNG BAO GIỜ ra khỏi máy chủ.
//   Khoá file                 : mỗi file một khoá riêng (ảnh/âm thanh/video ≤ 23MB: HKDF(khoá chủ, salt trong header file); video/âm thanh m3u8: khoá AES-128 riêng
//                               của lần tải lên, bọc 2 chiều trong mnha-media.json). Lộ 1 khoá ⇒ không suy ra được khoá chủ, không mở được file khác.
//   Chỉ trả khoá khi qua authorize():
//     • token 'own'  → file của chính người đó ({uid}/codes/html/…), kể cả file riêng tư;
//     • token 'web'  → chỉ trong repo của app và đúng thư mục của CHỦ link (token.uid); người xem ≠ chủ thì file ở danh sách `private` của mnha-media.json BỊ TỪ CHỐI;
//     • mọi trường hợp khác (repo lạ, uid khác…) → 403.
//   "Phiếu xem": khi người xem lấy khoá file của NGƯỜI KHÁC, máy chủ ghi 1 dòng vào thư mục khoá của người xem — {viewerUid}/keys/ (file đánh dấu `.mnha-keys`,
//   `index.json`): chủ link, thư mục, thời điểm. Chỉ ghi định danh, KHÔNG ghi khoá. Ghi lỗi thì bỏ qua (không chặn việc xem).
//   Mọi đường giải mã quan trọng (khoá file, key.bin, giải mã dự phòng ở Node, tải về) đều đi qua authorize()/release*() ở đây.
'use strict';
const mc = require('./mediaCrypto');
const { MEDIA } = require('../../config/codeConfig');

const KEYS_DIR = 'keys';
const MARKER = '.mnha-keys';
const INDEX = 'index.json';

class KeyDenied extends Error { constructor(message, status = 403, code = 'DENIED') { super(message); this.status = status; this.code = code; } }

const enc = (segs) => segs.map(encodeURIComponent).join('/');
const sameCi = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** Token 'web' trỏ đúng repo GitHub của app? (chỉ repo này mới có media mã hoá bằng khoá chủ của app) */
function isAppRepo(payload, gh) {
    return !!(payload && payload.k === 'web' && payload.host === 'github' && Array.isArray(payload.base) && payload.base.length === 2
        && gh && gh.owner && gh.repo && sameCi(payload.base[0], gh.owner) && sameCi(payload.base[1], gh.repo));
}

/** Đường dẫn trong token → { ownerUid, viewerIsOwner, full[] } (full = đường dẫn đầy đủ trong repo) hoặc null nếu không được phép. */
function resolveTarget(payload, segs, gh) {
    if (!payload) return null;
    if (payload.k === 'own') return { ownerUid: payload.uid, viewerIsOwner: true, viewer: payload.uid, full: [payload.uid, 'codes', 'html', ...segs] };
    if (!isAppRepo(payload, gh) || !payload.uid) return null;
    if (segs[0] !== payload.uid || segs[1] !== 'codes' || segs[2] !== 'html') return null;
    return { ownerUid: payload.uid, viewerIsOwner: !!payload.viewer && payload.viewer === payload.uid, viewer: payload.viewer || null, full: segs.slice() };
}

// ---- đọc mnha-media.json của 1 thư mục qua cây GitHub (cache theo sha) ----
const manifests = new Map();
async function manifestOf(gh, dirFull) {
    const p = [...dirFull, MEDIA.MANIFEST].join('/');
    const sha = (await gh.getRepoTree()).files.get(p);
    if (!sha) return null;
    if (manifests.has(sha)) return manifests.get(sha);
    const buf = await gh.getBlobBuffer(sha);
    let j = null;
    try { j = buf ? JSON.parse(buf.toString('utf8')) : null; } catch (_) { j = null; }
    if (j && typeof j !== 'object') j = null;
    manifests.set(sha, j);
    if (manifests.size > 300) manifests.delete(manifests.keys().next().value);
    return j;
}
/** full → { dir[], name, entry } — hiểu cả đường dẫn đoạn `…/_media/<id>/…` (tên gốc lấy từ mục có id đó) */
async function locate(gh, full) {
    const h = full.indexOf(MEDIA.HIDDEN_DIR, 3);
    if (h >= 0) {
        const dir = full.slice(0, h), m = await manifestOf(gh, dir);
        const entry = m && m.files && Object.values(m.files).find((x) => x && x.id === full[h + 1]);
        return { dir, name: entry ? entry.name : null, entry: entry || null, manifest: m, hidden: true };
    }
    const dir = full.slice(0, -1), name = full[full.length - 1], m = await manifestOf(gh, dir);
    return { dir, name, entry: m && m.files ? m.files[name] || null : null, manifest: m, hidden: false };
}

// ---- giới hạn tần suất (mỗi token) ----
const hits = new Map();
function throttle(key, max = 600, windowMs = 10 * 60 * 1000) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }
    if (++h.n > max) throw new KeyDenied('Xin khoá quá nhiều lần — thử lại sau ít phút.', 429, 'RATE');
}

/** Kiểm quyền; ném KeyDenied nếu không được. Trả về target + vị trí media. */
async function authorize(payload, segs, gh, { tokenId } = {}) {
    if (tokenId) throttle('t:' + tokenId);
    const t = resolveTarget(payload, segs, gh);
    if (!t) throw new KeyDenied('Không có quyền mở khoá file này (ngoài phạm vi link đang xem).');
    const loc = await locate(gh, t.full);
    if (!t.viewerIsOwner) {
        const priv = loc.manifest && Array.isArray(loc.manifest.private) ? loc.manifest.private.map(String) : [];
        if (loc.name && priv.includes(loc.name)) throw new KeyDenied('File này chủ đã tắt công khai — chỉ chủ mới xem được.');
    }
    return { ...t, loc };
}

// ---- phiếu xem (thư mục khoá của người xem) ----
const seen = new Set();
const withTimeout = (p, ms) => Promise.race([p, new Promise((ok) => setTimeout(ok, ms))]);
async function recordView(gh, t) {
    if (t.viewerIsOwner || !t.viewer || !/^[A-Za-z0-9_\-]{1,64}$/.test(t.viewer)) return;
    const dirKey = `${t.ownerUid}/${t.loc.dir.slice(3).join('/')}`;
    const k = `${t.viewer}|${dirKey}`;
    if (seen.has(k)) return;
    seen.add(k);
    try {
        await withTimeout((async () => {
            const base = `${t.viewer}/${KEYS_DIR}`;
            const cur = (await gh.readJsonFile(`${base}/${INDEX}`).catch(() => null)) || { v: 1, views: {} };
            if (cur.views && cur.views[dirKey]) return;
            cur.views = cur.views || {};
            const now = new Date().toISOString();
            cur.views[dirKey] = { owner: t.ownerUid, dir: t.loc.dir.slice(3).join('/'), first: now };
            const changes = [{ path: `${base}/${INDEX}`, content: Buffer.from(JSON.stringify(cur, null, 2)) }];
            if (!(await gh.getRepoTree()).files.has(`${base}/${MARKER}`)) changes.push({ path: `${base}/${MARKER}`, content: Buffer.from(JSON.stringify({ v: 1, note: 'Thư mục khoá xem của người dùng — chỉ ghi định danh, không chứa khoá.' })) });
            await gh.commitFiles(changes, 'keys: phiếu xem ' + dirKey);
        })(), 3500);
    } catch (e) { seen.delete(k); console.error('[keyService] phiếu xem:', e.message); }
}

// ---- địa chỉ GitHub raw (trình duyệt tải thẳng file mã hoá) ----
function rawUrl(gh, full, v) {
    if (process.env.MEDIA_DIRECT === 'off' || MEDIA.DIRECT === false) return null;
    let base = process.env.MEDIA_RAW_BASE;
    if (!base) {
        let r = null;
        try { r = gh && gh.repoForSync ? gh.repoForSync(full.join('/')) : null; } catch (_) { r = null; }
        const owner = r ? r.owner : (gh && gh.owner);
        const repo = r ? r.repo : (gh && gh.repo);
        const branch = r ? r.branch : (gh && gh.branch);
        if (owner && repo) base = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch || 'main')}`;
    }
    if (!base) return null;
    return base.replace(/\/+$/, '') + '/' + enc(full) + (v ? '?v=' + encodeURIComponent(v) : '');
}

// ---- khoá file MNHAENC1 (ảnh, âm thanh/video ≤ 23MB) ----
const saltBySha = new Map();        // sha → salt hex ('' = file không mã hoá)
async function saltFor(gh, sha) {
    if (saltBySha.has(sha)) return saltBySha.get(sha);
    const buf = await gh.getBlobBuffer(sha);
    if (!buf) return null;
    const s = mc.saltOf(buf);
    const hex = s ? s.toString('hex') : '';
    saltBySha.set(sha, hex);
    if (saltBySha.size > 2000) saltBySha.delete(saltBySha.keys().next().value);
    return hex;
}

/**
 * Trả cách mở 1 file: { mode:'direct', key(b64), sha, raw } | { mode:'plain', sha, raw } | { mode:'hls', kind, drm } | null (không có).
 * `raw` = null khi tắt tải thẳng (MEDIA_DIRECT=off) hoặc chưa cấu hình repo → trình duyệt quay về đường qua máy chủ.
 */
async function release(payload, segs, gh, opt = {}) {
    const t = await authorize(payload, segs, gh, opt);
    const path = t.full.join('/');
    let sha = (await gh.getRepoTree()).files.get(path);
    if (!sha) sha = (await gh.getRepoTree({ force: true })).files.get(path);
    if (sha) {
        const hex = await saltFor(gh, sha);
        if (hex === null) return null;
        await recordView(gh, t);
        if (!hex) return { mode: 'plain', sha, raw: rawUrl(gh, t.full, sha) };
        return { mode: 'direct', key: mc.fileKey(Buffer.from(hex, 'hex')).toString('base64'), sha, raw: rawUrl(gh, t.full, sha) };
    }
    const e = t.loc.entry;
    if (e && (e.mode === 'hls-audio' || e.mode === 'hls-video')) { await recordView(gh, t); return { mode: 'hls', kind: e.kind, drm: !!e.drm, codecs: e.codecs || null }; }
    return null;
}

/** Khoá DRM 16 byte của media m3u8 (key.bin) — mở khoá 2 chiều từ json, sau khi kiểm quyền. */
async function releaseHlsKey(payload, segs, gh, entry, opt = {}) {
    const t = await authorize(payload, segs, gh, opt);
    if (!entry || !entry.drm) throw new KeyDenied('Media này không có khoá DRM.', 404, 'NO_KEY');
    await recordView(gh, t);
    return mc.unwrapKey(entry.drm.key);
}

/** Trình duyệt có thể tự giải mã với token này? (đã cấu hình địa chỉ raw và token nằm trong phạm vi app) */
function canDirect(payload, gh) {
    if (!rawUrl(gh, ['x'])) return false;
    return !!payload && (payload.k === 'own' || (isAppRepo(payload, gh) && !!payload.uid));
}

/** Kiểm quyền cho đường giải mã dự phòng ở Node (không trả khoá). */
async function allowDecrypt(payload, segs, gh, opt = {}) { await authorize(payload, segs, gh, opt); }

module.exports = { KeyDenied, authorize, release, releaseHlsKey, allowDecrypt, canDirect, rawUrl, isAppRepo, resolveTarget, throttle, KEYS_DIR, MARKER, INDEX };
