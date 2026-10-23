// public/js/mediaUpload.js — tải ảnh / âm thanh / video lên (xem services/code/mediaService.js). Cần public/js/tsMux.js.
//   ≤ ngưỡng (23MB)  : chia phần ≤ 3.5MB → server mã hoá → ghép lại thành 1 file cùng tên (đuôi gốc).
//   > ngưỡng         : ĐỌC TỪNG LÁT file gốc, cắt đoạn MPEG-TS (m3u8), gửi từng đoạn để mã hoá, cứ vài đoạn ghi 1 lô + đánh dấu tiến độ
//                      vào mnha-media.json → đứt mạng/đóng trang thì mở lại, chọn đúng file đó là làm tiếp từ chỗ đã đánh dấu.
//   MnhaUpload.upload(file, { dir, encrypt, onProgress(text, fraction), confirmOverwrite(name) }) → Promise<{ name, plan }>
(function () {
    'use strict';
    var CONC = 3, BATCH = 8;

    function extOf(n) { var i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function qs(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }

    function request(method, url, body, isBin) {
        var opt = { method: method, headers: { Accept: 'application/json' } };
        if (isBin) { opt.headers['Content-Type'] = 'application/octet-stream'; opt.body = body; }
        else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
        return fetch(url, opt).then(function (r) {
            return r.json().then(function (j) { return j; }, function () { return {}; }).then(function (j) {
                if (!r.ok) { var e = new Error(j.error || ('Lỗi ' + r.status)); e.status = r.status; throw e; }
                return j;
            });
        });
    }
    // lỗi mạng / 5xx thử lại; lỗi do dữ liệu (4xx) thì dừng ngay
    function retry(fn, label) {
        var n = 0;
        function go() {
            return fn().catch(function (e) {
                n++;
                if ((e.status && e.status < 500 && e.status !== 429) || n >= 4) { e.message = (label ? label + ': ' : '') + e.message; throw e; }
                return sleep(700 * n).then(go);
            });
        }
        return go();
    }

    function direct(file, init, opt) {
        var n = Math.max(1, Math.ceil(file.size / init.partBytes)), parts = [];
        function sendPart(i) {
            var body = file.slice(i * init.partBytes, (i + 1) * init.partBytes);
            var q = qs({ dir: opt.dir, name: init.name, uploadId: init.uploadId, i: i, n: n, encrypt: init.encrypt ? '1' : '0' });
            return retry(function () { return request('PUT', '/code/html/upload/part?' + q, body, true); }, 'phần ' + (i + 1) + '/' + n);
        }
        var chain = Promise.resolve();
        for (var i = 0; i < n; i++) (function (i) {
            chain = chain.then(function () {
                opt.onProgress('Đang mã hoá & tải phần ' + (i + 1) + '/' + n, i / n);
                return sendPart(i).then(function (r) { if (n > 1) parts.push({ i: i, sha: r.sha, size: r.size, receipt: r.receipt }); });
            });
        })(i);
        return chain.then(function () {
            if (n === 1) return null;
            opt.onProgress('Đang ghép & ghi lên GitHub…', 0.97);
            return retry(function () { return request('POST', '/code/html/upload/finish', { dir: opt.dir, name: init.name, uploadId: init.uploadId, parts: parts }); }, 'ghép file');
        }).then(function () { opt.onProgress('Xong', 1); return { name: init.name, plan: 'direct' }; });
    }

    async function hls(file, init, opt) {
        if (!window.TsMux) throw new Error('Thiếu bộ cắt (tsMux.js) — tải lại trang.');
        var ext = extOf(init.name);
        var f = await TsMux.open(TsMux.fileReader(file), ext, { segSec: init.segSec, segBytes: init.segBytes });
        var skip = init.resume ? init.resume.done : 0;
        var base = { dir: opt.dir, name: init.name, uploadId: init.uploadId };
        var done = {}, committed = skip, active = new Set(), fail = null, chain = Promise.resolve();

        function commit(final) {
            var recs = [];
            while (done[committed + recs.length]) recs.push(done[committed + recs.length]);
            if (!final && recs.length < BATCH) return;
            recs.forEach(function (r) { delete done[r.i]; });
            committed += recs.length;
            var body = { dir: opt.dir, name: init.name, uploadId: init.uploadId, srcName: file.name, src: { size: file.size, lastModified: file.lastModified }, segs: recs, final: !!final };
            chain = chain.then(function () { return retry(function () { return request('POST', '/code/html/upload/commit', body); }, final ? 'hoàn tất' : 'ghi lô đoạn'); }).catch(function (e) { fail = fail || e; });
        }
        function sendSeg(seg) {
            var q = qs({ dir: base.dir, name: base.name, uploadId: base.uploadId, i: seg.i });
            return retry(function () { return request('PUT', '/code/html/upload/seg?' + q, seg.bytes, true); }, 'đoạn ' + (seg.i + 1))
                .then(function (r) { done[seg.i] = { i: seg.i, dur: seg.dur, plainSize: r.plainSize, sha: r.sha, size: r.size, receipt: r.receipt }; });
        }
        if (skip) opt.onProgress('Làm tiếp từ đoạn ' + (skip + 1) + '…', 0);
        for await (const seg of f.segments(skip)) {
            if (fail) break;
            while (active.size >= CONC) await Promise.race(Array.from(active));
            if (fail) break;
            const p = sendSeg(seg).catch(function (e) { fail = fail || e; }).then(function () { active.delete(p); commit(false); });
            active.add(p);
            opt.onProgress('Đã cắt & mã hoá ' + (seg.i + 1) + (f.total ? '/' + f.total : '') + ' đoạn (m3u8)', Math.min(0.98, seg.progress));
        }
        await Promise.all(Array.from(active));
        if (!fail) { commit(true); }
        await chain;
        if (fail) throw fail;
        opt.onProgress('Xong', 1);
        return { name: init.name, plan: 'hls' };
    }

    async function upload(file, opt) {
        opt = opt || {}; opt.dir = opt.dir || '';
        opt.onProgress = opt.onProgress || function () { };
        opt.onProgress('Kiểm tra…', 0);
        var init = await retry(function () {
            return request('POST', '/code/html/upload/init', { dir: opt.dir, name: file.name, size: file.size, lastModified: file.lastModified, srcName: file.name, encrypt: opt.encrypt !== false });
        });
        if (init.exists && opt.confirmOverwrite && !opt.confirmOverwrite(init.name)) { var c = new Error('Đã huỷ (giữ file cũ).'); c.cancelled = true; throw c; }
        return init.plan === 'direct' ? direct(file, init, opt) : hls(file, init, opt);
    }
    window.MnhaUpload = { upload: upload };
})();
