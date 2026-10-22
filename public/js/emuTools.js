// public/js/emuTools.js — ASCII codes / Calculator / Convertor giống emu8086
(function () {
    var CP437_HI = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
    var CTRL = ['NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'TAB', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI', 'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'];
    var modal = document.getElementById('emuModal');
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function open(title, html) {
        modal.innerHTML = '<div class="emu-box"><header><span>' + title + '</span><button type="button" aria-label="Đóng">×</button></header><div class="body">' + html + '</div></div>';
        modal.classList.remove('hidden');
        modal.querySelector('header button').onclick = close;
        return modal.querySelector('.body');
    }
    function close() { modal.classList.add('hidden'); modal.innerHTML = ''; }
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
    function pad(s, n) { s = s.toUpperCase(); while (s.length < n) s = '0' + s; return s; }
    // ---- Bảng ASCII đầy đủ 0–255 (theo bảng tổng hợp: điều khiển / in được / mở rộng)
    // [viết tắt, phím truy nhập, tên/ý nghĩa]
    var CTRL_INFO = [
        ['NUL', '^@', 'Ký tự rỗng'], ['SOH', '^A', 'Bắt đầu Header'], ['STX', '^B', 'Bắt đầu văn bản'], ['ETX', '^C', 'Kết thúc văn bản'],
        ['EOT', '^D', 'Kết thúc truyền'], ['ENQ', '^E', 'Truy vấn'], ['ACK', '^F', 'Sự công nhận'], ['BEL', '^G', 'Tiếng kêu (bíp)'],
        ['BS', '^H', 'Xoá ngược (Backspace)'], ['HT', '^I', 'Thẻ ngang (Tab)'], ['LF', '^J', 'Xuống dòng mới'], ['VT', '^K', 'Thẻ dọc'],
        ['FF', '^L', 'Cấp giấy'], ['CR', '^M', 'Chuyển dòng / Về đầu dòng'], ['SO', '^N', 'Ngoài mã'], ['SI', '^O', 'Mã hóa / Trong mã'],
        ['DLE', '^P', 'Thoát liên kết dữ liệu'], ['DC1', '^Q', 'Điều khiển thiết bị 1'], ['DC2', '^R', 'Điều khiển thiết bị 2'], ['DC3', '^S', 'Điều khiển thiết bị 3'],
        ['DC4', '^T', 'Điều khiển thiết bị 4'], ['NAK', '^U', 'Thông báo có lỗi bên gửi'], ['SYN', '^V', 'Thông báo đã đồng bộ'], ['ETB', '^W', 'Kết thúc truyền tin'],
        ['CAN', '^X', 'Hủy'], ['EM', '^Y', 'End of Medium'], ['SUB', '^Z', 'Thay thế'], ['ESC', '^[ hay ESC', 'Thoát'],
        ['FS', '^\\', 'Phân tách tập tin'], ['GS', '^]', 'Phân tách nhóm'], ['RS', '^^', 'Phân tách bản ghi'], ['US', '^_', 'Phân tách đơn vị']
    ];
    var CTRL_ORDER = []; for (var ci = 0; ci < 32; ci++) CTRL_ORDER.push(ci); CTRL_ORDER.push(127);
    // 128–159 theo Windows-1252 ('' = ô không dùng); 160–255 theo ISO-8859-1
    var WIN1252 = ['€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '', '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ'];
    function extChar(i, enc) {
        if (enc === 'dos') return CP437_HI.charAt(i - 128);
        if (i < 160) return WIN1252[i - 128];
        return String.fromCharCode(i);
    }
    function bin(i) { return i < 128 ? pad(i.toString(2), 7).replace(/(\d{3})(\d{4})/, '$1 $2') : pad(i.toString(2), 8).replace(/(\d{4})(\d{4})/, '$1 $2'); }
    function htmlOf(i, ch, enc) { return '&#' + (enc === 'dos' && ch ? ch.charCodeAt(0) : i) + ';'; }
    function row(cells, extra) { return '<tr data-q="' + esc((cells.join(' ') + ' ' + (extra || '')).toLowerCase()) + '">' + cells.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }
    function tbl(head, rows) { return '<table class="emu-ascii"><thead><tr>' + head.map(function (t) { return '<th>' + t + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>'; }

    function asciiTable(tab, enc) {
        var rows = [], i;
        if (tab === 'ctrl') {
            CTRL_ORDER.forEach(function (c) {
                var d = c === 127 ? ['DEL', 'DEL', 'Xóa'] : CTRL_INFO[c];
                rows.push(row([c, bin(c), pad(c.toString(16), 2) + 'h', '&#' + c + ';', d[0], d[1], d[2]]));
            });
            return tbl(['Hệ 10', 'Hệ 2', 'Hệ 16', 'HTML', 'Viết tắt', 'Truy nhập bàn phím', 'Tên / Ý nghĩa'], rows) +
                '<div class="emu-note">Không in ra màn hình được (trừ vài mã đặc biệt chạy theo lệnh): 7 = BEL (tiếng bíp), 8 = lùi 1 ô, 10 = LF xuống dòng, 13 = CR về đầu dòng.</div>';
        }
        if (tab === 'print') {
            for (i = 32; i <= 126; i++) rows.push(row([i, bin(i), pad(i.toString(16), 2) + 'h', '&#' + i + ';', i === 32 ? 'Khoảng trống (Space)' : String.fromCharCode(i)]));
            return tbl(['Hệ 10', 'Hệ 2', 'Hệ 16', 'HTML', 'Đồ họa (hiển thị được)'], rows) +
                '<div class="emu-note">32 = dấu cách, 36 = "$" (kết thúc chuỗi của INT 21h/AH=9), "0" = 48, "A" = 65, "a" = 97.</div>';
        }
        for (i = 128; i <= 255; i++) {
            var ch = extChar(i, enc);
            var show = enc !== 'dos' && i === 160 ? '(NBSP)' : enc !== 'dos' && i === 173 ? '(SHY)' : (ch || '—');
            rows.push(row([i, bin(i), pad(i.toString(16), 2) + 'h', htmlOf(i, ch, enc), show], enc === 'dos' ? 'cp437' : 'win1252 latin1'));
        }
        return tbl(['Hệ 10', 'Hệ 2', 'Hệ 16', 'HTML', 'Ký tự'], rows) +
            '<div class="emu-note">' + (enc === 'dos'
                ? 'Bảng mã DOS (CP437) — kiểu màn hình DOS gốc của emu8086 (khung, ký hiệu toán…).'
                : 'Chuẩn ISO-8859-1 (128–159 theo Windows-1252, ô trống = không dùng; 160 = khoảng trắng không ngắt, 173 = dấu nối mềm). Đây là bảng mở rộng phổ biến trên Internet/Windows.') + '</div>';
    }

    function ascii() {
        var st = { tab: 'ctrl', enc: 'win' };
        var b = open('ASCII codes', '<div class="emu-tabs"></div><div class="emu-row"><input class="wide emu-filter" placeholder="Lọc theo mã, ký tự, tên… (vd: 65, A, LF, 0x41)"></div><div class="emu-asc"></div>');
        var tabs = b.querySelector('.emu-tabs'), box = b.querySelector('.emu-asc'), flt = b.querySelector('.emu-filter');
        function render() {
            var T = [['ctrl', 'Điều khiển (0–31, 127)'], ['print', 'In được (32–126)'], ['ext', 'Mở rộng (128–255)']];
            var h = T.map(function (t) { return '<button type="button" class="' + (st.tab === t[0] ? 'on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('');
            if (st.tab === 'ext') h += '<span class="sep"></span>' + [['win', 'ISO-8859-1 / Windows-1252'], ['dos', 'CP437 (DOS)']].map(function (t) { return '<button type="button" class="' + (st.enc === t[0] ? 'on' : '') + '" data-enc="' + t[0] + '">' + t[1] + '</button>'; }).join('');
            tabs.innerHTML = h;
            box.innerHTML = asciiTable(st.tab, st.enc);
            tabs.querySelectorAll('[data-tab]').forEach(function (x) { x.onclick = function () { st.tab = x.dataset.tab; render(); }; });
            tabs.querySelectorAll('[data-enc]').forEach(function (x) { x.onclick = function () { st.enc = x.dataset.enc; render(); }; });
            filter();
        }
        function filter() {
            var q = flt.value.trim().toLowerCase(), m = /^0x([0-9a-f]+)$/.exec(q);
            if (m) q = String(parseInt(m[1], 16));
            box.querySelectorAll('tbody tr').forEach(function (tr) {
                var cells = tr.children, hit = !q || (tr.dataset.q || '').indexOf(q) >= 0 || (cells[0] && cells[0].textContent === q);
                tr.style.display = hit ? '' : 'none';
            });
        }
        flt.addEventListener('input', filter);
        render();
    }

    function conv() {
        var b = open('Convertor', '<div class="emu-row"><label>Decimal</label><input class="wide" data-b="10"></div><div class="emu-row"><label>Hex</label><input class="wide" data-b="16"></div><div class="emu-row"><label>Binary</label><input class="wide" data-b="2"></div><div class="emu-row"><label>Octal</label><input class="wide" data-b="8"></div><div class="emu-row"><label>Ký tự</label><input class="wide" data-b="chr" maxlength="1"></div><div class="emu-note">Gõ vào một ô, các ô còn lại tự đổi (số nguyên không âm).</div>');
        var ins = b.querySelectorAll('input');
        ins.forEach(function (inp) {
            inp.addEventListener('input', function () {
                var k = inp.dataset.b, n;
                if (k === 'chr') n = inp.value ? inp.value.charCodeAt(0) : NaN;
                else { var v = inp.value.trim().replace(/h$/i, ''); var ok = { 10: /^\d+$/, 16: /^[0-9a-f]+$/i, 2: /^[01]+$/, 8: /^[0-7]+$/ }[k]; n = ok.test(v) ? parseInt(v, +k) : NaN; }
                ins.forEach(function (o) {
                    if (o === inp) return;
                    var kk = o.dataset.b;
                    if (isNaN(n)) { o.value = ''; return; }
                    o.value = kk === 'chr' ? (n < 65536 ? String.fromCharCode(n) : '') : n.toString(+kk).toUpperCase();
                });
            });
        });
        ins[0].focus();
    }

    // máy tính: + - * / % ( ) theo cơ số chọn, không dùng eval
    function evaluate(src, base) {
        var s = src.replace(/\s+/g, '').toUpperCase(), i = 0;
        var digits = '0123456789ABCDEF'.slice(0, base);
        function num() {
            var st = i; while (i < s.length && digits.indexOf(s[i]) >= 0) i++;
            if (st === i) throw new Error('Thiếu số tại vị trí ' + (i + 1));
            return parseInt(s.slice(st, i), base);
        }
        function atom() {
            if (s[i] === '(') { i++; var v = expr(); if (s[i] !== ')') throw new Error('Thiếu ")"'); i++; return v; }
            if (s[i] === '-') { i++; return -atom(); }
            return num();
        }
        function term() { var v = atom(); while (s[i] === '*' || s[i] === '/' || s[i] === '%') { var o = s[i++], r = atom(); if (o !== '*' && r === 0) throw new Error('Chia cho 0'); v = o === '*' ? v * r : o === '/' ? Math.trunc(v / r) : v % r; } return v; }
        function expr() { var v = term(); while (s[i] === '+' || s[i] === '-') { var o = s[i++], r = term(); v = o === '+' ? v + r : v - r; } return v; }
        var r = expr(); if (i < s.length) throw new Error('Ký tự lạ "' + s[i] + '"'); return r;
    }
    function calc() {
        var b = open('Calculator', '<div class="emu-row"><label>Cơ số</label><select id="cBase"><option value="10">Decimal</option><option value="16">Hex</option><option value="2">Binary</option><option value="8">Octal</option></select></div><div class="emu-row"><label>Biểu thức</label><input class="wide" id="cExp" placeholder="vd: 5+7*2"></div><div id="cRes" class="emu-note"></div><div class="emu-note">Hỗ trợ + − × ÷ (chia nguyên) % và dấu ngoặc.</div>');
        var exp = b.querySelector('#cExp'), bs = b.querySelector('#cBase'), res = b.querySelector('#cRes');
        function go() {
            if (!exp.value.trim()) { res.textContent = ''; return; }
            try {
                var v = evaluate(exp.value, +bs.value), u = v < 0 ? (v & 0xffff) : v;
                res.innerHTML = 'Dec: <b>' + v + '</b> &nbsp; Hex: <b>' + pad(u.toString(16), 4) + 'h</b> &nbsp; Bin: <b>' + pad(u.toString(2), 8) + '</b> &nbsp; Oct: <b>' + u.toString(8) + '</b>' + (v >= 32 && v < 256 ? ' &nbsp; Ký tự: <b>' + esc(glyph(v)) + '</b>' : '');
            } catch (e) { res.innerHTML = '<span style="color:#f87171">' + esc(e.message) + '</span>'; }
        }
        exp.addEventListener('input', go); bs.addEventListener('change', go); exp.focus();
    }

    document.querySelectorAll('[data-emu-tool]').forEach(function (btn) {
        btn.addEventListener('click', function () { ({ ascii: ascii, calc: calc, conv: conv })[btn.dataset.emuTool](); });
    });
})();
