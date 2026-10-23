// public/js/mediaPlayer.js — trình phát ảnh / âm thanh / video của 1 thư mục (file của tôi hoặc trên mạng).
// Địa chỉ file là /preview/<token>/...: máy chủ tự giải mã (ảnh/âm thanh/video mã hoá), media đã cắt m3u8 thì trả playlist → hls.js.
(function () {
    'use strict';
    var P = JSON.parse(document.getElementById('payload').textContent);
    var items = P.items || [], stage = document.getElementById('plStage'), side = document.getElementById('plSide');
    var cur = -1, hls = null, auto = true;
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    var ICON = { image: '🖼️', audio: '🎵', video: '🎬' }, LABEL = { image: 'ảnh', audio: 'âm thanh', video: 'video' };

    if (!items.length) { stage.innerHTML = '<div class="pl-empty">Thư mục này chưa có ảnh, âm thanh hoặc video.</div>'; side.style.display = 'none'; return; }

    side.innerHTML = items.map(function (it, i) {
        return '<button type="button" class="pl-item" data-i="' + i + '"><span>' + ICON[it.kind] + '</span><span class="n">' + esc(it.name) + '</span><span class="k">' + LABEL[it.kind] + (it.cut ? ' · m3u8' : '') + '</span></button>';
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
    // phần tử phát lỗi: hỏi máy chủ nguyên nhân; nếu là playlist m3u8 thì gắn hls.js, nếu là lỗi giải mã/không thấy thì báo rõ
    function diagnose(el, it, box) {
        fetch(it.url, { headers: { Range: 'bytes=0-0' } }).then(function (r) {
            var ct = r.headers.get('content-type') || '';
            if (r.ok && /mpegurl/i.test(ct)) {
                if (el.canPlayType('application/vnd.apple.mpegurl')) { showErr(box, 'Trình duyệt không phát được m3u8 này.'); return; }
                return loadHls().then(function () {
                    if (!window.Hls || !Hls.isSupported()) { showErr(box, 'Trình duyệt này không hỗ trợ phát m3u8 (MSE).'); return; }
                    if (hls) { hls.destroy(); hls = null; }
                    hls = new Hls({ maxBufferLength: 30 });
                    hls.on(Hls.Events.ERROR, function (ev, d) {
                        if (!d || !d.fatal) return;
                        var codecErr = /Codec|codec|bufferAddCodec|manifestIncompatible/.test(d.details || '') || (d.type === Hls.ErrorTypes.MEDIA_ERROR && /codec|MIME|type/i.test((d.error && d.error.message) || ''));
                        showErr(box, codecErr ? 'Trình duyệt/thiết bị này không giải mã được codec video của file (H.265/AV1/VP9 cần trình duyệt hoặc phần cứng hỗ trợ). Hãy thử Chrome/Edge/Safari mới, hoặc tải về để mở bằng phần mềm khác.' : 'Lỗi phát m3u8: ' + (d.details || d.type));
                    });
                    hls.loadSource(it.url); hls.attachMedia(el);
                    el.play && el.play().catch(function () { });
                });
            }
            if (r.ok) { showErr(box, 'Trình duyệt không phát được định dạng này — hãy tải về để mở bằng phần mềm khác.'); return; }
            return r.json().then(function (j) { return j; }, function () { return {}; }).then(function (j) { showErr(box, (j && j.error) || ('Lỗi ' + r.status)); });
        }, function () { showErr(box, 'Không kết nối được máy chủ.'); });
    }

    function select(i) {
        if (i < 0 || i >= items.length) return;
        cur = i; var it = items[i];
        if (hls) { hls.destroy(); hls = null; }
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
            el.src = it.url; stage.appendChild(el); stage.appendChild(box);
        }
        var ctl = document.createElement('div'); ctl.className = 'pl-ctl';
        ctl.innerHTML = '<button type="button" class="hx-btn" id="plPrev">⏮ Trước</button><button type="button" class="hx-btn" id="plNext">Sau ⏭</button>' +
            '<a class="hx-btn hx-btn-green" href="' + esc(it.dl) + '" download>⬇ Tải về (' + esc(it.name) + ')</a>' +
            (it.kind !== 'image' ? '<label class="text-sm text-slate-300 inline-flex items-center gap-1"><input type="checkbox" id="plAuto"' + (auto ? ' checked' : '') + '> Tự phát tiếp</label>' : '');
        stage.appendChild(ctl);
        document.getElementById('plPrev').onclick = function () { select(cur - 1); };
        document.getElementById('plNext').onclick = function () { select(cur + 1); };
        document.getElementById('plPrev').disabled = cur === 0; document.getElementById('plNext').disabled = cur === items.length - 1;
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
