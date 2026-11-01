// public/js/mediaPlayer.js — trình phát ảnh / âm thanh / video của 1 thư mục (file của tôi hoặc trên mạng).
// Địa chỉ file là /preview/<token>/...: máy chủ tự giải mã (ảnh/âm thanh/video mã hoá), media đã cắt m3u8 thì trả playlist → hls.js.
(function () {
    'use strict';
    var P = JSON.parse(document.getElementById('payload').textContent);
    var items = P.items || [], stage = document.getElementById('plStage'), side = document.getElementById('plSide');
    var cur = -1, hls = null, auto = true, curBlob = null;
    // web kết nối đang giữ dữ liệu: xem và tải ảnh / âm thanh / video đều đi qua đây (không qua web chính)
    (function () { var d = P.data, b = document.getElementById('plNode'); if (!d || !d.node || !b) return; b.textContent = 'Xem / tải xuống qua web kết nối: ' + d.node.name + (d.node.id && d.node.id !== d.node.name ? ' (' + d.node.id + ')' : ''); })();
    // Trình duyệt TỰ giải mã (mnhaMedia.js): tải file mã hoá thẳng từ GitHub raw, chỉ xin khoá nhỏ ở máy chủ → không tốn băng thông Vercel. Không được thì quay về đường cũ.
    var direct = !!(P.direct && window.MnhaMedia && MnhaMedia.supported());
    if (direct) MnhaMedia.bindDownloads(document, {});
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    var ICON = { image: '🖼️', audio: '🎵', video: '🎬' }, LABEL = { image: 'ảnh', audio: 'âm thanh', video: 'video' };

    if (!items.length) { stage.innerHTML = '<div class="pl-empty">Thư mục này chưa có ảnh, âm thanh hoặc video.</div>'; side.style.display = 'none'; return; }

    function kText(it) { return LABEL[it.kind] + (it.cut ? ' · m3u8' : '') + (P.own && it.pub === false ? ' · 🔒' : ''); }
    side.innerHTML = items.map(function (it, i) {
        return '<button type="button" class="pl-item" data-i="' + i + '"><span>' + ICON[it.kind] + '</span><span class="n">' + esc(it.name) + '</span><span class="k">' + kText(it) + '</span></button>';
    }).join('');
    side.addEventListener('click', function (e) { var b = e.target.closest('.pl-item'); if (b) select(Number(b.dataset.i)); });

    var hlsLoad = null;
    function loadHls() {
        if (window.Hls) return Promise.resolve();
        if (hlsLoad) return hlsLoad;
        hlsLoad = new Promise(function (ok, no) { var s = document.createElement('script'); s.src = P.hlsjs; s.onload = ok; s.onerror = function () { no(new Error('Không tải được hls.js')); }; document.head.appendChild(s); });
        return hlsLoad;
    }
    function showErr(box, msg) { box.style.display = 'block'; box.textContent = '⚠ ' + msg; }
    // hls.js trước (đoạn tải thẳng GitHub bằng XHR, không lệ thuộc Content-Type; iPhone iOS 17.1+ dùng ManagedMediaSource). Lỗi nặng/không hỗ trợ MSE → phát native của Safari bằng playlist master (vẫn tải thẳng GitHub).
    function masterUrl(u) { return u + (u.indexOf('?') < 0 ? '?' : '&') + 'master=1'; }          // playlist "master" có CODECS (Safari native cần để phát fMP4 H.265/AV1)
    function canNative(el) { return !!(el.canPlayType && el.canPlayType('application/vnd.apple.mpegurl')); }
    var CODEC_NAME = { av01: 'AV1', hvc1: 'H.265/HEVC', hev1: 'H.265/HEVC', vp09: 'VP9', avc1: 'H.264' };
    function codecOk(el, codecs) {          // thiết bị có giải mã được codec này không (MSE / MMS của iPhone / phát native)
        var t = 'video/mp4; codecs="' + codecs + '"';
        try { if (window.ManagedMediaSource && window.ManagedMediaSource.isTypeSupported(t)) return true; } catch (e) { /* */ }
        try { if (window.MediaSource && window.MediaSource.isTypeSupported(t)) return true; } catch (e) { /* */ }
        try { if (el.canPlayType && el.canPlayType(t)) return true; } catch (e) { /* */ }
        return false;
    }
    function codecMsg(codecs) {
        var v = String(codecs).split(',')[0], n = CODEC_NAME[v.split('.')[0]] || v;
        return 'Thiết bị/trình duyệt này không giải mã được video ' + n + ' (' + v + '). ' + (/^av01/.test(v) ? 'iPhone/Mac chỉ phát AV1 khi chip có giải mã phần cứng (iPhone 15 Pro trở lên, Mac M3 trở lên). ' : '') +
            'Hãy xem bằng Chrome/Edge/Firefox trên máy tính, hoặc tải về mở bằng VLC; muốn xem được trên mọi máy thì nén lại video bằng H.264 hoặc H.265 rồi tải lên lại.';
    }
    // Phát native (Safari): đoạn tải thẳng GitHub. Chờ tối đa 9s cho loadedmetadata/playing — iPhone khi không phát được thường KHÔNG báo lỗi mà quay mãi.
    function tryNative(el, url, last) {
        var done = false, t = 0;
        function clean() { clearTimeout(t); el.removeEventListener('error', bad); el.removeEventListener('loadedmetadata', ok); el.removeEventListener('playing', ok); }
        function ok() { if (done) return; done = true; clean(); }
        function bad() { if (done) return; done = true; clean(); last(); }
        el.addEventListener('error', bad); el.addEventListener('loadedmetadata', ok); el.addEventListener('playing', ok);
        t = setTimeout(bad, 9000);
        el.src = url;
        try { var p = el.play && el.play(); if (p && p.catch) p.catch(function () { }); } catch (e) { /* */ }
    }
    function playHls(el, it, box, codecs) {
        if (codecs && !codecOk(el, codecs)) return showErr(box, codecMsg(codecs));
        function native(why) { el.__nativeTried = true; return tryNative(el, masterUrl(it.url), function () { showErr(box, why + (codecs ? ' (codec ' + codecs.split(',')[0] + ')' : '')); }); }
        return loadHls().catch(function () { return null; }).then(function () {
            if (!window.Hls || !Hls.isSupported()) {
                if (canNative(el)) return native('Trình duyệt không phát được m3u8 của file này.');
                showErr(box, window.Hls ? 'Trình duyệt này không hỗ trợ phát m3u8 (MSE).' : 'Không tải được hls.js (kiểm tra mạng hoặc biến HLSJS_URL).');
                return;
            }
            if (hls) { hls.destroy(); hls = null; }
            var h = hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 20, maxBufferSize: 60 * 1000 * 1000 });     // xem đến đâu xả bộ đệm cũ đến đó (đỡ RAM)
            var retried = false;
            h.on(Hls.Events.ERROR, function (ev, d) {
                if (!d || !d.fatal) return;
                if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !retried) { retried = true; try { h.recoverMediaError(); return; } catch (e) { /* */ } }     // vd bufferAppendError: thử cứu 1 lần
                var msg = 'Lỗi phát m3u8: ' + (d.details || d.type);
                if (canNative(el) && !el.__nativeTried) { h.destroy(); if (hls === h) hls = null; return native(msg); }
                showErr(box, /Codec|codec|bufferAddCodec|manifestIncompatible/.test(d.details || '') ? 'Trình duyệt/thiết bị này không giải mã được codec video của file (H.265/AV1/VP9 cần trình duyệt hoặc phần cứng hỗ trợ). Hãy thử Chrome/Edge/Safari mới, hoặc tải về để mở bằng phần mềm khác.' : msg);
            });
            h.loadSource(it.url); h.attachMedia(el);
            el.play && el.play().catch(function () { });
        });
    }
    // phần tử phát lỗi: hỏi máy chủ nguyên nhân; nếu là playlist m3u8 thì gắn hls.js, nếu là lỗi giải mã/không thấy thì báo rõ
    function diagnose(el, it, box) {
        fetch(it.url, { headers: { Range: 'bytes=0-0' } }).then(function (r) {
            var ct = r.headers.get('content-type') || '';
            if (r.ok && /mpegurl/i.test(ct)) {
                // Ưu tiên hls.js (Chrome/Edge mới trả canPlayType = 'maybe' nhưng phát native m3u8 mã hoá AES-128 / fMP4 thì lỗi);
                // chỉ dùng phát native khi hls.js không hỗ trợ (vd Safari iOS).
                return playHls(el, it, box);
            }
            if (r.ok) { showErr(box, 'Trình duyệt không phát được định dạng này — hãy tải về để mở bằng phần mềm khác.'); return; }
            return r.json().then(function (j) { return j; }, function () { return {}; }).then(function (j) { showErr(box, (j && j.error) || ('Lỗi ' + r.status)); });
        }, function () { showErr(box, 'Không kết nối được máy chủ.'); });
    }

    function select(i) {
        if (i < 0 || i >= items.length) return;
        cur = i; var it = items[i];
        if (hls) { hls.destroy(); hls = null; }
        if (curBlob) { MnhaMedia.revoke(curBlob); curBlob = null; }
        Array.prototype.forEach.call(side.querySelectorAll('.pl-item'), function (b) { b.classList.toggle('on', Number(b.dataset.i) === i); });
        var on = side.querySelector('.pl-item.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
        stage.innerHTML = '';
        var title = document.createElement('div'); title.className = 'pl-title'; title.textContent = it.name; stage.appendChild(title);
        var box = document.createElement('div'); box.className = 'pl-err';
        if (it.pending) { showErr(box, 'File này đang tải lên dở dang — vào trang quản lý, chọn lại đúng file để làm tiếp.'); stage.appendChild(box); }
        else {
            var el;
            if (it.kind === 'image') { el = document.createElement('img'); el.alt = it.name; }
            else if (it.kind === 'audio') {
                var art = document.createElement('div'); art.className = 'pl-art'; art.textContent = '🎵'; stage.appendChild(art);
                el = document.createElement('audio'); el.controls = true; el.autoplay = true;
            } else { el = document.createElement('video'); el.controls = true; el.autoplay = true; el.playsInline = true; }
            el.addEventListener('error', function () { if (el.__diag === it.url) return; el.__diag = it.url; diagnose(el, it, box); });
            if (it.kind !== 'image') el.addEventListener('ended', function () { if (auto && cur < items.length - 1) select(cur + 1); });
            stage.appendChild(el); stage.appendChild(box);
            if (!direct) el.src = it.url;
            else {
                var mine = i;
                MnhaMedia.open(it.url, it.name).then(function (r) {
                    if (cur !== mine) { if (r.type === 'blob') MnhaMedia.revoke(r.url); return; }
                    if (r.type === 'blob') { curBlob = r.url; el.src = r.url; }
                    else playHls(el, it, box, r.codecs);          // m3u8: hls.js tải đoạn thẳng từ GitHub, tự giải mã AES-128 bằng khoá lấy từ máy chủ
                }, function (err) {
                    if (cur !== mine) return;
                    if (err && (err.status === 403 || err.status === 429)) return showErr(box, err.message);
                    el.src = it.url;                    // đường dự phòng: máy chủ giải mã như trước
                });
            }
        }
        var ctl = document.createElement('div'); ctl.className = 'pl-ctl';
        ctl.innerHTML = '<button type="button" class="hx-btn" id="plPrev">⏮ Trước</button><button type="button" class="hx-btn" id="plNext">Sau ⏭</button>' +
            '<a class="hx-btn hx-btn-green" href="' + esc(it.dl) + '" download>⬇ Tải về (' + esc(it.name) + ')</a>' +
            (P.own && !it.pending ? '<button type="button" class="hx-btn" id="plPub"></button>' : '') +
            (it.kind !== 'image' ? '<label class="text-sm text-slate-300 inline-flex items-center gap-1"><input type="checkbox" id="plAuto"' + (auto ? ' checked' : '') + '> Tự phát tiếp</label>' : '');
        stage.appendChild(ctl);
        document.getElementById('plPrev').onclick = function () { select(cur - 1); };
        document.getElementById('plNext').onclick = function () { select(cur + 1); };
        document.getElementById('plPrev').disabled = cur === 0; document.getElementById('plNext').disabled = cur === items.length - 1;
        var pb = document.getElementById('plPub');
        if (pb) {
            var paint = function () { pb.textContent = it.pub === false ? '🔒 Đang riêng tư — bấm để công khai' : '🌐 Đang công khai — bấm để tắt'; pb.title = it.pub === false ? 'Ẩn khỏi danh sách và trình phát khi xem thư mục trên mạng; nhúng vào trang HTML vẫn dùng được' : 'Hiện trong danh sách và trình phát khi xem thư mục trên mạng'; };
            paint();
            pb.onclick = function () {
                var want = it.pub === false;       // true = bật công khai
                if (!want && !confirm('Tắt công khai "' + it.name + '"?\nFile sẽ không hiện trong danh sách/trình phát khi xem thư mục trên mạng (nhúng vào HTML vẫn dùng được)' + (it.kind === 'image' ? ' và ảnh chưa mã hoá sẽ được mã hoá' : '') + '.')) return;
                pb.disabled = true;
                fetch(P.visUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ dir: P.dir, name: it.name, public: want }) })
                    .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }, function () { return { r: r, j: {} }; }); })
                    .then(function (o) {
                        if (!o.r.ok) throw new Error(o.j.error || ('Lỗi ' + o.r.status));
                        it.pub = o.j.public !== false; paint(); pb.disabled = false;
                        var sb = side.querySelector('.pl-item[data-i="' + i + '"] .k'); if (sb) sb.textContent = kText(it);
                    })
                    .catch(function (e) { alert(e.message); pb.disabled = false; });
            };
        }
        var a = document.getElementById('plAuto'); if (a) a.onchange = function () { auto = a.checked; };
        if (it.kind !== 'image' && (it.cut || false)) { var note = document.createElement('div'); note.className = 'text-xs text-slate-500'; note.textContent = 'File lớn: phát theo m3u8 (đã cắt & mã hoá). Tải về sẽ là luồng MPEG-TS đã giải mã, giữ đuôi gốc.'; stage.appendChild(note); }
    }
    document.addEventListener('keydown', function (e) {
        if (/INPUT|TEXTAREA/.test((e.target.tagName || ''))) return;
        if (e.key === 'ArrowLeft' && items[cur] && items[cur].kind === 'image') select(cur - 1);
        if (e.key === 'ArrowRight' && items[cur] && items[cur].kind === 'image') select(cur + 1);
    });
    var start = items.findIndex(function (x) { return x.name === P.start; });
    select(start >= 0 ? start : 0);
    if (window.lucide) lucide.createIcons();
})();
