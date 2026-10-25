// services/connect/cloudflare.js — Cloudflare R2 cho VIDEO / ÂM THANH (ảnh vẫn ở GitHub).
//
//   • Cấu hình nằm trong repo CHÍNH: v-s/cloudflare.json. Hai khoá R2 (Access Key ID /
//     Secret Access Key) và token GitHub dự phòng được MÃ HOÁ 2 CHIỀU bằng
//     services/connect/crypto.js (AES-256-GCM, AAD riêng từng trường) — lộ file json
//     cũng không lấy được khoá. Trang /connect chỉ hiện 4 ký tự cuối của Access Key ID (Secret/token không hiện hint).
//   • R2 dùng API tương thích S3 (SigV4, path-style): put / get / delete / list prefix /
//     presign GET. Có 3 cách trả địa chỉ xem:
//       – public   : CLOUDFLARE_PUBLIC_BASE + /<key> (bucket bật Public / custom domain)
//       – presign  : ký URL tạm thời (bucket private)
//       – proxy    : không trả URL, mọi đoạn đi qua máy chủ /preview
//   • GitHub dự phòng (fallback) là một tài khoản/repo KHÁC, token riêng: khi R2 lỗi
//     (put/link) thì đoạn/file + m3u8 được ghi sang đó. Nhờ vậy không bao giờ ghi media
//     mới vào tài khoản GitHub media đang bị khoá.
//   • Đọc media cũ vẫn qua GitHub như trước; module này chỉ dùng cho entry có `storage`.
'use strict';
const crypto = require('crypto');
const cc = require('./crypto');

const FILE = () => process.env.CLOUDFLARE_INDEX_PATH || 'v-s/cloudflare.json';
const TTL_MS = 30 * 1000;
const EMPTY_SHA = crypto.createHash('sha256').update('').digest('hex');
const XML = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const encPath = (key) => String(key || '').split('/').map(encodeURIComponent).join('/');
const trimBase = (u) => String(u || '').replace(/\/+$/, '');
const gh = () => require('../githubService');
// Đếm GB ghi/đọc R2 (lưu theo tuần như Vercel — xem services/connect/usage.js). Lỗi đếm không được làm hỏng việc tải lên.
const usage = () => { try { return require('./usage'); } catch (_) { return null; } };
const noteCloud = (spec) => { try { const u = usage(); if (u && u.noteCloud) u.noteCloud(spec); } catch (_) { /* bỏ qua */ } };

let _doc = null, _at = 0, _promise = null;
let _rt = null, _rtAt = 0;

function normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    d.v = 1;
    if (d.enabled == null) d.enabled = true;
    d.mode = ['public', 'presign', 'proxy'].includes(d.mode) ? d.mode : (d.publicBase ? 'public' : 'presign');
    if (!d.fallback || typeof d.fallback !== 'object') d.fallback = { enabled: false };
    if (d.fallback.enabled == null) d.fallback.enabled = !!(d.fallback.tokenEnc || d.fallback.repo);
    d.fallback.branch = d.fallback.branch || 'main';
    d.fallback.public = d.fallback.public !== false;
    if (!d.prefix) d.prefix = '';
    return d;
}

function invalidate() { _doc = null; _at = 0; _rt = null; _rtAt = 0; }

async function load({ force = false } = {}) {
    if (!force && _doc && Date.now() - _at < TTL_MS) return _doc;
    if (_promise) return _promise;
    _promise = (async () => {
        const raw = await gh().readJsonFile(FILE()).catch(() => null);
        _doc = normalize(raw);
        _at = Date.now();
        return _doc;
    })();
    try { return await _promise; } finally { _promise = null; }
}

function dec(token, field) {
    if (!token) return '';
    return String(cc.decrypt(token, 'cloudflare|' + field) || '');
}

/** Storage công khai (không chứa khoá) để ghi vào mnha-media.json. */
function cfStorage(doc) {
    if (!doc || !doc.accountId || !doc.bucket) return null;
    return {
        provider: 'cloudflare',
        accountId: String(doc.accountId),
        bucket: String(doc.bucket),
        endpoint: trimBase(doc.endpoint) || null,
        region: doc.region || 'auto',
        prefix: String(doc.prefix || ''),
        publicBase: trimBase(doc.publicBase) || null,
        mode: doc.mode
    };
}

function fbStorage(doc) {
    const f = doc && doc.fallback;
    if (!f || f.enabled === false || !f.owner || !f.repo) return null;
    return {
        provider: 'github-fallback',
        owner: String(f.owner),
        repo: String(f.repo),
        branch: f.branch || 'main',
        public: f.public !== false
    };
}

/**
 * Cấu hình đang dùng. Trả { doc, storage, fallback, direct }.
 * storage = R2 (null nếu chưa đủ), fallback = GitHub dự phòng (null nếu chưa đủ).
 */
async function runtime({ force = false } = {}) {
    if (!force && _rt && Date.now() - _rtAt < TTL_MS) return _rt;
    let doc;
    try { doc = await load({ force }); } catch (e) { doc = normalize(null); }
    let storage = null, error = null;
    if (doc.enabled !== false) {
        try {
            const accessKeyId = dec(doc.accessKeyIdEnc, 'accessKeyId');
            const secretAccessKey = dec(doc.secretAccessKeyEnc, 'secretAccessKey');
            if (doc.accountId && doc.bucket && accessKeyId && secretAccessKey) storage = cfStorage(doc);
            else if (doc.accountId || doc.bucket || doc.accessKeyIdEnc) error = 'Thiếu Account ID / Bucket / Access Key / Secret của Cloudflare R2.';
        } catch (e) { error = e.message; }
    }
    const fallback = fbStorage(doc);
    const direct = (!!storage && doc.mode !== 'proxy') || (!!fallback && fallback.public !== false);
    _rt = { doc, storage, fallback, direct, error };
    _rtAt = Date.now();
    return _rt;
}

/** Khoá thật chỉ dùng ở máy chủ — không bao giờ trả xuống trình duyệt. */
async function creds(storage) {
    const rt = await runtime();
    if (!rt.doc) throw new Error('Chưa có cấu hình Cloudflare trong ' + FILE() + '.');
    const accessKeyId = dec(rt.doc.accessKeyIdEnc, 'accessKeyId');
    const secretAccessKey = dec(rt.doc.secretAccessKeyEnc, 'secretAccessKey');
    if (!accessKeyId || !secretAccessKey) throw new Error('Chưa lưu Access Key / Secret của Cloudflare R2.');
    const accountId = (storage && storage.accountId) || rt.doc.accountId;
    const bucket = (storage && storage.bucket) || rt.doc.bucket;
    if (!accountId || !bucket) throw new Error('Thiếu Account ID hoặc tên Bucket R2.');
    return {
        accessKeyId, secretAccessKey, accountId, bucket,
        endpoint: trimBase((storage && storage.endpoint) || rt.doc.endpoint) || `https://${accountId}.r2.cloudflarestorage.com`,
        region: (storage && storage.region) || rt.doc.region || 'auto'
    };
}

// ---------------------------------------------------------------- SigV4
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function signingKey(secret, day, region) {
    return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
}
function canonicalQuery(params) {
    return Object.keys(params).filter((k) => params[k] != null).sort()
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]))).join('&');
}
function s3Url(c, key, query) {
    const base = c.endpoint + '/' + encodeURIComponent(c.bucket) + '/' + encPath(key);
    const q = query ? '?' + (typeof query === 'string' ? query : canonicalQuery(query)) : '';
    return base + q;
}
function amzDate(d = new Date()) {
    const z = (n) => String(n).padStart(2, '0');
    const day = `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}`;
    const time = `${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}`;
    return { day, stamp: day + 'T' + time + 'Z' };
}

async function request(method, c, key, { body = null, query = null, contentType = null, timeout = 30000 } = {}) {
    const url = s3Url(c, key, query);
    noteCloud({ req: 1 });
    const u = new URL(url);
    const cq = query ? (typeof query === 'string' ? query : canonicalQuery(query)) : '';
    const { day, stamp } = amzDate();
    const payloadHash = body ? sha256(body) : EMPTY_SHA;
    const headers = {
        host: u.host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': stamp
    };
    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map((h) => h + ':' + headers[h] + '\n').join('');
    const canonical = [method, u.pathname, cq, canonicalHeaders, signed.join(';'), payloadHash].join('\n');
    const scope = `${day}/${c.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
    const sig = crypto.createHmac('sha256', signingKey(c.secretAccessKey, day, c.region)).update(toSign).digest('hex');
    const auth = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;

    const outHeaders = { Authorization: auth, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
    if (contentType) outHeaders['Content-Type'] = contentType;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    if (timer.unref) timer.unref();
    let res;
    try {
        res = await fetch(url, { method, headers: outHeaders, body: body || undefined, signal: ac.signal });
    } catch (e) {
        throw new Error('Cloudflare R2 không phản hồi (' + method + ' ' + key + '): ' + e.message);
    } finally { clearTimeout(timer); }
    if (res.status === 404) return { status: 404, body: Buffer.alloc(0), headers: res.headers };
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
        throw new Error(`Cloudflare R2 lỗi ${res.status}${code ? ' (' + code + ')' : ''} khi ${method} ${key}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)}`);
    }
    const ab = await res.arrayBuffer();
    return { status: res.status, body: Buffer.from(ab), headers: res.headers };
}

/** Ký URL GET tạm thời (bucket private). */
function presignGet(c, key, expires = 6 * 60 * 60) {
    const url = s3Url(c, key);
    const u = new URL(url);
    const { day, stamp } = amzDate();
    const scope = `${day}/${c.region}/s3/aws4_request`;
    const params = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${c.accessKeyId}/${scope}`,
        'X-Amz-Date': stamp,
        'X-Amz-Expires': String(Math.max(60, Math.min(7 * 24 * 3600, Number(expires) || 21600))),
        'X-Amz-SignedHeaders': 'host'
    };
    const q = canonicalQuery(params);
    const canonical = ['GET', u.pathname, q, 'host:' + u.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
    const sig = crypto.createHmac('sha256', signingKey(c.secretAccessKey, day, c.region)).update(toSign).digest('hex');
    return url + '?' + q + '&X-Amz-Signature=' + sig;
}

async function putObject(storage, key, buf, contentType) {
    const c = await creds(storage);
    const body = Buffer.from(buf);
    await request('PUT', c, key, { body, contentType: contentType || 'application/octet-stream' });
    noteCloud({ up: body.length });
    return { ok: true, key, size: body.length };
}

async function getObject(storage, key) {
    const c = await creds(storage);
    const r = await request('GET', c, key);
    if (r.status !== 404) noteCloud({ down: r.body.length });
    return r.status === 404 ? null : r.body;
}

async function headObject(storage, key) {
    const c = await creds(storage);
    const r = await request('HEAD', c, key);
    return r.status === 404 ? null : { size: Number(r.headers.get('content-length')) || 0, type: r.headers.get('content-type') || '' };
}

async function deleteObject(storage, key) {
    const c = await creds(storage);
    await request('DELETE', c, key);
    return { ok: true };
}

async function listPrefix(storage, prefix) {
    const c = await creds(storage);
    const keys = [];
    let token = null;
    for (let page = 0; page < 100; page++) {
        const q = { 'list-type': '2', prefix: String(prefix || ''), 'max-keys': '1000' };
        if (token) q['continuation-token'] = token;
        const r = await request('GET', c, '', { query: q });
        const xml = r.body.toString('utf8');
        for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(XML(m[1]));
        const next = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1];
        if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        token = XML(next);
    }
    return keys;
}

/** Liệt kê object kèm dung lượng: [{ key, size }]. */
async function listObjects(storage, prefix) {
    const c = await creds(storage);
    const out = [];
    let token = null;
    for (let page = 0; page < 1000; page++) {
        const q = { 'list-type': '2', prefix: String(prefix || ''), 'max-keys': '1000' };
        if (token) q['continuation-token'] = token;
        const r = await request('GET', c, '', { query: q });
        const xml = r.body.toString('utf8');
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
            const key = (m[1].match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
            const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1]) || 0;
            if (key != null) out.push({ key: XML(key), size });
        }
        const next = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1];
        if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        token = XML(next);
    }
    return out;
}

async function deletePrefix(storage, prefix) {
    const keys = await listPrefix(storage, prefix);
    for (const k of keys) await deleteObject(storage, k);
    return { ok: true, deleted: keys.length };
}

function publicUrl(storage, key) {
    if (!storage || !storage.publicBase) return null;
    return trimBase(storage.publicBase) + '/' + encPath(key);
}

/**
 * Địa chỉ xem trực tiếp 1 object (null = phải đi qua máy chủ).
 * storage: storage của entry; opts.v: mốc cache-busting (uploadId).
 */
async function urlFor(storage, key, opts = {}) {
    if (!storage || process.env.MEDIA_DIRECT === 'off') return null;
    const v = opts.v ? 'v=' + encodeURIComponent(opts.v) : '';
    if (storage.provider === 'github-fallback') {
        if (storage.public === false) return null;
        const base = process.env.MEDIA_RAW_BASE
            ? trimBase(process.env.MEDIA_RAW_BASE)
            : `https://raw.githubusercontent.com/${encodeURIComponent(storage.owner)}/${encodeURIComponent(storage.repo)}/${encodeURIComponent(storage.branch || 'main')}`;
        return base + '/' + encPath(key) + (v ? '?' + v : '');
    }
    if (storage.provider !== 'cloudflare') return null;
    if (storage.mode === 'proxy') return null;
    const pub = publicUrl(storage, key);
    if (pub) return pub + (v ? '?' + v : '');
    try {
        const rt = await runtime();
        if (!rt.doc) return null;
        const c = {
            accessKeyId: dec(rt.doc.accessKeyIdEnc, 'accessKeyId'),
            secretAccessKey: dec(rt.doc.secretAccessKeyEnc, 'secretAccessKey'),
            accountId: storage.accountId || rt.doc.accountId,
            bucket: storage.bucket || rt.doc.bucket,
            endpoint: trimBase(storage.endpoint || rt.doc.endpoint) || `https://${storage.accountId || rt.doc.accountId}.r2.cloudflarestorage.com`,
            region: storage.region || rt.doc.region || 'auto'
        };
        if (!c.accessKeyId || !c.secretAccessKey || !c.bucket) return null;
        return presignGet(c, key);
    } catch (_) { return null; }
}

// ---------------------------------------------------------------- GitHub dự phòng
async function fallbackClient(storage) {
    const g = gh();
    if (!g || typeof g.createClient !== 'function') return null;
    let token = '';
    try {
        const doc = await load();
        token = dec(doc.fallback && doc.fallback.tokenEnc, 'fallbackToken');
    } catch (_) { token = ''; }
    token = token || process.env.GITHUB_FALLBACK_TOKEN || '';
    if (!token || !storage || !storage.owner || !storage.repo) return null;
    return g.createClient({ token, owner: storage.owner, repo: storage.repo, branch: storage.branch || 'main' });
}
async function fallbackReady(storage) {
    return !!(await fallbackClient(storage));
}
async function fallbackWriteBinary(storage, path, buf, message = 'media: ghi dự phòng') {
    const c = await fallbackClient(storage);
    if (!c) throw new Error('Repo GitHub dự phòng chưa cấu hình (token/owner/repo).');
    const body = Buffer.from(buf);
    const r = await c.writeBinaryFileBig(path, body, message);
    noteCloud({ fbUp: body.length });
    return r;
}
async function fallbackCreateBlob(storage, buf) {
    const c = await fallbackClient(storage);
    if (!c) throw new Error('Repo GitHub dự phòng chưa cấu hình (token/owner/repo).');
    const body = Buffer.from(buf);
    const r = await c.createBlob(body);
    noteCloud({ fbUp: body.length });
    return r;
}
async function fallbackGetBlob(storage, sha) {
    const c = await fallbackClient(storage);
    if (!c) return null;
    return c.getBlobBuffer(String(sha));
}
async function fallbackReadLarge(storage, path) {
    const c = await fallbackClient(storage);
    if (!c) return null;
    return c.readBinaryFileLarge(path);
}
async function fallbackCommit(storage, changes, message = 'media: ghi dự phòng') {
    const c = await fallbackClient(storage);
    if (!c) throw new Error('Repo GitHub dự phòng chưa cấu hình (token/owner/repo).');
    const r = await c.commitFiles(changes, message);
    const n = (changes || []).reduce((t, x) => t + (x && x.content != null ? Buffer.byteLength(x.content) : 0), 0);
    if (n) noteCloud({ fbUp: n });
    return r;
}
async function fallbackTree(storage, { force = false } = {}) {
    const c = await fallbackClient(storage);
    if (!c) return null;
    return c.getRepoTree({ force });
}
async function fallbackRemovePrefix(storage, prefix, message = 'media: xoá dự phòng') {
    const t = await fallbackTree(storage, { force: true });
    if (!t) return { removed: 0 };
    const paths = [...t.files.keys()].filter((p) => p.startsWith(prefix));
    if (!paths.length) return { removed: 0 };
    for (let i = 0; i < paths.length; i += 200) {
        await fallbackCommit(storage, paths.slice(i, i + 200).map((path) => ({ path, remove: true })), message);
    }
    return { removed: paths.length };
}

/** Đọc 1 object theo storage đã ghi trong manifest (R2 hoặc GitHub dự phòng). */
async function readObject(storage, key) {
    if (!storage) return null;
    if (storage.provider === 'github-fallback') return fallbackReadLarge(storage, key);
    if (storage.provider === 'cloudflare') return getObject(storage, key);
    return null;
}

// ---------------------------------------------------------------- lưu / xem cấu hình
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const cleanKey = (v) => clean(v, 400);

function publicSummary(doc, rt) {
    const d = doc || normalize(null);
    const f = d.fallback || {};
    return {
        ok: true, enabled: d.enabled !== false, configured: !!rt.storage,
        accountId: d.accountId || '', bucket: d.bucket || '', endpoint: d.endpoint || '',
        region: d.region || 'auto', prefix: d.prefix || '', publicBase: d.publicBase || '',
        mode: d.mode, keyHint: d.keyHint || null, secretSaved: !!d.secretAccessKeyEnc, stored: d.stored || null,
        error: rt.error || null, direct: !!rt.direct, updatedAt: d.updatedAt || null,
        fallback: {
            enabled: f.enabled !== false && !!(f.owner && f.repo), owner: f.owner || '', repo: f.repo || '',
            branch: f.branch || 'main', public: f.public !== false, tokenSaved: !!f.tokenEnc,
            configured: !!rt.fallback
        },
        path: FILE()
    };
}

async function summary() {
    const rt = await runtime();
    return publicSummary(rt.doc, rt);
}

/**
 * Lưu cấu hình. Trường bí mật để trống = GIỮ NGUYÊN bản cũ.
 * @param {{accountId,bucket,accessKeyId,secretAccessKey,endpoint,region,prefix,publicBase,mode,enabled,
 *          fallbackOwner,fallbackRepo,fallbackBranch,fallbackToken,fallbackPublic,fallbackEnabled,clear}} b
 */
async function saveConfig(b = {}) {
    const accountId = clean(b.accountId, 80).replace(/[^A-Za-z0-9-]/g, '');
    const bucket = clean(b.bucket, 100).replace(/[^A-Za-z0-9._-]/g, '');
    if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) throw bad('Account ID của Cloudflare phải là 32 ký tự hex.');
    if (bucket && bucket.length < 3) throw bad('Tên bucket R2 phải có ít nhất 3 ký tự.');
    const publicBase = clean(b.publicBase, 500);
    if (publicBase && !/^https:\/\//i.test(publicBase)) throw bad('Địa chỉ công khai phải bắt đầu bằng https://');
    const endpoint = clean(b.endpoint, 500);
    if (endpoint && !/^https:\/\//i.test(endpoint)) throw bad('Endpoint R2 phải bắt đầu bằng https://');
    const mode = ['public', 'presign', 'proxy'].includes(b.mode) ? b.mode : (publicBase ? 'public' : 'presign');

    let last = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await gh().readJsonFileWithSha(FILE());
        const d = normalize(cur ? cur.data : {});
        if (b.clear === true || b.clear === '1') {
            const next = normalize({ enabled: false });
            next.updatedAt = new Date().toISOString();
            try {
                await gh().writeJsonFileIfSha(FILE(), next, cur ? cur.sha : null, 'connect: xoá cấu hình Cloudflare');
                invalidate();
                return summary();
            } catch (e) { last = e; if (e.code !== 'SHA_CONFLICT') throw e; await new Promise((ok) => setTimeout(ok, 220)); continue; }
        }
        d.enabled = b.enabled === false || b.enabled === '0' ? false : true;
        delete d.secretHint;                       // bản cũ từng lưu 4 ký tự cuối của Secret — bỏ đi (repo public)
        if (d.fallback) delete d.fallback.tokenHint;
        if ('accountId' in b) d.accountId = accountId;
        if ('bucket' in b) d.bucket = bucket;
        if ('endpoint' in b) d.endpoint = endpoint;
        if ('region' in b) d.region = clean(b.region, 40) || 'auto';
        if ('prefix' in b) d.prefix = clean(b.prefix, 200).replace(/^\/+|\/+$/g, '');
        if ('publicBase' in b) d.publicBase = publicBase;
        if ('mode' in b || 'publicBase' in b) d.mode = mode;
        const ak = cleanKey(b.accessKeyId), sk = cleanKey(b.secretAccessKey);
        if (ak) { d.accessKeyIdEnc = cc.encrypt(ak, 'cloudflare|accessKeyId'); d.keyHint = cc.hint(ak); }
        if (sk) { d.secretAccessKeyEnc = cc.encrypt(sk, 'cloudflare|secretAccessKey'); delete d.secretHint; }

        const f = d.fallback || (d.fallback = {});
        if ('fallbackEnabled' in b) f.enabled = b.fallbackEnabled === true || b.fallbackEnabled === '1' || b.fallbackEnabled === 'on';
        if ('fallbackOwner' in b) f.owner = clean(b.fallbackOwner, 80).replace(/[^A-Za-z0-9-]/g, '');
        if ('fallbackRepo' in b) f.repo = clean(b.fallbackRepo, 100).replace(/[^A-Za-z0-9._-]/g, '');
        if ('fallbackBranch' in b) f.branch = clean(b.fallbackBranch, 80) || 'main';
        if ('fallbackPublic' in b) f.public = !(b.fallbackPublic === false || b.fallbackPublic === '0');
        const ft = cleanKey(b.fallbackToken);
        if (ft) { f.tokenEnc = cc.encrypt(ft, 'cloudflare|fallbackToken'); delete f.tokenHint; }
        if (!('fallbackEnabled' in b)) f.enabled = !!(f.owner && f.repo);
        d.fallback = f;
        d.updatedAt = new Date().toISOString();
        try {
            await gh().writeJsonFileIfSha(FILE(), d, cur ? cur.sha : null, 'connect: cấu hình Cloudflare R2');
            invalidate();
            return summary();
        } catch (e) {
            last = e;
            if (e.code !== 'SHA_CONFLICT') throw e;
            await new Promise((ok) => setTimeout(ok, 220 * (attempt + 1)));
        }
    }
    throw last || new Error('Không ghi được v-s/cloudflare.json (xung đột SHA).');
}

/** Kiểm tra thật: ghi/đọc/xoá 1 object nhỏ trên R2 + quyền tạo blob ở repo dự phòng. */
async function test() {
    const rt = await runtime({ force: true });
    const out = { ok: false, cloudflare: null, fallback: null };
    if (!rt.storage) throw new Error(rt.error || 'Chưa cấu hình Cloudflare R2 (Account ID, Bucket, Access Key, Secret).');
    const key = '_mnha-kiem-tra/' + crypto.randomBytes(8).toString('hex') + '.txt';
    const payload = Buffer.from('MNHA R2 test ' + new Date().toISOString());
    const t0 = Date.now();
    await putObject(rt.storage, key, payload, 'text/plain; charset=utf-8');
    const back = await getObject(rt.storage, key);
    await deleteObject(rt.storage, key).catch(() => null);
    if (!back || !back.equals(payload)) throw new Error('R2 ghi được nhưng đọc lại không khớp.');
    out.cloudflare = { ok: true, ms: Date.now() - t0, bucket: rt.storage.bucket, accountId: rt.storage.accountId };
    if (rt.fallback) {
        try {
            const sha = await fallbackCreateBlob(rt.fallback, Buffer.from('MNHA fallback test'));
            out.fallback = { ok: !!sha, owner: rt.fallback.owner, repo: rt.fallback.repo, branch: rt.fallback.branch };
        } catch (e) { out.fallback = { ok: false, error: e.message }; }
    } else {
        out.fallback = { ok: false, error: 'Chưa cấu hình repo GitHub dự phòng.' };
    }
    out.ok = !!out.cloudflare.ok;
    return out;
}

/**
 * Đo DUNG LƯỢNG THẬT đang nằm trong bucket R2 (liệt kê object + cộng size) rồi LƯU vào v-s/cloudflare.json
 * (stored = { bytes, objects, at, prefix }) — giống số liệu Vercel nhập ở /connect nhưng do hệ thống tự đo.
 */
async function measure() {
    const rt = await runtime({ force: true });
    if (!rt.storage) throw new Error(rt.error || 'Chưa cấu hình Cloudflare R2.');
    const prefix = String(rt.doc.prefix || '');
    const list = await listObjects(rt.storage, prefix);
    const bytes = list.reduce((t, o) => t + o.size, 0);
    const stored = { bytes, objects: list.length, at: new Date().toISOString(), prefix };
    let last = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await gh().readJsonFileWithSha(FILE());
        const d = normalize(cur ? cur.data : {});
        d.stored = stored;
        try {
            await gh().writeJsonFileIfSha(FILE(), d, cur ? cur.sha : null, 'connect: đo dung lượng bucket R2');
            invalidate();
            return stored;
        } catch (e) {
            last = e;
            if (e.code !== 'SHA_CONFLICT') throw e;
            await new Promise((ok) => setTimeout(ok, 220 * (attempt + 1)));
        }
    }
    throw last || new Error('Không ghi được kết quả đo dung lượng (xung đột SHA).');
}

module.exports = {
    FILE, load, runtime, invalidate, summary, saveConfig, test,
    putObject, getObject, headObject, deleteObject, listPrefix, listObjects, measure, deletePrefix, urlFor, publicUrl, presignGet,
    cfStorage, fbStorage, readObject,
    fallbackClient, fallbackReady, fallbackWriteBinary, fallbackCreateBlob, fallbackGetBlob,
    fallbackReadLarge, fallbackCommit, fallbackTree, fallbackRemovePrefix
};
