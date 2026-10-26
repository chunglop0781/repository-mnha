// public/js/connectBadge.js — hiện "Web kết nối: <tên>" ở thanh trên mọi trang + MnhaConnect.get() cho nơi khác (vd nút Tải).
//   localhost → "localhost" (tự kết nối dữ liệu với localhost) · web chính → web dữ liệu đang dùng · web dữ liệu → chính nó.
(function () {
    'use strict';
    var cache = null;
    function get() {
        if (!cache) cache = fetch('/api/connect-info', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        return cache;
    }
    function label(i) { return i && i.name ? (i.id && i.id !== i.name ? i.name + ' (' + i.id + ')' : i.name) : ''; }
    function show(i) {
        var b = document.getElementById('connBadge'); if (!b || !i) return;
        b.classList.remove('hidden', 'bg-gray-100', 'text-gray-600', 'bg-green-50', 'text-green-700', 'bg-red-50', 'text-red-700');
        if (i.ok) { b.textContent = 'Web kết nối: ' + label(i); b.classList.add('bg-green-50', 'text-green-700'); if (i.url) b.title = i.url; }
        else { b.textContent = 'Web kết nối: chưa có web nào hoạt động'; b.classList.add('bg-red-50', 'text-red-700'); b.title = i.error || ''; }
        b.classList.add('sm:inline');
    }
    window.MnhaConnect = { get: get, label: label };
    get().then(show);
})();
