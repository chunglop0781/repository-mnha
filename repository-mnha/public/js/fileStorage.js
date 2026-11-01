// public/js/fileStorage.js — trang "Lưu trữ file" (/code/files): tải lên (chia phần ≤ 3.5MB, làm tiếp được), tải về, đổi tên, xoá.
//   Tải lên: POST /code/files/upload/init (web chính chọn web kết nối + ký phiếu) → gửi từng PHẦN thẳng tới web kết nối
//   (PUT …/files/part) → POST …/files/finish. Web lỗi → tự chuyển web kế. Xem services/code/fileStore.js.
(function () {
    'use strict';
    var root = document.getElementById('fileStorage'); if (!root) return;
    var P = JSON.parse(document.getElementById('payload').textContent), dir = P.dir || '';
    var allowed = [].concat.apply([], Object.keys(P.exts).map(function (k) { return P.exts[k]; }));

    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function extOf(n) { var i = String(n).lastIndexOf('.'); return i > 0 ? String(n).slice(i + 1).toLowerCase() : ''; }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function qs(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }
    function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

    function request(method, url, body, isBin) {
        var opt = { method: method, headers: { Accept: 'application/json' } };
        if (isBin) { opt.headers['Content-Type'] = 'application/octet-stream'; opt.body = body; }
        else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
        return fetch(url, opt).then(function (r) {
            return r.json().then(function (j) { return j; }, function () { return {}; }).then(function (j) {
                if (!r.ok) { var e = new Error(j.error || ('Lỗi ' + r.status)); e.status = r.status; e.code = j.code; throw e; }
                return j;
            });
        });
    }
    // lỗi mạng / 5xx thử lại; lỗi do dữ liệu (4xx) dừng ngay
    function retry(fn, label) {
        var n = 0;
        function go() {
            return fn().catch(function (e) {
                n++;
                if ((e.status && e.status < 500 && e.status !== 429) || n >= 4) { if (label) e.message = label + ': ' + e.message; throw e; }
                return sleep(700 * n).then(go);
            });
        }
        return go();
    }
    function isDataError(e) { return e && e.status && e.status < 500 && e.status !== 429 && e.status !== 408; }
    function post(url, body) { return request('POST', url, body); }

    // ---------------------------------------------------------------- thư mục / file
    var bf = document.getElementById('btnNewFolder');
    if (bf) bf.onclick = function () {
        var n = prompt('Tên thư mục (chữ, số, - _ và dấu ngoặc ( ))'); if (!n) return;
        post('/code/files/folder', { dir: dir, name: n.trim() }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
    };
    var df = document.getElementById('btnDelFolder');
    if (df) df.onclick = function () {
        if (!confirm('Xoá thư mục "' + dir + '" và MỌI file trong đó?')) return;
        post('/code/files/folder/delete', { dir: dir }).then(function () {
            var up = dir.split('/').slice(0, -1).join('/');
            location.href = '/code/files' + (up ? '?dir=' + encodeURIComponent(up) : '');
        }).catch(function (e) { alert(e.message); });
    };
    document.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () {
            if (!confirm('Xoá file "' + b.dataset.del + '"?')) return;
            post('/code/files/delete', { dir: dir, name: b.dataset.del }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
        };
    });
    document.querySelectorAll('[data-ren]').forEach(function (b) {
        b.onclick = function () {
            var n = prompt('Tên mới (giữ đuôi .' + extOf(b.dataset.ren) + ')', b.dataset.ren); if (!n || n === b.dataset.ren) return;
            post('/code/files/rename', { dir: dir, name: b.dataset.ren, newName: n.trim() }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
        };
    });
    document.querySelectorAll('[data-dl]').forEach(function (b) {
        b.onclick = function () {
            var old = b.textContent; b.textContent = '…'; b.disabled = true;
            post('/code/files/download-token', { dir: dir, name: b.dataset.dl }).then(function (j) {
                var a = document.createElement('a'); a.href = j.url; a.rel = 'noopener'; a.style.display = 'none';
                document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 1000);
            }).catch(function (e) { alert(e.message); }).then(function () { b.textContent = old; b.disabled = false; });
        };
    });

    // ---------------------------------------------------------------- tải lên
    var drop = document.getElementById('upDrop'), input = document.getElementById('upInput'), list = document.getElementById('upList'), notice = document.getElementById('upNotice');
    if (!drop || !input || !list) return;      // tài khoản chưa được quyền tải lên: chỉ hiện thông báo

    function nodeUrls(node) {
        var base = node ? String(node.url || '').replace(/\/+$/, '') : '';
        return {
            init: base + (node ? '/api/node/files/init' : '/code/files/upload/local/init'),
            part: base + (node ? '/api/node/files/part' : '/code/files/upload/part'),
            finish: base + (node ? '/api/node/files/finish' : '/code/files/upload/finish')
        };
    }
    function say(t) { if (!notice) return; notice.textContent = t; notice.classList.toggle('hidden', !t); }

    function sendParts(file, init, urls, token, label, onProgress) {
        var n = init.n, have = {}, i;
        (init.have || []).forEach(function (x) { have[x] = true; });
        var chain = Promise.resolve(), done = Object.keys(have).length;
        function step(i) {
            return function () {
                if (have[i]) return;
                onProgress('Đang mã hoá & tải phần ' + (i + 1) + '/' + n + (label ? ' — web ' + label : ''), done / n);
                var q = { dir: dir, name: init.name, uploadId: init.uploadId, i: i, n: n };
                if (token) q.token = token;
                var body = file.slice(i * init.partBytes, (i + 1) * init.partBytes);
                return retry(function () { return request('PUT', urls.part + '?' + qs(q), body, true); }, 'phần ' + (i + 1) + '/' + n)
                    .then(function (r) { done++; if (r && r.repo) onProgress('Phần ' + (i + 1) + '/' + n + ' → repo ' + r.repo, done / n); });
            };
        }
        for (i = 0; i < n; i++) chain = chain.then(step(i));
        return chain.then(function () {
            onProgress('Đang ghi vào danh sách file…', 0.98);
            var b = { dir: dir, name: init.name, uploadId: init.uploadId, size: file.size, lastModified: file.lastModified };
            if (token) b.token = token;
            return retry(function () { return request('POST', urls.finish, b); }, 'hoàn tất');
        });
    }

    function upload(file, onProgress) {
        onProgress('Đang kiểm tra web tải lên…', 0);
        var body = { dir: dir, name: file.name, size: file.size, lastModified: file.lastModified };
        return retry(function () { return post('/code/files/upload/init', body); }).then(function (plan) {
            var candidates = plan.mode === 'node' ? (plan.candidates && plan.candidates.length ? plan.candidates : [plan.node]) : [null];
            var lastErr = null, k = 0;
            function tryNext() {
                if (k >= candidates.length) return Promise.reject(new Error('Không tải lên được qua web nào. ' + (lastErr ? lastErr.message : '')));
                var node = candidates[k++], label = node ? (node.name || node.id || node.url) : null;
                var tok = node ? ((plan.tokens && plan.tokens[node.id]) || plan.token) : null;
                var urls = nodeUrls(node);
                var first = node
                    ? retry(function () { return request('POST', urls.init, { token: tok, dir: plan.dir || dir, name: plan.name || file.name, size: file.size, lastModified: file.lastModified }); }, label)
                    : (plan.uploadId && plan.name ? Promise.resolve(plan) : retry(function () { return post(urls.init, body); }));
                return first.then(function (init) {
                    if (init.exists && !confirm('Đã có file "' + init.name + '" trong thư mục này. Ghi đè?')) { var c = new Error('Đã huỷ (giữ file cũ).'); c.cancelled = true; throw c; }
                    return sendParts(file, init, urls, init.token || tok, label, onProgress);
                }).catch(function (e) {
                    lastErr = e;
                    if (e.cancelled || (isDataError(e) && e.status !== 401 && e.status !== 403)) throw e;     // 401/403 từ web kết nối = sai khoá/phiếu → thử web kế
                    if (node) { say('Web "' + label + '" không tải được (' + e.message + ') — đang chuyển sang web kế tiếp…'); post('/code/html/upload/node-fail', { id: node.id }).catch(function () { }); }
                    return tryNext();
                });
            }
            return tryNext();
        });
    }

    var queue = [], running = false, okCount = 0;
    function addRow(file) {
        var li = document.createElement('div');
        li.className = 'rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm';
        li.innerHTML = '<div class="flex items-center gap-2"><span class="flex-1 break-all font-medium">' + esc(file.name) + '</span><span class="text-xs text-gray-500">' + size(file.size) + '</span></div>' +
            '<div class="mt-1 h-1.5 rounded bg-gray-100 overflow-hidden"><div class="bar h-full bg-indigo-500" style="width:0%"></div></div><div class="msg mt-1 text-xs text-gray-500">Đang chờ…</div>';
        list.appendChild(li);
        return { bar: li.querySelector('.bar'), msg: li.querySelector('.msg'), el: li };
    }
    function runQueue() {
        if (running) return; running = true;
        (function next() {
            var it = queue.shift();
            if (!it) { running = false; if (okCount) setTimeout(function () { location.reload(); }, 900); return; }
            upload(it.file, function (t, fr) { it.row.msg.textContent = t; it.row.bar.style.width = Math.round((fr || 0) * 100) + '%'; })
                .then(function (r) { okCount++; it.row.bar.style.width = '100%'; it.row.bar.className = 'bar h-full bg-emerald-500'; it.row.msg.textContent = 'Xong — ' + r.parts + ' phần' + (r.repos && r.repos.length ? ' · repo: ' + r.repos.join(' → ') : ''); })
                .catch(function (e) { it.row.bar.className = 'bar h-full bg-red-400'; it.row.msg.className = 'msg mt-1 text-xs text-red-600'; it.row.msg.textContent = e.message; })
                .then(next);
        })();
    }
    function addFiles(files) {
        Array.prototype.forEach.call(files, function (f) {
            var row = addRow(f), e = extOf(f.name);
            if (allowed.indexOf(e) < 0) { row.bar.className = 'bar h-full bg-red-400'; row.msg.className = 'msg mt-1 text-xs text-red-600'; row.msg.textContent = 'Chỉ nhận file Word, Excel, PowerPoint (và file Office khác), PDF, ảnh — không nhận ".' + (e || '?') + '".'; return; }
            if (!f.size) { row.msg.className = 'msg mt-1 text-xs text-red-600'; row.msg.textContent = 'File rỗng.'; return; }
            if (f.size > P.limits.maxFile) { row.msg.className = 'msg mt-1 text-xs text-red-600'; row.msg.textContent = 'File quá lớn (tối đa ' + size(P.limits.maxFile) + ').'; return; }
            queue.push({ file: f, row: row });
        });
        runQueue();
    }
    input.onchange = function () { addFiles(input.files); input.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('bg-indigo-50'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('bg-indigo-50'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
})();
