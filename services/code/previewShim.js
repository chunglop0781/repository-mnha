// services/code/previewShim.js — đoạn <script> được chèn vào ĐẦU mọi trang HTML phục vụ qua /preview (chạy trong iframe sandbox, origin "null").
// Nhiệm vụ:
//   1) báo chiều cao nội dung cho trang cha → iframe giãn hết cỡ, người dùng kéo cả trang rồi mới tới thanh link GitHub/GitLab ở dưới;
//   2) báo lỗi tài nguyên (ảnh/css/js/media: không tìm thấy, KHÔNG GIẢI MÃ ĐƯỢC...) và lỗi JavaScript lên trang cha để hiện cảnh báo;
//   3) <audio>/<video> khai báo đuôi gốc (mp4, mp3...) mà máy chủ trả playlist m3u8 (file lớn đã cắt) → tự gắn hls.js (tải khi cần);
//   4) nút "⬇ Tải" hiện khi rê chuột/chạm vào ảnh, âm thanh, video của trang (tải về đúng đuôi lúc tải lên; media đã cắt thì giải mã ghép thành mpegts);
//   5) link ra ngoài (không phải file của trang) mở ở tab mới thay vì thay cả khung xem.
// Không dùng cú pháp mới để chạy được trên trình duyệt cũ.
'use strict';

const SOURCE = function (BASE, HLS) {
    var seen = {};
    function post(m) { try { m.mnha = 1; parent.postMessage(m, '*'); } catch (e) { /* */ } }
    function ours(u) { try { return new URL(u, location.href).pathname.indexOf(BASE) === 0; } catch (e) { return false; } }
    function once(key, fn) { if (seen[key]) return; seen[key] = 1; fn(); }
    function problem(url, message, status) { once('p|' + url + '|' + message, function () { post({ type: 'error', url: String(url || ''), message: message, status: status || 0 }); }); }

    // ---- 1) chiều cao
    var lastH = 0, raf = 0;
    function height() {
        var de = document.documentElement, b = document.body;
        var h = de.offsetHeight;
        if (de.scrollHeight > h && de.scrollHeight > window.innerHeight) h = de.scrollHeight;
        if (b && b.scrollHeight > h && b.scrollHeight > window.innerHeight) h = b.scrollHeight;
        h = Math.ceil(h);
        if (Math.abs(h - lastH) > 1) { lastH = h; post({ type: 'height', h: h }); }
    }
    function schedule() { if (raf) return; raf = (window.requestAnimationFrame || setTimeout)(function () { raf = 0; height(); }); }
    window.addEventListener('load', function () { schedule(); setTimeout(schedule, 300); setTimeout(schedule, 1500); });
    window.addEventListener('resize', schedule);
    document.addEventListener('DOMContentLoaded', function () {
        schedule();
        try { if (window.ResizeObserver) { var ro = new ResizeObserver(schedule); ro.observe(document.documentElement); if (document.body) ro.observe(document.body); } } catch (e) { /* */ }
        try { new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); } catch (e) { /* */ }
    });
    document.addEventListener('load', schedule, true);        // ảnh/video nạp xong làm đổi kích thước

    // ---- 2) lỗi tài nguyên
    function explain(url, fallback) {
        if (!ours(url)) { problem(url, fallback || 'Không tải được tài nguyên bên ngoài (sai link hoặc bị chặn).'); return; }
        fetch(url, { headers: { Range: 'bytes=0-0' } }).then(function (r) {
            if (r.ok) return;
            return r.json().then(function (j) { return j; }, function () { return {}; }).then(function (j) { problem(url, (j && j.error) || ('Lỗi ' + r.status), r.status); });
        }, function () { problem(url, 'Không tải được: ' + url); });
    }
    // ---- 3) media: đuôi gốc → m3u8
    var hlsLoad = null;
    function loadHls() {
        if (window.Hls) return Promise.resolve();
        if (hlsLoad) return hlsLoad;
        hlsLoad = new Promise(function (ok, no) {
            var s = document.createElement('script'); s.src = HLS; s.onload = ok;
            s.onerror = function () { no(new Error('Không tải được hls.js (' + HLS + ')')); };
            document.head.appendChild(s);
        });
        return hlsLoad;
    }
    function attachHls(el, url) {
        el.__mnhaSrc = url;
        loadHls().then(function () {
            if (el.__hls) { try { el.__hls.destroy(); } catch (e) { /* */ } el.__hls = null; }
            if (window.Hls && window.Hls.isSupported()) {
                var h = new window.Hls();
                h.on(window.Hls.Events.ERROR, function (ev, d) { if (d && d.fatal) problem(url, 'Không phát được (HLS): ' + (d.details || d.type)); });
                h.loadSource(url); h.attachMedia(el); el.__hls = h;
            } else if (el.canPlayType && el.canPlayType('application/vnd.apple.mpegurl')) { el.src = url; }
            else problem(url, 'Trình duyệt này không phát được HLS (m3u8).');
        }, function (e) { problem(url, e.message); });
    }
    function mediaError(el, url) {
        var u = url || el.currentSrc || el.src;
        if (!u || el.__mnhaFor === u) return;
        el.__mnhaFor = u;
        if (!ours(u)) { problem(u, 'Không phát được media bên ngoài (sai link hoặc định dạng không hỗ trợ).'); return; }
        fetch(u, { headers: { Range: 'bytes=0-0' } }).then(function (r) {
            if (!r.ok) return r.json().then(function (j) { return j; }, function () { return {}; }).then(function (j) { problem(u, (j && j.error) || ('Lỗi ' + r.status), r.status); });
            if (/mpegurl/i.test(r.headers.get('content-type') || '')) return attachHls(el, u);
            problem(u, 'Trình duyệt không phát được định dạng/codec này: ' + u);
        }, function () { problem(u, 'Không tải được: ' + u); });
    }
    document.addEventListener('error', function (e) {
        var t = e.target; if (!t || !t.tagName) return;
        var tag = t.tagName;
        if (tag === 'VIDEO' || tag === 'AUDIO') return mediaError(t);
        if (tag === 'SOURCE') { var p = t.parentNode; if (p && (p.tagName === 'VIDEO' || p.tagName === 'AUDIO')) return mediaError(p, t.src); if (p && p.tagName === 'PICTURE') return explain(t.src); return; }
        if (tag === 'IMG') return explain(t.currentSrc || t.src);
        if (tag === 'SCRIPT') return explain(t.src);
        if (tag === 'LINK') return explain(t.href);
    }, true);
    // media tạo bằng JavaScript (new Audio(...), createElement('video')) chưa nằm trong trang nên không nhận được sự kiện lỗi ở document
    try {
        var OA = window.Audio;
        if (OA) {
            var NA = function (src) { var a = new OA(); a.addEventListener('error', function () { mediaError(a); }); if (src !== undefined) a.src = src; return a; };
            NA.prototype = OA.prototype; window.Audio = NA;
        }
        var ce = document.createElement;
        document.createElement = function (tag) {
            var el = ce.apply(document, arguments), t = String(tag).toLowerCase();
            if (t === 'audio' || t === 'video') el.addEventListener('error', function () { mediaError(el); });
            return el;
        };
    } catch (e) { /* */ }

    // ---- 4) nút Tải
    var dlBtn = null, dlHide = 0;
    function mediaSrc(el) {
        var u = el.__mnhaSrc || el.getAttribute('src');
        if (!u) { var s = el.querySelector && el.querySelector('source[src]'); u = s && s.getAttribute('src'); }
        if (!u) u = el.currentSrc;
        try { u = new URL(u, location.href).href; } catch (e) { return ''; }
        return ours(u) ? u : '';
    }
    function hideSoon() { clearTimeout(dlHide); dlHide = setTimeout(function () { if (dlBtn) dlBtn.style.display = 'none'; }, 900); }
    function showDl(el) {
        var u = mediaSrc(el); if (!u) return;
        if (!dlBtn) {
            dlBtn = document.createElement('a'); dlBtn.setAttribute('data-mnha-dl', '1'); dlBtn.textContent = '\u2b07 T\u1ea3i';
            dlBtn.style.cssText = 'position:absolute;z-index:2147483647;display:none;background:rgba(15,23,42,.88);color:#fff;font:600 12px/1 system-ui,sans-serif;padding:7px 11px;border-radius:6px;text-decoration:none;box-shadow:0 1px 5px rgba(0,0,0,.45);cursor:pointer;margin:0';
            dlBtn.addEventListener('mouseenter', function () { clearTimeout(dlHide); });
            dlBtn.addEventListener('mouseleave', hideSoon);
            (document.body || document.documentElement).appendChild(dlBtn);
        }
        clearTimeout(dlHide);
        var base = u.split('#')[0]; dlBtn.href = base + (base.indexOf('?') < 0 ? '?' : '&') + 'dl=1'; dlBtn.setAttribute('download', '');
        dlBtn.style.display = 'block';
        var r = el.getBoundingClientRect(), x = (window.pageXOffset || 0) + r.right - dlBtn.offsetWidth - 6, y = (window.pageYOffset || 0) + r.top + 6;
        dlBtn.style.left = Math.max(0, x) + 'px'; dlBtn.style.top = Math.max(0, y) + 'px';
    }
    function mediaOf(t) { while (t && t.nodeType === 1) { var g = t.tagName; if (g === 'IMG' || g === 'VIDEO' || g === 'AUDIO') return t; t = t.parentNode; if (t === document.body) break; } return null; }
    document.addEventListener('mouseover', function (e) { var m = mediaOf(e.target); if (m) showDl(m); }, true);
    document.addEventListener('mouseout', function (e) { if (mediaOf(e.target)) hideSoon(); }, true);
    document.addEventListener('touchstart', function (e) { var m = mediaOf(e.target); if (m) { showDl(m); hideSoon(); } }, true);

    // ---- 5) link ra ngoài mở tab mới
    document.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a || a.target || a.hasAttribute('download') || a.getAttribute('data-mnha-dl')) return;
        var h = a.getAttribute('href');
        if (!h || h.charAt(0) === '#' || /^(javascript|mailto|tel|blob|data):/i.test(h)) return;
        if (!ours(a.href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }, true);

    window.addEventListener('error', function (e) {
        if (e && e.target && e.target !== window) return;       // lỗi tài nguyên đã xử lý ở trên
        once('js|' + e.message + e.lineno, function () { post({ type: 'js', message: String(e.message || 'Lỗi JavaScript'), line: e.lineno || 0, col: e.colno || 0 }); });
    });
    window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason; once('rej|' + String(r), function () { post({ type: 'js', message: 'Promise bị từ chối: ' + (r && r.message ? r.message : String(r)) }); });
    });
};

/** Chuỗi <script>…</script> đã nhúng BASE (đường dẫn gốc của token, vd "/preview/abc/") và địa chỉ hls.js. */
function build(base, hlsUrl) {
    return '<script>(' + SOURCE.toString() + ')(' + JSON.stringify(String(base)).replace(/</g, '\\u003c') + ',' + JSON.stringify(String(hlsUrl)).replace(/</g, '\\u003c') + ');</script>';
}
module.exports = { build };
