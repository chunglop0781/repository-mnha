// public/js/wordFiles.js — trang thư mục Word: tạo/xoá tài liệu, công khai/riêng tư, tải .docx theo từng phần
(function () {
    'use strict';
    var root = document.getElementById('wordFiles'); if (!root) return;
    var P = JSON.parse(document.getElementById('payload').textContent), dir = P.dir || '', L = P.limits || {};
    var base = '/code/word';
    function post(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Lỗi ' + r.status)); return j; }); });
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function extOf(n) { var i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; }
    function mb(n) { return Math.round(n / 1048576) + 'MB'; }
    function safeName(n) {
        var s = String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
        s = s.replace(/\.docx$/i, '').replace(/[^A-Za-z0-9_\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
        return (s || 'tai-lieu') + '.docx';
    }
    function hexId() {
        var a = new Uint8Array(16);
        if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
        else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
        return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }
    function copy(text, btn) {
        function done(ok) {
            if (!btn) return;
            var t = btn.textContent; btn.textContent = ok ? 'Đã sao chép ✓' : 'Chọn & copy thủ công';
            setTimeout(function () { btn.textContent = t; }, 1800);
        }
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        else {
            var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
            var ok = false; try { ok = document.execCommand('copy'); } catch (e) { }
            document.body.removeChild(t); done(ok);
        }
    }
    function absolute(path) { return path && path.charAt(0) === '/' ? location.origin + path : path; }

    var btnNew = document.getElementById('btnNewDoc');
    if (btnNew) btnNew.onclick = function () {
        var n = prompt('Tên tài liệu (không cần gõ .docx)\nVí dụ: Bai giang tin hoc', 'Tài liệu mới');
        if (n === null) return;
        n = n.trim(); if (!n) return;
        if (!/\.[A-Za-z0-9]+$/.test(n)) n += '.docx';
        if (extOf(n) !== 'docx') { alert('Chỉ tạo được tài liệu .docx.'); return; }
        n = safeName(n);
        btnNew.disabled = true;
        post(P.urls.create, { dir: dir, name: n }).then(function (j) {
            location.href = base + '/edit?dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(j.file || j.name || n);
        }).catch(function (e) { alert(e.message); btnNew.disabled = false; });
    };
    var btnFolder = document.getElementById('btnNewFolder');
    if (btnFolder) btnFolder.onclick = function () {
        var n = prompt('Tên thư mục (chữ, số, - _ và dấu ngoặc ( ))'); if (!n) return;
        post('/code/word/folder', { dir: dir, name: n.trim() }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
    };
    var df = document.getElementById('btnDelFolder');
    if (df) df.onclick = function () {
        if (!confirm('Xoá thư mục "' + dir + '" và toàn bộ tài liệu bên trong?')) return;
        post(P.urls.del, { type: 'folder', dir: dir }).then(function () {
            location.href = base + (dir.indexOf('/') >= 0 ? '?dir=' + encodeURIComponent(dir.split('/').slice(0, -1).join('/')) : '');
        }).catch(function (e) { alert(e.message); });
    };
    document.querySelectorAll('.btn-rename-doc').forEach(function (b) {
        b.onclick = function () {
            var old = b.dataset.file;
            var n = prompt('Đổi tên tài liệu "' + old + '" thành (không gõ đuôi thì giữ .docx):', old);
            if (n === null) return; n = n.trim(); if (!n || n === old) return;
            b.disabled = true;
            post(P.urls.rename, { dir: dir, file: old, name: n }).then(function () { location.reload(); })
                .catch(function (e) { alert(e.message); b.disabled = false; });
        };
    });
    document.querySelectorAll('.btn-del-doc').forEach(function (b) {
        b.onclick = function () {
            if (!confirm('Xoá tài liệu "' + b.dataset.file + '"?')) return;
            post(P.urls.del, { type: 'file', dir: dir, file: b.dataset.file }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
        };
    });
    document.querySelectorAll('.btn-pub').forEach(function (b) {
        b.onclick = function () {
            var next = b.dataset.public !== '1';
            b.disabled = true;
            post(P.urls.visibility, { dir: dir, file: b.dataset.file, public: next }).then(function () {
                location.reload();
            }).catch(function (e) { alert(e.message); b.disabled = false; });
        };
    });
    document.querySelectorAll('.btn-copy-pub').forEach(function (b) {
        b.onclick = function () { copy(absolute(b.dataset.path), b); };
    });

    // ---- tải .docx lên (gửi từng phần 3.2MB, server mã hoá từng phần rồi chuyển HTML)
    var drop = document.getElementById('upDrop'), input = document.getElementById('upInput'), list = document.getElementById('upList'), notice = document.getElementById('upNotice');
    if (!drop || !input || !list) return;
    var queue = [], running = false, okCount = 0;
    var existing = {};
    (P.docs || []).forEach(function (d) { existing[d.name.toLowerCase()] = true; });
    function note(t) { if (!notice) return; notice.textContent = t || ''; notice.classList.toggle('hidden', !t); }
    function check(f) {
        var e = extOf(f.name);
        if (e === 'doc') return 'File .doc (Word 97-2003) chưa hỗ trợ. Hãy mở bằng Word → “Save As” → chọn .docx rồi tải lại.';
        if (e !== 'docx') return 'Chỉ nhận file .docx (Word 2007 trở lên). File bạn chọn là “.' + (e || '?') + '”.';
        if (f.size <= 0) return 'File rỗng.';
        if (L.maxFile && f.size > L.maxFile) return 'Quá lớn: tối đa ' + mb(L.maxFile) + ' mỗi file.';
        return null;
    }
    function addItems(files) {
        note('');
        Array.prototype.forEach.call(files, function (f) {
            var name = safeName(f.name);
            var li = document.createElement('div'); li.className = 'up-item';
            li.innerHTML = '<div class="flex justify-between gap-2"><b class="break-all">' + esc(name) + '</b><span class="text-gray-500 whitespace-nowrap">' + (f.size / 1048576).toFixed(1) + ' MB</span></div>' + (name !== f.name ? '<div class="text-xs text-gray-400 break-all">từ: ' + esc(f.name) + '</div>' : '') + '<div class="bar"><i></i></div><div class="msg text-gray-600">Đang chờ…</div>';
            list.appendChild(li);
            var bad = check(f);
            if (bad) { li.classList.add('err'); li.querySelector('.msg').className = 'msg err'; li.querySelector('.msg').textContent = bad; return; }
            if (existing[name.toLowerCase()] && !confirm('"' + name + '" đã có. Ghi đè bằng bản mới?')) {
                li.classList.add('err'); li.querySelector('.msg').className = 'msg err'; li.querySelector('.msg').textContent = 'Bỏ qua (đã có).'; return;
            }
            queue.push({ file: f, name: name, li: li });
        });
        run();
    }
    function putPart(file, id, i, n, blob) {
        var q = 'dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(file) + '&uploadId=' + id + '&i=' + i + '&n=' + n;
        return fetch('/code/word/upload/part?' + q, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, body: blob })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Lỗi tải phần ' + (i + 1))); return j; }); });
    }
    function uploadOne(it) {
        var f = it.file, name = it.name, li = it.li, bar = li.querySelector('.bar>i'), msg = li.querySelector('.msg');
        var partSize = L.part || 3.2 * 1024 * 1024;
        var n = Math.max(1, Math.ceil(f.size / partSize));
        if (n > (L.maxParts || 96)) throw new Error('File quá nhiều phần (tối đa ' + (L.maxParts || 96) + ' phần × 3.2MB).');
        var id = hexId(), parts = [];
        var i = 0;
        function next() {
            if (i >= n) {
                msg.textContent = 'Đang chuyển Word → HTML và mã hoá…';
                bar.style.width = '96%';
                return post(P.urls.uploadFinish, { dir: dir, file: name, uploadId: id, parts: parts }).then(function (j) {
                    okCount++;
                    li.classList.add('ok'); bar.style.width = '100%'; msg.className = 'msg ok';
                    msg.textContent = '✓ Đã chuyển và lưu' + (j.page && j.page.size ? ' (' + j.page.size + ')' : '') + '.';
                });
            }
            var blob = f.slice(i * partSize, Math.min(f.size, (i + 1) * partSize));
            msg.textContent = 'Đang gửi phần ' + (i + 1) + '/' + n + '…';
            return putPart(name, id, i, n, blob).then(function (r) {
                parts.push({ i: i, sha: r.sha, size: r.size, receipt: r.receipt });
                i++;
                bar.style.width = Math.round((i / n) * 94) + '%';
                return next();
            });
        }
        return Promise.resolve().then(next);
    }
    function run() {
        if (running) return; running = true;
        (function next() {
            var it = queue.shift();
            if (!it) {
                running = false;
                if (okCount) setTimeout(function () { location.reload(); }, 900);
                return;
            }
            var msg = it.li.querySelector('.msg');
            Promise.resolve().then(function () { return uploadOne(it); }).catch(function (e) {
                it.li.classList.add('err'); msg.className = 'msg err';
                msg.textContent = '✗ ' + e.message;
            }).then(next);
        })();
    }
    input.onchange = function () { addItems(input.files); input.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addItems(e.dataTransfer.files);
        else note('Hãy kéo thẳng file .docx vào khung này.');
    });
    window.addEventListener('beforeunload', function (e) { if (running) { e.preventDefault(); e.returnValue = ''; } });
    if (window.lucide) lucide.createIcons();
})();
