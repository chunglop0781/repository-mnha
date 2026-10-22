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
    function glyph(i) { return i < 32 ? CTRL[i] : i === 127 ? 'DEL' : i < 127 ? String.fromCharCode(i) : CP437_HI.charAt(i - 128); }

    function ascii() {
        var h = '<table class="emu-ascii"><thead><tr><th>Dec</th><th>Hex</th><th>Bin</th><th>Ký tự</th><th>Dec</th><th>Hex</th><th>Bin</th><th>Ký tự</th></tr></thead><tbody>';
        for (var i = 0; i < 128; i++) {
            h += '<tr>';
            [i, i + 128].forEach(function (c) { h += '<td>' + c + '</td><td>' + pad(c.toString(16), 2) + 'h</td><td>' + pad(c.toString(2), 8) + '</td><td>' + esc(glyph(c)) + '</td>'; });
            h += '</tr>';
        }
        open('ASCII codes', h + '</tbody></table><div class="emu-note">0–31 và 127 là ký tự điều khiển (13 = CR về đầu dòng, 10 = LF xuống dòng, 8 = Backspace, 36 = "$" kết thúc chuỗi của INT 21h/AH=9). 128–255 theo bảng mã DOS (CP437). Chữ số "0" = 48, "A" = 65, "a" = 97.</div>');
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
