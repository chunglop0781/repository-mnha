// public/js/filePublicFolder.js — trang xem THƯ MỤC công khai (/f/d): nút "Tải tất cả file (.zip)".
// Mỗi file: xin khoá ở /f/key → trình duyệt tự tải bản mã từ GitHub raw và giải mã → gói .zip ngay ở trình duyệt (không qua máy chủ).
(function () {
    'use strict';
    var b = document.body, btn = document.getElementById('btnZipAll'), msg = document.getElementById('zmsg');
    if (!btn) return;
    function say(t, err) { msg.textContent = t; msg.className = err ? 'err' : ''; }
    function sub(rel) { return rel ? (b.dataset.d ? b.dataset.d + '/' + rel : rel) : b.dataset.d; }
    btn.onclick = function () {
        if (!window.MnhaFiles || !window.MnhaFiles.supported() || !window.MnhaZip) { say('Trình duyệt không hỗ trợ giải mã (cần https:// hoặc localhost).', true); return; }
        btn.disabled = true; say('Đang quét thư mục con…');
        // cả cây file công khai (gồm thư mục con, kể cả khi thư mục này không có file trực tiếp)
        fetch('/f/tree?' + new URLSearchParams({ u: b.dataset.u, d: b.dataset.d }).toString(), { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Lỗi ' + r.status)); return j; }); })
            .then(function (t) {
                if (!t.files.length) throw new Error('Thư mục này chưa có file nào công khai.');
                return window.MnhaFiles.zipAll(t.files, function (it) {
                    var q = new URLSearchParams({ u: b.dataset.u, d: sub(it.dir), n: it.name }).toString();
                    return fetch('/f/key?' + q, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
                        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Lỗi ' + r.status)); return j; });
                    });
                }, { root: b.dataset.zip || 'thu-muc', onFile: function (i, n, nm) { say('Đang tải & giải mã ' + (i + 1) + '/' + n + ': ' + nm); } }).then(function (r) { return { r: r, t: t }; });
            })
            .then(function (x) {
                var r = x.r;
                window.MnhaZip.save(r.blob, (b.dataset.zip || 'thu-muc') + '.zip');
                say(r.failed.length ? 'Đã gói ' + r.count + ' file; ' + r.failed.length + ' file lỗi (' + r.failed[0].name + ': ' + r.failed[0].error + ').' : 'Xong — đã gói ' + r.count + ' file cùng thư mục con.', r.failed.length > 0);
            })
            .catch(function (e) { say(e.message, true); })
            .then(function () { btn.disabled = false; });
    };
})();
