// public/js/mnhaFiles.js — TRÌNH DUYỆT tự giải mã file "Lưu trữ file" (không để máy chủ gánh băng thông).
//
//   1) hỏi máy chủ (≈ vài KB): POST /code/files/open (chủ) hoặc GET /f/key (file công khai) → { mode:'direct', key, parts:[{url,size}], name, mime }
//   2) tải TỪNG PHẦN đã mã hoá THẲNG từ GitHub raw (nhiều phần cùng lúc), không qua máy chủ
//   3) giải mã bằng WebCrypto: mỗi phần = "MNHAENC1" | ver | salt | len | iv | tag | ciphertext, AES-256-GCM, AAD = "MNHA" + SỐ THỨ TỰ PHẦN
//      (GitHub/ai đó đảo hoặc đổi chỗ phần → xác thực thất bại, không ra file sai). Khoá chỉ nằm trong RAM của trang (extractable:false).
//   Khoá chủ KHÔNG BAO GIỜ tới đây — chỉ khoá riêng của file này. Lỗi tải thẳng (repo riêng tư, mạng, thiếu WebCrypto) mang `code` để nơi gọi quay về đường qua máy chủ.
//   API:  MnhaFiles.supported() · MnhaFiles.toBlob(info, { onProgress(done, total), concurrency }) → Blob · MnhaFiles.save(blob, name) · MnhaFiles.decryptPart(key, u8, index)
(function (root) {
    'use strict';
    var MAGIC = [0x4d, 0x4e, 0x48, 0x41, 0x45, 0x4e, 0x43, 0x31];      // "MNHAENC1"
    var HEADER_LEN = 25;
    var g = (typeof globalThis !== 'undefined' ? globalThis : root);
    var subtle = function () { return g.crypto && g.crypto.subtle; };

    function fail(msg, code, status) { var e = new Error(msg); e.code = code || ''; e.status = status || 0; return e; }
    function supported() { return !!(subtle() && typeof fetch === 'function' && typeof Blob === 'function'); }
    function b64ToBytes(b64) { var s = atob(b64), u = new Uint8Array(s.length), i; for (i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    function u32be(u, o) { return ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0; }
    function aadOf(index) { var a = new Uint8Array(8); a[0] = 0x4d; a[1] = 0x4e; a[2] = 0x48; a[3] = 0x41; a[4] = index >>> 24; a[5] = index >>> 16; a[6] = index >>> 8; a[7] = index; return a; }
    function isEncrypted(u) { if (!u || u.length < HEADER_LEN) return false; for (var i = 0; i < 8; i++) if (u[i] !== MAGIC[i]) return false; return true; }

    function importKey(b64) {
        var kb = b64ToBytes(b64);
        return subtle().importKey('raw', kb, 'AES-GCM', false, ['decrypt']).then(function (k) { kb.fill(0); return k; }, function (e) { kb.fill(0); throw e; });
    }

    /** 1 phần (file MNHAENC1 chứa 1 hoặc vài khối) → Uint8Array bản rõ. index = số thứ tự phần (AAD của khối đầu). */
    async function decryptPart(key, u8, index) {
        if (!isEncrypted(u8)) throw fail('Phần tải về không phải dữ liệu mã hoá của hệ thống (có thể repo chưa công khai).', 'BAD_FORMAT');
        if (u8[8] !== 1) throw fail('Phiên bản mã hoá không hỗ trợ.', 'BAD_FORMAT');
        var pos = HEADER_LEN, idx = index, out = [], total = 0;
        while (pos < u8.length) {
            if (pos + 32 > u8.length) throw fail('Phần mã hoá bị cắt cụt.', 'BAD_FORMAT');
            var len = u32be(u8, pos), s = pos + 32, e = s + len;
            if (e > u8.length) throw fail('Phần mã hoá bị cắt cụt.', 'BAD_FORMAT');
            var ct = new Uint8Array(len + 16);
            ct.set(u8.subarray(s, e), 0); ct.set(u8.subarray(pos + 16, pos + 32), len);     // WebCrypto: bản mã nối thẻ xác thực ở cuối
            var plain;
            try { plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: u8.subarray(pos + 4, pos + 16), additionalData: aadOf(idx), tagLength: 128 }, key, ct)); }
            catch (_) { throw fail('Phần ' + (index + 1) + ' sai khoá, bị sửa hoặc sai thứ tự — không giải mã được.', 'AUTH'); }
            out.push(plain); total += plain.length; pos = e; idx++;
        }
        if (!out.length) throw fail('Phần mã hoá rỗng.', 'BAD_FORMAT');
        if (out.length === 1) return out[0];
        var all = new Uint8Array(total), o = 0;
        out.forEach(function (p) { all.set(p, o); o += p.length; });
        return all;
    }

    async function fetchPart(p) {
        var r;
        try { r = await fetch(p.url, { credentials: 'omit', referrerPolicy: 'no-referrer' }); }
        catch (_) { throw fail('Không tải được phần ' + (p.i + 1) + ' từ GitHub (mạng hoặc bị chặn).', 'RAW'); }
        if (!r.ok) throw fail('Không tải được phần ' + (p.i + 1) + ' từ GitHub (HTTP ' + r.status + (r.status === 404 ? ' — repo chưa công khai?' : '') + ').', 'RAW', r.status);
        return new Uint8Array(await r.arrayBuffer());
    }

    /** Tải + giải mã mọi phần theo thứ tự (đọc trước `concurrency` phần), trả mảng các Uint8Array bản rõ. */
    async function readAll(info, opt) {
        opt = opt || {};
        if (!supported()) throw fail('Trình duyệt không có WebCrypto.', 'NO_CRYPTO');
        if (!info || info.mode !== 'direct' || !info.parts || !info.parts.length) throw fail('Máy chủ không cho tải thẳng từ GitHub.', 'NO_RAW');
        var key = await importKey(info.key), n = info.parts.length, conc = Math.max(1, Math.min(opt.concurrency || 3, 6)), pending = [], out = [], i;
        function launch(k) {
            var p = info.parts[k];
            pending[k] = fetchPart({ i: k, url: p.url }).then(function (u8) { return decryptPart(key, u8, k); }).then(function (pt) {
                if (p.size != null && pt.length !== p.size) throw fail('Phần ' + (k + 1) + ' sai kích thước — file có thể bị hỏng.', 'BAD_FORMAT');
                return pt;
            });
            pending[k].catch(function () { /* lỗi được ném khi tới lượt */ });
        }
        for (i = 0; i < Math.min(conc, n); i++) launch(i);
        for (i = 0; i < n; i++) {
            out.push(await pending[i]); pending[i] = null;
            if (i + conc < n) launch(i + conc);
            if (opt.onProgress) opt.onProgress(i + 1, n);
        }
        return out;
    }
    async function toBlob(info, opt) { return new Blob(await readAll(info, opt), { type: info.mime || 'application/octet-stream' }); }

    function save(blob, name) {
        var url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = String(name || 'file'); a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
    }

    var api = { supported: supported, readAll: readAll, toBlob: toBlob, save: save, decryptPart: decryptPart, importKey: importKey };
    root.MnhaFiles = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
