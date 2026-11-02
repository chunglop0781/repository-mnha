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
    function say(t) { var n = document.getElementById('upNotice'); if (!n) return; n.textContent = t; n.classList.toggle('hidden', !t); }
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
    // Tải về: TRÌNH DUYỆT tự tải các phần mã hoá từ GitHub raw và giải mã (không tốn băng thông máy chủ). Không được thì quay về tải qua máy chủ.
    function serverDownload(d, name) {
        return post('/code/files/download-token', { dir: d, name: name }).then(function (j) {
            var a = document.createElement('a'); a.href = j.url; a.rel = 'noopener'; a.style.display = 'none';
            document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 1000);
        });
    }
    function download(btn, d, name) {
        var old = btn.textContent; btn.disabled = true; btn.textContent = '…';
        post('/code/files/open', { dir: d, name: name }).then(function (info) {
            if (info.mode !== 'direct' || !window.MnhaFiles || !window.MnhaFiles.supported()) return serverDownload(d, name);
            return window.MnhaFiles.toBlob(info, { onProgress: function (i, n) { btn.textContent = Math.round(i * 100 / n) + '%'; } })
                .then(function (blob) { window.MnhaFiles.save(blob, info.name || name); })
                .catch(function (e) {
                    if (e.code === 'RAW' || e.code === 'NO_RAW' || e.code === 'NO_CRYPTO') { say('Không tải thẳng được từ GitHub (' + e.message + ') — đang tải qua máy chủ…'); return serverDownload(d, name); }
                    throw e;
                });
        }).catch(function (e) { alert(e.message); }).then(function () { btn.textContent = old; btn.disabled = false; });
    }
    document.querySelectorAll('[data-dl]').forEach(function (b) { b.onclick = function () { download(b, dir, b.dataset.dl); }; });

    // ---------------------------------------------------------------- công khai / riêng tư
    function shareUrl(d, name) { return location.origin + '/f?' + qs({ u: P.uid, d: d, n: name }); }
    function copyText(t) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
        return new Promise(function (ok, no) {
            try { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); ok(); } catch (e) { no(e); }
        });
    }
    document.querySelectorAll('[data-vis]').forEach(function (b) {
        b.onclick = function () {
            var toPublic = b.dataset.public !== '1';
            if (toPublic && !confirm('Công khai "' + b.dataset.vis + '"?\nAi có link đều xem/tải được file này.')) return;
            b.disabled = true;
            post('/code/files/visibility', { dir: dir, name: b.dataset.vis, public: toPublic }).then(function () { location.reload(); })
                .catch(function (e) { b.disabled = false; alert(e.message); });
        };
    });
    document.querySelectorAll('[data-copy]').forEach(function (b) {
        b.onclick = function () {
            var link = location.origin + b.dataset.copy;
            copyText(link).then(function () { var t = b.textContent; b.textContent = 'Đã chép ✓'; setTimeout(function () { b.textContent = t; }, 1500); })
                .catch(function () { prompt('Sao chép link:', link); });
        };
    });
    document.querySelectorAll('[data-copyabs]').forEach(function (b) {
        b.onclick = function () {
            var link = b.dataset.copyabs;
            copyText(link).then(function () { var t = b.textContent; b.textContent = 'Đã chép ✓'; setTimeout(function () { b.textContent = t; }, 1500); })
                .catch(function () { prompt('Sao chép link:', link); });
        };
    });
    function bulk(toPublic) {
        return function () {
            var msg = toPublic ? 'Công khai TẤT CẢ file trong thư mục này? Ai có link đều xem/tải được.' : 'Chuyển TẤT CẢ file trong thư mục này về riêng tư?';
            if (!confirm(msg)) return;
            post('/code/files/visibility', { dir: dir, all: true, public: toPublic }).then(function (j) { alert('Đã đổi ' + j.changed + ' file.'); location.reload(); })
                .catch(function (e) { alert(e.message); });
        };
    }
    var ba = document.getElementById('btnPublicAll'), bp = document.getElementById('btnPrivateAll');
    if (ba) ba.onclick = bulk(true);
    if (bp) bp.onclick = bulk(false);

    // ---------------------------------------------------------------- tìm kiếm
    function fold(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim(); }
    var box = document.getElementById('fsSearch'), res = document.getElementById('fsResults'), btnAll = document.getElementById('btnSearchAll');
    if (box) {
        var rowsEl = Array.prototype.slice.call(document.querySelectorAll('.fs-row'));
        box.addEventListener('input', function () {            // lọc ngay các dòng của thư mục đang mở
            var q = fold(box.value);
            rowsEl.forEach(function (r) { r.style.display = !q || fold(r.dataset.name).indexOf(q) >= 0 ? '' : 'none'; });
            if (!q && res) res.classList.add('hidden');
        });
        box.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); searchAll(); } });
        if (btnAll) btnAll.onclick = searchAll;
    }
    function searchAll() {
        var q = box.value.trim(); if (!q) { box.focus(); return; }
        res.classList.remove('hidden'); res.innerHTML = '<div class="px-4 py-3 text-sm text-gray-500">Đang tìm…</div>';
        request('GET', '/code/files/search?q=' + encodeURIComponent(q)).then(function (j) {
            var html = '';
            j.folders.forEach(function (f) {
                html += '<div class="flex items-center gap-3 px-4 py-2.5 text-sm"><span class="text-amber-500">📁</span><a class="flex-1 break-all text-gray-900 hover:text-indigo-600" href="/code/files?dir=' + encodeURIComponent(f) + '">' + esc(f) + '</a></div>';
            });
            j.files.forEach(function (f, i) {
                html += '<div class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm"><span class="flex-1 min-w-[10rem] break-all text-gray-900">' + esc(f.name) + '</span>' +
                    '<a class="text-xs text-indigo-600 hover:underline" href="/code/files' + (f.dir ? '?dir=' + encodeURIComponent(f.dir) : '') + '">' + esc(f.dir || '(thư mục gốc)') + '</a>' +
                    '<span class="text-xs text-gray-500">' + size(f.size) + '</span>' +
                    '<span class="text-xs rounded-full px-2 py-0.5 border ' + (f.public ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-gray-300 bg-gray-50 text-gray-600') + '">' + (f.public ? 'Công khai' : 'Riêng tư') + '</span>' +
                    (f.public ? '<button type="button" class="text-xs text-emerald-700 hover:underline" data-rcopy="' + i + '">Sao chép link</button>' : '') +
                    '<button type="button" class="text-xs text-indigo-600 hover:underline" data-rdl="' + i + '">Tải</button></div>';
            });
            if (!html) html = '<div class="px-4 py-4 text-sm text-gray-500">Không thấy file hay thư mục nào có tên chứa "' + esc(q) + '".</div>';
            else if (j.truncated) html += '<div class="px-4 py-2 text-xs text-amber-600">Kết quả bị cắt bớt — hãy gõ từ khoá cụ thể hơn.</div>';
            res.innerHTML = html;
            res.querySelectorAll('[data-rdl]').forEach(function (b) { b.onclick = function () { var f = j.files[+b.dataset.rdl]; download(b, f.dir, f.name); }; });
            res.querySelectorAll('[data-rcopy]').forEach(function (b) {
                b.onclick = function () {
                    var f = j.files[+b.dataset.rcopy], link = shareUrl(f.dir, f.name);
                    copyText(link).then(function () { b.textContent = 'Đã chép ✓'; }).catch(function () { prompt('Sao chép link:', link); });
                };
            });
        }).catch(function (e) { res.innerHTML = '<div class="px-4 py-3 text-sm text-red-600">' + esc(e.message) + '</div>'; });
    }

    // ---------------------------------------------------------------- chia sẻ thư mục (xem trên mạng)
    var bs = document.getElementById('btnShareFolder');
    if (bs) bs.onclick = function () {
        var on = bs.dataset.shared !== '1';
        if (on && !confirm('Chia sẻ thư mục này? Ai có link đều duyệt được thư mục này và các thư mục con, chỉ thấy các file ĐÃ BẬT CÔNG KHAI (file riêng tư không hiện).')) return;
        bs.disabled = true;
        post('/code/files/folder/share', { dir: dir, shared: on }).then(function () { location.reload(); }).catch(function (e) { bs.disabled = false; alert(e.message); });
    };

    // ---------------------------------------------------------------- xem / sửa file .txt (giải mã trong trình duyệt; lưu = mã hoá lại, ghi đè cùng tên)
    var ed = { box: document.getElementById('edBox'), text: document.getElementById('edText'), title: document.getElementById('edTitle'), msg: document.getElementById('edMsg'), save: document.getElementById('edSave'), close: document.getElementById('edClose') };
    var edName = null, edOrig = '';
    function edSay(t, err) { ed.msg.textContent = t; ed.msg.className = 'flex-1 text-xs ' + (err ? 'text-red-600' : 'text-gray-500'); }
    function edClose() { if (ed.text.value !== edOrig && !confirm('Có thay đổi chưa lưu. Đóng không lưu?')) return; ed.box.classList.add('hidden'); edName = null; }
    function readText(d, name) {
        return post('/code/files/open', { dir: d, name: name }).then(function (info) {
            if (info.size > P.limits.textEdit) throw new Error('File quá lớn để mở trên web (tối đa ' + size(P.limits.textEdit) + ') — hãy tải về.');
            var viaServer = function () {
                return post('/code/files/download-token', { dir: d, name: name }).then(function (j) { return fetch(j.url).then(function (r) { if (!r.ok) throw new Error('Không đọc được file (HTTP ' + r.status + ').'); return r.arrayBuffer(); }); });
            };
            if (info.mode === 'direct' && window.MnhaFiles && window.MnhaFiles.supported()) {
                return window.MnhaFiles.toBlob(info).then(function (b) { return b.arrayBuffer(); })
                    .catch(function (e) { if (e.code === 'RAW' || e.code === 'NO_RAW' || e.code === 'NO_CRYPTO') return viaServer(); throw e; });
            }
            return viaServer();
        }).then(function (ab) { return new TextDecoder('utf-8').decode(ab); });
    }
    document.querySelectorAll('[data-edit]').forEach(function (b) {
        b.onclick = function () {
            var name = b.dataset.edit, old = b.textContent; b.disabled = true; b.textContent = '…';
            readText(dir, name).then(function (txt) {
                edName = name; edOrig = txt; ed.text.value = txt; ed.title.textContent = name;
                ed.text.readOnly = !P.canUpload; ed.save.classList.toggle('hidden', !P.canUpload);
                edSay(P.canUpload ? 'Lưu sẽ mã hoá lại và ghi đè file (UTF-8).' : 'Chỉ xem — tài khoản chưa có quyền sửa.');
                ed.box.classList.remove('hidden'); ed.text.focus();
            }).catch(function (e) { alert(e.message); }).then(function () { b.disabled = false; b.textContent = old; });
        };
    });
    if (ed.close) ed.close.onclick = edClose;
    if (ed.save) ed.save.onclick = function () {
        if (!edName || !P.canUpload) return;
        var txt = ed.text.value;
        if (!txt.length) { edSay('Nội dung rỗng — không lưu được file rỗng (hãy xoá file nếu muốn bỏ).', true); return; }
        var f = new File([txt], edName, { type: 'text/plain', lastModified: Date.now() });
        if (f.size > P.limits.textEdit) { edSay('Nội dung quá lớn (tối đa ' + size(P.limits.textEdit) + ').', true); return; }
        ed.save.disabled = true; edSay('Đang mã hoá và lưu…');
        upload(f, function (t) { edSay(t); }, { overwrite: true })
            .then(function () { edOrig = txt; edSay('Đã lưu ✓'); setTimeout(function () { location.reload(); }, 600); })
            .catch(function (e) { ed.save.disabled = false; edSay(e.message, true); });
    };

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

    function upload(file, onProgress, opt) {
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
                    if (init.exists && !(opt && opt.overwrite) && !confirm('Đã có file "' + init.name + '" trong thư mục này. Ghi đè?')) { var c = new Error('Đã huỷ (giữ file cũ).'); c.cancelled = true; throw c; }
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
