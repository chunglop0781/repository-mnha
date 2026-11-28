// public/js/onlineDownload.js — trang "Đọc thư mục trên mạng" (cpp / emu8086): nút TẢI TẤT CẢ file về (zip, gồm cả thư mục con), mỗi file có nút "Tải" riêng (link thường)
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
    function fetchUrl(href, name, dirRel) {
        return fetch(href).then(function (r) {
            if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
            return r.arrayBuffer();
        }).then(function (b) { return { dir: dirRel || '', name: name, data: new Uint8Array(b) }; });
    }
    function getTree() {      // cả cây thư mục trên mạng (gồm thư mục con); lỗi/không có thư mục con → dùng các file đang hiện
        var here = links.map(function (a) { return { dir: '', name: a.dataset.dlFile, href: a.getAttribute('href') }; });
        if (!root.dataset.url || !root.querySelector('a[data-dir-link]')) return Promise.resolve({ files: here, truncated: false, failed: [] });
        var base = '/code/' + root.dataset.lang;
        return fetch(base + '/online/tree?url=' + encodeURIComponent(root.dataset.url), { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
            .then(function (t) {
                return { truncated: !!t.truncated, failed: t.failed || [], files: (t.files || []).map(function (x) { return { dir: x.dir, name: x.name, href: base + '/online/download?url=' + encodeURIComponent(x.web) }; }) };
            });
    }
    btn.onclick = function () {
        btn.disabled = true; say('Đang quét thư mục con...');
        getTree().then(function (t) {
            var list = t.files;
            if (!list.length) return say('Thư mục này không có file nào để tải.', 'err');
            var i = 0, done = 0, got = [], failed = (t.failed || []).slice();
            say('Đang tải 0/' + list.length + ' file...');
            function worker() {
                if (i >= list.length) return Promise.resolve();
                var it = list[i++], label = (it.dir ? it.dir + '/' : '') + it.name;
                return fetchUrl(it.href, it.name, it.dir).then(function (e) { got.push(e); }, function (er) { failed.push(label + ' — ' + er.message); })
                    .then(function () { say('Đang tải ' + (++done) + '/' + list.length + ' file...'); return worker(); });
            }
            return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
                if (!got.length) return say('Không tải được file nào:\n' + failed.join('\n'), 'err');
                var seen = {}; got.sort(function (a, b) { var x = a.dir + '/' + a.name, y = b.dir + '/' + b.name; return x < y ? -1 : x > y ? 1 : 0; });
                got = got.filter(function (e) { var k = e.dir + '/' + e.name; if (seen[k]) return false; seen[k] = 1; return true; });      // trùng đường dẫn (khác repo) → giữ 1 bản
                var last = (root.dataset.dir || '').split('/').pop().replace(/\s*@.*$/, '').replace(/[^\w.()\-]+/g, '_') || root.dataset.lang;
                var nested = got.some(function (e) { return e.dir; });
                if (got.length === 1 && !nested) window.MnhaZip.save(new Blob([got[0].data], { type: 'text/plain' }), got[0].name);
                else {
                    var top = nested ? last + '/' : '', entries = nested ? [{ name: top, data: new Uint8Array(0) }] : [];
                    got.forEach(function (e) { entries.push({ name: top + (e.dir ? e.dir + '/' : '') + e.name, data: e.data }); });
                    window.MnhaZip.save(window.MnhaZip.zip(entries), last + '.zip');
                }
                say('Đã tải về ' + got.length + ' file' + (nested ? ' cùng thư mục con' : '') + (got.length > 1 || nested ? ' (' + last + '.zip)' : '') + '.'
                    + (t.truncated ? '\n(Thư mục rất lớn hoặc GitHub giới hạn — chỉ quét được một phần.)' : '')
                    + (failed.length ? '\nKhông tải được ' + failed.length + ' mục:\n' + failed.join('\n') : ''), failed.length || t.truncated ? 'info' : 'ok');
            });
        }).catch(function (e) { say('Lỗi: ' + e.message, 'err'); }).then(function () { btn.disabled = false; });
    };
})();
