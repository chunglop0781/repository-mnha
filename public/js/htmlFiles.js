// public/js/htmlFiles.js — trang thư mục HTML: tạo/xoá file & thư mục, tải ảnh/âm thanh/video lên (hàng đợi từng file)
(function () {
    'use strict';
    var root = document.getElementById('htmlFiles'); if (!root) return;
    var P = JSON.parse(document.getElementById('payload').textContent), dir = P.dir || '';
    var L = P.limits, mb = function (n) { return Math.round(n / 1048576); };
    function post(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lỗi'); return j; }); });
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function extOf(n) { var i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; }
    function kindOf(n) { var e = extOf(n); return P.exts.image.indexOf(e) >= 0 ? 'image' : P.exts.audio.indexOf(e) >= 0 ? 'audio' : P.exts.video.indexOf(e) >= 0 ? 'video' : null; }

    document.getElementById('btnNewFile').onclick = function () {
        var n = prompt('Tên file (đuôi: ' + P.textExts.map(function (e) { return '.' + e; }).join(', ') + ')\nVí dụ: index.html, style.css, main.js'); if (!n) return;
        n = n.trim(); if (n.indexOf('.') < 0) n += '.html';
        post('/code/html/file', { dir: dir, name: n }).then(function (j) {
            window.open('/code/html/edit?dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(j.file), '_blank'); location.reload();
        }).catch(function (e) { alert(e.message); });
    };
    document.getElementById('btnNewFolder').onclick = function () {
        var n = prompt('Tên thư mục (chữ, số, - _ và dấu ngoặc ( ))'); if (!n) return;
        post('/code/html/folder', { dir: dir, name: n.trim() }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
    };
    var df = document.getElementById('btnDelFolder');
    if (df) df.onclick = function () {
        if (!confirm('Xoá thư mục "' + dir + '" và mọi file trong đó (kể cả ảnh/âm thanh/video)?')) return;
        post('/code/html/delete', { type: 'folder', dir: dir }).then(function () { location.href = '/code/html'; }).catch(function (e) { alert(e.message); });
    };
    document.querySelectorAll('.btn-del-file').forEach(function (b) {
        b.onclick = function () {
            if (!confirm('Xoá file "' + b.dataset.file + '"?')) return;
            post('/code/html/delete', { type: 'file', dir: dir, file: b.dataset.file }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
        };
    });
    document.querySelectorAll('.btn-del-asset').forEach(function (b) {
        b.onclick = function () {
            if (!confirm('Xoá "' + b.dataset.name + '"?')) return;
            var p = b.dataset.cut === '1' ? post('/code/html/media/delete', { dir: dir, name: b.dataset.name }) : post('/code/html/delete', { type: 'file', dir: dir, file: b.dataset.name });
            p.then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
        };
    });

    // ---- tải lên
    var drop = document.getElementById('upDrop'), input = document.getElementById('upInput'), list = document.getElementById('upList'), enc = document.getElementById('upEnc');
    var queue = [], running = false, okCount = 0;
    function check(f) {
        var k = kindOf(f.name), e = extOf(f.name);
        if (!k) return 'Đuôi .' + (e || '?') + ' không hỗ trợ (ảnh, âm thanh, video).';
        if (f.size > L.maxFile) return 'Quá lớn (tối đa ' + mb(L.maxFile) + 'MB).';
        if (f.size > L.directMax) {
            if (k === 'image') return 'Ảnh tối đa ' + mb(L.directMax) + 'MB.';
            var ok = k === 'audio' ? L.hlsAudio : L.hlsVideo;
            if (ok.indexOf(e) < 0) return 'Trên ' + mb(L.directMax) + 'MB chỉ cắt (m3u8) được: ' + ok.map(function (x) { return '.' + x; }).join(', ') + (k === 'video' ? ' (H.264 + AAC)' : '') + '. Hãy chuyển định dạng.';
        }
        return null;
    }
    function addItems(files) {
        Array.prototype.forEach.call(files, function (f) {
            var li = document.createElement('div'); li.className = 'up-item';
            li.innerHTML = '<div class="flex justify-between gap-2"><b class="break-all">' + esc(f.name) + '</b><span class="text-gray-500 whitespace-nowrap">' + (f.size / 1048576).toFixed(1) + ' MB</span></div><div class="bar"><i></i></div><div class="msg text-gray-600">Đang chờ…</div>';
            list.appendChild(li);
            var bad = check(f);
            if (bad) { li.classList.add('err'); li.querySelector('.msg').className = 'msg err'; li.querySelector('.msg').textContent = bad; return; }
            queue.push({ file: f, li: li });
        });
        run();
    }
    function run() {
        if (running) return; running = true;
        (function next() {
            var it = queue.shift();
            if (!it) { running = false; if (okCount) setTimeout(function () { location.reload(); }, 900); return; }
            var bar = it.li.querySelector('.bar>i'), msg = it.li.querySelector('.msg');
            MnhaUpload.upload(it.file, {
                dir: dir, encrypt: enc.checked,
                confirmOverwrite: function (n) { return confirm('"' + n + '" đã có. Ghi đè?'); },
                onProgress: function (t, fr) { msg.textContent = t; bar.style.width = Math.round(fr * 100) + '%'; }
            }).then(function (r) {
                okCount++; it.li.classList.add('ok'); bar.style.width = '100%'; msg.className = 'msg ok';
                msg.textContent = '✓ Xong' + (r.plan === 'hls' ? ' — đã cắt m3u8, tên gốc khai báo trong mnha-media.json' : ' — đã mã hoá') + '.';
            }).catch(function (e) {
                it.li.classList.add('err'); msg.className = 'msg err'; msg.textContent = (e.cancelled ? '' : '✗ ') + e.message + (e.cancelled ? '' : ' — chọn lại file để thử/làm tiếp.');
            }).then(next);
        })();
    }
    input.onchange = function () { addItems(input.files); input.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addItems(e.dataTransfer.files); });
    window.addEventListener('beforeunload', function (e) { if (running) { e.preventDefault(); e.returnValue = ''; } });
    if (window.lucide) lucide.createIcons();
})();
