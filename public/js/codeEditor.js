(function () {
    var P = JSON.parse(document.getElementById('payload').textContent);
    var $ = function (id) { return document.getElementById(id); };
    var ed = $('editor'), gutter = $('gutter'), termOut = $('termOut'), inputRow = $('inputRow'), inputBox = $('inputBox');
    var info = $('termInfo'), dirty = $('dirty'), btnRun = $('btnRun'), btnStop = $('btnStop');
    var saved = P.content, sid = null, timer = null, since = 0;
    ed.value = P.content; ed.disabled = false;
    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function api(method, url, body) {
        return fetch(url, { method: method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lỗi'); return j; }); });
    }
    function lines() { var n = ed.value.split('\n').length, s = ''; for (var i = 1; i <= n; i++) s += i + '\n'; gutter.textContent = s; }
    ed.addEventListener('input', function () { lines(); dirty.classList.toggle('hidden', ed.value === saved); });
    ed.addEventListener('scroll', function () { gutter.scrollTop = ed.scrollTop; });
    ed.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') { e.preventDefault(); var s = ed.selectionStart; ed.value = ed.value.slice(0, s) + '    ' + ed.value.slice(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = s + 4; ed.dispatchEvent(new Event('input')); }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
        if (e.key === 'F5') { e.preventDefault(); run(); }
    });
    lines();

    function save() {
        return api('POST', '/code/' + P.lang + '/save', { dir: P.dir, file: P.file, content: ed.value }).then(function () { saved = ed.value; dirty.classList.add('hidden'); info.innerHTML = '<span class="ok">Đã lưu lên GitHub.</span>'; }).catch(function (e) { info.innerHTML = '<span class="bad">Lưu lỗi: ' + esc(e.message) + '</span>'; throw e; });
    }
    $('btnSave').onclick = function () { save().catch(function () { }); };

    // ---------- chạy ----------
    function setRunning(on) { if (!btnRun) return; btnRun.classList.toggle('hidden', on); btnStop.classList.toggle('hidden', !on); }
    function run() {
        if (!P.runnable || sid) return;
        termOut.textContent = ''; info.textContent = 'Đang khởi động...'; $('outFiles').innerHTML = ''; since = 0; showInput(false);
        setRunning(true);
        (ed.value !== saved ? save().catch(function () { }) : Promise.resolve()).then(function () {
            return api('POST', '/code/' + P.lang + '/run', { dir: P.dir, file: P.file, content: ed.value });
        }).then(function (j) { sid = j.sid; poll(); if (isEmu) term.focus(); }).catch(function (e) { info.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; setRunning(false); });
    }
    if (btnRun) btnRun.onclick = run;
    if ($('btnCompile')) $('btnCompile').onclick = function () {
        info.textContent = 'Đang dịch...';
        api('POST', '/code/emu8086/compile', { content: ed.value }).then(function (j) {
            if (j.ok) { termOut.textContent = ''; info.innerHTML = '<span class="ok">Compile thành công — không có lỗi' + (j.instructions != null ? ' (' + j.instructions + ' lệnh)' : '') + '. Bấm Emulate để chạy.</span>'; }
            else { termOut.innerHTML = j.errors.map(function (e) { return '<div class="t-err">Dòng ' + e.line + ': ' + esc(e.message) + '</div>'; }).join(''); info.innerHTML = '<span class="bad">Có ' + j.errors.length + ' lỗi.</span>'; }
        }).catch(function (e) { info.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
    };
    if (btnStop) btnStop.onclick = function () { if (sid) api('POST', '/code/session/' + sid + '/stop').catch(function () { }); };

    var isEmu = P.lang === 'emu8086', term = $('term'), keyQ = Promise.resolve();
    // emu8086: gõ phím thẳng vào màn hình (mỗi phím gửi ngay, Enter = mã 13) — giống console thật.
    // Chỉ khi chương trình dùng INT 21h/AH=0Ah (nhập cả dòng) mới hiện ô nhập dòng.
    function showInput(on, mode) {
        var form = on && !(isEmu && mode === 'char');
        inputRow.classList.toggle('hidden', !form);
        if (form) { $('inputPrompt').textContent = mode === 'char' ? 'ký tự ›' : '›'; inputBox.focus(); }
        else if (on && isEmu) term.focus();
    }
    function sendKey(t) {
        if (!sid) return;
        var id = sid;
        keyQ = keyQ.then(function () { return api('POST', '/code/session/' + id + '/input', { text: t }); }).catch(function () { });
    }
    if (isEmu) {
        term.addEventListener('keydown', function (e) {
            if (!sid || e.ctrlKey || e.metaKey || e.altKey || !inputRow.classList.contains('hidden')) return;
            var t = null;
            if (e.key === 'Enter') t = '\r'; else if (e.key === 'Backspace') t = '\b'; else if (e.key.length === 1) t = e.key;
            if (t === null) return;
            e.preventDefault(); sendKey(t);
        });
        term.addEventListener('paste', function (e) {
            if (!sid || !inputRow.classList.contains('hidden')) return;
            e.preventDefault(); var x = (e.clipboardData || window.clipboardData).getData('text'); x.split(/\r\n|\n|\r/).forEach(function (l, i, a) { if (l) sendKey(l); if (i < a.length - 1) sendKey('\r'); });
        });
        term.addEventListener('click', function () { if (inputRow.classList.contains('hidden')) term.focus(); });
    }
    function renderScreen(v) {
        var rows = (v.screen || []).slice(), cur = v.status !== 'finished' && v.cursor;
        if (cur) while (rows.length <= cur.r) rows.push('');
        termOut.innerHTML = rows.map(function (l, r) {
            if (!cur || r !== cur.r) return esc(l);
            while (l.length < cur.c) l += ' ';
            return esc(l.slice(0, cur.c)) + '<span class="cur">' + (esc(l.charAt(cur.c)) || ' ') + '</span>' + esc(l.slice(cur.c + 1));
        }).join('\n');
    }
    inputRow.addEventListener('submit', function (e) {
        e.preventDefault(); if (!sid) return;
        var t = inputBox.value; inputBox.value = ''; showInput(false);
        api('POST', '/code/session/' + sid + '/input', { text: t }).catch(function (er) { info.innerHTML = '<span class="bad">' + esc(er.message) + '</span>'; });
    });

    function renderRegs(v) {
        var box = $('emuRegs'); if (!box || !v.regs) return;
        var h = ''; ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP', 'CS', 'DS', 'ES', 'SS', 'IP'].forEach(function (k) { h += '<div><b>' + k + '</b> ' + v.regs[k] + 'h</div>'; });
        h += '<div style="grid-column:1/-1">'; Object.keys(v.flags).forEach(function (k) { h += '<span class="' + (v.flags[k] ? 'fl-on' : 'fl-off') + '">' + k + '=' + v.flags[k] + '</span> '; }); h += '</div>';
        box.innerHTML = h;
    }
    function renderOutFiles(files) {
        var o = $('outFiles'); if (!files) return; var h = '';
        Object.keys(files).forEach(function (n) {
            var f = files[n]; if (!f.changed && !f.isNew) return;
            h += '<div class="f"><div class="fh"><span>' + esc(n) + (f.isNew ? ' (mới)' : ' (đã đổi)') + '</span><a href="#" data-save="' + esc(n) + '" style="color:#38bdf8">Lưu vào thư mục</a></div><pre>' + esc(f.content) + '</pre></div>';
        });
        o.innerHTML = h;
        o.querySelectorAll('[data-save]').forEach(function (a) {
            a.onclick = function (e) {
                e.preventDefault(); var n = a.dataset.save;
                api('POST', '/code/' + P.lang + '/save-output', { dir: P.dir, name: n, content: files[n].content }).then(function () { a.textContent = 'Đã lưu ✓'; }).catch(function (er) { alert(er.message); });
            };
        });
    }
    function poll() {
        api('GET', '/code/session/' + sid + '?since=' + since).then(function (v) {
            if (P.lang === 'emu8086') {
                renderScreen(v); renderRegs(v);
                if (v.asmErrors) termOut.innerHTML = v.asmErrors.map(function (e) { return '<div class="t-err">Dòng ' + e.line + ': ' + esc(e.message) + '</div>'; }).join('');
            } else {
                if (v.compileOutput && since === 0) termOut.innerHTML += '<div class="' + (v.compileOk === false ? 't-err' : '') + '">' + esc(v.compileOutput) + '</div>';
                (v.chunks || []).forEach(function (c) { var s = document.createElement('span'); if (c.t === 'err') s.className = 't-err'; if (c.t === 'in') s.className = 't-in'; s.textContent = c.s; termOut.appendChild(s); });
                since = v.next;
            }
            showInput(v.status !== 'finished' && v.waiting, v.waitMode);
            if (v.status === 'finished') {
                var msg = v.error ? '<span class="bad">' + esc(v.error) + '</span>' : '<span class="ok">Chạy xong' + (v.exitCode != null ? ' (mã thoát ' + v.exitCode + ')' : '') + '.</span>';
                info.innerHTML = msg + ' <span id="sv">Đang lưu kết quả lên GitHub...</span>';
                renderOutFiles(v.files); finish(v); return;
            }
            info.textContent = v.waiting ? (isEmu && v.waitMode === 'char' ? 'Đang chờ phím — gõ trực tiếp vào màn hình đen (Enter = xuống dòng).' : 'Chương trình đang chờ bạn nhập...') : 'Đang chạy...';
            timer = setTimeout(poll, 150);
        }).catch(function (e) { info.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; sid = null; setRunning(false); });
    }
    function finish(v) {
        var id = sid, tries = 0;
        setRunning(false); showInput(false);
        (function waitSaved() {
            api('GET', '/code/session/' + id + '?since=999999').then(function (x) {
                var sv = $('sv'); if (!sv) return;
                if (x.saved) { sv.textContent = 'Đã lưu: ' + x.saved; sid = null; loadHistory(); }
                else if (x.saveError) { sv.innerHTML = '<span class="bad">Lưu kết quả lỗi: ' + esc(x.saveError) + '</span>'; sid = null; }
                else if (++tries < 40) setTimeout(waitSaved, 500); else sid = null;
            }).catch(function () { sid = null; });
        })();
    }

    // ---------- lịch sử ----------
    function loadHistory() {
        api('GET', '/code/' + P.lang + '/results').then(function (j) {
            var h = $('history'); h.innerHTML = '';
            j.results.forEach(function (ts) {
                var a = document.createElement('a'); a.textContent = new Date(ts).toLocaleString('vi-VN') + '  (' + ts + '.json)';
                a.onclick = function () {
                    api('GET', '/code/' + P.lang + '/results/' + ts).then(function (r) {
                        termOut.textContent = r.console || ''; info.innerHTML = 'Kết quả cũ — ' + esc(r.status) + (r.error ? ': ' + esc(r.error) : '') + (r.compile && r.compile.output ? '\n' + esc(r.compile.output) : '');
                    });
                };
                h.appendChild(a);
            });
            if (!j.results.length) h.textContent = 'Chưa có kết quả nào.';
        }).catch(function () { });
    }
    loadHistory();
    window.addEventListener('beforeunload', function (e) { if (ed.value !== saved) { e.preventDefault(); e.returnValue = ''; } });
    if (window.lucide) lucide.createIcons();
})();
