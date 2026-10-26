// public/js/folderTools.js — trang thư mục code (mọi dạng, kể cả html): nút "Đổi tên" thư mục + sao chép link GitHub của thư mục
(function () {
    'use strict';
    var root = document.getElementById('codeFiles') || document.getElementById('htmlFiles') || document.getElementById('wordFiles'); if (!root) return;
    var lang = root.dataset.lang || 'html', dir = root.dataset.dir || '';
    function post(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lỗi'); return j; }); });
    }
    document.querySelectorAll('[data-rename]').forEach(function (b) {
        b.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            var path = b.dataset.rename, old = path.split('/').pop();
            var n = prompt('Đổi tên thư mục "' + old + '" thành (chữ, số, - _ và dấu ngoặc ( )):', old);
            if (n === null) return; n = n.trim(); if (!n || n === old) return;
            b.disabled = true; var t = b.textContent; b.textContent = 'Đang đổi...';
            post('/code/' + lang + '/rename-folder', { dir: path, name: n }).then(function (j) {
                if (path === dir) location.href = '/code/' + lang + '?dir=' + encodeURIComponent(j.dir); else location.reload();
            }).catch(function (er) { alert(er.message); b.disabled = false; b.textContent = t; });
        });
    });
    document.querySelectorAll('[data-rename-file]').forEach(function (b) {
        b.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            var old = b.dataset.renameFile;
            var n = prompt('Đổi tên file "' + old + '" thành (không gõ đuôi thì giữ đuôi cũ):', old);
            if (n === null) return; n = n.trim(); if (!n || n === old) return;
            b.disabled = true; var t = b.textContent; b.textContent = 'Đang đổi...';
            post('/code/' + lang + '/rename-file', { dir: dir, file: old, name: n }).then(function () { location.reload(); })
                .catch(function (er) { alert(er.message); b.disabled = false; b.textContent = t; });
        });
    });
    var cp = document.getElementById('btnCopyFolderLink'), a = document.getElementById('ghFolderLink');
    if (cp && a) cp.addEventListener('click', function () {
        function done(ok) { cp.textContent = ok ? 'Đã sao chép ✓' : 'Chọn & copy thủ công'; setTimeout(function () { cp.textContent = 'Sao chép'; }, 1800); }
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(a.href).then(function () { done(true); }, function () { done(false); });
        else { var t = document.createElement('textarea'); t.value = a.href; document.body.appendChild(t); t.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { } document.body.removeChild(t); done(ok); }
    });
})();
