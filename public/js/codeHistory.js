// Trang "Lịch sử chạy code": chỉ XEM code (đúng như lúc chạy) và màn hình kết quả — không sửa, không chạy lại.
(function () {
    var root = document.getElementById('histApp'); if (!root) return;
    var lang = root.dataset.lang;
    var $ = function (id) { return document.getElementById(id); };
    var list = $('histList'), codeEl = $('histCode'), gutter = $('histGutter'), out = $('histOut'), info = $('histInfo');
    var detail = {}, items = {};
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function api(url) { return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lỗi'); return j; }); }); }
    function safeLink(u) { return /^https:\/\/(github\.com|gitlab\.com)\//.test(u || '') ? u : null; }
    function lines(text) { var n = String(text).split('\n').length, s = ''; for (var i = 1; i <= n; i++) s += i + '\n'; gutter.textContent = s; }
    codeEl.addEventListener('scroll', function () { gutter.scrollTop = codeEl.scrollTop; });

    function label(ts, r) {
        var b = items[ts]; if (!b) return;
        var time = new Date(ts).toLocaleString('vi-VN');
        if (!r) { b.innerHTML = '<span class="f">' + esc(time) + '</span>'; return; }
        b.innerHTML = '<span class="f">' + (r.origin ? '<span class="web" title="Code từ link trên mạng">🌐 </span>' : '') + esc(r.file || '(không tên)') + ' <span class="' + (r.status === 'ok' ? 'ok' : 'bad') + '">' + (r.status === 'ok' ? '✓' : '✗') + '</span></span><span class="t">' + esc(time) + '</span>';
    }
    function screenText(r) {
        if (Array.isArray(r.screen) && r.screen.length) { var rows = r.screen.slice(); while (rows.length && !String(rows[rows.length - 1]).trim()) rows.pop(); return rows.join('\n'); }
        return String(r.console || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
    }
    function show(ts, r) {
        Object.keys(items).forEach(function (k) { items[k].classList.toggle('on', k === String(ts)); });
        var src = r.source == null ? '' : String(r.source);
        codeEl.textContent = src; lines(src); codeEl.scrollTop = 0;
        var h = '';
        if (r.assemble && r.assemble.errors && r.assemble.errors.length) h += r.assemble.errors.map(function (e) { return '<div class="t-err">Dòng ' + esc(e.line) + ': ' + esc(e.message) + '</div>'; }).join('');
        if (r.compile && r.compile.output) h += '<div class="' + (r.compile.ok === false ? 't-err' : '') + '">' + esc(r.compile.output) + '</div>';
        h += esc(screenText(r));
        if (r.error) h += '\n<span class="t-err">' + esc(r.error) + '</span>';
        out.innerHTML = h || '(không có đầu ra)';
        var link = safeLink(r.origin);
        info.innerHTML = 'File: <b>' + esc(r.file || '') + '</b> · ' + esc(new Date(r.timestamp || ts).toLocaleString('vi-VN')) + ' · ' +
            (r.status === 'ok' ? '<span class="ok">chạy xong</span>' : '<span class="bad">có lỗi</span>') +
            (r.exitCode != null ? ' (mã thoát ' + esc(r.exitCode) + ')' : '') +
            (link ? ' · nguồn: <a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(link) + '</a>' : '');
    }
    function open(ts) {
        if (detail[ts]) return show(ts, detail[ts]);
        info.textContent = 'Đang tải...';
        api('/code/' + lang + '/results/' + ts).then(function (r) { detail[ts] = r; label(ts, r); show(ts, r); })
            .catch(function (e) { info.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
    }
    // nạp trước nhãn (tên file + trạng thái) của vài lần chạy gần nhất, mỗi lúc 3 yêu cầu
    function preload(tsList) {
        var q = tsList.slice(0, 12), running = 0;
        (function next() {
            while (running < 3 && q.length) {
                (function (ts) {
                    running++;
                    api('/code/' + lang + '/results/' + ts).then(function (r) { detail[ts] = r; label(ts, r); })
                        .catch(function () { }).then(function () { running--; next(); });
                })(q.shift());
            }
        })();
    }

    api('/code/' + lang + '/results').then(function (j) {
        list.innerHTML = '';
        if (!j.results.length) { list.textContent = 'Chưa có lần chạy nào.'; return; }
        j.results.forEach(function (ts) {
            var b = document.createElement('button'); b.type = 'button'; b.className = 'hist-item';
            b.onclick = function () { open(ts); };
            items[ts] = b; label(ts, null); list.appendChild(b);
        });
        preload(j.results);
        open(j.results[0]);
    }).catch(function (e) { list.innerHTML = '<span class="bad" style="padding:10px;display:block">' + esc(e.message) + '</span>'; });
    if (window.lucide) lucide.createIcons();
})();
