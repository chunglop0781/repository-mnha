// public/js/fileStorage.js — trang "Lưu trữ file" (/code/files): tải lên (chia phần ≤ 3.5MB, làm tiếp được), tải về, đổi tên, xoá.
//   Tải lên: POST /code/files/upload/init (web chính chọn web kết nối + ký phiếu) → init ở web kết nối trả khoá RIÊNG của file →
//   TRÌNH DUYỆT MÃ HOÁ từng PHẦN bằng WebCrypto (AES-256-GCM, MnhaFiles.encryptPart) rồi gửi bản mã thẳng tới web kết nối
//   (PUT …/files/part) → POST …/files/finish. Nếu init trả `direct.urls` (đã cấu hình Cloudflare R2): trình duyệt PUT THẲNG bản mã lên R2 bằng URL ký sẵn
//   (không qua Vercel), rồi POST …/files/finish {direct:true}; R2 lỗi/CORS → tự quay về đường cũ. Nếu init trả `ghDirect` (đã nhập GitHub App ở /connect): trình duyệt tự POST /git/blobs lên api.github.com bằng TOKEN TẠM (không qua Vercel) rồi POST …/files/commit để server gom vào 1 commit. Bản rõ không rời máy; web kết nối chỉ kiểm tra + ghi lên GitHub. Web lỗi → tự chuyển web kế. Xem services/code/fileStore.js.
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

    // ---------------------------------------------------------------- lấy nội dung file đã giải mã (dùng cho Xem + Tải tất cả)
    function fetchInfo(d, name) {       // → info { mode:'direct', ... } hoặc { blob } khi phải đi qua máy chủ
        return post('/code/files/open', { dir: d, name: name }).then(function (info) {
            var viaServer = function () {
                return post('/code/files/download-token', { dir: d, name: name }).then(function (j) {
                    return fetch(j.url).then(function (r) { if (!r.ok) throw new Error('Không đọc được file (HTTP ' + r.status + ').'); return r.blob(); });
                }).then(function (bl) { return { blob: bl, name: name }; });
            };
            if (info.mode !== 'direct' || !window.MnhaFiles || !window.MnhaFiles.supported()) return viaServer();
            return Promise.resolve(info);
        });
    }
    function fetchBlob(d, name) {
        return fetchInfo(d, name).then(function (info) {
            if (info.blob) return info.blob;
            return window.MnhaFiles.toBlob(info).catch(function (e) {
                if (e.code === 'RAW' || e.code === 'NO_RAW' || e.code === 'NO_CRYPTO') return post('/code/files/download-token', { dir: d, name: name }).then(function (j) { return fetch(j.url).then(function (r) { if (!r.ok) throw new Error('Không đọc được file (HTTP ' + r.status + ').'); return r.blob(); }); });
                throw e;
            });
        });
    }

    // ---------------------------------------------------------------- tải CẢ THƯ MỤC (.zip, gói ngay ở trình duyệt): gồm mọi thư mục con, giữ nguyên cấu trúc — kể cả thư mục mẹ không có file trực tiếp
    var bz = document.getElementById('btnZipAll');
    if (bz) bz.onclick = function () {
        if (!window.MnhaFiles || !window.MnhaFiles.supported() || !window.MnhaZip) { alert('Trình duyệt không hỗ trợ giải mã (cần https:// hoặc localhost).'); return; }
        var old = bz.textContent, zipName = dir ? dir.split('/').pop() : 'luu-tru-file';
        function sub(rel) { return dir ? (rel ? dir + '/' + rel : dir) : rel; }
        bz.disabled = true; bz.textContent = 'Đang quét thư mục…'; say('Đang quét thư mục con…');
        fetch('/code/files/tree?dir=' + encodeURIComponent(dir), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Lỗi ' + r.status)); return j; }); })
            .then(function (t) {
                if (!t.files.length && !(t.emptyDirs || []).length) throw new Error('Thư mục này chưa có file.');
                return window.MnhaFiles.zipAll(t.files, function (it) { return fetchInfo(sub(it.dir), it.name); }, {
                    root: zipName, emptyDirs: t.emptyDirs,
                    onFile: function (i, n, nm) { bz.textContent = 'Đang tải ' + (i + 1) + '/' + n + '…'; say('Đang tải & giải mã: ' + nm); }
                }).then(function (r) { return { r: r, t: t }; });
            })
            .then(function (x) {
                var r = x.r;
                window.MnhaZip.save(r.blob, zipName + '.zip');
                say((r.failed.length ? 'Đã gói ' + r.count + ' file; ' + r.failed.length + ' file lỗi (' + r.failed[0].name + ': ' + r.failed[0].error + ').' : 'Xong — đã gói ' + r.count + ' file cùng thư mục con.') + (x.t.truncated ? ' (cây rất lớn — chỉ quét ' + 500 + ' thư mục đầu)' : ''));
            })
            .catch(function (e) { alert(e.message); })
            .then(function () { bz.textContent = old; bz.disabled = false; });
    };

    // ---------------------------------------------------------------- XEM file ngay trên web (ảnh, PDF) + Trước / Sau bằng nút hoặc phím ← →
    var vw = { box: document.getElementById('vwBox'), title: document.getElementById('vwTitle'), body: document.getElementById('vwBody'), count: document.getElementById('vwCount'), prev: document.getElementById('vwPrev'), next: document.getElementById('vwNext'), close: document.getElementById('vwClose'), dl: document.getElementById('vwDl') };
    var vwList = [], vwIdx = -1, vwUrl = null, vwSeq = 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) { vwList.push({ name: b.dataset.view, kind: b.dataset.kind }); });
    function vwStop() { if (vwUrl) { try { URL.revokeObjectURL(vwUrl); } catch (_) { } vwUrl = null; } }
    function vwShow(i) {
        if (!vw.box || i < 0 || i >= vwList.length) return;
        var it = vwList[i], seq = ++vwSeq; vwIdx = i; vwStop();
        vw.box.classList.remove('hidden'); vw.title.textContent = it.name; vw.count.textContent = vwList.length > 1 ? (i + 1) + ' / ' + vwList.length : '';
        vw.prev.disabled = i <= 0; vw.next.disabled = i >= vwList.length - 1;
        vw.body.innerHTML = '<div class="text-sm text-gray-500">Đang tải & giải mã…</div>';
        var card = vw.box.firstElementChild; if (card) { card.classList.toggle('max-w-5xl', it.kind !== 'excel'); card.classList.toggle('max-w-[96vw]', it.kind === 'excel'); }
        fetchBlob(dir, it.name).then(function (bl) {
            if (seq !== vwSeq) return;
            if (it.kind === 'excel') {          // bảng tính: đọc .xlsx ngay trong trình duyệt (public/js/xlsxView.js)
                if (!window.XlsxView) throw new Error('Thiếu xlsxView.js');
                return bl.arrayBuffer().then(function (ab) { if (seq !== vwSeq) return; vw.body.innerHTML = ''; return window.XlsxView.render(vw.body, ab, { height: 'calc(95vh - 130px)' }); });
            }
            vwUrl = URL.createObjectURL(bl);
            vw.body.innerHTML = '';
            var el = document.createElement(it.kind === 'image' ? 'img' : 'iframe');
            el.src = vwUrl; if (it.kind === 'image') { el.alt = it.name; el.className = 'max-w-full max-h-[78vh] object-contain mx-auto'; } else { el.title = it.name; el.className = 'w-full h-[78vh] border-0 bg-white'; }
            vw.body.appendChild(el);
        }).catch(function (e) { if (seq === vwSeq) vw.body.innerHTML = '<div class="text-sm text-red-600">' + esc(e.message) + '</div>'; });
    }
    function vwHide() { if (!vw.box) return; vwSeq++; vwStop(); vw.body.innerHTML = ''; vw.box.classList.add('hidden'); vwIdx = -1; }
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b, i) { b.onclick = function () { vwShow(i); }; });
    if (vw.prev) vw.prev.onclick = function () { vwShow(vwIdx - 1); };
    if (vw.next) vw.next.onclick = function () { vwShow(vwIdx + 1); };
    if (vw.close) vw.close.onclick = vwHide;
    if (vw.dl) vw.dl.onclick = function () { if (vwIdx >= 0) download(vw.dl, dir, vwList[vwIdx].name); };
    document.addEventListener('keydown', function (e) {
        if (vwIdx < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); vwShow(vwIdx - 1); } else if (e.key === 'ArrowRight') { e.preventDefault(); vwShow(vwIdx + 1); } else if (e.key === 'Escape') vwHide();
    });

    // ---------------------------------------------------------------- mật khẩu chia sẻ (băm một chiều ở máy chủ — không xem lại được, chỉ đặt lại)
    var pw = { box: document.getElementById('pwBox'), input: document.getElementById('pwInput'), msg: document.getElementById('pwMsg'), save: document.getElementById('pwSave'), cancel: document.getElementById('pwCancel') };
    var bpw = document.getElementById('btnPass'), bpr = document.getElementById('btnPassRemove');
    function pwSay(t, err) { if (pw.msg) { pw.msg.textContent = t; pw.msg.className = 'text-xs ' + (err ? 'text-red-600' : 'text-gray-500'); } }
    if (bpw && pw.box) bpw.onclick = function () { pw.input.value = ''; pw.input.type = 'password'; pwSay(''); pw.box.classList.remove('hidden'); pw.input.focus(); };
    if (pw.cancel) pw.cancel.onclick = function () { pw.box.classList.add('hidden'); pw.input.value = ''; };
    if (pw.save) pw.save.onclick = function () {
        var v = pw.input.value;
        if (v.length < 4) { pwSay('Mật khẩu tối thiểu 4 ký tự.', true); return; }
        pw.save.disabled = true; pwSay('Đang lưu…');
        post('/code/files/folder/password', { dir: dir, password: v }).then(function () { location.reload(); }).catch(function (e) { pw.save.disabled = false; pwSay(e.message, true); });
    };
    if (bpr) bpr.onclick = function () {
        if (!confirm('Xoá mật khẩu? Link chia sẻ sẽ mở được mà không cần mật khẩu.')) return;
        post('/code/files/folder/password', { dir: dir, remove: true }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
    };

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
            finish: base + (node ? '/api/node/files/finish' : '/code/files/upload/finish'),
            commit: base + (node ? '/api/node/files/commit' : '/code/files/upload/commit')
        };
    }

    // Khoá riêng của file (init trả về) → CryptoKey chỉ dùng để mã hoá, không xuất được. Không có WebCrypto / máy chủ cũ không trả khoá → báo lỗi rõ (KHÔNG gửi bản rõ).
    function encryptor(init) {
        var M = window.MnhaFiles;
        if (!M || !M.supported() || typeof M.encryptPart !== 'function') {
            var e = new Error('Trình duyệt không có WebCrypto (cần mở bằng https:// hoặc localhost) nên không mã hoá được file trước khi gửi.'); e.status = 400; return Promise.reject(e);
        }
        if (!init || !init.key || !init.salt) {
            var e2 = new Error('Máy chủ nhận file chưa hỗ trợ mã hoá tại trình duyệt (thiếu khoá). Hãy cập nhật web kết nối cùng phiên bản rồi thử lại.'); e2.status = 400; return Promise.reject(e2);
        }
        return M.importEncryptKey(init.key).then(function (key) { return { key: key, salt: M.b64ToBytes(init.salt) }; });
    }

    // Tải thẳng lên R2 bằng URL PUT ký sẵn (init.direct.urls[i]): bản mã không qua máy chủ → không tốn băng thông Vercel. Lỗi mạng/CORS/403 → e.direct để quay về đường qua web kết nối.
    function putDirect(url, body) {
        return fetch(url, { method: 'PUT', body: body }).then(function (r) {
            if (!r.ok) { var e = new Error('R2 trả HTTP ' + r.status); e.status = r.status; e.direct = true; throw e; }
            return {};
        }, function (err) {
            var e2 = new Error('Không gửi thẳng được lên R2 (' + ((err && err.message) || 'mạng / CORS') + ')'); e2.direct = true; throw e2;
        });
    }

    // Tạo BLOB bản mã THẲNG trên GitHub (api.github.com cho phép CORS) bằng TOKEN TẠM do máy chủ cấp (GitHub App, 1 giờ, 1 repo) → không tốn băng thông Vercel.
    // Lỗi mạng / token hết hạn / hết hạn mức → e.direct để quay về đường qua web kết nối.
    function blobToBase64(bytes) {
        return new Promise(function (ok, no) {
            var fr = new FileReader();
            fr.onload = function () { var s = String(fr.result || ''); ok(s.slice(s.indexOf(',') + 1)); };
            fr.onerror = function () { no(fr.error || new Error('Không đọc được dữ liệu')); };
            fr.readAsDataURL(new Blob([bytes]));
        });
    }
    function putGithubBlob(t, bytes) {
        return blobToBase64(bytes).then(function (b64) {
            return fetch('https://api.github.com/repos/' + encodeURIComponent(t.owner) + '/' + encodeURIComponent(t.repo) + '/git/blobs', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + t.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: b64, encoding: 'base64' })
            });
        }).then(function (r) {
            if (r.status === 201 || r.status === 200) return r.json().then(function (j) { if (!j || !/^[0-9a-f]{40}$/.test(j.sha || '')) { var e0 = new Error('GitHub không trả mã blob'); e0.direct = true; throw e0; } return j.sha; });
            var e = new Error('GitHub trả HTTP ' + r.status + (r.status === 401 || r.status === 403 ? ' (token tạm hết hạn / hết quyền / hết hạn mức)' : '')); e.status = r.status; e.direct = true; throw e;
        }, function (err) {
            var e2 = new Error('Không gửi thẳng được lên GitHub (' + ((err && err.message) || 'mạng') + ')'); e2.direct = true; throw e2;
        });
    }

    function sendParts(file, init, urls, token, label, onProgress) {
        var gt = init.ghDirect && init.ghDirect.token ? init.ghDirect : null;
        var direct = init.direct && init.direct.urls ? init.direct.urls : null;
        var n = init.n, have = {}, i;
        (init.have || []).forEach(function (x) { have[x] = true; });
        var done = Object.keys(have).length;
        var pending = [];          // blob đã tạo trên GitHub nhưng chưa commit: [{ i, sha }]
        var COMMIT_EVERY = 8;      // gom ~28MB / 1 commit → đứt giữa chừng vẫn làm tiếp được
        function commitPending() {
            if (!pending.length) return Promise.resolve();
            var list = pending.splice(0, pending.length);
            var cb = { dir: dir, name: init.name, uploadId: init.uploadId, size: file.size, lastModified: file.lastModified, parts: list };
            if (token) cb.token = token;
            return retry(function () { return request('POST', urls.commit, cb); }, 'ghi ' + list.length + ' phần vào repo');
        }
        return encryptor(init).then(function (enc) {
            var chain = Promise.resolve();
            function step(i) {
                return function () {
                    if (have[i]) return;
                    onProgress('Đang mã hoá & tải phần ' + (i + 1) + '/' + n + (direct ? ' — thẳng lên R2' : (gt ? ' — thẳng lên GitHub' : (label ? ' — web ' + label : ''))), done / n);
                    var q = { dir: dir, name: init.name, uploadId: init.uploadId, i: i, n: n };
                    if (token) q.token = token;
                    // mã hoá 1 lần ở trình duyệt; gửi lại khi lỗi mạng thì dùng đúng bản mã đó
                    return file.slice(i * init.partBytes, (i + 1) * init.partBytes).arrayBuffer()
                        .then(function (ab) { return window.MnhaFiles.encryptPart(enc.key, enc.salt, new Uint8Array(ab), i); })
                        .then(function (body) {
                            if (direct) {
                                if (!direct[i]) { var ne = new Error('Thiếu URL tải lên cho phần ' + (i + 1)); ne.direct = true; throw ne; }
                                return retry(function () { return putDirect(direct[i], body); }, 'phần ' + (i + 1) + '/' + n);
                            }
                            if (gt) {
                                return retry(function () { return putGithubBlob(gt, body); }, 'phần ' + (i + 1) + '/' + n).then(function (sha) {
                                    pending.push({ i: i, sha: sha });
                                    return pending.length >= COMMIT_EVERY ? commitPending() : null;
                                });
                            }
                            return retry(function () { return request('PUT', urls.part + '?' + qs(q), body, true); }, 'phần ' + (i + 1) + '/' + n);
                        })
                        .then(function (r) { done++; if (r && r.repo) onProgress('Phần ' + (i + 1) + '/' + n + ' → repo ' + r.repo, done / n); });
                };
            }
            for (i = 0; i < n; i++) chain = chain.then(step(i));
            return chain.then(commitPending);
        }).then(function () {
            onProgress('Đang ghi vào danh sách file…', 0.98);
            var b = { dir: dir, name: init.name, uploadId: init.uploadId, size: file.size, lastModified: file.lastModified };
            if (direct) b.direct = true;
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
                    // Cho người dùng THẤY đang đi đường nào: thẳng R2 (không tốn băng thông Vercel) hay qua web kết nối (tốn).
                    if ((init.direct && init.direct.urls) || init.ghDirect) say('');
                    else say('Đang gửi file QUA web kết nối (tốn băng thông Vercel) — không tải thẳng được vì: ' + (init.directWhy || 'web kết nối này đang chạy bản code cũ chưa hỗ trợ tải thẳng R2 (hãy deploy lại web đó)') + '.');
                    return sendParts(file, init, urls, init.token || tok, label, onProgress).catch(function (e) {
                        if (!e || !e.direct) throw e;
                        // R2 không nhận (thường do chưa bật CORS cho bucket) → gửi lại toàn bộ qua web kết nối → GitHub như trước
                        say('Không tải thẳng được (' + e.message + ') — chuyển sang gửi qua web kết nối (tốn băng thông Vercel)…');
                        return sendParts(file, Object.assign({}, init, { have: [], direct: null, ghDirect: null }), urls, init.token || tok, label, onProgress);
                    });
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

    var queue = [], running = false, okCount = 0, badCount = 0, failedItems = [];
    function addRow(file) {
        var li = document.createElement('div');
        li.className = 'rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm';
        li.innerHTML = '<div class="flex items-center gap-2"><span class="flex-1 break-all font-medium">' + esc(file.name) + '</span><span class="text-xs text-gray-500">' + size(file.size) + '</span></div>' +
            '<div class="mt-1 h-1.5 rounded bg-gray-100 overflow-hidden"><div class="bar h-full bg-indigo-500" style="width:0%"></div></div><div class="msg mt-1 text-xs text-gray-500">Đang chờ…</div>';
        list.appendChild(li);
        return { bar: li.querySelector('.bar'), msg: li.querySelector('.msg'), el: li };
    }
    function rowErr(row, text) { row.bar.className = 'bar h-full bg-red-400'; row.msg.className = 'msg mt-1 text-xs text-red-600'; row.msg.textContent = text; }
    // Lỗi tạm thời (mạng, 5xx, GitHub chưa kịp cập nhật → 409) thì thử lại tối đa 2 lần; lỗi do dữ liệu (đuôi, kích thước…) dừng ngay.
    function attempt(it, n) {
        it.row.bar.className = 'bar h-full bg-indigo-500';
        it.row.msg.className = 'msg mt-1 text-xs text-gray-500';
        return upload(it.file, function (t, fr) { it.row.msg.textContent = t; it.row.bar.style.width = Math.round((fr || 0) * 100) + '%'; })
            .then(function (r) { okCount++; it.row.bar.style.width = '100%'; it.row.bar.className = 'bar h-full bg-emerald-500'; it.row.msg.textContent = 'Xong — ' + r.parts + ' phần' + (r.repos && r.repos.length ? ' · repo: ' + r.repos.join(' → ') : ''); })
            .catch(function (e) {
                var retriable = !e.cancelled && n < 2 && (!isDataError(e) || e.status === 409);
                if (retriable) { it.row.msg.textContent = 'Lỗi tạm thời (' + e.message + ') — thử lại lần ' + (n + 2) + '…'; return sleep(1500 * (n + 1)).then(function () { return attempt(it, n + 1); }); }
                rowErr(it.row, e.message); failedItems.push(it);
            });
    }
    // Xong CẢ LÔ mới tải lại trang; còn file lỗi thì giữ nguyên trang để đọc lỗi, có nút "Thử lại file lỗi".
    function endBatch() {
        var ok = okCount, bad = badCount; okCount = 0; badCount = 0;          // số đếm tính riêng từng lô
        if (!failedItems.length && !bad) { if (ok) setTimeout(function () { location.reload(); }, 900); return; }
        var box = document.createElement('div');
        box.className = 'rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-sm px-3 py-2 flex flex-wrap items-center gap-3';
        box.innerHTML = '<span class="flex-1">Đã tải xong ' + okCount + ' file' + (failedItems.length ? ', ' + failedItems.length + ' file lỗi' : '') + (badCount ? ', ' + badCount + ' file không hợp lệ' : '') + '. Trang chưa tải lại để bạn xem lỗi.</span>' +
            (failedItems.length ? '<button type="button" class="rt px-3 py-1 rounded-lg bg-white border border-amber-400 text-xs font-medium">Thử lại file lỗi</button>' : '') +
            '<button type="button" class="rl px-3 py-1 rounded-lg bg-white border border-amber-400 text-xs font-medium">Tải lại trang</button>';
        list.appendChild(box);
        var rl = box.querySelector('.rl'), rt = box.querySelector('.rt');
        if (rl) rl.onclick = function () { location.reload(); };
        if (rt) rt.onclick = function () { var again = failedItems.splice(0, failedItems.length); if (box.remove) box.remove(); again.forEach(function (it) { it.row.msg.textContent = 'Đang chờ…'; queue.push(it); }); runQueue(); };
    }
    function runQueue() {
        if (running) return; running = true;
        (function next() {
            var it = queue.shift();
            if (!it) { running = false; endBatch(); return; }
            attempt(it, 0).then(function () { return queue.length ? sleep(500) : null; }).then(next, next);     // nghỉ nửa giây giữa các file để GitHub kịp cập nhật
        })();
    }
    function addFiles(files) {
        Array.prototype.slice.call(files).forEach(function (f) {
            var row = addRow(f), e = extOf(f.name);
            if (allowed.indexOf(e) < 0) { badCount++; rowErr(row, 'Chỉ nhận file Word, Excel, PowerPoint (và file Office khác), PDF, ảnh — không nhận ".' + (e || '?') + '".'); return; }
            if (!f.size) { badCount++; rowErr(row, 'File rỗng.'); return; }
            if (f.size > P.limits.maxFile) { badCount++; rowErr(row, 'File quá lớn (tối đa ' + size(P.limits.maxFile) + ').'); return; }
            queue.push({ file: f, row: row });
        });
        runQueue();
    }
    input.onchange = function () { var picked = Array.prototype.slice.call(input.files || []); input.value = ''; addFiles(picked); };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('bg-indigo-50'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('bg-indigo-50'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
})();
