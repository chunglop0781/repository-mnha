// services/code/remoteSource.js — "Xem code trên mạng": nhận link file trên GitHub / GitLab, lấy code về để xem + chạy.
//
// Link nhận được (chỉ https, chỉ 2 nơi này):
//   GitHub : https://github.com/<user>/<repo>/blob/<nhánh>/<đường-dẫn>/file.asm     (cũng nhận /raw/ và raw.githubusercontent.com)
//   GitLab : https://gitlab.com/<nhóm>[/<nhóm-con>]/<dự-án>/-/blob/<nhánh>/<đường-dẫn>/file.asm   (cũng nhận /-/raw/)
//
// AN TOÀN (máy chủ tự tải file nên phải chặn SSRF):
//   • Chỉ cho host trong danh sách trắng; địa chỉ tải được TỰ DỰNG LẠI từ các thành phần đã kiểm tra, không dùng nguyên link người dùng.
//   • Không tự động theo redirect: mỗi lần chuyển hướng đều kiểm tra lại host (tối đa 3 lần).
//   • Giới hạn kích thước (200KB), thời gian (10 giây), từ chối file nhị phân và trang HTML (repo riêng tư → trang đăng nhập).
'use strict';

const MAX_BYTES = 200 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;     // ảnh/âm thanh/video/css/js trong trang HTML xem trước (media mã hoá ≤ 23MB + đệm)
const FETCH_HOSTS = new Set(['raw.githubusercontent.com', 'github.com', 'gitlab.com']);
const NAME_SEG = /^[A-Za-z0-9_.\-]{1,100}$/;           // owner / repo / nhóm / nhánh
const PATH_SEG = /^[^\\/\x00-\x1f]{1,200}$/;           // thư mục / tên file trong repo

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const enc = (segs) => segs.map(encodeURIComponent).join('/');

function splitPath(u) {
    try { return u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s)); }
    catch (_) { throw bad('Link có ký tự không hợp lệ.'); }
}
function checkSegs(names, paths) {
    for (const s of names) if (!NAME_SEG.test(s) || s === '.' || s === '..') throw bad('Link có phần tên không hợp lệ: ' + s.slice(0, 40));
    for (const s of paths) if (!PATH_SEG.test(s) || s === '.' || s === '..') throw bad('Đường dẫn file trong link không hợp lệ.');
}

/** Dựng địa chỉ từ các thành phần ĐÃ kiểm tra (không bao giờ dùng nguyên link người dùng gửi). */
function buildLinks(host, base, ref, pathSegs) {
    const r = encodeURIComponent(ref);
    const info = { host, base, ref, pathSegs, path: pathSegs.join('/'), last: pathSegs[pathSegs.length - 1] };
    if (host === 'github') {
        info.web = `https://github.com/${enc(base)}/blob/${r}/${enc(pathSegs)}`;
        info.raw = `https://raw.githubusercontent.com/${enc(base)}/${r}/${enc(pathSegs)}`;
    } else {
        info.web = `https://gitlab.com/${enc(base)}/-/blob/${r}/${enc(pathSegs)}`;
        info.raw = `https://gitlab.com/${enc(base)}/-/raw/${r}/${enc(pathSegs)}`;
    }
    return info;
}

/** File khác trong CÙNG repo/nhánh, tính theo thư mục của file đang xem (relSegs: mảng đoạn đường dẫn đã kiểm tra). */
function siblingOf(parsed, relSegs) {
    const segs = [...parsed.pathSegs.slice(0, -1), ...relSegs];
    for (const s of segs) if (!PATH_SEG.test(s) || s === '.' || s === '..') throw bad('Đường dẫn file không hợp lệ.');
    return buildLinks(parsed.host, parsed.base, parsed.ref, segs);
}

/**
 * Phân tích link → { host:'github'|'gitlab', web, raw, path, last }
 *   web  = trang xem file (blob, KHÔNG phải raw) — dùng để hiển thị/chia sẻ
 *   raw  = địa chỉ tải nội dung thô (chỉ dùng phía máy chủ)
 */
function parseSourceUrl(input) {
    let u;
    try { u = new URL(String(input || '').trim()); } catch (_) { throw bad('Link không hợp lệ. Hãy dán link file trên github.com hoặc gitlab.com.'); }
    if (u.protocol !== 'https:') throw bad('Chỉ nhận link bắt đầu bằng https://');
    if (u.username || u.password || (u.port && u.port !== '443')) throw bad('Link không hợp lệ.');
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const segs = splitPath(u);

    if (host === 'github.com' || host === 'raw.githubusercontent.com') {
        let owner, repo, ref, path;
        if (host === 'github.com') {
            if (segs.length < 5 || !['blob', 'raw'].includes(segs[2])) throw bad('Link GitHub phải trỏ tới 1 FILE, dạng https://github.com/<user>/<repo>/blob/<nhánh>/<file>');
            [owner, repo, , ref] = segs; path = segs.slice(4);
        } else {
            if (segs.length < 4) throw bad('Link raw.githubusercontent.com không đủ thành phần.');
            [owner, repo, ref] = segs; path = segs.slice(3);
        }
        checkSegs([owner, repo, ref], path);
        return buildLinks('github', [owner, repo], ref, path);
    }

    if (host === 'gitlab.com') {
        const dash = segs.indexOf('-');
        const kind = dash >= 0 ? dash + 1 : segs.findIndex((s, k) => k >= 2 && (s === 'blob' || s === 'raw'));   // không có "/-/" = link GitLab kiểu cũ
        const ns = segs.slice(0, dash >= 0 ? dash : kind);
        if (kind < 0 || ns.length < 2 || !['blob', 'raw'].includes(segs[kind]) || segs.length < kind + 3) throw bad('Link GitLab phải trỏ tới 1 FILE, dạng https://gitlab.com/<nhóm>/<dự-án>/-/blob/<nhánh>/<file>');
        const ref = segs[kind + 1], path = segs.slice(kind + 2);
        checkSegs([...ns, ref], path);
        return buildLinks('gitlab', ns, ref, path);
    }
    throw bad('Chỉ hỗ trợ link từ github.com hoặc gitlab.com.');
}

// cache RAM ngắn (60 giây): mở trang xem rồi bấm chạy không phải tải lại
const cache = new Map();
const CACHE_MS = 60 * 1000;

async function readLimited(res, max = MAX_BYTES) {
    const tooBig = () => bad(max === MAX_BYTES ? 'File quá lớn (tối đa 200KB).' : `File quá lớn (tối đa ${Math.round(max / 1048576)}MB).`, 413);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) throw tooBig();
    if (!res.body || !res.body.getReader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > max) throw tooBig();
        return buf;
    }
    const reader = res.body.getReader(); const chunks = []; let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) { try { await reader.cancel(); } catch (_) { /* */ } throw tooBig(); }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/** Tải nội dung file (chuỗi UTF-8) từ link đã qua parseSourceUrl. */
async function fetchText(parsed, opts) {
    const maxBytes = (opts && opts.maxBytes) || MAX_BYTES;
    const hit = cache.get(parsed.raw);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.text;

    let url = parsed.raw;
    for (let hop = 0; hop <= 3; hop++) {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !FETCH_HOSTS.has(u.hostname)) throw bad('Link bị chuyển hướng tới nơi không được phép.');
        let res;
        try {
            res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'repository-mnha', accept: 'text/plain,*/*;q=0.8' } });
        } catch (e) {
            throw bad('Không tải được file từ ' + u.hostname + ' (' + ((e.cause && e.cause.code) || e.message) + ').', 502);
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).toString(); continue; }
        if (res.status === 404) throw bad('Không tìm thấy file. Kiểm tra lại link (đúng nhánh/đường dẫn) — repo phải CÔNG KHAI (public).', 404);
        if (!res.ok) throw bad('Nơi lưu code trả lỗi ' + res.status + '.', 502);
        if (/text\/html/i.test(res.headers.get('content-type') || '')) throw bad('Link trả về trang web chứ không phải file code (repo riêng tư/cần đăng nhập?). Hãy dùng repo công khai.');
        const buf = await readLimited(res, maxBytes);
        if (buf.includes(0)) throw bad('Đây không phải file văn bản (code).');
        const text = buf.toString('utf8').replace(/^\uFEFF/, '');
        if (text.length < 1024 * 1024) {            // file lớn không giữ trong bộ nhớ đệm
            if (cache.size > 50) cache.delete(cache.keys().next().value);
            cache.set(parsed.raw, { at: Date.now(), text });
        }
        return text;
    }
    throw bad('Link bị chuyển hướng quá nhiều lần.');
}

// ---- tải file NHỊ PHÂN trong cùng repo/nhánh (ảnh, css, js, âm thanh, video... của trang HTML xem trên mạng)
const bcache = new Map();
const BCACHE_ITEM = 2 * 1024 * 1024, BCACHE_TOTAL = 24 * 1024 * 1024;
let bcacheBytes = 0;
function bcachePut(key, buf) {
    if (buf.length > BCACHE_ITEM) return;
    bcache.set(key, { at: Date.now(), buf }); bcacheBytes += buf.length;
    while (bcacheBytes > BCACHE_TOTAL || bcache.size > 200) { const k = bcache.keys().next().value; bcacheBytes -= bcache.get(k).buf.length; bcache.delete(k); }
}

/** Link tới file khác (đường dẫn tính từ GỐC repo/nhánh) — segs: mảng đoạn đường dẫn, được kiểm tra chặt. */
function fromParts(parsedOrParts, segs) {
    const { host, base, ref } = parsedOrParts;
    if (!['github', 'gitlab'].includes(host) || !Array.isArray(base) || typeof ref !== 'string') throw bad('Nguồn không hợp lệ.');
    checkSegs([...base, ref], []);
    if (!Array.isArray(segs) || !segs.length || segs.length > 24) throw bad('Đường dẫn file không hợp lệ.');
    for (const sg of segs) if (!PATH_SEG.test(sg) || sg === '.' || sg === '..') throw bad('Đường dẫn file không hợp lệ.');
    return buildLinks(host, base, ref, segs);
}

/** Tải nội dung file (Buffer) từ link đã qua parseSourceUrl/fromParts. 404 → lỗi status 404. Cùng chống SSRF/redirect như fetchText. */
async function fetchBuffer(parsed, { maxBytes = MAX_ASSET_BYTES } = {}) {
    const hit = bcache.get(parsed.raw);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.buf;
    let url = parsed.raw;
    for (let hop = 0; hop <= 3; hop++) {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !FETCH_HOSTS.has(u.hostname)) throw bad('Link bị chuyển hướng tới nơi không được phép.');
        let res;
        try {
            res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'repository-mnha', accept: '*/*' } });
        } catch (e) {
            throw bad('Không tải được file từ ' + u.hostname + ' (' + ((e.cause && e.cause.code) || e.message) + ').', 502);
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).toString(); continue; }
        if (res.status === 404) throw bad('Không tìm thấy file.', 404);
        if (!res.ok) throw bad('Nơi lưu code trả lỗi ' + res.status + '.', 502);
        if (/text\/html/i.test(res.headers.get('content-type') || '')) throw bad('Link trả về trang web chứ không phải file (repo riêng tư/cần đăng nhập?). Hãy dùng repo công khai.', 403);
        const buf = await readLimited(res, maxBytes);
        bcachePut(parsed.raw, buf);
        return buf;
    }
    throw bad('Link bị chuyển hướng quá nhiều lần.');
}

// ---- "Xem thư mục" trên mạng: nhận link thư mục (hoặc file / gốc repo) và liệt kê qua API công khai của GitHub/GitLab.
// KHÔNG gửi token của app (tránh lộ repo riêng tư của app qua link người dùng nhập); chỉ 2 host API được phép, không theo redirect ra ngoài.
const API_HOSTS = new Set(['api.github.com', 'gitlab.com']);
const MAX_LIST = 300;

/** → { host, base[], ref|null, dirSegs[] } ; ref null = gốc repo (chưa biết nhánh mặc định → resolveRef). */
function parseFolderUrl(input) {
    let u;
    try { u = new URL(String(input || '').trim()); } catch (_) { throw bad('Link không hợp lệ. Hãy dán link thư mục hoặc file trên github.com / gitlab.com.'); }
    if (u.protocol !== 'https:') throw bad('Chỉ nhận link bắt đầu bằng https://');
    if (u.username || u.password || (u.port && u.port !== '443')) throw bad('Link không hợp lệ.');
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const segs = splitPath(u);
    if (host === 'github.com') {
        if (segs.length < 2) throw bad('Link GitHub cần có dạng https://github.com/<user>/<repo>[/tree/<nhánh>/<thư-mục>]');
        const [owner, repo] = segs;
        if (segs.length === 2) { checkSegs([owner, repo], []); return { host: 'github', base: [owner, repo], ref: null, dirSegs: [] }; }
        if (!['tree', 'blob'].includes(segs[2]) || segs.length < 4) throw bad('Link GitHub cần có dạng https://github.com/<user>/<repo>/tree/<nhánh>/<thư-mục>');
        const ref = segs[3]; let dir = segs.slice(4); if (segs[2] === 'blob') dir = dir.slice(0, -1);
        checkSegs([owner, repo, ref], dir);
        return { host: 'github', base: [owner, repo], ref, dirSegs: dir };
    }
    if (host === 'gitlab.com') {
        const dash = segs.indexOf('-');
        if (dash < 0) {
            if (segs.length < 2) throw bad('Link GitLab cần có dạng https://gitlab.com/<nhóm>/<dự-án>[/-/tree/<nhánh>/<thư-mục>]');
            checkSegs(segs, []); return { host: 'gitlab', base: segs, ref: null, dirSegs: [] };
        }
        const ns = segs.slice(0, dash), kind = segs[dash + 1];
        if (ns.length < 2) throw bad('Link GitLab không hợp lệ.');
        if (!kind) { checkSegs(ns, []); return { host: 'gitlab', base: ns, ref: null, dirSegs: [] }; }
        if (!['tree', 'blob'].includes(kind) || segs.length < dash + 3) throw bad('Link GitLab cần có dạng https://gitlab.com/<nhóm>/<dự-án>/-/tree/<nhánh>/<thư-mục>');
        const ref = segs[dash + 2]; let dir = segs.slice(dash + 3); if (kind === 'blob') dir = dir.slice(0, -1);
        checkSegs([...ns, ref], dir);
        return { host: 'gitlab', base: ns, ref, dirSegs: dir };
    }
    throw bad('Chỉ hỗ trợ link từ github.com hoặc gitlab.com.');
}

async function fetchJson(url) {
    let cur = url;
    for (let hop = 0; hop <= 2; hop++) {
        const u = new URL(cur);
        if (u.protocol !== 'https:' || !API_HOSTS.has(u.hostname)) throw bad('Link bị chuyển hướng tới nơi không được phép.');
        let res;
        try { res = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'repository-mnha', accept: 'application/json' } }); }
        catch (e) { throw bad('Không gọi được ' + u.hostname + ' (' + ((e.cause && e.cause.code) || e.message) + ').', 502); }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).toString(); continue; }
        if (res.status === 404) throw bad('Không tìm thấy thư mục/repo. Kiểm tra link (đúng nhánh, repo công khai).', 404);
        if (res.status === 403 || res.status === 429) throw bad('GitHub/GitLab đang giới hạn số lần xem thư mục (quá nhiều yêu cầu) — thử lại sau ít phút, hoặc dán link từng file.', 429);
        if (!res.ok) throw bad('Nơi lưu code trả lỗi ' + res.status + '.', 502);
        const buf = await readLimited(res, 2 * 1024 * 1024);
        try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw bad('Phản hồi không hợp lệ từ ' + u.hostname + '.', 502); }
    }
    throw bad('Link bị chuyển hướng quá nhiều lần.');
}

/** Bổ sung nhánh mặc định nếu link chỉ là gốc repo. */
async function resolveRef(f) {
    if (f.ref) return f;
    if (f.host === 'github') {
        const j = await fetchJson(`https://api.github.com/repos/${enc(f.base)}`);
        if (!j || !j.default_branch) throw bad('Không biết nhánh mặc định của repo.');
        checkSegs([j.default_branch], []); return { ...f, ref: j.default_branch };
    }
    const j = await fetchJson(`https://gitlab.com/api/v4/projects/${encodeURIComponent(f.base.join('/'))}`);
    if (!j || !j.default_branch) throw bad('Không biết nhánh mặc định của dự án.');
    checkSegs([j.default_branch], []); return { ...f, ref: j.default_branch };
}

/** Trang web (tree) của thư mục — dùng làm link chia sẻ. */
function treeWeb(f, dirSegs) {
    const r = encodeURIComponent(f.ref), d = dirSegs && dirSegs.length ? '/' + enc(dirSegs) : '';
    return f.host === 'github' ? `https://github.com/${enc(f.base)}/tree/${r}${d}` : `https://gitlab.com/${enc(f.base)}/-/tree/${r}${d}`;
}
/** Liệt kê thư mục → [{name, type:'dir'|'file', size|null}] (thư mục trước, tên A→Z). Ẩn _media và mnha-media.json (hệ thống). */
async function listFolder(f) {
    if (!f.ref) throw bad('Thiếu nhánh.');
    let items = [];
    if (f.host === 'github') {
        const p = f.dirSegs.length ? '/' + enc(f.dirSegs) : '';
        const j = await fetchJson(`https://api.github.com/repos/${enc(f.base)}/contents${p}?ref=${encodeURIComponent(f.ref)}`);
        if (!Array.isArray(j)) throw bad('Link này là file, không phải thư mục.');
        items = j.map((x) => ({ name: String(x.name), type: x.type === 'dir' ? 'dir' : 'file', size: x.type === 'dir' ? null : (Number(x.size) || 0) }));
    } else {
        const id = encodeURIComponent(f.base.join('/'));
        for (let page = 1; page <= 3; page++) {
            const j = await fetchJson(`https://gitlab.com/api/v4/projects/${id}/repository/tree?ref=${encodeURIComponent(f.ref)}&path=${encodeURIComponent(f.dirSegs.join('/'))}&per_page=100&page=${page}`);
            if (!Array.isArray(j)) break;
            items.push(...j.map((x) => ({ name: String(x.name), type: x.type === 'tree' ? 'dir' : 'file', size: null })));
            if (j.length < 100) break;
        }
    }
    const hasManifest = items.some((x) => x.type === 'file' && x.name === 'mnha-media.json');   // thư mục chỉ có media đã cắt m3u8 thì danh sách hiện rỗng nhưng vẫn có manifest
    items = items.filter((x) => PATH_SEG.test(x.name) && x.name !== '_media' && x.name !== 'mnha-media.json' && x.name !== '.keep');
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    items = items.slice(0, MAX_LIST);
    Object.defineProperty(items, 'hasManifest', { value: hasManifest });
    return items;
}

module.exports = { parseSourceUrl, parseFolderUrl, resolveRef, listFolder, treeWeb, siblingOf, fromParts, fetchText, fetchBuffer, MAX_BYTES, MAX_ASSET_BYTES };
