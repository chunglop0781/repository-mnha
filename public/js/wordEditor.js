// public/js/wordEditor.js — trình soạn Word: ribbon, trang A4, lưu theo phần, tải .docx, công khai/riêng tư
(function () {
    'use strict';
    var app = document.getElementById('wdApp'); if (!app) return;
    var P = JSON.parse(document.getElementById('payload').textContent);
    var body = document.getElementById('wdBody'), page = document.getElementById('wdPage'), canvas = document.getElementById('wdCanvas');
    var dirtyEl = document.getElementById('wdDirty'), statusEl = document.getElementById('wdStatus');
    var saveBtn = document.getElementById('wdSave'), saveState = document.getElementById('wdSaveState');
    var wordsEl = document.getElementById('wdWords'), pagesEl = document.getElementById('wdPages');
    var zoomInput = document.getElementById('wdZoom'), zoomText = document.getElementById('wdZoomText');
    var publicBtn = document.getElementById('wdPublicBtn'), copyBtn = document.getElementById('wdCopyLink');
    var imageInput = document.getElementById('wdImageInput');
    var SIZES = { A4: { w: 794, h: 1123 }, Letter: { w: 816, h: 1056 } };
    var PRESET = { normal: 96, narrow: 48, wide: 144 };
    var pageCfg = normalizePage(P.page || {});
    var dirty = false, saving = false, loading = true, savedRange = null;

    function normalizePage(p) {
        var size = String(p.size || '').toLowerCase() === 'letter' ? 'Letter' : 'A4';
        var orientation = String(p.orientation || '').toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
        var base = SIZES[size], w = base.w, h = base.h;
        if (orientation === 'landscape') { var t = w; w = h; h = t; }
        var margin = ['normal', 'narrow', 'wide', 'custom'].indexOf(String(p.margin || '').toLowerCase()) >= 0 ? String(p.margin).toLowerCase() : '';
        var raw = p.marginsPx || null;
        var m = raw ? {
            top: clamp(raw.top), right: clamp(raw.right), bottom: clamp(raw.bottom), left: clamp(raw.left)
        } : null;
        if (!margin) {
            var v = m ? [m.top, m.right, m.bottom, m.left] : [];
            var close = function (x) { return v.length === 4 && v.every(function (n) { return Math.abs(n - x) <= 6; }); };
            margin = close(PRESET.normal) ? 'normal' : close(PRESET.narrow) ? 'narrow' : close(PRESET.wide) ? 'wide' : m ? 'custom' : 'normal';
        }
        if (margin !== 'custom') { var k = PRESET[margin] || PRESET.normal; m = { top: k, right: k, bottom: k, left: k }; }
        m = m || { top: 96, right: 96, bottom: 96, left: 96 };
        return { size: size, orientation: orientation, margin: margin, marginsPx: m, widthPx: w, heightPx: h };
    }
    function clamp(v) { var n = Math.round(Number(v) || 0); return Math.max(12, Math.min(288, n)); }
    function dims(p) { var b = SIZES[p.size] || SIZES.A4; return p.orientation === 'landscape' ? { w: b.h, h: b.w } : { w: b.w, h: b.h }; }

    function setStatus(t, cls) {
        if (!statusEl) return;
        statusEl.textContent = t || '';
        statusEl.className = 'wd-status' + (cls ? ' ' + cls : '');
    }
    function setDirty(v, stateText) {
        dirty = !!v;
        if (dirtyEl) dirtyEl.classList.toggle('hidden', !dirty);
        if (saveState) saveState.textContent = stateText || (dirty ? 'Có thay đổi chưa lưu' : 'Đã lưu');
    }
    function markDirty() { setDirty(true); updateCounts(); }

    function applyPage() {
        var d = dims(pageCfg), m = pageCfg.marginsPx;
        page.style.width = d.w + 'px';
        page.style.minHeight = d.h + 'px';
        page.style.padding = m.top + 'px ' + m.right + 'px ' + m.bottom + 'px ' + m.left + 'px';
        body.style.minHeight = Math.max(120, d.h - m.top - m.bottom) + 'px';
        var ps = document.getElementById('wdPageSize'), or = document.getElementById('wdOrient'), mg = document.getElementById('wdMargin');
        if (ps) ps.value = pageCfg.size;
        if (or) or.value = pageCfg.orientation;
        if (mg) mg.value = pageCfg.margin;
        updateCounts();
    }
    function applyZoom(z) {
        z = Math.max(40, Math.min(200, Math.round(Number(z) || 100)));
        page.style.zoom = String(z / 100);
        if (zoomText) zoomText.textContent = z + '%';
        if (zoomInput) zoomInput.value = String(Math.max(60, Math.min(150, z)));
    }
    function updateCounts() {
        if (wordsEl) {
            var t = (body.innerText || '').replace(/\u200b/g, ' ').replace(/\s+/g, ' ').trim();
            wordsEl.textContent = (t ? t.split(' ').length : 0) + ' từ';
        }
        if (pagesEl) {
            var usable = Math.max(120, pageCfg.heightPx - pageCfg.marginsPx.top - pageCfg.marginsPx.bottom);
            var n = Math.max(1, Math.ceil((body.scrollHeight || usable) / usable));
            pagesEl.textContent = n + ' trang';
        }
    }

    function rememberSelection() {
        var s = window.getSelection();
        if (s && s.rangeCount && body.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    }
    document.addEventListener('selectionchange', rememberSelection);
    function focusBody() {
        body.focus();
        if (savedRange) {
            var s = window.getSelection();
            try { s.removeAllRanges(); s.addRange(savedRange); } catch (e) { }
        }
    }
    function exec(cmd, val) {
        focusBody();
        try {
            document.execCommand('styleWithCSS', false, true);
            document.execCommand(cmd, false, val == null ? null : val);
        } catch (e) { }
        rememberSelection(); syncToolbar(); markDirty();
    }
    function insertHtml(html) {
        focusBody();
        try { document.execCommand('insertHTML', false, html); }
        catch (e) {
            var sel = window.getSelection();
            if (sel && sel.rangeCount) {
                var r = sel.getRangeAt(0); r.deleteContents();
                var tmp = document.createElement('div'); tmp.innerHTML = html;
                var frag = document.createDocumentFragment();
                while (tmp.firstChild) frag.appendChild(tmp.firstChild);
                r.insertNode(frag);
            }
        }
        rememberSelection(); syncToolbar(); markDirty();
    }
    function applyInline(css) {
        focusBody();
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) { setStatus('Hãy bôi đen đoạn văn bản trước.', 'bad'); return; }
        var range = sel.getRangeAt(0);
        var span = document.createElement('span');
        span.setAttribute('style', css);
        if (range.collapsed) {
            span.appendChild(document.createTextNode('\u200b'));
            range.insertNode(span);
            var r0 = document.createRange(); r0.setStart(span.firstChild, 1); r0.collapse(true);
            sel.removeAllRanges(); sel.addRange(r0); savedRange = r0.cloneRange();
        } else {
            try { range.surroundContents(span); }
            catch (e) {
                var frag = range.extractContents();
                span.appendChild(frag);
                range.insertNode(span);
            }
            var r1 = document.createRange(); r1.selectNodeContents(span);
            sel.removeAllRanges(); sel.addRange(r1); savedRange = r1.cloneRange();
        }
        syncToolbar(); markDirty();
    }

    function activeBlock() {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        var n = sel.anchorNode;
        if (!n || !body.contains(n)) return null;
        var el = n.nodeType === 1 ? n : n.parentElement;
        while (el && el !== body && el.parentElement !== body) el = el.parentElement;
        return el && el !== body ? el : null;
    }
    function syncToolbar() {
        var n = activeBlock(); if (!n) return;
        var state = function (c) { try { return document.queryCommandState(c); } catch (e) { return false; } };
        ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript', 'insertUnorderedList', 'insertOrderedList',
            'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'].forEach(function (c) {
            var b = app.querySelector('[data-cmd="' + c + '"]');
            if (b) b.classList.toggle('on', !!state(c));
        });
        var block = document.getElementById('wdBlock');
        if (block) {
            var tag = n.tagName;
            if (/^(P|H1|H2|H3|H4|BLOCKQUOTE|PRE)$/.test(tag)) block.value = tag;
        }
        var cs = window.getComputedStyle(n);
        var font = document.getElementById('wdFont'), size = document.getElementById('wdSize');
        if (font) {
            var fam = String(cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim();
            var opt = Array.prototype.filter.call(font.options, function (o) { return o.value.replace(/['"]/g, '').toLowerCase() === fam.toLowerCase(); })[0];
            if (opt) font.value = opt.value;
        }
        if (size) {
            var pt = Math.round(parseFloat(cs.fontSize) * 0.75);
            var near = Array.prototype.filter.call(size.options, function (o) { return Math.abs(Number(o.value) - pt) <= 1; })[0];
            if (near) size.value = near.value;
        }
    }

    // ------------------------------------------------------------ nạp / lưu
    function loadContent() {
        setStatus('Đang mở tài liệu…');
        fetch(P.rawUrl, { credentials: 'same-origin', headers: { Accept: 'text/html' } })
            .then(function (r) {
                if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('Lỗi ' + r.status)); });
                return r.text();
            })
            .then(function (html) {
                body.innerHTML = html || '<p><br></p>';
                if (!body.firstChild) body.innerHTML = '<p><br></p>';
                loading = false; setDirty(false, 'Đã lưu'); setStatus(''); updateCounts();
                if (window.lucide) lucide.createIcons();
            })
            .catch(function (e) {
                loading = false; setStatus('Không mở được: ' + e.message, 'bad');
                body.innerHTML = '<p><b>Không mở được tài liệu.</b></p><p>' + String(e.message).replace(/[<>&]/g, '') + '</p>';
            });
    }

    function hexId() {
        var a = new Uint8Array(16);
        if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
        else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
        return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }
    function slice(chunks, s, n) {
        for (var i = 0; i < s.length;) {
            var end = Math.min(s.length, i + n);
            // không cắt đôi cặp surrogate (emoji) — nếu không sẽ thành ký tự hỏng khi gửi UTF-8
            if (end < s.length && end > i + 1 && /[\uD800-\uDBFF]/.test(s.charAt(end - 1))) end--;
            chunks.push(s.slice(i, end));
            i = end;
        }
    }
    function jsonFetch(url, opt) {
        return fetch(url, opt).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
                if (!r.ok) throw new Error(j.error || ('Lỗi ' + r.status));
                return j;
            });
        });
    }
    function save() {
        if (saving) return Promise.resolve(false);
        if (loading) { setStatus('Tài liệu đang mở, thử lại sau 1 giây…', 'bad'); return Promise.resolve(false); }
        saving = true; if (saveBtn) saveBtn.disabled = true;
        var html = body.innerHTML.replace(/\u200b/g, '');
        if (!html.trim()) html = '<p><br></p>';
        var chunks = []; slice(chunks, html, 700000);
        var id = hexId(), parts = [];
        setStatus('Đang lưu…');
        var chain = Promise.resolve();
        chunks.forEach(function (chunk, i) {
            chain = chain.then(function () {
                setStatus('Đang lưu ' + (i + 1) + '/' + chunks.length + '…');
                return fetch(P.savePartUrl + '&uploadId=' + id + '&i=' + i + '&n=' + chunks.length, {
                    method: 'PUT', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
                    body: chunk
                }).then(function (r) {
                    return r.json().catch(function () { return {}; }).then(function (j) {
                        if (!r.ok) throw new Error(j.error || ('Lỗi phần ' + (i + 1)));
                        parts.push({ i: i, sha: j.sha, size: j.size, receipt: j.receipt });
                    });
                });
            });
        });
        return chain.then(function () {
            setStatus('Đang mã hoá & lưu…');
            return jsonFetch(P.saveFinishUrl, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ dir: P.dir, file: P.file, uploadId: id, parts: parts, page: pageCfg, title: P.title })
            });
        }).then(function () {
            setDirty(false, 'Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN'));
            setStatus('Đã lưu ✓', 'ok');
            setTimeout(function () { if (!dirty) setStatus(''); }, 2200);
            return true;
        }).catch(function (e) {
            setStatus('Lỗi lưu: ' + e.message, 'bad');
            alert('Không lưu được: ' + e.message);
            return false;
        }).then(function (ok) {
            saving = false; if (saveBtn) saveBtn.disabled = false;
            return ok;
        });
    }

    // ------------------------------------------------------------ gắn sự kiện
    app.querySelectorAll('.wd-ribbon button').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    });
    app.querySelectorAll('.wd-ribbon [data-cmd]').forEach(function (b) {
        b.addEventListener('click', function () { exec(b.dataset.cmd); });
    });
    body.addEventListener('input', markDirty);
    body.addEventListener('keyup', updateCounts);
    body.addEventListener('mouseup', function () { rememberSelection(); syncToolbar(); });

    var fontSel = document.getElementById('wdFont');
    if (fontSel) fontSel.onchange = function () { applyInline("font-family:" + fontSel.value); };
    var sizeSel = document.getElementById('wdSize');
    if (sizeSel) sizeSel.onchange = function () {
        var px = Math.max(6, Math.round(Number(sizeSel.value) * 96 / 72));
        applyInline('font-size:' + px + 'px');
    };
    var blockSel = document.getElementById('wdBlock');
    if (blockSel) blockSel.onchange = function () { exec('formatBlock', blockSel.value); };
    var color = document.getElementById('wdColor');
    if (color) color.onchange = function () { exec('foreColor', color.value); };
    var hilite = document.getElementById('wdHilite');
    if (hilite) hilite.onchange = function () {
        focusBody();
        try { document.execCommand('styleWithCSS', false, true); document.execCommand('hiliteColor', false, hilite.value); }
        catch (e) { try { document.execCommand('backColor', false, hilite.value); } catch (_) { } }
        syncToolbar(); markDirty();
    };

    var clearBtn = document.getElementById('wdClear');
    if (clearBtn) clearBtn.addEventListener('click', function () {
        focusBody();
        try { document.execCommand('removeFormat'); } catch (e) { }
        var sel = window.getSelection();
        if (sel && sel.rangeCount) {
            var range = sel.getRangeAt(0);
            var c = range.commonAncestorContainer;
            if (c && c.nodeType !== 1) c = c.parentNode;
            if (c && body.contains(c)) {
                Array.prototype.slice.call(c.querySelectorAll('span,font,strong,b,em,i,u,s,strike,mark,sup,sub')).forEach(function (el) {
                    if (!range.intersectsNode(el)) return;
                    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
                    el.parentNode.removeChild(el);
                });
                if (c !== body) { c.removeAttribute('style'); c.removeAttribute('class'); }
            }
        }
        syncToolbar(); markDirty();
    });

    // chèn bảng
    var tableBtn = document.getElementById('wdTable');
    if (tableBtn) tableBtn.onclick = function () {
        var rows = parseInt(prompt('Số hàng (1–30):', '3'), 10);
        if (!rows || rows < 1) return;
        rows = Math.min(30, rows);
        var cols = parseInt(prompt('Số cột (1–10):', '3'), 10);
        if (!cols || cols < 1) return;
        cols = Math.min(10, cols);
        var out = ['<table class="word-table" style="border-collapse:collapse;width:100%"><tbody>'];
        for (var r = 0; r < rows; r++) {
            out.push('<tr>');
            for (var c = 0; c < cols; c++) out.push('<td style="border:1px solid #94a3b8;padding:6px 8px;min-width:40px"><br></td>');
            out.push('</tr>');
        }
        out.push('</tbody></table><p><br></p>');
        insertHtml(out.join(''));
        markDirty();
    };

    // chèn ảnh
    function insertImageFile(file) {
        if (!/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(file.type)) { alert('Chỉ chèn được ảnh PNG/JPG/GIF/WEBP/BMP.'); return; }
        if (file.size > 8 * 1024 * 1024) { alert('Ảnh tối đa 8MB.'); return; }
        var reader = new FileReader();
        reader.onload = function () {
            // alt = tên ảnh không đuôi → khi lưu thành file anh-001-<mô-tả>.<ext>
            var alt = String(file.name || '').replace(/\.[^.]+$/, '').replace(/["<>&]/g, '');
            insertHtml('<img src="' + reader.result + '" alt="' + alt + '" style="max-width:100%;height:auto">');
            markDirty();
        };
        reader.readAsDataURL(file);
    }
    var imageBtn = document.getElementById('wdImage');
    if (imageBtn && imageInput) {
        imageBtn.onclick = function () { imageInput.click(); };
        imageInput.onchange = function () {
            if (imageInput.files && imageInput.files[0]) insertImageFile(imageInput.files[0]);
            imageInput.value = '';
        };
    }
    body.addEventListener('paste', function (e) {
        var items = e.clipboardData && e.clipboardData.items; if (!items) return;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type && items[i].type.indexOf('image/') === 0) {
                var f = items[i].getAsFile();
                if (f) { e.preventDefault(); insertImageFile(f); }
                return;
            }
        }
    });

    // chèn liên kết / đường kẻ / ngắt trang
    var linkBtn = document.getElementById('wdLink');
    if (linkBtn) linkBtn.onclick = function () {
        var url = prompt('Địa chỉ liên kết (https://…, mailto:… hoặc #mục):', 'https://');
        if (!url) return;
        url = url.trim();
        if (!/^(https?:\/\/|mailto:|tel:|#)/i.test(url)) { alert('Liên kết phải bắt đầu bằng http://, https://, mailto:, tel: hoặc #.'); return; }
        exec('createLink', url);
    };
    var ruleBtn = document.getElementById('wdRule');
    if (ruleBtn) ruleBtn.onclick = function () { insertHtml('<hr><p><br></p>'); };
    var pbBtn = document.getElementById('wdPageBreak');
    if (pbBtn) pbBtn.onclick = function () { insertHtml('<hr class="word-pagebreak"><p><br></p>'); };

    // khổ giấy / lề
    function changePage() {
        var ps = document.getElementById('wdPageSize'), or = document.getElementById('wdOrient'), mg = document.getElementById('wdMargin');
        pageCfg = normalizePage({
            size: ps ? ps.value : pageCfg.size,
            orientation: or ? or.value : pageCfg.orientation,
            margin: mg ? mg.value : pageCfg.margin,
            marginsPx: pageCfg.marginsPx
        });
        applyPage(); markDirty();
    }
    ['wdPageSize', 'wdOrient', 'wdMargin'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', changePage);
    });
    if (zoomInput) zoomInput.addEventListener('input', function () { applyZoom(zoomInput.value); });

    // công khai / riêng tư
    function setPublicUi(on) {
        if (!publicBtn) return;
        publicBtn.dataset.public = on ? '1' : '0';
        publicBtn.classList.toggle('on', !!on);
        var t = document.getElementById('wdPublicText');
        if (t) t.textContent = on ? 'Công khai' : 'Riêng tư';
        if (copyBtn) copyBtn.classList.toggle('hidden', !on);
        var old = publicBtn.querySelector('[data-lucide],svg');
        if (old) {
            var icon = document.createElement('i');
            icon.setAttribute('data-lucide', on ? 'globe' : 'lock');
            icon.className = 'w-4 h-4';
            old.parentNode.replaceChild(icon, old);
            if (window.lucide) lucide.createIcons();
        }
    }
    if (publicBtn) publicBtn.addEventListener('click', function () {
        var next = publicBtn.dataset.public !== '1';
        publicBtn.disabled = true;
        jsonFetch(P.visibilityUrl, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ dir: P.dir, file: P.file, public: next })
        }).then(function () {
            setPublicUi(next);
            setStatus(next ? 'Đã bật công khai — ai có link /w đều xem được.' : 'Đã tắt công khai.', 'ok');
            setTimeout(function () { setStatus(''); }, 2600);
        }).catch(function (e) { alert('Không đổi được: ' + e.message); })
            .then(function () { publicBtn.disabled = false; });
    });
    if (copyBtn) copyBtn.addEventListener('click', function () {
        var url = location.origin + P.publicPath;
        function done(ok) { setStatus(ok ? 'Đã sao chép link công khai ✓' : 'Hãy chọn & copy thủ công: ' + url, ok ? 'ok' : 'bad'); }
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
        else {
            var t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select();
            var ok = false; try { ok = document.execCommand('copy'); } catch (e) { }
            document.body.removeChild(t); done(ok);
        }
    });

    if (saveBtn) saveBtn.onclick = save;
    function downloadDoc() {
        var p = dirty ? save() : Promise.resolve(true);
        p.then(function (ok) {
            if (!ok) { alert('Hãy lưu thành công trước khi tải Word về máy.'); return; }
            var f = document.createElement('iframe');
            f.style.display = 'none'; f.src = P.downloadUrl;
            document.body.appendChild(f);
            setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 60000);
        });
    }
    ['wdDownload', 'wdDownload2'].forEach(function (id) {
        var b = document.getElementById(id); if (b) b.onclick = downloadDoc;
    });
    var printBtn = document.getElementById('wdPrint');
    if (printBtn) printBtn.onclick = function () { window.print(); };

    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 's') {
            e.preventDefault(); save();
        }
        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'p') {
            // để trình duyệt in; CSS @media print đã ẩn thanh công cụ
        }
    });
    window.addEventListener('beforeunload', function (e) {
        if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
    });
    ['input', 'keyup', 'paste', 'cut'].forEach(function (ev) { body.addEventListener(ev, function () { setTimeout(updateCounts, 0); }); });

    // ------------------------------------------------------------ bắt đầu
    applyPage();
    var initialZoom = 100;
    var available = (canvas ? canvas.clientWidth : window.innerWidth) - 34;
    var baseW = dims(pageCfg).w;
    if (available < baseW) initialZoom = Math.max(45, Math.min(95, Math.floor(available / baseW * 100)));
    applyZoom(initialZoom);
    if (pageCfg.margin === 'custom') {
        var mg = document.getElementById('wdMargin');
        if (mg) {
            if (!mg.querySelector('option[value="custom"]')) {
                var o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Lề hiện tại'; mg.appendChild(o);
            }
            mg.value = 'custom';
        }
    }
    setDirty(false, 'Đang mở…');
    loadContent();
    if (window.lucide) lucide.createIcons();
})();
