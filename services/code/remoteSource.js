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
        const tail = `${enc([owner, repo])}`;
        return {
            host: 'github', path: path.join('/'), last: path[path.length - 1],
            web: `https://github.com/${tail}/blob/${encodeURIComponent(ref)}/${enc(path)}`,
            raw: `https://raw.githubusercontent.com/${tail}/${encodeURIComponent(ref)}/${enc(path)}`
        };
    }

    if (host === 'gitlab.com') {
        const dash = segs.indexOf('-');
        const kind = dash >= 0 ? dash + 1 : segs.findIndex((s, k) => k >= 2 && (s === 'blob' || s === 'raw'));   // không có "/-/" = link GitLab kiểu cũ
        const ns = segs.slice(0, dash >= 0 ? dash : kind);
        if (kind < 0 || ns.length < 2 || !['blob', 'raw'].includes(segs[kind]) || segs.length < kind + 3) throw bad('Link GitLab phải trỏ tới 1 FILE, dạng https://gitlab.com/<nhóm>/<dự-án>/-/blob/<nhánh>/<file>');
        const ref = segs[kind + 1], path = segs.slice(kind + 2);
        checkSegs([...ns, ref], path);
        const base = `https://gitlab.com/${enc(ns)}/-`;
        return {
            host: 'gitlab', path: path.join('/'), last: path[path.length - 1],
            web: `${base}/blob/${encodeURIComponent(ref)}/${enc(path)}`,
            raw: `${base}/raw/${encodeURIComponent(ref)}/${enc(path)}`
        };
    }
    throw bad('Chỉ hỗ trợ link từ github.com hoặc gitlab.com.');
}

// cache RAM ngắn (60 giây): mở trang xem rồi bấm chạy không phải tải lại
const cache = new Map();
const CACHE_MS = 60 * 1000;

async function readLimited(res) {
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw bad('File quá lớn (tối đa 200KB).');
    if (!res.body || !res.body.getReader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw bad('File quá lớn (tối đa 200KB).');
        return buf;
    }
    const reader = res.body.getReader(); const chunks = []; let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) { try { await reader.cancel(); } catch (_) { /* */ } throw bad('File quá lớn (tối đa 200KB).'); }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/** Tải nội dung file (chuỗi UTF-8) từ link đã qua parseSourceUrl. */
async function fetchText(parsed) {
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
        const buf = await readLimited(res);
        if (buf.includes(0)) throw bad('Đây không phải file văn bản (code).');
        const text = buf.toString('utf8').replace(/^\uFEFF/, '');
        if (cache.size > 50) cache.delete(cache.keys().next().value);
        cache.set(parsed.raw, { at: Date.now(), text });
        return text;
    }
    throw bad('Link bị chuyển hướng quá nhiều lần.');
}

module.exports = { parseSourceUrl, fetchText, MAX_BYTES };
