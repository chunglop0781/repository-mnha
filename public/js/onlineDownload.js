// public/js/onlineDownload.js — trang "Đọc thư mục trên mạng" (cpp / emu8086): nút TẢI TẤT CẢ file đang hiện về (zip), mỗi file có nút "Tải" riêng (link thường)
(function () {
    'use strict';
    var root = document.getElementById('onlineFolder'), btn = document.getElementById('btnDownloadAll');
    if (!root || !btn || !window.MnhaZip) return;
    var links = Array.prototype.slice.call(root.querySelectorAll('a[data-dl-file]'));
    var msg = document.createElement('div'); msg.className = 'mt-3 hidden text-sm rounded-xl border px-4 py-3 whitespace-pre-line';
    var row = btn.parentNode; row.parentNode.insertBefore(msg, row.nextSibling);
    function say(t, kind) {
        msg.className = 'mt-3 text-sm rounded-xl border px-4 py-3 whitespace-pre-line ' + (kind === 'err' ? 'border-red-300 bg-red-50 text-red-800' : kind === 'ok' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-indigo-200 bg-indigo-50 text-indigo-800');
        msg.textContent = t;
    }
    function fetchOne(a) {
        return fetch(a.getAttribute('href')).then(function (r) {
            if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
            return r.arrayBuffer();
        }).then(function (b) { return { name: a.dataset.dlFile, data: new Uint8Array(b) }; });
    }
    btn.onclick = function () {
        if (!links.length) return say('Thư mục này không có file nào để tải.', 'err');
        btn.disabled = true; var i = 0, done = 0, got = [], failed = [];
        say('Đang tải 0/' + links.length + ' file...');
        function worker() {
            if (i >= links.length) return Promise.resolve();
            var a = links[i++];
            return fetchOne(a).then(function (e) { got.push(e); }, function (er) { failed.push(a.dataset.dlFile + ' — ' + er.message); })
                .then(function () { say('Đang tải ' + (++done) + '/' + links.length + ' file...'); return worker(); });
        }
        Promise.all([worker(), worker(), worker(), worker()]).then(function () {
            if (!got.length) return say('Không tải được file nào:\n' + failed.join('\n'), 'err');
            var seen = {}; got.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
            got = got.filter(function (e) { if (seen[e.name]) return false; seen[e.name] = 1; return true; });      // trùng tên (khác repo) → giữ 1 bản
            var last = (root.dataset.dir || '').split('/').pop().replace(/\s*@.*$/, '').replace(/[^\w.()\-]+/g, '_') || root.dataset.lang;
            if (got.length === 1) window.MnhaZip.save(new Blob([got[0].data], { type: 'text/plain' }), got[0].name);
            else window.MnhaZip.save(window.MnhaZip.zip(got), last + '.zip');
            say('Đã tải về ' + got.length + ' file' + (got.length > 1 ? ' (' + last + '.zip)' : '') + '.' + (failed.length ? '\nKhông tải được ' + failed.length + ' file:\n' + failed.join('\n') : ''), failed.length ? 'info' : 'ok');
        }).catch(function (e) { say('Lỗi: ' + e.message, 'err'); }).then(function () { btn.disabled = false; });
    };
})();
