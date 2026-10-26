// public/js/wordEditor.js — trình soạn Word: ribbon đầy đủ, trang A4, lưu theo phần, tải .docx, công khai/riêng tư
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
    var zoomLevel = 100, painterCss = null, caseMode = 0, lockPw = null;
    var trackOn = false, noteIndex = -1;
    var toastEl = null, toastTimer = null, modalEl = null, findbar = null, navEl = null, readExit = null;

    function byId(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function toast(msg, bad) {
        if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'wd-toast'; document.body.appendChild(toastEl); }
        toastEl.textContent = msg;
        toastEl.className = 'wd-toast show' + (bad ? ' bad' : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.className = 'wd-toast' + (bad ? ' bad' : ''); }, 3200);
    }
    function closeModal() {
        if (!modalEl) return;
        if (modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
        modalEl = null;
    }
    function modal(opts) {
        closeModal();
        opts = opts || {};
        var wrap = document.createElement('div');
        wrap.className = 'wd-modal' + (app.classList.contains('wd-dark') ? ' wd-dark' : '');
        wrap.innerHTML = '<div class="wd-modal-box" role="dialog" aria-modal="true">' +
            '<h2>' + esc(opts.title || '') + '</h2>' + (opts.html || '') +
            '<div class="wd-modal-actions">' +
            '<button type="button" class="wd-btn" data-modal-cancel>' + esc(opts.cancel || 'Đóng') + '</button>' +
            (opts.ok ? '<button type="button" class="wd-btn wd-btn-primary" data-modal-ok>' + esc(opts.ok) + '</button>' : '') +
            '</div></div>';
        document.body.appendChild(wrap);
        modalEl = wrap;
        var cancel = wrap.querySelector('[data-modal-cancel]');
        cancel.onclick = function () { closeModal(); if (opts.onCancel) opts.onCancel(); };
        var okBtn = wrap.querySelector('[data-modal-ok]');
        if (okBtn) okBtn.onclick = function () {
            var box = wrap.querySelector('.wd-modal-box');
            var keep = opts.onOk ? opts.onOk(box, wrap) : undefined;
            if (keep !== false) closeModal();
        };
        wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) closeModal(); });
        var first = wrap.querySelector('input,textarea,select');
        if (first) setTimeout(function () { first.focus(); }, 40);
        return { el: wrap, close: closeModal };
    }

    // ------------------------------------------------------------ trang giấy / thu phóng
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
        var color = /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? String(p.color).toLowerCase() : '#ffffff';
        var columns = Math.max(1, Math.min(3, Math.round(Number(p.columns) || 1)));
        var watermark = String(p.watermark == null ? '' : p.watermark).replace(/["\\\r\n]/g, ' ').slice(0, 60).trim();
        return {
            size: size, orientation: orientation, margin: margin, marginsPx: m,
            widthPx: w, heightPx: h, color: color, columns: columns, watermark: watermark
        };
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
        page.style.setProperty('--wd-page-h', Math.max(120, d.h - m.top - m.bottom) + 'px');
        body.style.columnCount = pageCfg.columns > 1 ? String(pageCfg.columns) : '';
        body.style.columnGap = pageCfg.columns > 1 ? '38px' : '';
        body.style.columnRule = pageCfg.columns > 1 ? '1px solid #e2e8f0' : '';
        page.style.backgroundColor = pageCfg.color || '#ffffff';
        page.classList.toggle('wd-watermark', !!pageCfg.watermark);
        if (pageCfg.watermark) page.style.setProperty('--wd-wm', '"' + pageCfg.watermark.replace(/"/g, '') + '"');
        else page.style.removeProperty('--wd-wm');
        var ps = byId('wdPageSize'), or = byId('wdOrient'), mg = byId('wdMargin'), col = byId('wdColumns'), pc = byId('wdPageColor');
        if (ps) ps.value = pageCfg.size;
        if (or) or.value = pageCfg.orientation;
        if (mg) mg.value = pageCfg.margin;
        if (col) col.value = String(pageCfg.columns);
        if (pc) pc.value = pageCfg.color;
        var wmBtn = app.querySelector('[data-action="watermark"]');
        if (wmBtn) wmBtn.classList.toggle('on', !!pageCfg.watermark);
        updateCounts();
    }
    function applyZoom(z) {
        z = Math.max(40, Math.min(200, Math.round(Number(z) || 100)));
        zoomLevel = z;
        page.style.zoom = String(z / 100);
        if (zoomText) zoomText.textContent = z + '%';
        if (zoomInput) zoomInput.value = String(Math.max(60, Math.min(150, z)));
    }
    function fitPage() {
        var d = dims(pageCfg);
        var availW = Math.max(240, (canvas ? canvas.clientWidth : window.innerWidth) - (app.classList.contains('wd-nav') ? 244 : 0) - 42);
        var availH = Math.max(240, (canvas ? canvas.clientHeight : window.innerHeight) - 74);
        applyZoom(Math.floor(Math.min(availW / d.w, availH / d.h) * 100));
    }
    function updateCounts() {
        if (!body) return;
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

    // ------------------------------------------------------------ vùng chọn / chèn
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
    function insertText(t) { insertHtml(esc(t).replace(/\r?\n/g, '<br>')); }
    function applyInline(css) {
        focusBody();
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) { setStatus('Hãy bôi đen đoạn văn bản trước.', 'bad'); return; }
        var range = sel.getRangeAt(0);
        if (!body.contains(range.commonAncestorContainer)) { setStatus('Hãy bôi đen đoạn văn bản trước.', 'bad'); return; }
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
    function selectedText() {
        var s = window.getSelection();
        return s && s.rangeCount && body.contains(s.anchorNode) ? s.toString() : '';
    }
    function selectedElement(selector) {
        var s = window.getSelection();
        if (!s || !s.rangeCount) return null;
        var n = s.anchorNode;
        if (n && n.nodeType !== 1) n = n.parentElement;
        return n && n.closest ? n.closest(selector) : null;
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
    function blocksInSelection() {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) return [];
        var r = sel.getRangeAt(0);
        var all = body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,div.word-textbox,div.word-cover,div.word-toc');
        var out = Array.prototype.filter.call(all, function (el) { return r.intersectsNode(el); });
        if (!out.length) { var b = activeBlock(); if (b) out.push(b); }
        return out;
    }
    function eachBlock(fn) {
        var list = blocksInSelection();
        if (!list.length) { toast('Hãy đặt con trỏ vào một đoạn văn hoặc bôi đen nhiều đoạn.', true); return; }
        list.forEach(fn); markDirty();
    }
    function syncToolbar() {
        var n = activeBlock(); if (!n) return;
        var state = function (c) { try { return document.queryCommandState(c); } catch (e) { return false; } };
        ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript', 'insertUnorderedList', 'insertOrderedList',
            'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'].forEach(function (c) {
            var b = app.querySelector('[data-cmd="' + c + '"]');
            if (b) b.classList.toggle('on', !!state(c));
        });
        var block = byId('wdBlock');
        if (block) {
            var tag = n.tagName;
            if (/^(P|H1|H2|H3|H4|BLOCKQUOTE|PRE)$/.test(tag)) block.value = tag;
        }
        Array.prototype.forEach.call(app.querySelectorAll('.wd-style-btn'), function (b) {
            b.classList.toggle('on', String(b.dataset.style) === n.tagName);
        });
        var cs = window.getComputedStyle(n);
        var font = byId('wdFont'), size = byId('wdSize');
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

    // ------------------------------------------------------------ tab ribbon
    function setTab(name) {
        Array.prototype.forEach.call(app.querySelectorAll('.wd-tab'), function (t) {
            var on = t.dataset.tab === name;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Array.prototype.forEach.call(app.querySelectorAll('.wd-pane'), function (p) {
            p.classList.toggle('active', p.dataset.pane === name);
        });
    }
    Array.prototype.forEach.call(app.querySelectorAll('.wd-tab'), function (t) {
        t.addEventListener('click', function () { setTab(t.dataset.tab); });
    });

    // ------------------------------------------------------------ nạp / lưu
    function lockMath() {
        Array.prototype.forEach.call(body.querySelectorAll('math'), function (m) { m.setAttribute('contenteditable', 'false'); });
    }
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
                lockMath();
                loading = false; setDirty(false, 'Đã lưu'); setStatus(''); updateCounts();
                applyPage();
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
        if (window.wdShapes && window.wdShapes.beforeSave) window.wdShapes.beforeSave();
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

    // ------------------------------------------------------------ in / tải / công khai
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
    function paintPublicUi(on) {
        if (publicBtn) {
            publicBtn.dataset.public = on ? '1' : '0';
            publicBtn.classList.toggle('on', !!on);
        }
        var t = byId('wdPublicText');
        if (t) t.textContent = on ? 'Công khai' : 'Riêng tư';
        var rt = byId('wdRibbonPublicText');
        if (rt) rt.textContent = on ? 'Công khai' : 'Riêng tư';
        if (copyBtn) copyBtn.classList.toggle('hidden', !on);
        Array.prototype.forEach.call(app.querySelectorAll('[data-action="public"]'), function (b) {
            b.classList.toggle('on', !!on);
            var old = b.querySelector('[data-lucide],svg');
            if (old) {
                var icon = document.createElement('i');
                icon.setAttribute('data-lucide', on ? 'globe' : 'lock');
                icon.className = 'w-5 h-5';
                old.parentNode.replaceChild(icon, old);
            }
        });
        if (window.lucide) lucide.createIcons();
    }
    function togglePublic() {
        if (!publicBtn) return;
        if (publicBtn.disabled) return;
        publicBtn.click();
    }
    function copyPublicLink() {
        if (!copyBtn || copyBtn.classList.contains('hidden')) { toast('Hãy bật công khai trước khi sao chép link.', true); return; }
        copyBtn.click();
    }
    function openDocList() {
        window.location.href = P.backUrl || '/code/word';
    }
    function newDocDialog() {
        modal({
            title: 'Tài liệu Word mới',
            html: '<label for="wdNewName">Tên tài liệu</label><input type="text" id="wdNewName" placeholder="Ví dụ: Báo cáo tháng 11">' +
                '<p>File sẽ được tạo trong thư mục hiện tại. Nội dung mới bắt đầu với một trang trống.</p>',
            ok: 'Tạo tài liệu',
            onOk: function (box) {
                var n = String((box.querySelector('#wdNewName') || {}).value || '').trim();
                if (!n) { toast('Hãy nhập tên tài liệu.', true); return false; }
                if (!/\.docx$/i.test(n)) n += '.docx';
                jsonFetch('/code/word/file', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ dir: P.dir, name: n })
                }).then(function () {
                    window.location.href = '/code/word/edit?dir=' + encodeURIComponent(P.dir || '') + '&file=' + encodeURIComponent(n);
                }).catch(function (e) { toast('Không tạo được: ' + e.message, true); });
                return true;
            }
        });
    }
    function aboutDialog() {
        var wc = countWords();
        modal({
            title: 'Thông tin tài liệu',
            html: '<p><b>' + esc(P.title || P.file) + '</b><br>' + esc(P.file) + '</p>' +
                '<ul class="wd-modal-list">' +
                '<li>Thư mục: ' + esc(P.dir || '(gốc)') + '</li>' +
                '<li>' + wc.words + ' từ · ' + wc.chars + ' ký tự · ' + wc.paras + ' đoạn</li>' +
                '<li>Khổ giấy: ' + esc(pageCfg.size) + ' · ' + (pageCfg.orientation === 'landscape' ? 'ngang' : 'dọc') + ' · lề ' + esc(pageCfg.margin) + '</li>' +
                '<li>Lưu trữ: HTML được mã hoá AES-256-GCM; tài liệu lớn lưu từng trang mã hoá riêng.</li>' +
                '</ul>'
        });
    }
    function countWords() {
        var text = (body.innerText || '').replace(/\u200b/g, ' ').trim();
        return {
            words: text ? text.split(/\s+/).length : 0,
            chars: text.replace(/\s/g, '').length,
            paras: body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre').length
        };
    }
    function wordCountDialog() {
        var c = countWords();
        modal({
            title: 'Đếm từ',
            html: '<ul class="wd-modal-list"><li><b>' + c.words + '</b> từ</li><li><b>' + c.chars + '</b> ký tự (không tính khoảng trắng)</li>' +
                '<li><b>' + c.paras + '</b> đoạn</li><li><b>' + body.querySelectorAll('.word-comment').length + '</b> nhận xét</li></ul>'
        });
    }

    // ------------------------------------------------------------ tìm / thay thế
    function ensureFindbar() {
        if (findbar) return findbar;
        findbar = document.createElement('div');
        findbar.className = 'wd-findbar';
        findbar.innerHTML = '<input type="text" id="wdFindText" placeholder="Tìm trong tài liệu" aria-label="Tìm">' +
            '<span class="wd-find-count" id="wdFindCount">0/0</span>' +
            '<button type="button" class="wd-btn wd-btn-ghost" data-find-prev title="Kết quả trước">↑</button>' +
            '<button type="button" class="wd-btn wd-btn-ghost" data-find-next title="Kết quả tiếp">↓</button>' +
            '<input type="text" id="wdReplaceText" placeholder="Thay bằng" aria-label="Thay thế">' +
            '<button type="button" class="wd-btn wd-btn-ghost" data-find-replace>Thay</button>' +
            '<button type="button" class="wd-btn wd-btn-ghost" data-find-all>Thay tất cả</button>' +
            '<button type="button" class="wd-btn" data-find-close>Đóng</button>';
        app.appendChild(findbar);
        findbar.querySelector('[data-find-close]').onclick = closeFind;
        findbar.querySelector('[data-find-next]').onclick = function () { findNext(1); };
        findbar.querySelector('[data-find-prev]').onclick = function () { findNext(-1); };
        findbar.querySelector('[data-find-replace]').onclick = replaceCurrent;
        findbar.querySelector('[data-find-all]').onclick = replaceAll;
        var ft = findbar.querySelector('#wdFindText');
        ft.addEventListener('input', function () { findState.dirty = true; findNext(0); });
        ft.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
            if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
        });
        findbar.querySelector('#wdReplaceText').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
            if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
        });
        return findbar;
    }
    var findState = { term: '', dirty: true, matches: [], idx: -1 };
    function textNodesInBody() {
        var out = [];
        var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                var p = n.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (/^(SCRIPT|STYLE|MATH)$/i.test(p.tagName) || p.closest('math')) return NodeFilter.FILTER_REJECT;
                if (!n.nodeValue || !n.nodeValue.length) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        var n;
        while ((n = walker.nextNode())) out.push(n);
        return out;
    }
    function collectMatches(term) {
        var out = [], low = String(term || '').toLowerCase();
        if (!low) return out;
        textNodesInBody().forEach(function (node) {
            var text = String(node.nodeValue || ''), lt = text.toLowerCase(), i = 0;
            while ((i = lt.indexOf(low, i)) >= 0) {
                out.push({ node: node, start: i, end: i + low.length });
                i += Math.max(1, low.length);
            }
        });
        return out;
    }
    function selectMatch(m) {
        if (!m || !m.node || !m.node.parentNode) return;
        var r = document.createRange();
        try {
            r.setStart(m.node, m.start); r.setEnd(m.node, m.end);
            var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
            savedRange = r.cloneRange();
            var el = m.node.parentElement;
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (e) { }
    }
    function updateFindCount() {
        var el = findbar && findbar.querySelector('#wdFindCount');
        if (el) el.textContent = (findState.matches.length ? (findState.idx + 1) : 0) + '/' + findState.matches.length;
    }
    function findNext(dir) {
        if (!findbar) return;
        var term = findbar.querySelector('#wdFindText').value;
        if (findState.dirty || term !== findState.term) {
            findState.term = term; findState.matches = collectMatches(term);
            findState.idx = -1; findState.dirty = false;
        }
        if (!findState.matches.length) { updateFindCount(); toast('Không tìm thấy "' + term + '".', true); return; }
        if (!dir) dir = 1;
        findState.idx = (findState.idx + dir + findState.matches.length) % findState.matches.length;
        selectMatch(findState.matches[findState.idx]);
        updateFindCount();
    }
    function replaceCurrent() {
        if (!findbar) return;
        var term = findbar.querySelector('#wdFindText').value;
        var rep = findbar.querySelector('#wdReplaceText').value;
        if (!term) return;
        if (findState.dirty || term !== findState.term) findNext(1);
        var m = findState.matches[findState.idx];
        if (!m) { findNext(1); return; }
        if (!m.node || !m.node.parentNode) { findState.dirty = true; findNext(1); return; }
        var text = String(m.node.nodeValue || '');
        if (text.slice(m.start, m.end).toLowerCase() !== term.toLowerCase()) { findState.dirty = true; findNext(1); return; }
        m.node.nodeValue = text.slice(0, m.start) + rep + text.slice(m.end);
        markDirty(); findState.dirty = true; findNext(1);
    }
    function replaceAll() {
        if (!findbar) return;
        var term = findbar.querySelector('#wdFindText').value;
        var rep = findbar.querySelector('#wdReplaceText').value;
        if (!term) return;
        var count = 0;
        textNodesInBody().forEach(function (node) {
            var text = String(node.nodeValue || ''), low = text.toLowerCase(), t = term.toLowerCase(), i = 0;
            var out = '', last = 0;
            while ((i = low.indexOf(t, i)) >= 0) {
                out += text.slice(last, i) + rep;
                last = i + term.length; i += Math.max(1, term.length); count++;
            }
            if (last) { out += text.slice(last); node.nodeValue = out; }
        });
        findState.dirty = true; findNext(0);
        markDirty();
        toast(count ? 'Đã thay ' + count + ' chỗ.' : 'Không tìm thấy "' + term + '".', !count);
    }
    function openFind(withReplace) {
        ensureFindbar();
        var sel = selectedText();
        var input = findbar.querySelector('#wdFindText');
        if (sel && sel.length < 140) input.value = sel;
        findbar.style.top = Math.round((app.getBoundingClientRect().top || 0) + (app.querySelector('.wd-topbar') || { offsetHeight: 46 }).offsetHeight + (app.querySelector('.wd-ribbon') || { offsetHeight: 112 }).offsetHeight + 10) + 'px';
        findbar.classList.add('open');
        findState.dirty = true;
        setTimeout(function () {
            (withReplace ? findbar.querySelector('#wdReplaceText') : input).focus();
            if (withReplace) findbar.querySelector('#wdReplaceText').select();
        }, 30);
        if (input.value) findNext(0);
    }
    function closeFind() {
        if (findbar) findbar.classList.remove('open');
        focusBody();
    }

    // ------------------------------------------------------------ định dạng
    function styleOf(el) {
        var cs = window.getComputedStyle(el);
        return ['font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'color', 'background-color']
            .map(function (p) { return p + ':' + cs.getPropertyValue(p); }).join(';');
    }
    function startPainter(btn) {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount || sel.isCollapsed) { toast('Hãy bôi đen đoạn có định dạng cần sao chép.', true); return; }
        var n = sel.anchorNode; if (n && n.nodeType !== 1) n = n.parentElement;
        if (!n) return;
        painterCss = styleOf(n);
        painterActive = true;
        Array.prototype.forEach.call(app.querySelectorAll('[data-action="format-painter"]'), function (b) { b.classList.toggle('on', true); });
        toast('Đã sao chép định dạng. Bôi đen đoạn cần dán.');
        if (btn) btn.blur();
    }
    var painterActive = false;
    function cancelPainter() {
        painterCss = null; painterActive = false;
        Array.prototype.forEach.call(app.querySelectorAll('[data-action="format-painter"]'), function (b) { b.classList.remove('on'); });
    }
    function stepFont(delta) {
        var n = null, sel = window.getSelection();
        if (sel && sel.rangeCount) { n = sel.anchorNode; if (n && n.nodeType !== 1) n = n.parentElement; }
        var px = n && body.contains(n) ? parseFloat(window.getComputedStyle(n).fontSize) : NaN;
        if (!isFinite(px)) {
            var ss = byId('wdSize');
            px = Number(ss && ss.value || 12) * 96 / 72;
        }
        var pt = Math.round(px * 0.75) + (delta > 0 ? 2 : -2);
        pt = Math.max(6, Math.min(96, pt));
        applyInline('font-size:' + Math.round(pt * 96 / 72) + 'px');
        var size = byId('wdSize');
        if (size) {
            var near = Array.prototype.filter.call(size.options, function (o) { return Math.abs(Number(o.value) - pt) <= 1; })[0];
            if (near) size.value = near.value;
        }
    }
    function changeCase() {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount || sel.isCollapsed) { toast('Hãy bôi đen đoạn văn bản cần đổi chữ hoa/thường.', true); return; }
        var r = sel.getRangeAt(0), text = r.toString();
        if (!text) return;
        var modes = ['upper', 'lower', 'title'];
        var mode = modes[caseMode % modes.length]; caseMode++;
        var out = mode === 'upper' ? text.toUpperCase() : mode === 'lower' ? text.toLowerCase() :
            text.replace(/\S+/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
        r.deleteContents();
        var node = document.createTextNode(out);
        r.insertNode(node);
        var nr = document.createRange(); nr.selectNodeContents(node);
        sel.removeAllRanges(); sel.addRange(nr); savedRange = nr.cloneRange();
        syncToolbar(); markDirty();
        toast(mode === 'upper' ? 'Đã đổi thành CHỮ HOA.' : mode === 'lower' ? 'Đã đổi thành chữ thường.' : 'Đã đổi thành Chữ Hoa Đầu Từ.');
    }
    function paraBorder() {
        eachBlock(function (el) {
            var on = !!el.style.border;
            el.style.border = on ? '' : '1px solid #94a3b8';
            el.style.padding = on ? '' : '6px 8px';
        });
    }
    function paraShading() {
        eachBlock(function (el) {
            var on = !!el.style.backgroundColor;
            el.style.backgroundColor = on ? '' : '#fff7d6';
            el.style.padding = on ? '' : '4px 8px';
        });
    }
    function adjustBlocks(prop, delta) {
        eachBlock(function (el) {
            var cur = parseFloat(el.style[prop] || window.getComputedStyle(el)[prop]) || 0;
            el.style[prop] = Math.max(0, Math.min(288, Math.round(cur + delta))) + 'px';
        });
    }
    function applyLineHeight(v) {
        eachBlock(function (el) { el.style.lineHeight = String(v); });
    }

    // ------------------------------------------------------------ chèn
    function insertCover() {
        var title = P.title || (P.file || '').replace(/\.docx$/i, '');
        insertHtml('<div class="word-cover"><h1>' + esc(title) + '</h1><p>' + esc(new Date().toLocaleDateString('vi-VN')) + '</p></div>' +
            '<hr class="word-pagebreak"><p><br></p>');
    }
    function quickTable() {
        var out = ['<table class="word-table" style="border-collapse:collapse;width:100%"><tbody>'];
        for (var r = 0; r < 3; r++) {
            out.push('<tr>');
            for (var c = 0; c < 3; c++) out.push('<td style="border:1px solid #94a3b8;padding:7px 9px;min-width:44px"><br></td>');
            out.push('</tr>');
        }
        out.push('</tbody></table><p><br></p>');
        insertHtml(out.join(''));
    }
    var SYMBOLS = ['©', '®', '™', '€', '£', '¥', '§', '¶', '†', '‡', '•', '…', '°', '±', '×', '÷', '≤', '≥', '≠', '≈', '∞', 'α', 'β', 'γ', 'Δ', 'π', 'Ω', '∑', '√', '∫', '←', '→', '↑', '↓', '↔', '★', '☆', '✓', '✗', '♥', '☺', '☼', '☎', '✉', '⌘', '⌫', '⏎'];
    function insertSymbol() {
        var m = modal({
            title: 'Ký tự đặc biệt',
            html: '<div class="wd-symbol-grid">' + SYMBOLS.map(function (s) {
                return '<button type="button" data-sym="' + esc(s) + '" title="' + esc(s) + '">' + esc(s) + '</button>';
            }).join('') + '</div><p>Bấm một ký tự để chèn vào vị trí con trỏ.</p>'
        });
        Array.prototype.forEach.call(m.el.querySelectorAll('[data-sym]'), function (b) {
            b.onclick = function () {
                var s = b.getAttribute('data-sym');
                closeModal();
                insertText(s);
            };
        });
    }
    function insertBookmark() {
        var name = prompt('Tên đánh dấu (không dấu, không khoảng trắng):', 'muc-' + (body.querySelectorAll('.word-bookmark').length + 1));
        if (!name) return;
        var id = 'bm-' + String(name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        if (!id || id === 'bm-') { toast('Tên đánh dấu không hợp lệ.', true); return; }
        insertHtml('<span class="word-bookmark" id="' + esc(id) + '" title="' + esc(name) + '"></span>');
        toast('Đã đánh dấu "' + name + '" (' + id + ').');
    }
    function headerFooter(kind, value) {
        var cls = kind === 'header' ? 'word-header' : 'word-footer';
        var existing = body.querySelector('.' + cls);
        if (existing) {
            existing.textContent = value;
        } else {
            var html = '<div class="' + cls + '">' + esc(value) + '</div>';
            if (kind === 'header') body.insertAdjacentHTML('afterbegin', html);
            else body.insertAdjacentHTML('beforeend', html);
        }
        markDirty();
        toast('Đã cập nhật ' + (kind === 'header' ? 'đầu trang' : 'chân trang') + '.');
    }
    function insertHeader() {
        var old = body.querySelector('.word-header');
        var v = prompt('Nội dung đầu trang:', old ? old.textContent : (P.title || ''));
        if (v == null) return;
        headerFooter('header', v);
    }
    function insertFooter() {
        var old = body.querySelector('.word-footer');
        var v = prompt('Nội dung chân trang:', old ? old.textContent : '');
        if (v == null) return;
        headerFooter('footer', v);
    }
    function insertPageNumber() {
        var f = body.querySelector('.word-footer');
        if (f) f.insertAdjacentHTML('beforeend', ' · Trang 1');
        else body.insertAdjacentHTML('beforeend', '<div class="word-footer">Trang 1</div>');
        markDirty();
        toast('Đã thêm số trang vào chân trang.');
    }
    function insertTextbox() {
        insertHtml('<div class="word-textbox"><p>Nhập nội dung hộp văn bản…</p></div><p><br></p>');
    }
    function insertDate() {
        insertText(new Date().toLocaleString('vi-VN'));
    }

    // ------------------------------------------------------------ tham khảo
    function headings() { return Array.prototype.slice.call(body.querySelectorAll('h1,h2,h3')); }
    function ensureHeadingIds() {
        headings().forEach(function (h, i) { if (!h.id) h.id = 'muc-' + (i + 1); });
        return headings();
    }
    function tocHtml(title, entries) {
        var out = ['<div class="word-toc"><p><b>' + esc(title) + '</b></p>'];
        if (!entries.length) out.push('<p><i>Chưa có mục nào.</i></p>');
        else entries.forEach(function (e) {
            out.push('<p style="margin-left:' + Math.max(0, (Number(e.level) || 1) - 1) * 18 + 'px"><a href="#' + esc(e.id) + '">' + esc(e.text) + '</a></p>');
        });
        out.push('</div>');
        return out.join('');
    }
    function insertToc() {
        var hs = ensureHeadingIds();
        if (!hs.length) { toast('Hãy tạo ít nhất một tiêu đề (H1/H2/H3) trước.', true); return; }
        var entries = hs.map(function (h) { return { id: h.id, text: h.textContent.trim() || '(không tên)', level: Number(String(h.tagName).slice(1)) }; });
        insertHtml(tocHtml('Mục lục', entries) + '<p><br></p>');
        markDirty();
    }
    function findToc() {
        return Array.prototype.filter.call(body.querySelectorAll('.word-toc'), function (el) { return /Mục lục/.test(el.textContent || ''); })[0] || null;
    }
    function updateToc() {
        var toc = findToc();
        if (!toc) { insertToc(); return; }
        var hs = ensureHeadingIds();
        var entries = hs.map(function (h) { return { id: h.id, text: h.textContent.trim() || '(không tên)', level: Number(String(h.tagName).slice(1)) }; });
        toc.outerHTML = tocHtml('Mục lục', entries);
        markDirty();
        toast('Đã cập nhật mục lục.');
    }
    function noteNumber() { return body.querySelectorAll('sup.word-footnote').length + 1; }
    function insertNote(end) {
        var n = noteNumber();
        var text = prompt(end ? 'Nội dung chú thích cuối tài liệu:' : 'Nội dung chú thích cuối trang:', '');
        if (text == null) return;
        var span = document.createElement('sup');
        span.className = 'word-footnote';
        span.title = text;
        span.textContent = '[' + n + ']';
        var sel = window.getSelection();
        if (sel && sel.rangeCount && body.contains(sel.anchorNode)) {
            var r = sel.getRangeAt(0);
            r.deleteContents();
            r.insertNode(span);
            var after = document.createRange(); after.setStartAfter(span); after.collapse(true);
            sel.removeAllRanges(); sel.addRange(after); savedRange = after.cloneRange();
        } else {
            body.appendChild(span);
        }
        body.insertAdjacentHTML('beforeend', '<p class="word-footnote" style="font-size:12.5px;color:#475569">[' + n + '] ' + esc(text) + '</p>');
        markDirty();
        toast('Đã thêm chú thích [' + n + '].');
    }
    function nextFootnote() {
        var list = body.querySelectorAll('.word-footnote');
        if (!list.length) { toast('Tài liệu chưa có chú thích.', true); return; }
        noteIndex = (noteIndex + 1) % list.length;
        var el = list[noteIndex];
        el.scrollIntoView({ block: 'center' });
        var r = document.createRange(); r.selectNodeContents(el);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); savedRange = r.cloneRange();
        toast('Chú thích ' + (noteIndex + 1) + '/' + list.length + ': ' + (el.title || el.textContent));
    }
    function insertCitation() {
        var source = prompt('Nguồn trích dẫn (tác giả, năm, tên tài liệu):', '');
        if (!source) return;
        insertHtml('<span class="word-citation" title="' + esc(source) + '">(' + esc(source) + ')</span>');
    }
    function citationList() {
        var seen = {}, out = [];
        Array.prototype.forEach.call(body.querySelectorAll('.word-citation'), function (el) {
            var t = String(el.title || el.textContent || '').replace(/^\(|\)$/g, '').trim();
            if (t && !seen[t]) { seen[t] = 1; out.push(t); }
        });
        return out;
    }
    function insertBibliography() {
        var list = citationList();
        if (!list.length) {
            var s = prompt('Chưa có trích dẫn nào. Nhập nguồn đầu tiên:', '');
            if (!s) return;
            insertHtml('<span class="word-citation" title="' + esc(s) + '">(' + esc(s) + ')</span>');
            list = [s];
        }
        var html = '<div class="word-toc"><p><b>Tài liệu tham khảo</b></p>' +
            list.map(function (s, i) { return '<p>[' + (i + 1) + '] ' + esc(s) + '</p>'; }).join('') + '</div><p><br></p>';
        insertHtml(html);
    }
    function manageSources() {
        var list = citationList();
        modal({
            title: 'Quản lý nguồn trích dẫn',
            html: (list.length ? '<ul class="wd-modal-list">' + list.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '<p>Chưa có nguồn nào.</p>') +
                '<label for="wdNewSource">Thêm nguồn mới (chèn ngay tại con trỏ)</label><input type="text" id="wdNewSource" placeholder="Tác giả, năm, tên tài liệu">',
            ok: 'Thêm & chèn',
            onOk: function (box) {
                var s = String((box.querySelector('#wdNewSource') || {}).value || '').trim();
                if (!s) return true;
                insertHtml('<span class="word-citation" title="' + esc(s) + '">(' + esc(s) + ')</span>');
            }
        });
    }
    function insertCaption() {
        var n = body.querySelectorAll('.word-caption').length + 1;
        var table = activeBlock() && activeBlock().closest ? activeBlock().closest('table') : null;
        var label = table ? 'Bảng' : 'Hình';
        var text = prompt('Nội dung chú thích ' + label.toLowerCase() + ':', '');
        if (text == null) return;
        insertHtml('<p class="word-caption">' + label + ' ' + n + ': ' + esc(text) + '</p>');
    }
    function crossReference() {
        var id = prompt('Mã đánh dấu hoặc tiêu đề cần tham chiếu (ví dụ: bm-muc-1, muc-2):', '');
        if (!id) return;
        var clean = String(id).trim().replace(/^#/, '');
        if (!/^[A-Za-z][\w:.-]{0,63}$/.test(clean)) { toast('Mã tham chiếu không hợp lệ.', true); return; }
        var text = prompt('Chữ hiển thị:', 'Xem mục');
        if (text == null) return;
        insertHtml('<a href="#' + esc(clean) + '">' + esc(text || clean) + '</a>');
    }
    function indexEntry() {
        var sel = selectedText();
        var term = prompt('Mục tra cứu:', sel || '');
        if (!term) return;
        var id = 'idx-' + String(term).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
        if (!id || id === 'idx-') id = 'idx-' + hexId().slice(0, 8);
        insertHtml('<span class="word-bookmark" id="' + esc(id) + '" title="' + esc(term) + '"></span>');
        toast('Đã đánh dấu mục tra cứu "' + term + '".');
    }
    function insertIndex() {
        var entries = [];
        Array.prototype.forEach.call(body.querySelectorAll('[id^="idx-"]'), function (el) {
            var t = String(el.title || '').trim();
            if (t && entries.indexOf(t) < 0) entries.push(t);
        });
        entries.sort(function (a, b) { return a.localeCompare(b, 'vi'); });
        var html = '<div class="word-toc"><p><b>Mục tra cứu</b></p>' +
            (entries.length ? entries.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') : '<p><i>Chưa có mục tra cứu nào.</i></p>') +
            '</div><p><br></p>';
        insertHtml(html);
    }

    // ------------------------------------------------------------ xem lại
    function toggleSpell() {
        body.spellcheck = !body.spellcheck;
        var btn = app.querySelector('[data-action="spellcheck"]');
        if (btn) btn.classList.toggle('on', body.spellcheck);
        toast(body.spellcheck ? 'Đã bật kiểm tra chính tả của trình duyệt.' : 'Đã tắt kiểm tra chính tả.');
    }
    function addComment() {
        var note = prompt('Nội dung nhận xét:', '');
        if (note == null) return;
        var text = selectedText();
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount || !body.contains(sel.anchorNode)) { toast('Hãy bôi đen đoạn cần nhận xét.', true); return; }
        var r = sel.getRangeAt(0);
        var span = document.createElement('span');
        span.className = 'word-comment';
        span.title = note || 'Nhận xét';
        if (r.collapsed) {
            span.textContent = '[Ghi chú]';
            r.insertNode(span);
        } else {
            try { r.surroundContents(span); }
            catch (e) { var frag = r.extractContents(); span.appendChild(frag); r.insertNode(span); }
        }
        var nr = document.createRange(); nr.selectNodeContents(span);
        sel.removeAllRanges(); sel.addRange(nr); savedRange = nr.cloneRange();
        markDirty();
        toast('Đã thêm nhận xét' + (text ? ' cho đoạn đã chọn.' : '.'));
    }
    function closestComment() {
        var n = selectedElement('.word-comment');
        return n || null;
    }
    function unwrap(el) {
        if (!el || !el.parentNode) return;
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.parentNode.removeChild(el);
    }
    function deleteComment() {
        var one = closestComment();
        if (one) { unwrap(one); markDirty(); toast('Đã xoá nhận xét.'); return; }
        var all = body.querySelectorAll('.word-comment');
        if (!all.length) { toast('Tài liệu không có nhận xét nào.', true); return; }
        if (!confirm('Xoá tất cả ' + all.length + ' nhận xét? Nội dung được giữ lại.')) return;
        Array.prototype.forEach.call(all, unwrap);
        markDirty(); toast('Đã xoá tất cả nhận xét.');
    }
    function toggleComments() {
        var hidden = app.classList.toggle('wd-hide-comments');
        var btn = app.querySelector('[data-action="show-comments"]');
        if (btn) btn.classList.toggle('on', hidden);
        toast(hidden ? 'Đã ẩn nhận xét.' : 'Đã hiện nhận xét.');
    }
    function toggleTrack() {
        trackOn = !trackOn;
        var btn = app.querySelector('[data-action="track-changes"]');
        if (btn) btn.classList.toggle('on', trackOn);
        toast(trackOn ? 'Đã bật theo dõi thay đổi (nhận xét được đánh dấu màu vàng).' : 'Đã tắt theo dõi thay đổi.');
    }
    function acceptAll() {
        var all = body.querySelectorAll('.word-comment');
        Array.prototype.forEach.call(all, unwrap);
        if (all.length) markDirty();
        toast(all.length ? 'Đã chấp nhận ' + all.length + ' thay đổi.' : 'Không có thay đổi nào cần chấp nhận.');
    }
    function rejectAll() {
        var all = body.querySelectorAll('.word-comment');
        if (!all.length) { toast('Không có thay đổi nào cần từ chối.'); return; }
        if (!confirm('Từ chối và xoá ' + all.length + ' phần đã đánh dấu? Nội dung bên trong cũng bị xoá.')) return;
        Array.prototype.forEach.call(all, function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
        markDirty(); toast('Đã từ chối ' + all.length + ' thay đổi.');
    }
    function syncLockUi() {
        var btn = app.querySelector('[data-action="protect"]');
        if (btn) btn.classList.toggle('on', body.isContentEditable === false);
        app.classList.toggle('wd-locked', body.isContentEditable === false);
    }
    function toggleProtect() {
        if (body.isContentEditable === false) {
            var p = prompt('Nhập mật khẩu để mở khoá chỉnh sửa:');
            if (p == null) return;
            if (p !== lockPw) { toast('Mật khẩu không đúng.', true); return; }
            body.contentEditable = 'true';
            lockPw = null; syncLockUi(); focusBody();
            toast('Đã mở khoá chỉnh sửa.');
            return;
        }
        modal({
            title: 'Bảo vệ tài liệu',
            html: '<p>Khoá chỉnh sửa trong phiên làm việc này. Mật khẩu không được lưu lên máy chủ.</p>' +
                '<label for="wdLock1">Mật khẩu (tối thiểu 4 ký tự)</label><input type="password" id="wdLock1">' +
                '<label for="wdLock2">Nhập lại mật khẩu</label><input type="password" id="wdLock2">',
            ok: 'Khoá',
            onOk: function (box) {
                var a = String((box.querySelector('#wdLock1') || {}).value || '');
                var b = String((box.querySelector('#wdLock2') || {}).value || '');
                if (a.length < 4) { toast('Mật khẩu phải có ít nhất 4 ký tự.', true); return false; }
                if (a !== b) { toast('Mật khẩu nhập lại không khớp.', true); return false; }
                lockPw = a;
                body.contentEditable = 'false';
                syncLockUi();
                toast('Đã khoá chỉnh sửa. Bấm lại "Bảo vệ" để mở khoá.');
            }
        });
    }
    function compareDialog() {
        modal({
            title: 'So sánh tài liệu',
            html: '<p>Để so sánh, hãy mở tài liệu cần đối chiếu trong một tab khác rồi dùng trình duyệt đặt cạnh nhau. ' +
                'Bản so sánh tự động (track changes) sẽ được bổ sung sau.</p>',
            ok: 'Mở danh sách tài liệu',
            onOk: function () { window.open(P.backUrl || '/code/word', '_blank', 'noopener'); }
        });
    }

    // ------------------------------------------------------------ xem / bố cục
    function toggleClass(cls, action, btn) {
        var on = app.classList.toggle(cls);
        if (btn) btn.classList.toggle('on', on);
        if (action) toast((action === true ? '' : ''));
        return on;
    }
    function toggleRead() {
        var on = app.classList.toggle('wd-read');
        var btn = app.querySelector('[data-action="read-mode"]');
        if (btn) btn.classList.toggle('on', on);
        if (on) {
            if (!readExit) {
                readExit = document.createElement('button');
                readExit.type = 'button';
                readExit.className = 'wd-read-exit';
                readExit.textContent = 'Thoát chế độ đọc';
                readExit.onclick = toggleRead;
                document.body.appendChild(readExit);
            }
            toast('Đang ở chế độ đọc. Bấm "Thoát chế độ đọc" để quay lại.');
        } else if (readExit && readExit.parentNode) {
            readExit.parentNode.removeChild(readExit); readExit = null;
        }
    }
    function setLayout(kind) {
        app.classList.remove('wd-read');
        if (readExit && readExit.parentNode) { readExit.parentNode.removeChild(readExit); readExit = null; }
        app.classList.toggle('wd-web', kind === 'web');
        var rb = app.querySelector('[data-action="read-mode"]');
        if (rb) rb.classList.remove('on');
        var pb = app.querySelector('[data-action="print-layout"]');
        if (pb) pb.classList.toggle('on', kind === 'print');
        var wb = app.querySelector('[data-action="web-layout"]');
        if (wb) wb.classList.toggle('on', kind === 'web');
        toast(kind === 'web' ? 'Đã chuyển sang bố cục web.' : 'Đã chuyển sang bố cục in.');
    }
    function toggleDark() {
        var on = app.classList.toggle('wd-dark');
        var btn = app.querySelector('[data-action="dark"]');
        if (btn) btn.classList.toggle('on', on);
        if (modalEl) modalEl.classList.toggle('wd-dark', on);
        toast(on ? 'Đã bật chế độ tối.' : 'Đã tắt chế độ tối.');
    }
    function buildNav() {
        if (!navEl) {
            navEl = document.createElement('aside');
            navEl.className = 'wd-navpane';
            canvas.appendChild(navEl);
        }
        var hs = ensureHeadingIds();
        navEl.innerHTML = '<h3>Dẫn hướng</h3>';
        if (!hs.length) {
            var empty = document.createElement('div');
            empty.className = 'wd-nav-empty';
            empty.textContent = 'Chưa có tiêu đề. Dùng kiểu Tiêu đề 1/2/3 để tạo mục dẫn hướng.';
            navEl.appendChild(empty);
            return;
        }
        hs.forEach(function (h) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'wd-nav-item lv' + Math.min(3, Number(String(h.tagName).slice(1)) || 1);
            b.textContent = h.textContent.trim() || '(không tên)';
            b.onclick = function () {
                h.scrollIntoView({ behavior: 'smooth', block: 'center' });
                var r = document.createRange(); r.selectNodeContents(h);
                var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); savedRange = r.cloneRange();
            };
            navEl.appendChild(b);
        });
    }
    function toggleNav() {
        var on = app.classList.toggle('wd-nav');
        var btn = app.querySelector('[data-action="navigation"]');
        if (btn) btn.classList.toggle('on', on);
        if (on) buildNav();
        toast(on ? 'Đã mở khung dẫn hướng.' : 'Đã đóng khung dẫn hướng.');
    }
    function toggleWatermark() {
        var text = prompt('Chữ hình chìm (để trống để tắt):', pageCfg.watermark || 'BẢN NHÁP');
        if (text == null) return;
        pageCfg.watermark = String(text).trim().slice(0, 60);
        applyPage(); markDirty();
        toast(pageCfg.watermark ? 'Đã thêm hình chìm.' : 'Đã tắt hình chìm.');
    }
    function toggleLineNumbers() {
        var on = page.classList.toggle('wd-lines');
        var btn = app.querySelector('[data-action="line-numbers"]');
        if (btn) btn.classList.toggle('on', on);
        toast(on ? 'Đã bật vạch số dòng.' : 'Đã tắt vạch số dòng.');
    }
    function reorderSelected(front) {
        var el = (window.wdShapes && window.wdShapes.current && window.wdShapes.current()) || selectedElement('img,.word-shape,.word-textbox');
        if (!el) { toast('Hãy bấm vào ảnh/hình khối cần sắp xếp.', true); return; }
        if (window.wdShapes && el.classList && el.classList.contains('word-shape')) { window.wdShapes.layer(front ? 1 : -1); return; }
        var p = el.parentNode;
        if (!p) return;
        if (front) p.appendChild(el); else p.insertBefore(el, p.firstChild);
        markDirty();
        toast(front ? 'Đã đưa lên trước.' : 'Đã đưa ra sau.');
    }
    function pageSetupDialog() {
        var m = modal({
            title: 'Thiết lập trang',
            html: '<label for="psSize">Khổ giấy</label><select id="psSize"><option value="A4">A4</option><option value="Letter">Letter</option></select>' +
                '<label for="psOrient">Hướng giấy</label><select id="psOrient"><option value="portrait">Dọc</option><option value="landscape">Ngang</option></select>' +
                '<label for="psMargin">Lề</label><select id="psMargin"><option value="normal">Lề thường</option><option value="narrow">Lề hẹp</option><option value="wide">Lề rộng</option></select>' +
                '<label for="psColor">Màu nền trang</label><input type="color" id="psColor" value="' + esc(pageCfg.color) + '" style="width:60px;min-height:34px;padding:2px">',
            ok: 'Áp dụng',
            onOk: function (box) {
                pageCfg = normalizePage({
                    size: (box.querySelector('#psSize') || {}).value,
                    orientation: (box.querySelector('#psOrient') || {}).value,
                    margin: (box.querySelector('#psMargin') || {}).value,
                    color: (box.querySelector('#psColor') || {}).value,
                    columns: pageCfg.columns,
                    watermark: pageCfg.watermark,
                    marginsPx: pageCfg.marginsPx
                });
                applyPage(); markDirty();
            }
        });
        m.el.querySelector('#psSize').value = pageCfg.size;
        m.el.querySelector('#psOrient').value = pageCfg.orientation;
        m.el.querySelector('#psMargin').value = pageCfg.margin === 'custom' ? 'normal' : pageCfg.margin;
        m.el.querySelector('#psColor').value = pageCfg.color;
    }
    function changePage() {
        var ps = byId('wdPageSize'), or = byId('wdOrient'), mg = byId('wdMargin');
        pageCfg = normalizePage({
            size: ps ? ps.value : pageCfg.size,
            orientation: or ? or.value : pageCfg.orientation,
            margin: mg ? mg.value : pageCfg.margin,
            color: pageCfg.color,
            columns: pageCfg.columns,
            watermark: pageCfg.watermark,
            marginsPx: pageCfg.marginsPx
        });
        applyPage(); markDirty();
    }

    // ------------------------------------------------------------ trợ giúp
    function helpDialog() {
        modal({
            title: 'Trợ giúp soạn Word',
            html: '<p>Trình soạn hỗ trợ đầy đủ các thẻ ribbon như Word. Nội dung được lưu dưới dạng HTML đã mã hoá; khi tải về sẽ chuyển thành .docx thật.</p>' +
                '<ul class="wd-modal-list">' +
                '<li><b>Lưu</b>: Ctrl+S. Tài liệu rất lớn được tách thành nhiều trang mã hoá riêng.</li>' +
                '<li><b>Tải về</b>: nếu .docx vượt giới hạn, hệ thống tạo <i>ten-1.docx, ten-2.docx…</i> trong file ZIP — hình ảnh giữ nguyên chất lượng.</li>' +
                '<li><b>Ảnh</b>: kéo/thả hoặc dán trực tiếp vào trang.</li>' +
                '<li><b>Chèn nhanh</b>: Ctrl+F tìm, Ctrl+H thay thế, Ctrl+K liên kết, Ctrl+Enter ngắt trang.</li>' +
                '<li><b>Công khai</b>: bật ở thẻ Tệp hoặc nút trên thanh trên; link dạng /w.</li>' +
                '</ul>'
        });
    }
    function shortcutsDialog() {
        modal({
            title: 'Phím tắt',
            html: '<ul class="wd-modal-list">' +
                '<li><kbd>Ctrl</kbd> + <kbd>S</kbd> — Lưu</li>' +
                '<li><kbd>Ctrl</kbd> + <kbd>F</kbd> — Tìm</li>' +
                '<li><kbd>Ctrl</kbd> + <kbd>H</kbd> — Thay thế</li>' +
                '<li><kbd>Ctrl</kbd> + <kbd>K</kbd> — Chèn liên kết</li>' +
                '<li><kbd>Ctrl</kbd> + <kbd>Enter</kbd> — Ngắt trang</li>' +
                '<li><kbd>Ctrl</kbd> + <kbd>B</kbd> / <kbd>I</kbd> / <kbd>U</kbd> — Đậm / nghiêng / gạch chân</li>' +
                '<li><kbd>Esc</kbd> — Đóng hộp thoại / thanh tìm</li>' +
                '</ul>'
        });
    }
    function contactDialog() {
        modal({
            title: 'Liên hệ',
            html: '<p>Gửi câu hỏi cho quản trị viên hệ thống qua hộp thư hỗ trợ.</p>' +
                '<p><a href="mailto:hotro@example.com?subject=H%E1%BB%97%20tr%E1%BB%A3%20Word">hotro@example.com</a></p>'
        });
    }
    function feedbackDialog() {
        modal({
            title: 'Gửi phản hồi',
            html: '<label for="wdFeedback">Nội dung phản hồi</label><textarea id="wdFeedback" placeholder="Bạn muốn góp ý điều gì?"></textarea>',
            ok: 'Gửi',
            onOk: function (box) {
                var t = String((box.querySelector('#wdFeedback') || {}).value || '').trim();
                if (!t) { toast('Hãy nhập nội dung phản hồi.', true); return false; }
                window.location.href = 'mailto:hotro@example.com?subject=' + encodeURIComponent('Phản hồi Word: ' + P.file) + '&body=' + encodeURIComponent(t);
            }
        });
    }

    // ------------------------------------------------------------ bảng hành động
    function cmdAction(cmd) {
        if (cmd === 'paste') {
            if (navigator.clipboard && navigator.clipboard.readText) {
                navigator.clipboard.readText().then(function (t) {
                    if (t) insertText(t); else toast('Bộ nhớ tạm trống.', true);
                }, function () { toast('Trình duyệt chặn dán — hãy dùng Ctrl+V.', true); });
            } else toast('Hãy dùng Ctrl+V để dán.', true);
            return;
        }
        exec(cmd);
    }
    var actions = {
        'save': save,
        'download': downloadDoc,
        'print': function () { window.print(); },
        'new-doc': newDocDialog,
        'open-doc': openDocList,
        'public': togglePublic,
        'copy-link': copyPublicLink,
        'about': aboutDialog,
        'format-painter': startPainter,
        'grow-font': function () { stepFont(1); },
        'shrink-font': function () { stepFont(-1); },
        'change-case': changeCase,
        'para-border': paraBorder,
        'para-shading': paraShading,
        'find': function () { openFind(false); },
        'replace': function () { openFind(true); },
        'cover': insertCover,
        'blank-page': function () { insertHtml('<hr class="word-pagebreak"><p><br></p>'); },
        'quick-table': quickTable,
        'icon': insertSymbol,
        'bookmark': insertBookmark,
        'header': insertHeader,
        'footer': insertFooter,
        'page-number': insertPageNumber,
        'textbox': insertTextbox,
        'date': insertDate,
        'symbol': insertSymbol,
        'page-setup': pageSetupDialog,
        'indent-left': function () { adjustBlocks('marginLeft', 24); },
        'indent-right': function () { adjustBlocks('marginRight', 24); },
        'space-before': function () { adjustBlocks('marginTop', 6); },
        'space-after': function () { adjustBlocks('marginBottom', 6); },
        'watermark': toggleWatermark,
        'line-numbers': toggleLineNumbers,
        'bring-front': function () { reorderSelected(true); },
        'send-back': function () { reorderSelected(false); },
        'toc': insertToc,
        'toc-update': updateToc,
        'footnote': function () { insertNote(false); },
        'endnote': function () { insertNote(true); },
        'next-footnote': nextFootnote,
        'citation': insertCitation,
        'bibliography': insertBibliography,
        'manage-sources': manageSources,
        'caption': insertCaption,
        'cross-reference': crossReference,
        'index-entry': indexEntry,
        'index': insertIndex,
        'spellcheck': toggleSpell,
        'word-count': wordCountDialog,
        'comment': addComment,
        'delete-comment': deleteComment,
        'show-comments': toggleComments,
        'track-changes': toggleTrack,
        'accept-all': acceptAll,
        'reject-all': rejectAll,
        'protect': toggleProtect,
        'compare': compareDialog,
        'read-mode': toggleRead,
        'print-layout': function () { setLayout('print'); },
        'web-layout': function () { setLayout('web'); },
        'ruler': function (btn) { toggleClass('wd-ruler', null, btn); toast(app.classList.contains('wd-ruler') ? 'Đã hiện thước.' : 'Đã ẩn thước.'); },
        'gridlines': function (btn) { toggleClass('wd-grid', null, btn); toast(app.classList.contains('wd-grid') ? 'Đã hiện đường lưới.' : 'Đã ẩn đường lưới.'); },
        'navigation': toggleNav,
        'dark': toggleDark,
        'separate-pages': function (btn) { toggleClass('wd-sep', null, btn); toast(app.classList.contains('wd-sep') ? 'Đã tách trang bằng vạch ngăn.' : 'Đã bỏ vạch ngăn trang.'); },
        'zoom-out': function () { applyZoom(zoomLevel - 10); },
        'zoom-in': function () { applyZoom(zoomLevel + 10); },
        'zoom-100': function () { applyZoom(100); },
        'fit-page': fitPage,
        'help': helpDialog,
        'shortcuts': shortcutsDialog,
        'contact': contactDialog,
        'feedback': feedbackDialog
    };
    function runAction(name, btn) {
        var fn = actions[name];
        if (!fn) { toast('Chức năng "' + name + '" chưa được hỗ trợ.', true); return; }
        try { fn(btn); }
        catch (e) { toast('Không thực hiện được: ' + e.message, true); }
    }

    // ------------------------------------------------------------ gắn sự kiện
    Array.prototype.forEach.call(app.querySelectorAll('.wd-ribbon button'), function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    });
    Array.prototype.forEach.call(app.querySelectorAll('.wd-ribbon [data-cmd]'), function (b) {
        b.addEventListener('click', function () { cmdAction(b.dataset.cmd); });
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-action]'), function (b) {
        b.addEventListener('click', function () { runAction(b.dataset.action, b); });
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-style]'), function (b) {
        b.addEventListener('click', function () {
            exec('formatBlock', '<' + b.dataset.style + '>');
            syncToolbar();
        });
    });

    body.addEventListener('input', markDirty);
    body.addEventListener('keyup', updateCounts);
    body.addEventListener('mouseup', function () {
        rememberSelection(); syncToolbar();
        if (painterActive && painterCss) {
            var s = window.getSelection();
            if (s && s.rangeCount && !s.isCollapsed) {
                applyInline(painterCss); cancelPainter();
                toast('Đã dán định dạng.');
            }
        }
    });

    var fontSel = byId('wdFont');
    if (fontSel) fontSel.onchange = function () { applyInline('font-family:' + fontSel.value); };
    var sizeSel = byId('wdSize');
    if (sizeSel) sizeSel.onchange = function () {
        var px = Math.max(6, Math.round(Number(sizeSel.value) * 96 / 72));
        applyInline('font-size:' + px + 'px');
    };
    var blockSel = byId('wdBlock');
    if (blockSel) blockSel.onchange = function () { exec('formatBlock', '<' + blockSel.value + '>'); };
    var color = byId('wdColor');
    if (color) color.onchange = function () { exec('foreColor', color.value); };
    var hilite = byId('wdHilite');
    if (hilite) hilite.onchange = function () {
        focusBody();
        try { document.execCommand('styleWithCSS', false, true); document.execCommand('hiliteColor', false, hilite.value); }
        catch (e) { try { document.execCommand('backColor', false, hilite.value); } catch (_) { } }
        syncToolbar(); markDirty();
    };
    var lineHeight = byId('wdLineHeight');
    if (lineHeight) lineHeight.onchange = function () { applyLineHeight(lineHeight.value); };
    var columns = byId('wdColumns');
    if (columns) columns.onchange = function () {
        pageCfg.columns = Math.max(1, Math.min(3, Number(columns.value) || 1));
        applyPage(); markDirty();
    };
    var pageColor = byId('wdPageColor');
    if (pageColor) pageColor.onchange = function () {
        pageCfg.color = pageColor.value; applyPage(); markDirty();
    };

    var clearBtn = byId('wdClear');
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
    var tableBtn = byId('wdTable');
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
            var alt = String(file.name || '').replace(/\.[^.]+$/, '').replace(/["<>&]/g, '');
            insertHtml('<img src="' + reader.result + '" alt="' + alt + '" style="max-width:100%;height:auto">');
            markDirty();
        };
        reader.readAsDataURL(file);
    }
    var imageBtn = byId('wdImage');
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
    var linkBtn = byId('wdLink');
    if (linkBtn) linkBtn.onclick = function () {
        var url = prompt('Địa chỉ liên kết (https://…, mailto:… hoặc #mục):', 'https://');
        if (!url) return;
        url = url.trim();
        if (!/^(https?:\/\/|mailto:|tel:|#)/i.test(url)) { alert('Liên kết phải bắt đầu bằng http://, https://, mailto:, tel: hoặc #.'); return; }
        exec('createLink', url);
    };
    var ruleBtn = byId('wdRule');
    if (ruleBtn) ruleBtn.onclick = function () { insertHtml('<hr><p><br></p>'); };
    var pbBtn = byId('wdPageBreak');
    if (pbBtn) pbBtn.onclick = function () { insertHtml('<hr class="word-pagebreak"><p><br></p>'); };

    // khổ giấy / lề
    ['wdPageSize', 'wdOrient', 'wdMargin'].forEach(function (id) {
        var el = byId(id);
        if (el) el.addEventListener('change', changePage);
    });
    if (zoomInput) zoomInput.addEventListener('input', function () { applyZoom(zoomInput.value); });

    // công khai / riêng tư
    if (publicBtn) publicBtn.addEventListener('click', function () {
        var next = publicBtn.dataset.public !== '1';
        publicBtn.disabled = true;
        jsonFetch(P.visibilityUrl, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ dir: P.dir, file: P.file, public: next })
        }).then(function () {
            paintPublicUi(next);
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
    var dlBtn = byId('wdDownload');
    if (dlBtn) dlBtn.onclick = downloadDoc;
    var printBtn = byId('wdPrint');
    if (printBtn) printBtn.onclick = function () { window.print(); };

    document.addEventListener('keydown', function (e) {
        var k = String(e.key || '').toLowerCase();
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 's') { e.preventDefault(); save(); return; }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'f') { e.preventDefault(); openFind(false); return; }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'h') { e.preventDefault(); openFind(true); return; }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'k') { e.preventDefault(); if (linkBtn) linkBtn.click(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (pbBtn) pbBtn.click(); return; }
        if (e.key === 'Escape') {
            if (modalEl) { closeModal(); return; }
            if (findbar && findbar.classList.contains('open')) { closeFind(); return; }
            if (painterActive) { cancelPainter(); return; }
        }
        if ((e.ctrlKey || e.metaKey) && k === 'p') {
            // để trình duyệt in; CSS @media print đã ẩn thanh công cụ
        }
    });
    window.addEventListener('beforeunload', function (e) {
        if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
    });
    ['input', 'keyup', 'paste', 'cut'].forEach(function (ev) {
        body.addEventListener(ev, function () { setTimeout(updateCounts, 0); });
    });
    document.addEventListener('selectionchange', function () {
        if (!app.classList.contains('wd-nav')) return;
        // giữ khung dẫn hướng đồng bộ khi thêm/bớt tiêu đề
        clearTimeout(window.__wdNavTimer);
        window.__wdNavTimer = setTimeout(function () { buildNav(); }, 450);
    });

    // ------------------------------------------------------------ bắt đầu
    applyPage();
    var initialZoom = 100;
    var available = (canvas ? canvas.clientWidth : window.innerWidth) - 34;
    var baseW = dims(pageCfg).w;
    if (available < baseW) initialZoom = Math.max(45, Math.min(95, Math.floor(available / baseW * 100)));
    applyZoom(initialZoom);
    if (pageCfg.margin === 'custom') {
        var mg = byId('wdMargin');
        if (mg) {
            if (!mg.querySelector('option[value="custom"]')) {
                var o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Lề hiện tại'; mg.appendChild(o);
            }
            mg.value = 'custom';
        }
    }
    window.__wd = {
        app: app, body: body, page: page, canvas: canvas,
        markDirty: markDirty, toast: toast, setTab: setTab, esc: esc, modal: modal,
        getZoom: function () { return zoomLevel; },
        getPage: function () { return pageCfg; },
        dims: function () { return dims(pageCfg); }
    };
    if (window.wdShapes && window.wdShapes.init) window.wdShapes.init();
    paintPublicUi(P.public === true);
    syncLockUi();
    setDirty(false, 'Đang mở…');
    setTab('home');
    loadContent();
    if (window.lucide) lucide.createIcons();
})();
