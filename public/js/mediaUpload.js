// public/js/mediaUpload.js — tải ảnh / âm thanh / video lên (xem services/code/mediaService.js). Cần public/js/tsMux.js.
//
//   Bước 1: POST /code/html/upload/init — web chính kiểm tra LẦN LƯỢT các web dữ liệu
//           (thứ tự đã thêm: cũ → mới), chọn web đầu tiên hoạt động và ký phiếu tải lên.
//   Bước 2: gửi thẳng phần/đoạn file lên web dữ liệu đó (không đi qua web chính lần nữa).
//           Web đang lỗi → báo web chính cho web đó "nghỉ" rồi chuyển ngay sang web kế tiếp.
//
//   ≤ ngưỡng (23MB)  : chia phần ≤ 3.5MB → web dữ liệu mã hoá → ghép lại thành 1 file cùng tên.
//   > ngưỡng         : ĐỌC TỪNG LÁT file gốc, cắt đoạn MPEG-TS (m3u8) — video H.265/AV1/VP9 thì cắt đoạn fMP4 + init.mp4 —,
//                      gửi từng đoạn để mã hoá, cứ vài đoạn ghi 1 lô + đánh dấu tiến độ vào mnha-media.json.
//   MnhaUpload.upload(file, { dir, encrypt, onProgress, onNode, onNotice, confirmOverwrite(name) }) → Promise<{ name, plan, node }>
(function () {
    'use strict';
    var CONC = 3, BATCH = 8;

    function extOf(n) { var i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function b64(u8) { var s = '', i; for (i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); }
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
    function isDataError(e) { return e && e.status && e.status < 500 && e.status !== 429 && e.status !== 408; }

    function nodeUrls(node, local) {
        var base = node ? String(node.url || '').replace(/\/+$/, '') : '';
        return {
            init: base + (node ? '/api/node/media/init' : '/code/html/upload/local/init'),
            part: base + (node ? '/api/node/media/part' : '/code/html/upload/part'),
            finish: base + (node ? '/api/node/media/finish' : '/code/html/upload/finish'),
            seg: base + (node ? '/api/node/media/seg' : '/code/html/upload/seg'),
            commit: base + (node ? '/api/node/media/commit' : '/code/html/upload/commit'),
            visibility: base + (node ? '/api/node/media/visibility' : '/code/html/media/visibility'),
            del: base + (node ? '/api/node/media/delete' : '/code/html/media/delete')
        };
    }

    function direct(file, init, opt, urls, token, nodeName) {
        var n = Math.max(1, Math.ceil(file.size / init.partBytes)), parts = [];
        function progress(text, fr) { opt.onProgress(nodeName ? ('Web: ' + nodeName + ' — ' + text) : text, fr); }
        function sendPart(i) {
            var body = file.slice(i * init.partBytes, (i + 1) * init.partBytes);
            var q = { dir: opt.dir, name: init.name, uploadId: init.uploadId, i: i, n: n, encrypt: init.encrypt ? '1' : '0' };
            if (token) q.token = token;
            return retry(function () { return request('PUT', urls.part + '?' + qs(q), body, true); }, 'phần ' + (i + 1) + '/' + n);
        }
        var chain = Promise.resolve();
        for (var i = 0; i < n; i++) (function (i) {
            chain = chain.then(function () {
                progress('Đang mã hoá & tải phần ' + (i + 1) + '/' + n, i / n);
                return sendPart(i).then(function (r) {
                    if (r.notice) opt.onNotice(r.notice);
                    if (n > 1) parts.push({ i: i, sha: r.sha, ref: r.ref, provider: r.provider, size: r.size, receipt: r.receipt });
                });
            });
        })(i);
        return chain.then(function () {
            if (n === 1) return null;
            progress('Đang ghép & ghi lên kho media…', 0.97);
            var body = { dir: opt.dir, name: init.name, uploadId: init.uploadId, parts: parts };
            if (token) body.token = token;
            return retry(function () { return request('POST', urls.finish, body); }, 'ghép file').then(function (r) { if (r && r.notice) opt.onNotice(r.notice); });
        }).then(function () { progress('Xong', 1); return { name: init.name, plan: 'direct', node: nodeName || null, storage: init.storage || null }; });
    }

    async function hls(file, init, opt, urls, token, nodeName) {
        if (!window.TsMux) throw new Error('Thiếu bộ cắt (tsMux.js) — tải lại trang.');
        var ext = extOf(init.name);
        var f = await TsMux.open(TsMux.fileReader(file), ext, { segSec: init.segSec, segBytes: init.segBytes });
        var fm = f.fmt === 'fmp4', skip = init.resume ? init.resume.done : 0;
        var base = { dir: opt.dir, name: init.name, uploadId: init.uploadId };
        if (token) base.token = token;
        var done = {}, committed = skip, active = new Set(), fail = null, chain = Promise.resolve();
        function progress(text, fr) { opt.onProgress(nodeName ? ('Web: ' + nodeName + ' — ' + text) : text, fr); }

        function commit(final) {
            var recs = [];
            while (done[committed + recs.length]) recs.push(done[committed + recs.length]);
            if (!final && recs.length < BATCH) return;
            recs.forEach(function (r) { delete done[r.i]; });
            committed += recs.length;
            var body = { dir: opt.dir, name: init.name, uploadId: init.uploadId, srcName: file.name, src: { size: file.size, lastModified: file.lastModified }, segs: recs, final: !!final };
            if (token) body.token = token;
            if (fm) { body.fmt = 'fmp4'; body.init = b64(f.init); body.codecs = f.codecString; }
            chain = chain.then(function () { return retry(function () { return request('POST', urls.commit, body); }, final ? 'hoàn tất' : 'ghi lô đoạn'); }).then(function (r) { if (r && r.notice) opt.onNotice(r.notice); }).catch(function (e) { fail = fail || e; });
        }
        function sendSeg(seg) {
            var q = { dir: base.dir, name: base.name, uploadId: base.uploadId, i: seg.i };
            if (fm) q.fmt = 'fmp4';
            if (token) q.token = token;
            return retry(function () { return request('PUT', urls.seg + '?' + qs(q), seg.bytes, true); }, 'đoạn ' + (seg.i + 1))
                .then(function (r) {
                    if (r.notice) opt.onNotice(r.notice);
                    done[seg.i] = { i: seg.i, dur: seg.dur, plainSize: r.plainSize, sha: r.sha, ref: r.ref, provider: r.provider, size: r.size, receipt: r.receipt };
                });
        }
        if (skip) progress('Làm tiếp từ đoạn ' + (skip + 1) + '…', 0);
        for await (const seg of f.segments(skip)) {
            if (fail) break;
            while (active.size >= CONC) await Promise.race(Array.from(active));
            if (fail) break;
            const p = sendSeg(seg).catch(function (e) { fail = fail || e; }).then(function () { active.delete(p); commit(false); });
            active.add(p);
            progress('Đã cắt & mã hoá ' + (seg.i + 1) + (f.total ? '/' + f.total : '') + ' đoạn (m3u8' + (fm ? ' · fMP4 ' + (f.codecs.video || '') : '') + ')', Math.min(0.98, seg.progress));
        }
        await Promise.all(Array.from(active));
        if (!fail) { commit(true); }
        await chain;
        if (fail) throw fail;
        progress('Xong', 1);
        return { name: init.name, plan: 'hls', node: nodeName || null, storage: init.storage || null };
    }

    async function upload(file, opt) {
        opt = opt || {}; opt.dir = opt.dir || '';
        opt.onProgress = opt.onProgress || function () { };
        opt.onNode = opt.onNode || function () { };
        opt.onNotice = opt.onNotice || function () { };
        opt.onProgress('Đang kiểm tra web tải lên…', 0);
        var body = { dir: opt.dir, name: file.name, size: file.size, lastModified: file.lastModified, srcName: file.name, encrypt: opt.encrypt !== false };
        var plan = await retry(function () { return request('POST', '/code/html/upload/init', body); });
        if (plan.notice) opt.onNotice(plan.notice);

        var candidates = plan.mode === 'node' ? (plan.candidates && plan.candidates.length ? plan.candidates : [plan.node]) : [null];
        var lastErr = null;
        for (var i = 0; i < candidates.length; i++) {
            var node = candidates[i];
            var local = !node;
            var label = node ? (node.name || node.id || node.url) : 'máy chủ chính';
            opt.onNode(node || null);
            try {
                var init;
                if (local && plan.uploadId && plan.name) {
                    init = plan;                          // /upload/init đã chạy init (web dữ liệu hoặc tương thích cũ)
                } else if (local) {
                    init = await retry(function () { return request('POST', '/code/html/upload/local/init', body); });
                } else {
                    var q = { token: (plan.tokens && plan.tokens[node.id]) || plan.token, dir: plan.dir || opt.dir, name: plan.name || file.name, size: file.size, lastModified: file.lastModified, srcName: file.name, encrypt: body.encrypt };
                    init = await retry(function () { return request('POST', nodeUrls(node, false).init, q); }, label);
                }
                if (init.exists && opt.confirmOverwrite && !opt.confirmOverwrite(init.name)) { var c = new Error('Đã huỷ (giữ file cũ).'); c.cancelled = true; throw c; }
                var tok = init.token || (local ? null : ((plan.tokens && plan.tokens[node.id]) || plan.token));
                var urls = nodeUrls(node, local);
                return init.plan === 'direct' ? direct(file, init, opt, urls, tok, node && label) : hls(file, init, opt, urls, tok, node && label);
            } catch (e) {
                lastErr = e;
                if (e.cancelled || (isDataError(e) && e.status !== 401 && e.status !== 403)) throw e;   // 401/403 từ web dữ liệu = sai khoá/phiếu → thử web kế
                if (node) {
                    try { request('POST', '/code/html/upload/node-fail', { id: node.id }).catch(function () { }); } catch (_) { }
                    opt.onNotice('Web "' + label + '" không tải được (' + e.message + ') — đang chuyển sang web kế tiếp…');
                }
                if (i === candidates.length - 1) break;
            }
        }
        var msg = lastErr ? lastErr.message : 'không rõ lỗi';
        throw new Error('Không tải lên được qua web nào. ' + msg);
    }
    window.MnhaUpload = { upload: upload, nodeUrls: nodeUrls };
})();
