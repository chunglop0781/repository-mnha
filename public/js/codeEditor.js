(function () {
    var P = JSON.parse(document.getElementById('payload').textContent);
    var $ = function (id) { return document.getElementById(id); };
    var ed = $('editor'), gutter = $('gutter'), termOut = $('termOut'), inputRow = $('inputRow'), inputBox = $('inputBox');
    var info = $('termInfo'), dirty = $('dirty'), btnRun = $('btnRun'), btnStop = $('btnStop');
    var saved = P.content, sid = null, timer = null, since = 0, firstAuto = null;
    ed.value = P.content; ed.disabled = false;
    // Gấp/mở khối code (C++): PHẢI gắn trước EditorKit. Khi đang gấp, ed.value chứa dòng thay thế → luôn lấy code thật bằng text().
    var fold = window.FoldKit ? FoldKit.attach(ed, gutter, { lang: P.lang, file: P.file }) : null;
    function text() { return fold ? fold.getText() : ed.value; }
    if (P.online) ed.readOnly = true;      // code lấy từ link trên mạng: chỉ xem, không sửa (vẫn chạy được)
    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function api(method, url, body) {
        return fetch(url, { method: method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var er = new Error(j.error || 'Lỗi'); er.wake = !!j.wake; throw er; } return j; }); });
    }
    function lines() { if (fold) { fold.refresh(); return; } var n = ed.value.split('\n').length, s = ''; for (var i = 1; i <= n; i++) s += i + '\n'; gutter.textContent = s; }
    ed.addEventListener('input', function () { lines(); dirty.classList.toggle('hidden', text() === saved); });
    ed.addEventListener('scroll', function () { gutter.scrollTop = ed.scrollTop; });
    // Tab/Shift+Tab, tự đóng ngoặc, Enter giữ độ thụt, Ctrl+/ chú thích — dùng chung mọi ngôn ngữ (public/js/editorKit.js)
    var kit = window.EditorKit ? EditorKit.attach(ed, { lang: P.lang, file: P.file, readOnly: !!P.online }) : null;
    if ($('btnComment')) {
        if (!kit || !kit.canComment) $('btnComment').classList.add('hidden');
        else { $('btnComment').onmousedown = function (e) { e.preventDefault(); }; $('btnComment').onclick = function () { ed.focus(); if (fold) fold.beforeEdit(); kit.comment(); }; }
    }
    ['btnFoldAll', 'btnUnfoldAll'].forEach(function (id) {
        var b = $(id); if (!b) return;
        if (!fold) { b.classList.add('hidden'); return; }
        b.onmousedown = function (e) { e.preventDefault(); };
        b.onclick = function () { if (id === 'btnFoldAll') fold.foldAll(); else fold.unfoldAll(); ed.focus(); };
    });
    ed.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
        if (e.key === 'F5') { e.preventDefault(); run(); }
    });
    lines();

    function save() {
        if (P.online) return Promise.resolve();      // code trên mạng không lưu vào thư mục của tôi
        return api('POST', '/code/' + P.lang + '/save', { dir: P.dir, file: P.file, content: text() }).then(function () { saved = text(); dirty.classList.add('hidden'); info.innerHTML = '<span class="ok">Đã lưu lên GitHub.</span>'; }).catch(function (e) { info.innerHTML = '<span class="bad">Lưu lỗi: ' + esc(e.message) + '</span>'; throw e; });
    }
    if ($('btnSave')) $('btnSave').onclick = function () { save().catch(function () { }); };

    // ---------- sao chép link GitHub để chia sẻ ----------
    var btnCopy = $('btnCopyLink'), ghLink = $('ghLink');
    if (btnCopy && ghLink) btnCopy.onclick = function () {
        var url = ghLink.href;
        function done(ok) { btnCopy.textContent = ok ? 'Đã sao chép ✓' : 'Chọn & copy thủ công'; setTimeout(function () { btnCopy.textContent = 'Sao chép'; }, 1800); }
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
        else { var t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { } document.body.removeChild(t); done(ok); }
    };

    // ---------- chạy ----------
    function setRunning(on) { if (!btnRun) return; btnRun.classList.toggle('hidden', on); btnStop.classList.toggle('hidden', !on); }
    // ---------- C++ chạy trong trình duyệt (clang WebAssembly) khi máy chủ không có g++ ----------
    var wasmRun = null, wasmInputs = [], wasmConsole = '';
    var browserCpp = P.lang === 'cpp' && P.cppMode === 'browser' && window.CppWasm;
    function wasmOut(text, kind) {
        wasmConsole += text;
        if (/\x1b\[2J/.test(text)) { termOut.textContent = ''; text = text.slice(text.lastIndexOf('\x1b[2J') + 4); }
        text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
        var sp = document.createElement('span'); if (kind === 'err') sp.className = 't-err'; else if (kind === 'in') sp.className = 't-in'; sp.textContent = text; termOut.appendChild(sp);
    }
    function runBrowser() {
        if (wasmRun) return;
        termOut.textContent = ''; $('outFiles').innerHTML = ''; wasmInputs = []; wasmConsole = ''; setRunning(true);
        info.textContent = 'Đang chuẩn bị...';
        (text() !== saved ? save().catch(function () { }) : Promise.resolve()).then(function () {
            // file cùng thư mục: .txt + header #include (code của tôi: thư mục của tôi; code trên mạng: cùng thư mục trong repo GitHub/GitLab)
            return api('POST', '/code/cpp/siblings', { dir: P.dir, file: P.file, code: text(), online: P.online || undefined }).catch(function (e) { info.innerHTML = '<span class="bad">Không nạp được file cùng thư mục: ' + esc(e.message) + '</span>'; return { files: [] }; });
        }).then(function (j) {
            var code = text();
            warnMissing(j.missing);
            wasmRun = CppWasm.start({
                code: code, files: j.files || [], onOut: wasmOut,
                onStatus: function (m) { info.textContent = m; },
                onCompiled: function () { showInput(true, 'line'); }
            });
            wasmRun.done.then(function (r) {
                wasmRun = null; setRunning(false); showInput(false);
                var ok = r.status === 'finished' && !r.error;
                info.innerHTML = (ok ? '<span class="ok">Chạy xong (mã thoát ' + r.exitCode + ').</span>' : '<span class="bad">' + esc(r.error || r.status) + '</span>') + ' <span id="sv">Đang lưu kết quả lên GitHub...</span>';
                renderOutFiles(r.files);
                api('POST', '/code/cpp/client-result', { file: P.file, dir: P.dir, origin: P.online || undefined, source: code, console: wasmConsole, inputs: wasmInputs, exitCode: r.exitCode, error: r.error, files: r.files })
                    .then(function (x) { $('sv').innerHTML = 'Đã lưu: ' + esc(x.saved) + autoNote(x.autoSaved); loadHistory(); })
                    .catch(function (e) { var sv = $('sv'); if (sv) sv.innerHTML = '<span class="bad">Lưu kết quả lỗi: ' + esc(e.message) + '</span>'; });
            });
        });
    }
    // Runner C++ (Render gói free) có thể đang ngủ → tự thử lại cho tới khi chạy được. Mỗi lúc chỉ 1 yêu cầu,
    // giãn dần khoảng cách, tối đa ~3 phút, nút Dừng hủy ngay. (Máy chủ thăm dò /health trước nên không tạo phiên chạy thừa.)
    var cancelWake = false, wakeTimer = null;
    function startWithWake(body) {
        var t0 = Date.now(), n = 0;
        return new Promise(function (resolve, reject) {
            (function attempt() {
                if (cancelWake) return reject(new Error('Đã hủy.'));
                n++;
                api('POST', '/code/' + P.lang + '/run', body).then(resolve).catch(function (e) {
                    if (!e.wake || cancelWake) return reject(e);
                    var el = Math.round((Date.now() - t0) / 1000);
                    if (el > 180) return reject(new Error('Máy chạy code không phản hồi sau 3 phút. Kiểm tra dịch vụ runner trên Render rồi thử lại.'));
                    info.innerHTML = '<span class="ok">Máy chạy code đang thức dậy (Render gói miễn phí) — tự thử lại, đã chờ ' + el + ' giây, thường mất 30–60 giây...</span>';
                    wakeTimer = setTimeout(attempt, Math.min(3000 + n * 1000, 8000));
                });
            })();
        });
    }
    // Mở trang C++ → đánh thức runner sớm (thưa dần, dừng ngay khi sẵn sàng hoặc sau 6 lần)
    if (P.lang === 'cpp' && P.cppMode === 'server') {
        var warmTries = 0;
        (function warm() {
            if (document.hidden && warmTries) return void setTimeout(warm, 15000);
            if (++warmTries > 6) return;
            fetch('/code/cpp/warmup', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); })
                .then(function (j) { if (!j.ready) setTimeout(warm, 10000); }).catch(function () { setTimeout(warm, 15000); });
        })();
    }
    function warnMissing(list) {      // #include "..." mà không tìm thấy file cùng thư mục
        if (!list || !list.length) return;
        termOut.insertAdjacentHTML('afterbegin', '<div class="t-err">[Không tìm thấy file include cùng thư mục: ' + list.map(esc).join(', ') + '. Kiểm tra tên (phân biệt HOA/thường), đúng nhánh, repo công khai và file nằm cạnh file đang chạy.]</div>');
    }
    // ---------- emu8086 chạy NGAY TRONG TRÌNH DUYỆT (public: /code/emu8086/engine.js → window.Emu8086) ----------
    // Mỗi người có máy ảo riêng trong tab của mình: không có phiên trên máy chủ nên nhiều người chạy cùng lúc thoải mái (Vercel nhiều instance cũng không làm mất phiên).
    var browserEmu = P.lang === 'emu8086' && !!window.Emu8086, emuRun = null;
    function emuDraw(r) {
        var m = r.m; if (!m) return;
        var snap = m.snapshot(), w = m.status === 'waiting' ? m.waiting : null;
        var v = { status: r.finished ? 'finished' : 'running', waiting: !!w, waitMode: w ? w.mode : null, screen: snap.screen, cursor: snap.cursor, regs: snap.regs, flags: snap.flags };
        renderScreen(v); renderRegs(v); r.lastDraw = Date.now();
        if (!r.finished) {
            showInput(!!w, v.waitMode);
            info.textContent = w ? (w.mode === 'char' ? 'Đang chờ phím — gõ trực tiếp vào màn hình đen (Enter = xuống dòng).' : 'Chương trình đang chờ bạn nhập...') : 'Đang chạy...';
        }
    }
    function emuPump(r) {
        if (r.finished || r.pumping) return;
        r.pumping = true;
        (function tick() {
            if (r.finished) { r.pumping = false; return; }
            var m = r.m;
            if (Date.now() - r.startedAt > 240000 && !m.waiting) m.fault('Chạy quá thời gian cho phép.');
            var st = m.run(100000);
            if (st === 'running') { if (Date.now() - r.lastDraw > 80) emuDraw(r); return void setTimeout(tick, 0); }
            r.pumping = false;
            if (st === 'halted' || st === 'error') emuFinish(r); else emuDraw(r);
        })();
    }
    function emuSend(r, text) {
        if (!r || !r.m || r.finished) return false;
        var w = r.m.waiting, t = String(text).slice(0, 2000);
        if (w && w.mode === 'line') r.m.feed(t + '\r'); else r.m.feed(t === '' ? '\r' : t);
        emuPump(r); return true;
    }
    function emuFinish(r) {
        if (r.finished) return;
        r.finished = true; if (emuRun === r) emuRun = null;
        var m = r.m, snap = m ? m.snapshot() : null;
        if (m && m.error && !r.error) r.error = m.error;
        if (m) emuDraw(r);
        if (r.asmErrors) termOut.innerHTML = r.asmErrors.map(function (e) { return '<div class="t-err">Dòng ' + e.line + ': ' + esc(e.message) + '</div>'; }).join('');
        setRunning(false); showInput(false);
        var code = r.code, exit = snap ? snap.exitCode : null;
        info.innerHTML = (r.error ? '<span class="bad">' + esc(r.error) + '</span>' : '<span class="ok">Chạy xong' + (exit != null ? ' (mã thoát ' + exit + ')' : '') + '.</span>') + ' <span id="sv">Đang lưu kết quả lên GitHub...</span>';
        api('POST', '/code/emu8086/client-result', {
            file: P.file, dir: P.dir, origin: P.online || undefined, source: code, console: m ? m.screen.raw : '', screen: snap ? snap.screen : [], inputs: m ? m.inputLog : [],
            regs: snap ? snap.regs : null, flags: snap ? snap.flags : null, steps: snap ? snap.steps : 0, exitCode: exit, error: r.error, asmErrors: r.asmErrors || [],
            startedAt: new Date(r.startedAt).toISOString(), durationMs: Date.now() - r.startedAt
        }).then(function (x) { var sv = $('sv'); if (sv) sv.innerHTML = 'Đã lưu: ' + esc(x.saved); loadHistory(); })
            .catch(function (e) { var sv = $('sv'); if (sv) sv.innerHTML = '<span class="bad">Lưu kết quả lỗi: ' + esc(e.message) + '</span>'; });
    }
    function runEmuBrowser() {
        if (emuRun) return;
        termOut.textContent = ''; $('outFiles').innerHTML = ''; info.textContent = 'Đang khởi động...'; setRunning(true); showInput(false);
        var r = { m: null, code: '', finished: false, pumping: false, error: null, asmErrors: null, startedAt: Date.now(), lastDraw: 0 };
        emuRun = r;
        (text() !== saved ? save().catch(function () { }) : Promise.resolve()).then(function () {
            if (r.finished) return;
            r.code = text(); r.startedAt = Date.now();
            try { r.m = new Emu8086.Machine(r.code); }
            catch (e) {
                if (e && e.errors) { r.asmErrors = e.errors; r.error = 'Lỗi dịch hợp ngữ'; } else r.error = 'Lỗi: ' + (e && e.message);
                return emuFinish(r);
            }
            emuDraw(r); emuPump(r); term.focus();
        });
    }
    function emuStop() {
        var r = emuRun; if (!r) return;
        if (r.m) r.m.fault('Đã dừng bởi người dùng.');
        r.error = 'Đã dừng bởi người dùng.';
        if (!r.code) r.code = text();
        emuFinish(r);
    }
    function run() {
        if (browserEmu) return P.runnable ? runEmuBrowser() : undefined;
        if (browserCpp) return P.runnable ? runBrowser() : undefined;
        if (!P.runnable || sid) return;
        termOut.textContent = ''; info.textContent = 'Đang khởi động...'; $('outFiles').innerHTML = ''; since = 0; showInput(false);
        setRunning(true);
        cancelWake = false;
        (text() !== saved ? save().catch(function () { }) : Promise.resolve()).then(function () {
            return startWithWake(P.online ? { online: P.online } : { dir: P.dir, file: P.file, content: text() });
        }).then(function (j) { sid = j.sid; poll(); if (isEmu) term.focus(); warnMissing(j.missing); }).catch(function (e) { info.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; setRunning(false); });
    }
    if (btnRun) btnRun.onclick = run;
    if ($('btnCompile')) $('btnCompile').onclick = function () {
        info.textContent = 'Đang dịch...';
        api('POST', '/code/emu8086/compile', { content: text() }).then(function (j) {
            if (j.ok) { termOut.textContent = ''; info.innerHTML = '<span class="ok">Compile thành công — không có lỗi' + (j.instructions != null ? ' (' + j.instructions + ' lệnh)' : '') + '. Bấm Emulate để chạy.</span>'; }
            else { termOut.innerHTML = j.errors.map(function (e) { return '<div class="t-err">Dòng ' + e.line + ': ' + esc(e.message) + '</div>'; }).join(''); info.innerHTML = '<span class="bad">Có ' + j.errors.length + ' lỗi.</span>'; }
        }).catch(function (e) { info.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
    };
    if (btnStop) btnStop.onclick = function () { if (emuRun) { emuStop(); return; } if (wasmRun) { wasmRun.stop(); return; } if (!sid) { cancelWake = true; clearTimeout(wakeTimer); info.textContent = 'Đã hủy.'; setRunning(false); return; } if (sid) api('POST', '/code/session/' + sid + '/stop').catch(function () { }); };

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
        if (emuRun) { emuSend(emuRun, t); return; }
        if (!sid) return;
        var id = sid;
        keyQ = keyQ.then(function () { return api('POST', '/code/session/' + id + '/input', { text: t }); }).catch(function () { });
    }
    if (isEmu) {
        term.addEventListener('keydown', function (e) {
            if ((!sid && !emuRun) || e.ctrlKey || e.metaKey || e.altKey || !inputRow.classList.contains('hidden')) return;
            var t = null;
            if (e.key === 'Enter') t = '\r'; else if (e.key === 'Backspace') t = '\b'; else if (e.key.length === 1) t = e.key;
            if (t === null) return;
            e.preventDefault(); sendKey(t);
        });
        term.addEventListener('paste', function (e) {
            if ((!sid && !emuRun) || !inputRow.classList.contains('hidden')) return;
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
        e.preventDefault();
        if (wasmRun) { var w = inputBox.value; inputBox.value = ''; wasmInputs.push(w); wasmOut(w + '\n', 'in'); wasmRun.send(w + '\n'); return; }
        if (emuRun) { var et = inputBox.value; inputBox.value = ''; showInput(false); emuSend(emuRun, et); return; }
        if (!sid) return;
        var t = inputBox.value; inputBox.value = ''; showInput(false);
        api('POST', '/code/session/' + sid + '/input', { text: t }).catch(function (er) { info.innerHTML = '<span class="bad">' + esc(er.message) + '</span>'; });
    });

    function renderRegs(v) {
        var box = $('emuRegs'); if (!box || !v.regs) return;
        var h = ''; ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP', 'CS', 'DS', 'ES', 'SS', 'IP'].forEach(function (k) { h += '<div><b>' + k + '</b> ' + v.regs[k] + 'h</div>'; });
        h += '<div style="grid-column:1/-1">'; Object.keys(v.flags).forEach(function (k) { h += '<span class="' + (v.flags[k] ? 'fl-on' : 'fl-off') + '">' + k + '=' + v.flags[k] + '</span> '; }); h += '</div>';
        box.innerHTML = h;
    }
    // code xem trên mạng: file chương trình ghi ra (output.txt...) được máy chủ tự lưu vào codes/cpp/tren-mang/
    function autoNote(a) {
        if (!a) return '';
        var h = '';
        if (a.saved && a.saved.length) h += ' <span class="ok">Đã tự tạo trong codes/' + esc(P.lang) + '/: ' + a.saved.map(esc).join(', ') + '.</span>';
        if (a.skipped && a.skipped.length) h += ' <span class="bad">Không lưu được: ' + a.skipped.map(function (k) { return esc(k.name) + ' (' + esc(k.reason) + ')'; }).join('; ') + '.</span>';
        return h;
    }
    function renderOutFiles(files) {
        var o = $('outFiles'); if (!files) return; var h = '';
        Object.keys(files).forEach(function (n) {
            var f = files[n]; if (!f.changed && !f.isNew) return;
            h += '<div class="f"><div class="fh"><span>' + esc(n) + (f.isNew ? ' (mới)' : ' (đã đổi)') + '</span>' + (P.online ? '<span style="color:#38bdf8">tự lưu → codes/' + esc(P.lang) + '/tren-mang/' + esc(n) + '</span>' : '<a href="#" data-save="' + esc(n) + '" style="color:#38bdf8">Lưu vào thư mục</a>') + '</div><pre>' + esc(f.content) + '</pre></div>';
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
                renderOutFiles(v.files); firstAuto = v.autoSaved || null; finish(v); return;
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
                if (x.saved) { sv.innerHTML = 'Đã lưu: ' + esc(x.saved) + autoNote(x.autoSaved || firstAuto); sid = null; loadHistory(); }
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
    window.addEventListener('beforeunload', function (e) { if (text() !== saved) { e.preventDefault(); e.returnValue = ''; } });
    if (window.lucide) lucide.createIcons();
})();
