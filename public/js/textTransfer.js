// public/js/textTransfer.js — trang thư mục code (cpp, emu8086, html): TẢI FILE VĂN BẢN LÊN (trùng tên → ghi đè) + TẢI TẤT CẢ file văn bản về (zip)
(function () {
    'use strict';
    var root = document.getElementById('codeFiles') || document.getElementById('htmlFiles'); if (!root) return;
    var lang = root.dataset.lang || 'html', dir = root.dataset.dir || '';
    var exts = (root.dataset.exts || '').split(',').filter(Boolean);
    var maxBytes = Number(root.dataset.max) || 200 * 1024;
    var btnUp = document.getElementById('btnUploadText'), btnAll = document.getElementById('btnDownloadAll'), input = document.getElementById('textUploadInput');
    if (!btnUp && !btnAll) return;

    var msg = document.createElement('div');
    msg.className = 'mt-3 hidden text-sm rounded-xl border px-4 py-3 whitespace-pre-line';
    var row = (btnUp || btnAll).parentNode; row.parentNode.insertBefore(msg, row.nextSibling);
    function say(text, kind) {
        msg.className = 'mt-3 text-sm rounded-xl border px-4 py-3 whitespace-pre-line ' + (kind === 'err' ? 'border-red-300 bg-red-50 text-red-800' : kind === 'ok' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-indigo-200 bg-indigo-50 text-indigo-800');
        msg.textContent = text;
    }
    function names() { return Array.prototype.map.call(document.querySelectorAll('.btn-del-file'), function (b) { return b.dataset.file; }); }
    function fmt(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB'; }
    function normName(n) { var i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) + '.' + n.slice(i + 1).toLowerCase() : n; }      // server hạ chữ thường đuôi file

    // ---------- TẢI LÊN
    function post(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lỗi'); return j; }); });
    }
    function readText(f) {
        return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(String(r.result)); }; r.onerror = function () { no(new Error('không đọc được file')); }; r.readAsText(f, 'utf-8'); });
    }
    function upload(list) {
        var skipped = [], ready = [];
        return list.reduce(function (p, f) {
            return p.then(function () {
                var i = f.name.lastIndexOf('.'), ext = i > 0 ? f.name.slice(i + 1).toLowerCase() : '';
                if (exts.length && exts.indexOf(ext) < 0) return skipped.push({ name: f.name, reason: 'đuôi .' + (ext || '?') + ' không được phép (cho phép: ' + exts.map(function (e) { return '.' + e; }).join(', ') + ')' });
                if (f.size > maxBytes) return skipped.push({ name: f.name, reason: 'quá lớn (' + fmt(f.size) + ', tối đa ' + fmt(maxBytes) + ')' });
                return readText(f).then(function (t) {
                    if (t.indexOf('\u0000') >= 0) skipped.push({ name: f.name, reason: 'không phải file văn bản' });
                    else if (t.indexOf('\uFFFD') >= 0) skipped.push({ name: f.name, reason: 'không phải UTF-8 (lưu lại file ở dạng UTF-8 rồi tải lên)' });
                    else ready.push({ name: f.name, content: t, size: f.size });
                }).catch(function (e) { skipped.push({ name: f.name, reason: e.message }); });
            });
        }, Promise.resolve()).then(function () {
            if (!ready.length) return { saved: [], overwritten: [], skipped: skipped };
            var have = names(), dup = ready.filter(function (x) { return have.indexOf(normName(x.name)) >= 0; }).map(function (x) { return x.name; });
            if (dup.length && !confirm('Các file sau đã có trong thư mục, tải lên sẽ GHI ĐÈ bản cũ:\n\n' + dup.slice(0, 15).join('\n') + (dup.length > 15 ? '\n... (+' + (dup.length - 15) + ')' : '') + '\n\nTiếp tục?')) return null;
            var batches = [], cur = [], bytes = 0;
            ready.forEach(function (x) {
                if (cur.length && (cur.length >= 15 || bytes + x.size > 2.5 * 1024 * 1024)) { batches.push(cur); cur = []; bytes = 0; }
                cur.push({ name: x.name, content: x.content }); bytes += x.size;
            });
            if (cur.length) batches.push(cur);
            var total = { saved: [], overwritten: [], skipped: skipped };
            return batches.reduce(function (p, b, n) {
                return p.then(function () {
                    say('Đang tải lên... (đợt ' + (n + 1) + '/' + batches.length + ')');
                    return post('/code/' + lang + '/upload-text', { dir: dir, files: b }).then(function (j) {
                        total.saved = total.saved.concat(j.saved); total.overwritten = total.overwritten.concat(j.overwritten); total.skipped = total.skipped.concat(j.skipped);
                    });
                });
            }, Promise.resolve()).then(function () { return total; });
        });
    }
    if (btnUp && input) {
        btnUp.onclick = function () { input.value = ''; input.click(); };
        input.onchange = function () {
            var list = Array.prototype.slice.call(input.files || []); if (!list.length) return;
            btnUp.disabled = true; say('Đang đọc file...');
            upload(list).then(function (r) {
                if (!r) return say('Đã huỷ tải lên.');
                var t = [];
                if (r.saved.length) t.push('Đã tải lên ' + r.saved.length + ' file' + (r.overwritten.length ? ' (ghi đè ' + r.overwritten.length + ': ' + r.overwritten.join(', ') + ')' : '') + '.');
                if (r.skipped.length) t.push('Bỏ qua ' + r.skipped.length + ' file:\n' + r.skipped.map(function (s) { return '• ' + s.name + ' — ' + s.reason; }).join('\n'));
                say(t.join('\n') || 'Không có file nào được tải lên.', r.saved.length ? (r.skipped.length ? 'info' : 'ok') : 'err');
                if (r.saved.length) setTimeout(function () { location.reload(); }, r.skipped.length ? 4000 : 900);
            }).catch(function (e) { say('Lỗi: ' + e.message, 'err'); }).then(function () { btnUp.disabled = false; });
        };
    }

    // ---------- TẢI VỀ (zip tự dựng ở trình duyệt, không nén — chỉ gói lại)
    var zip = window.MnhaZip.zip, save = window.MnhaZip.save;
    function fetchOne(name) {
        return fetch('/code/' + lang + '/download?dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(name), { headers: { Accept: 'application/json' } })
            .then(function (r) { if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); }); return r.arrayBuffer(); })
            .then(function (b) { return { name: name, data: new Uint8Array(b) }; });
    }
    if (btnAll) btnAll.onclick = function () {
        var list = names(); if (!list.length) return say('Thư mục này chưa có file văn bản nào để tải.', 'err');
        btnAll.disabled = true; var done = 0, failed = [], got = [], i = 0;
        say('Đang tải 0/' + list.length + ' file...');
        function worker() {
            if (i >= list.length) return Promise.resolve();
            var n = list[i++];
            return fetchOne(n).then(function (e) { got.push(e); }, function (er) { failed.push(n + ' — ' + er.message); }).then(function () { say('Đang tải ' + (++done) + '/' + list.length + ' file...'); return worker(); });
        }
        Promise.all([worker(), worker(), worker(), worker()]).then(function () {
            if (!got.length) return say('Không tải được file nào:\n' + failed.join('\n'), 'err');
            got.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
            var base = (dir ? dir.split('/').pop() : lang) || 'codes';
            if (got.length === 1) save(new Blob([got[0].data], { type: 'text/plain' }), got[0].name); else save(zip(got), base + '.zip');
            say('Đã tải về ' + got.length + ' file' + (got.length > 1 ? ' (' + base + '.zip)' : '') + '.' + (failed.length ? '\nKhông tải được ' + failed.length + ' file:\n' + failed.join('\n') : ''), failed.length ? 'info' : 'ok');
        }).catch(function (e) { say('Lỗi: ' + e.message, 'err'); }).then(function () { btnAll.disabled = false; });
    };
})();
