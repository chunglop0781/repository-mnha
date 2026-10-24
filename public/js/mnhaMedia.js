// public/js/mnhaMedia.js — TRÌNH DUYỆT tự giải mã ảnh / âm thanh / video (không để máy chủ Vercel gánh băng thông).
//
//   Cách làm (xem services/code/keyService.js):
//     1) hỏi máy chủ  GET /preview/<token>/…/__key/<tên>  → { mode, key, raw, sha }   (≈100 byte; máy chủ kiểm quyền rồi mới trả khoá RIÊNG của file)
//     2) tải file mã hoá THẲNG từ GitHub raw (repo công khai) — không qua Vercel
//     3) giải mã bằng WebCrypto (AES-256-GCM từng khối, hoặc AES-128-CBC cho đoạn HLS), khoá chỉ nằm trong RAM của trang (import extractable:false, xoá bản thô ngay)
//   Khoá chủ KHÔNG BAO GIỜ tới đây. Thiếu WebCrypto / tải raw lỗi / máy chủ không cho tải thẳng → các hàm báo lỗi để nơi gọi quay về đường cũ qua máy chủ.
//
//   • MnhaMedia.open(previewUrl[, name])        → { type:'blob', url } | { type:'hls', url }   (blob: dùng cho <img>/<audio>/<video>, nhớ MnhaMedia.revoke)
//   • MnhaMedia.download(previewUrl, name, { onProgress })  tải về KIỂU STREAM: tải/giải mã từng đoạn, ghi xuống bộ nhớ tạm của trình duyệt (OPFS, đuôi .mnhapart),
//       giải phóng RAM ngay sau mỗi đoạn; đủ thì đổi tên về ĐUÔI GỐC rồi lưu (media cắt m3u8 = luồng MPEG-TS ghép / mp4 phân mảnh, y như bản tải ở máy chủ trước đây)
//   • MnhaMedia.bindDownloads(root, { onFallback })  gắn vào mọi <a href="…?dl=1"> trong root
// Chạy được cả ở Node (test): dùng globalThis.crypto.subtle và fetch.
(function (root) {
    'use strict';
    var MAGIC = [0x4d, 0x4e, 0x48, 0x41, 0x45, 0x4e, 0x43, 0x31];      // "MNHAENC1"
    var HEADER_LEN = 25;
    var TMP_EXT = '.mnhapart';
    var RAM_MAX = 400 * 1024 * 1024;
    var MIME = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska'
    };
    var g = (typeof globalThis !== 'undefined' ? globalThis : root);
    var subtle = function () { return g.crypto && g.crypto.subtle; };

    function extOf(n) { var s = String(n).split(/[?#]/)[0], i = s.lastIndexOf('.'); return i < 0 ? '' : s.slice(i + 1).toLowerCase(); }
    function supported() { return !!(subtle() && typeof fetch === 'function' && typeof Blob === 'function'); }
    function b64ToBytes(b64) { var s = atob(b64), u = new Uint8Array(s.length), i; for (i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    function u32be(u, o) { return ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0; }
    function aadOf(index) { var a = new Uint8Array(8); a[0] = 0x4d; a[1] = 0x4e; a[2] = 0x48; a[3] = 0x41; a[4] = index >>> 24; a[5] = index >>> 16; a[6] = index >>> 8; a[7] = index; return a; }
    function isEncrypted(u) { if (!u || u.length < HEADER_LEN) return false; for (var i = 0; i < 8; i++) if (u[i] !== MAGIC[i]) return false; return true; }
    function isOpaque() { try { return !!g.location && g.location.origin === 'null'; } catch (_) { return true; } }
    function fail(msg, status, code) { var e = new Error(msg); e.status = status || 0; e.code = code || ''; return e; }

    // ---------------------------------------------------------------- giải mã
    function importGcm(keyBytes) { return subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']); }
    function importCbc(keyBytes) { return subtle().importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']); }

    /** 1 bản ghi MNHAENC1: len(4) | iv(12) | tag(16) | ciphertext → Uint8Array bản rõ */
    function decryptRecord(key, rec, index) {
        var ct = new Uint8Array(rec.len + 16);
        ct.set(rec.ct, 0); ct.set(rec.tag, rec.len);        // WebCrypto: bản mã nối thẻ xác thực ở cuối
        return subtle().decrypt({ name: 'AES-GCM', iv: rec.iv, additionalData: aadOf(index), tagLength: 128 }, key, ct)
            .then(function (b) { return new Uint8Array(b); }, function () { throw fail('Sai khoá hoặc file đã bị sửa/hỏng (khối ' + index + ').', 0, 'AUTH'); });
    }
    /** Toàn bộ file MNHAENC1 đã tải xong → mảng các khối bản rõ */
    async function decryptFile(u8, keyBytes) {
        if (!isEncrypted(u8)) throw fail('Không phải file mã hoá của hệ thống.', 0, 'BAD_FORMAT');
        if (u8[8] !== 1) throw fail('Phiên bản mã hoá không hỗ trợ.', 0, 'BAD_FORMAT');
        var key = await importGcm(keyBytes), out = [], pos = HEADER_LEN, idx = 0;
        while (pos < u8.length) {
            if (pos + 32 > u8.length) throw fail('File mã hoá bị cắt cụt.', 0, 'BAD_FORMAT');
            var len = u32be(u8, pos), s = pos + 32, e = s + len;
            if (e > u8.length) throw fail('File mã hoá bị cắt cụt.', 0, 'BAD_FORMAT');
            out.push(await decryptRecord(key, { len: len, iv: u8.subarray(pos + 4, pos + 16), tag: u8.subarray(pos + 16, pos + 32), ct: u8.subarray(s, e) }, idx));
            pos = e; idx++;
        }
        if (!idx) throw fail('File mã hoá rỗng.', 0, 'BAD_FORMAT');
        return out;
    }

    /** Đọc đúng n byte từ luồng (gộp các mẩu nhỏ, chỉ sao chép khi cần) */
    function ChunkReader(reader) {
        var chunks = [], have = 0, done = false;
        function take(n) {
            var out = new Uint8Array(n), o = 0;
            while (o < n) {
                var c = chunks[0], need = n - o;
                if (c.length <= need) { out.set(c, o); o += c.length; chunks.shift(); } else { out.set(c.subarray(0, need), o); chunks[0] = c.subarray(need); o += need; }
            }
            have -= n; return out;
        }
        this.read = async function (n) {
            while (have < n && !done) { var r = await reader.read(); if (r.done) done = true; else if (r.value && r.value.length) { chunks.push(r.value); have += r.value.length; } }
            if (have < n) { if (have === 0) return null; throw fail('File mã hoá bị cắt cụt.', 0, 'BAD_FORMAT'); }
            return take(n);
        };
    }
    /** Giải mã KIỂU LUỒNG: đọc dần từ response.body, giải mã từng khối, trả từng khối bản rõ (RAM chỉ giữ 1 khối ≈ 3.5MB) */
    async function* decryptStream(body, keyBytes) {
        var cr = new ChunkReader(body.getReader()), head = await cr.read(HEADER_LEN);
        if (!head || !isEncrypted(head)) throw fail('Không phải file mã hoá của hệ thống.', 0, 'BAD_FORMAT');
        var key = await importGcm(keyBytes), idx = 0;
        for (;;) {
            var h = await cr.read(32);
            if (!h) break;
            var len = u32be(h, 0), ct = len ? await cr.read(len) : new Uint8Array(0);
            if (len && !ct) throw fail('File mã hoá bị cắt cụt.', 0, 'BAD_FORMAT');
            yield await decryptRecord(key, { len: len, iv: h.subarray(4, 16), tag: h.subarray(16, 32), ct: ct }, idx++);
        }
        if (!idx) throw fail('File mã hoá rỗng.', 0, 'BAD_FORMAT');
    }

    function hlsIv(sn) { var b = new Uint8Array(16); var hi = Math.floor(sn / 4294967296) >>> 0, lo = sn >>> 0; b[8] = hi >>> 24; b[9] = hi >>> 16; b[10] = hi >>> 8; b[11] = hi; b[12] = lo >>> 24; b[13] = lo >>> 16; b[14] = lo >>> 8; b[15] = lo; return b; }
    /** Đoạn HLS AES-128-CBC (IV = số thứ tự đoạn) */
    function hlsDecrypt(key, u8, sn) {
        return subtle().decrypt({ name: 'AES-CBC', iv: hlsIv(sn) }, key, u8).then(function (b) { return new Uint8Array(b); }, function () { throw fail('Không giải mã được đoạn ' + (sn + 1) + ' (sai khoá hoặc đoạn hỏng).', 0, 'AUTH'); });
    }
    /** Đọc playlist m3u8 do máy chủ trả (địa chỉ đã tuyệt đối) */
    function parsePlaylist(text, baseUrl) {
        var out = { keyUri: null, mapUri: null, segs: [], seq: 0 };
        String(text).split(/\r?\n/).forEach(function (l) {
            l = l.trim(); if (!l) return;
            var m;
            if (l.charAt(0) === '#') {
                if ((m = /^#EXT-X-KEY:.*URI="([^"]+)"/.exec(l)) && /METHOD=AES-128/.test(l)) out.keyUri = new URL(m[1], baseUrl).href;
                else if ((m = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(l))) out.mapUri = new URL(m[1], baseUrl).href;
                else if ((m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(l))) out.seq = Number(m[1]);
                return;
            }
            out.segs.push(new URL(l, baseUrl).href);
        });
        return out;
    }

    // ---------------------------------------------------------------- hỏi máy chủ + tải
    /** previewUrl (…/preview/<token>/dir/tên) → …/preview/<token>/dir/__key/tên */
    function keyUrl(previewUrl, base) {
        var x = new URL(previewUrl, (g.location && g.location.href) || 'http://x/');
        var b = base || (/^(.*?\/preview\/[^/]+\/)/.exec(x.pathname) || [])[1];
        if (!b || x.pathname.indexOf(b) !== 0) throw fail('Địa chỉ không thuộc /preview.', 0, 'BAD_URL');
        var rel = x.pathname.slice(b.length), i = rel.lastIndexOf('/');
        return x.origin + b + rel.slice(0, i + 1) + '__key/' + rel.slice(i + 1);
    }
    async function errorOf(r) { var j = null; try { j = await r.json(); } catch (_) { /* */ } return fail((j && j.error) || ('Lỗi ' + r.status), r.status, (j && j.code) || ''); }
    async function info(previewUrl, base) {
        var r = await fetch(keyUrl(previewUrl, base), { credentials: 'omit', cache: 'no-store' });
        if (!r.ok) throw await errorOf(r);
        return r.json();
    }
    async function getRaw(inf) {
        if (!inf.raw) throw fail('Máy chủ không bật tải thẳng từ GitHub.', 0, 'NO_RAW');
        var r = await fetch(inf.raw, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw fail('Không tải được file từ GitHub (HTTP ' + r.status + (r.status === 404 ? ' — repo chưa công khai?' : '') + ').', r.status, 'RAW');
        return r;
    }

    /** Mở media để gắn vào <img>/<audio>/<video>. m3u8 → { type:'hls', url } để hls.js tự lo. */
    async function open(previewUrl, name, base) {
        if (!supported()) throw fail('Trình duyệt không có WebCrypto.', 0, 'NO_CRYPTO');
        var inf = await info(previewUrl, base);
        if (inf.mode === 'hls') return { type: 'hls', url: previewUrl };
        var type = MIME[extOf(name || previewUrl)] || 'application/octet-stream';
        var r = await getRaw(inf);
        if (inf.mode === 'plain') return { type: 'blob', url: URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: type })) };
        var kb = b64ToBytes(inf.key), parts;
        try { parts = await decryptFile(new Uint8Array(await r.arrayBuffer()), kb); } finally { kb.fill(0); }
        return { type: 'blob', url: URL.createObjectURL(new Blob(parts, { type: type })) };
    }
    function revoke(url) { try { URL.revokeObjectURL(url); } catch (_) { /* */ } }

    // ---------------------------------------------------------------- tải về (stream → bộ nhớ tạm → đổi đuôi)
    function safeName(n) { return String(n || 'media').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'media'; }
    async function opfsDir() { try { return g.navigator && navigator.storage && navigator.storage.getDirectory ? await navigator.storage.getDirectory() : null; } catch (_) { return null; } }
    async function cleanupTemp(dir) {           // dọn file tạm bỏ dở > 1 ngày
        try {
            if (!dir || !dir.entries) return;
            for await (var e of dir.entries()) {
                if (e[0].slice(-TMP_EXT.length) !== TMP_EXT || e[1].kind !== 'file') continue;
                var f = await e[1].getFile();
                if (Date.now() - f.lastModified > 86400000) await dir.removeEntry(e[0]).catch(function () { });
            }
        } catch (_) { /* */ }
    }
    /** Nơi ghi: OPFS (đĩa, đuôi .mnhapart) nếu có, không thì gom Blob trong RAM. finish() trả File/Blob đã đổi về đuôi gốc. */
    async function makeSink(name, type) {
        var dir = await opfsDir(), tmp = 'mnha-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + TMP_EXT;
        if (dir) {
            try {
                await cleanupTemp(dir);
                var fh = await dir.getFileHandle(tmp, { create: true }), w = await fh.createWritable();
                return {
                    kind: 'opfs',
                    write: function (u8) { return w.write(u8); },
                    abort: async function () { try { await w.abort(); } catch (_) { /* */ } try { await dir.removeEntry(tmp); } catch (_) { /* */ } },
                    finish: async function () {
                        await w.close();
                        var final = tmp;
                        try { if (fh.move) { await fh.move(name); final = name; } } catch (_) { /* không đổi tên được: dùng File bọc lại bên dưới */ }
                        var file = await fh.getFile();
                        if (file.name !== name) file = new File([file], name, { type: type });
                        return { file: file, cleanup: function () { return dir.removeEntry(final).catch(function () { }); } };
                    }
                };
            } catch (_) { /* OPFS không ghi được → RAM */ }
        }
        var parts = [], held = 0;
        return {
            kind: 'ram',
            // không có OPFS mà file quá lớn thì KHÔNG giữ trong RAM (treo máy): báo lỗi để nơi gọi quay về tải qua máy chủ
            write: function (u8) {
                held += u8.length;
                if (held > RAM_MAX) return Promise.reject(fail('Trình duyệt không cho ghi bộ nhớ tạm (OPFS) nên không thể giữ file lớn trong RAM.', 0, 'NO_STORAGE'));
                parts.push(u8.slice ? u8.slice() : u8); return Promise.resolve();
            },
            abort: async function () { parts = []; },
            finish: async function () { return { file: new File(parts, name, { type: type }), cleanup: function () { parts = []; return Promise.resolve(); } }; }
        };
    }
    function saveFile(file, name, cleanup) {
        var url = URL.createObjectURL(file), a = document.createElement('a');
        a.href = url; a.download = name; a.style.display = 'none'; a.__mnhaPass = true;
        (document.body || document.documentElement).appendChild(a); a.click();
        setTimeout(function () { a.remove(); revoke(url); if (cleanup) cleanup(); }, 120000);
    }
    /** Tải trước tối đa `win` phần tử, nhưng trao kết quả THEO THỨ TỰ (bộ nhớ chỉ giữ vài đoạn). */
    function prefetcher(items, win, fn) {
        var pend = {};
        function start(i) { if (i < items.length && !pend[i]) { pend[i] = fn(items[i], i); pend[i].catch(function () { }); } }
        return { get: async function (i) { for (var k = i; k < i + win; k++) start(k); var v = await pend[i]; delete pend[i]; return v; } };
    }

    /**
     * Tải về: previewUrl của file (không có ?dl=1). Trả { name, bytes }. Lỗi → ném (nơi gọi quay về tải qua máy chủ).
     * opt.onProgress(fraction 0..1, text)
     */
    async function download(previewUrl, name, opt) {
        opt = opt || {};
        if (!supported()) throw fail('Trình duyệt không có WebCrypto.', 0, 'NO_CRYPTO');
        var prog = opt.onProgress || function () { };
        var inf = await info(previewUrl, opt.base), fname = safeName(name), sink = null, total = 0, type = MIME[extOf(fname)] || 'application/octet-stream';
        try {
            if (inf.mode === 'hls') {
                var pr = await fetch(previewUrl, { credentials: 'omit', cache: 'no-store' });
                if (!pr.ok) throw await errorOf(pr);
                var pl = parsePlaylist(await pr.text(), new URL(previewUrl, (g.location && g.location.href) || 'http://x/').href);
                if (!pl.segs.length) throw fail('Playlist rỗng.', 0, 'BAD_FORMAT');
                var key = null;
                if (pl.keyUri) {
                    var kr = await fetch(pl.keyUri, { credentials: 'omit', cache: 'no-store' });
                    if (!kr.ok) throw await errorOf(kr);
                    var kb = new Uint8Array(await kr.arrayBuffer()); key = await importCbc(kb); kb.fill(0);
                }
                type = pl.mapUri ? 'video/mp4' : 'video/mp2t';
                sink = await makeSink(fname, type);
                if (pl.mapUri) { var ir = await fetch(pl.mapUri, { credentials: 'omit' }); if (!ir.ok) throw await errorOf(ir); var init = new Uint8Array(await ir.arrayBuffer()); await sink.write(init); total += init.length; }
                var run = prefetcher(pl.segs, 3, async function (url, i) {
                    var r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
                    if (!r.ok) { if (r.headers.get('content-type') && /json/.test(r.headers.get('content-type'))) throw await errorOf(r); throw fail('Không tải được đoạn ' + (i + 1) + ' (HTTP ' + r.status + ').', r.status, 'RAW'); }
                    var u = new Uint8Array(await r.arrayBuffer());
                    return key ? hlsDecrypt(key, u, pl.seq + i) : u;
                });
                for (var i = 0; i < pl.segs.length; i++) {
                    var seg = await run.get(i); await sink.write(seg); total += seg.length;       // ghi xong là bỏ — RAM chỉ giữ vài đoạn đang tải
                    prog((i + 1) / pl.segs.length, 'Đoạn ' + (i + 1) + '/' + pl.segs.length);
                }
            } else {
                var r = await getRaw(inf);
                sink = await makeSink(fname, type);
                if (inf.mode === 'plain') {
                    var rd = r.body.getReader(), got = 0, len = Number(r.headers.get('content-length')) || 0;
                    for (;;) { var c = await rd.read(); if (c.done) break; await sink.write(c.value); got += c.value.length; total += c.value.length; if (len) prog(got / len, 'Đang tải'); }
                } else {
                    var kb2 = b64ToBytes(inf.key), len2 = Number(r.headers.get('content-length')) || 0, n = 0;
                    try {
                        for await (var blk of decryptStream(r.body, kb2)) { await sink.write(blk); total += blk.length; n++; prog(len2 ? Math.min(0.99, (total * 1.0001) / len2) : 0.5, 'Đã giải mã ' + Math.round(total / 1048576) + 'MB'); }
                    } finally { kb2.fill(0); }
                }
            }
            var fin = await sink.finish();
            prog(1, 'Xong');
            saveFile(fin.file, fname, fin.cleanup);
            return { name: fname, bytes: total, sink: sink.kind };
        } catch (e) { if (sink) await sink.abort(); throw e; }
    }

    /** Gắn tải-về-ở-trình-duyệt cho mọi <a href="…?dl=1">. Lỗi → onFallback(a, err) hoặc tải qua máy chủ như cũ. */
    function bindDownloads(rootEl, opt) {
        opt = opt || {};
        (rootEl || document).addEventListener('click', function (e) {
            var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a || a.__mnhaPass || !/[?&]dl=1(&|$)/.test(a.getAttribute('href') || '')) return;
            if (!supported()) return;
            var x; try { x = new URL(a.href, document.baseURI); } catch (_) { return; }
            if (!/\/preview\/[^/]+\//.test(x.pathname)) return;
            var plain = x.origin + x.pathname, name;
            try { name = decodeURIComponent(x.pathname.split('/').pop()); } catch (_) { name = x.pathname.split('/').pop(); }
            if (a.getAttribute('download')) name = a.getAttribute('download') || name;
            if (isOpaque()) {
                // iframe sandbox (origin "null") không có OPFS/ghi đĩa → nhờ trang cha (cùng app) tải; đứng một mình (mở thẳng /preview) thì tải qua máy chủ như cũ
                if (g.parent && g.parent !== g) { e.preventDefault(); e.stopPropagation(); try { g.parent.postMessage({ mnha: 1, type: 'download', url: plain, name: name }, '*'); } catch (_) { /* */ } }
                return;
            }
            e.preventDefault(); e.stopPropagation();
            if (a.__mnhaBusy) return;
            a.__mnhaBusy = true;
            var label = a.textContent;
            download(plain, name, { base: opt.base, onProgress: function (f, t) { a.textContent = '⬇ ' + Math.round(f * 100) + '% — ' + t; } }).then(function () {
                a.textContent = label; a.__mnhaBusy = false;
            }, function (err) {
                a.textContent = label; a.__mnhaBusy = false;
                if (opt.onFallback) opt.onFallback(a, err);
                a.__mnhaPass = true; a.click(); a.__mnhaPass = false;            // quay về tải qua máy chủ (đường cũ)
            });
        }, true);
    }

    var api = { supported: supported, open: open, revoke: revoke, info: info, keyUrl: keyUrl, download: download, bindDownloads: bindDownloads,
        _t: { decryptFile: decryptFile, decryptStream: decryptStream, hlsDecrypt: hlsDecrypt, importCbc: importCbc, parsePlaylist: parsePlaylist, isEncrypted: isEncrypted, hlsIv: hlsIv, b64ToBytes: b64ToBytes } };
    root.MnhaMedia = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
