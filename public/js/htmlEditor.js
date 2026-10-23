// public/js/htmlEditor.js — trình soạn HTML/CSS/JS: tab Code ⇄ View, lưu, xem trang trong iframe sandbox (tự cao theo nội dung).
(function () {
    'use strict';
    var P = JSON.parse(document.getElementById('payload').textContent);
    var $ = function (id) { return document.getElementById(id); };
    var app = $('hxApp'), ed = $('hxEditor'), gut = $('hxGutter'), dirty = $('hxDirty'), status = $('hxStatus');
    var tabCode = $('tabCode'), tabView = $('tabView'), frame = $('hxFrame'), stage = $('hxStage'), tools = $('viewTools');
    var errBox = $('hxErrors'), errList = $('hxErrList');
    var saved = P.content, mode = 'code', errs = {};

    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function say(html) { status.innerHTML = html || ''; }
    function api(method, url, body) {
        return fetch(url, { method: method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lỗi ' + r.status); return j; }); });
    }

    // ---- soạn code
    ed.value = P.content;
    function lines() { var n = ed.value.split('\n').length, s = ''; for (var i = 1; i <= n; i++) s += i + '\n'; gut.textContent = s; }
    lines();
    ed.addEventListener('input', function () { lines(); dirty.classList.toggle('hidden', ed.value === saved); });
    ed.addEventListener('scroll', function () { gut.scrollTop = ed.scrollTop; });
    // Tab/Shift+Tab, tự đóng ngoặc/thẻ, Enter giữ độ thụt, Ctrl+/ chú thích — dùng chung mọi ngôn ngữ (public/js/editorKit.js)
    var kit = window.EditorKit ? EditorKit.attach(ed, { lang: 'html', file: P.file, readOnly: !!P.readOnly }) : null;
    var bc = $('btnComment');
    if (bc) {
        if (!kit || !kit.canComment || P.readOnly) bc.classList.add('hidden');
        else { bc.onmousedown = function (e) { e.preventDefault(); }; bc.onclick = function () { ed.focus(); kit.comment(); }; }
    }
    ed.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!P.readOnly) save().catch(function () { }); }
    });
    document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !P.readOnly) { e.preventDefault(); save().catch(function () { }); } });
    window.addEventListener('beforeunload', function (e) { if (!P.readOnly && ed.value !== saved) { e.preventDefault(); e.returnValue = ''; } });

    function save() {
        if (P.readOnly || ed.value === saved) return Promise.resolve();
        say('Đang lưu…');
        var text = ed.value;
        return api('POST', '/code/html/save', { dir: P.dir, file: P.file, content: text })
            .then(function () { saved = text; dirty.classList.toggle('hidden', ed.value === saved); say('<span class="ok">Đã lưu lên GitHub.</span>'); })
            .catch(function (e) { say('<span class="bad">Lưu lỗi: ' + esc(e.message) + '</span>'); throw e; });
    }
    var bs = $('btnSave'); if (bs) bs.onclick = function () { save().catch(function () { }); };

    // ---- xem trang
    function freshUrl() {
        if (Date.now() - P.tokenAt < 6 * 3600 * 1000) return Promise.resolve(P.previewUrl);
        return api('POST', '/code/html/preview-token', P.online ? { online: P.online } : {}).then(function (j) {
            P.previewUrl = P.previewUrl.replace(/^\/preview\/[^/]+\//, '/preview/' + j.token + '/'); P.tokenAt = Date.now(); return P.previewUrl;
        });
    }
    function clearErrs() { errs = {}; errList.innerHTML = ''; errBox.classList.add('hidden'); }
    function addErr(d) {
        var key = d.url + '|' + d.message; if (errs[key]) return; errs[key] = 1;
        var name = ''; try { name = decodeURIComponent(String(d.url).split('?')[0].split('/').pop() || ''); } catch (e) { name = ''; }
        var li = document.createElement('li');
        li.innerHTML = (name ? '<code>' + esc(name) + '</code> — ' : '') + esc(d.message);
        errList.appendChild(li); errBox.classList.remove('hidden');
    }
    $('hxErrClear').onclick = clearErrs;
    function loadView() {
        if (!P.canView) return;
        clearErrs(); say('Đang tải trang…');
        var p = P.readOnly ? Promise.resolve() : save().catch(function () { say('<span class="bad">Chưa lưu được — đang xem bản đã lưu trước đó.</span>'); });
        p.then(freshUrl).then(function (url) {
            var u = url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + Date.now();
            $('btnNewTab').href = url;
            frame.src = u;
        }).catch(function (e) { say('<span class="bad">' + esc(e.message) + '</span>'); });
    }
    if (frame) {
        frame.addEventListener('load', function () { if (mode === 'view' && !/Chưa lưu/.test(status.textContent)) say(''); });
        window.addEventListener('message', function (e) {
            if (e.source !== frame.contentWindow) return;
            var d = e.data; if (!d || !d.mnha) return;
            if (d.type === 'height') frame.style.height = Math.max(120, d.h) + 'px';
            else if (d.type === 'error') addErr(d);
        });
        tools.querySelectorAll('[data-w]').forEach(function (b) {
            b.onclick = function () {
                tools.querySelectorAll('[data-w]').forEach(function (x) { x.classList.toggle('on', x === b); });
                frame.classList.toggle('w-tablet', b.dataset.w === 'tablet'); frame.classList.toggle('w-mobile', b.dataset.w === 'mobile');
                stage.classList.toggle('framed', b.dataset.w !== 'full');
            };
        });
        $('btnReload').onclick = loadView;
    }

    function setMode(m) {
        if (m === 'view' && !P.canView) return;
        mode = m;
        app.classList.toggle('is-code', m === 'code'); app.classList.toggle('is-view', m === 'view');
        tabCode.classList.toggle('on', m === 'code'); if (tabView) tabView.classList.toggle('on', m === 'view');
        if (tools) tools.classList.toggle('hidden', m !== 'view');
        try { history.replaceState(null, '', m === 'view' ? '#view' : location.pathname + location.search); } catch (e) { /* */ }
        window.scrollTo(0, 0);
        if (m === 'view') loadView(); else say('');
    }
    tabCode.onclick = function () { setMode('code'); };
    if (tabView) tabView.onclick = function () { setMode('view'); };
    if (P.canView && (P.startView || location.hash === '#view')) setMode('view');

    var cp = $('btnCopyLink'), gl = $('ghLink');
    if (cp && gl) cp.onclick = function () {
        var done = function () { cp.textContent = 'Đã chép ✓'; setTimeout(function () { cp.textContent = 'Sao chép'; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(gl.href).then(done, function () { window.prompt('Sao chép link:', gl.href); }); else window.prompt('Sao chép link:', gl.href);
    };
    if (window.lucide) lucide.createIcons();
})();
