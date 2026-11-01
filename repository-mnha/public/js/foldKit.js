// public/js/foldKit.js — GẤP / MỞ khối code (giống VS Code) cho trình soạn <textarea>: C++ (.cpp/.h...), HTML/SVG, CSS, JS, JSON.
//   • Mũi tên ▾ cạnh số dòng (rê chuột vào lề trái sẽ hiện) → bấm để thu gọn khối; dòng đã thu gọn hiện ▸ và dạng  `int main() { … }`
//   • Bấm vào dòng đã thu gọn (phần …) cũng mở ra được.      • Số dòng luôn là số dòng THẬT của file (nhảy qua phần bị ẩn).
//   • Ctrl+Shift+[ : thu gọn khối chứa con trỏ   • Ctrl+Shift+] : mở khối tại con trỏ   (Mac: Cmd+Option+[ / ])
//   • Nút "Thu gọn tất cả" / "Mở rộng tất cả" trên thanh trên.  Thu gọn lồng nhau được; mở khối ngoài thì khối trong vẫn giữ trạng thái thu gọn.
// Cách hoạt động: phần code bị ẩn được cất trong bộ nhớ, trong <textarea> chỉ còn 1 dòng thay thế (có mã nhận dạng ẩn ở cuối dòng).
//   → LUÔN lấy nội dung thật bằng  fold.getText()  (lưu / chạy / so sánh "chưa lưu"), đừng đọc thẳng ed.value khi đã gắn FoldKit.
//   → Gõ/xoá/dán đụng vào dòng đã thu gọn thì khối đó tự mở ra trước (không bao giờ làm mất code bị ẩn). Copy/Ctrl+A luôn lấy đủ code thật.
//   → Mỗi lần thu gọn/mở, trình duyệt xoá lịch sử Ctrl+Z của ô soạn (giới hạn của <textarea>); gõ tiếp bình thường vẫn undo được.
// Phần phân tích khối (computeRanges) và Doc là HÀM THUẦN → test bằng node (test/fold-kit.js).
(function (root) {
    'use strict';
    var MARK = '\u2063', Z0 = '\u200B', Z1 = '\u200C', DOTS = ' \u2026';
    var PH_RE = /\u2063([\u200B\u200C]+)\u2063$/;
    var MAXLEN = 1500000;      // file lớn hơn thế này: không dò khối (tránh đơ trình duyệt)

    function encId(n) { var b = n.toString(2), s = ''; for (var i = 0; i < b.length; i++) s += b.charAt(i) === '1' ? Z1 : Z0; return MARK + s + MARK; }
    function decId(z) { var b = ''; for (var i = 0; i < z.length; i++) b += z.charAt(i) === Z1 ? '1' : '0'; return parseInt(b, 2); }

    // ---------- cấu hình theo ngôn ngữ / đuôi file ----------
    var CFG_C = { open: '{', raw: true }, CFG_CSS = { open: '{' }, CFG_JS = { open: '{[(', backtick: true }, CFG_JSON = { open: '{[' }, CFG_HTML = { html: true };
    function cfgFor(lang, file) {
        var ext = String(file || '').split('.').pop().toLowerCase();
        if (lang === 'cpp') return ext === 'txt' ? null : CFG_C;
        if (lang === 'html') {
            if (ext === 'html' || ext === 'htm' || ext === 'svg') return CFG_HTML;
            if (ext === 'css') return CFG_CSS;
            if (ext === 'js') return CFG_JS;
            if (ext === 'json') return CFG_JSON;
        }
        return null;
    }

    // ---------- dò các khối có thể gấp ----------
    function lineStarts(t) { var a = [0], i = -1; while ((i = t.indexOf('\n', i + 1)) >= 0) a.push(i + 1); return a; }
    function lineOfFn(st) { return function (p) { var lo = 0, hi = st.length - 1; while (lo < hi) { var m = (lo + hi + 1) >> 1; if (st[m] <= p) lo = m; else hi = m - 1; } return lo; }; }

    // Khối kiểu ngoặc { } [ ] ( ) + chú thích /* */, bỏ qua chuỗi "..." '...' `...`, chú thích //, raw string C++
    // Trả về {s, e, h}: s = dòng bắt đầu, e = dòng CUỐI bị ẩn, h = dòng đóng cũng bị ẩn (true: dòng đóng chỉ có } ) ] ; , → hiện ở cuối dòng thu gọn)
    function scanBraces(text, o) {
        var n = text.length, i = 0, st = lineStarts(text), L = lineOfFn(st), stack = [], out = [], open = o.open;
        var CLOSE = { '{': '}', '[': ']', '(': ')' }, OPENER = { '}': '{', ']': '[', ')': '(' };
        function lineText(k) { return text.slice(st[k], k + 1 < st.length ? st[k + 1] - 1 : n); }
        while (i < n) {
            var c = text.charAt(i), d = text.charAt(i + 1);
            if (c === '/' && d === '/') { var nl = text.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
            if (c === '/' && d === '*') {
                var e = text.indexOf('*/', i + 2), end = e < 0 ? n : e + 2, a = L(i), b = L(Math.max(i, end - 1));
                if (b > a) out.push({ s: a, e: b, h: true });
                i = end; continue;
            }
            if (c === '"' || c === "'") {
                if (c === '"' && o.raw && text.charAt(i - 1) === 'R') {                      // R"delim( ... )delim"
                    var p = text.indexOf('(', i + 1), dl = p < 0 ? -1 : text.slice(i + 1, p);
                    if (p >= 0 && dl.length <= 16 && !/[\s\\)"]/.test(dl)) { var q = text.indexOf(')' + dl + '"', p); i = q < 0 ? n : q + dl.length + 2; continue; }
                }
                if (c === "'" && /[0-9A-Za-z_]/.test(text.charAt(i - 1))) { i++; continue; }  // 1'000'000 (C++14)
                var j = i + 1;
                while (j < n) { var ch = text.charAt(j); if (ch === '\\') { j += 2; continue; } if (ch === c || ch === '\n') break; j++; }
                i = text.charAt(j) === c ? j + 1 : j; continue;
            }
            if (c === '`' && o.backtick) { var j2 = i + 1; while (j2 < n && text.charAt(j2) !== '`') { if (text.charAt(j2) === '\\') j2++; j2++; } i = j2 + 1; continue; }
            if (open.indexOf(c) >= 0) { stack.push({ c: c, line: L(i) }); i++; continue; }
            if (OPENER[c] && open.indexOf(OPENER[c]) >= 0) {
                var k = stack.length - 1; while (k >= 0 && CLOSE[stack[k].c] !== c) k--;
                if (k >= 0) {
                    var op = stack[k], cl = L(i); stack.length = k;
                    if (cl > op.line) {
                        var tx = lineText(cl).replace(/\s*(\/\/.*|\/\*.*\*\/)\s*$/, '').trim();
                        if (/^[}\])]+[;,]*$/.test(tx)) out.push({ s: op.line, e: cl, h: true });          // dòng đóng chỉ có } hoặc };
                        else if (cl - 1 > op.line) out.push({ s: op.line, e: cl - 1, h: false });         // } else {  → giữ nguyên dòng đóng
                    }
                }
            }
            i++;
        }
        return out;
    }

    var VOID = {}; 'area base br col embed hr img input link meta param source track wbr'.split(' ').forEach(function (t) { VOID[t] = 1; });

    // Khối HTML: cặp thẻ mở/đóng, chú thích <!-- -->, và bên trong <script>/<style> thì gấp theo { } như JS/CSS
    function scanHtml(text) {
        var out = [], stack = [], st = lineStarts(text), L = lineOfFn(st), lower = null, m;
        var re = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
        while ((m = re.exec(text))) {
            var tok = m[0];
            if (tok.charAt(1) === '!') { var a = L(m.index), b = L(m.index + tok.length - 1); if (b > a) out.push({ s: a, e: b, h: true }); continue; }
            var name = m[2].toLowerCase();
            if (m[1] === '/') {
                var k = stack.length - 1; while (k >= 0 && stack[k].name !== name) k--;
                if (k < 0) continue;
                var op = stack[k], el = L(m.index); stack.length = k;
                if (el > op.line) {
                    if (!/\S/.test(text.slice(st[el], m.index))) out.push({ s: op.line, e: el, h: true });     // thẻ đóng đứng đầu dòng → ẩn cả dòng, hiện </div> ở cuối
                    else if (el - 1 > op.line) out.push({ s: op.line, e: el - 1, h: false });
                }
                continue;
            }
            if (VOID[name] || /\/\s*$/.test(m[3])) continue;
            stack.push({ name: name, line: L(m.index) });
            if (name === 'script' || name === 'style') {
                if (!lower) lower = text.toLowerCase();
                var from = re.lastIndex, close = lower.indexOf('</' + name, from);
                if (close < 0) close = text.length;
                if (close > from) {
                    var base = L(from), inner = scanBraces(text.slice(from, close), name === 'style' ? CFG_CSS : CFG_JS);
                    for (var x = 0; x < inner.length; x++) out.push({ s: inner[x].s + base, e: inner[x].e + base, h: inner[x].h });
                }
                re.lastIndex = close;
            }
        }
        return out;
    }

    function normalize(rs) {      // mỗi dòng bắt đầu giữ khối dài nhất; sắp theo dòng
        var best = {};
        rs.forEach(function (r) { if (r.e <= r.s) return; var b = best[r.s]; if (!b || r.e > b.e) best[r.s] = r; });
        return Object.keys(best).map(Number).sort(function (x, y) { return x - y; }).map(function (k) { return best[k]; });
    }
    function computeRanges(text, cfg) { return normalize(cfg.html ? scanHtml(text) : scanBraces(text, cfg)); }

    // ---------- trạng thái các khối đã thu gọn (không đụng DOM) ----------
    function splice1(lines, i, rep) { var tail = lines.slice(i + 1), k; lines.length = i; for (k = 0; k < rep.length; k++) lines.push(rep[k]); for (k = 0; k < tail.length; k++) lines.push(tail[k]); }

    function Doc() { this.folds = {}; this.nextId = 1; this.count = 0; }
    Doc.prototype.idOf = function (line) {
        if (line.charCodeAt(line.length - 1) !== 0x2063) return 0;
        var m = PH_RE.exec(line); if (!m) return 0;
        var id = decId(m[1]); return this.folds[id] ? id : 0;
    };
    Doc.prototype.flen = function (line) { var id = this.idOf(line); return id ? this.folds[id].flen : line.length; };
    // ol[i] = số dòng thật (0-based) của dòng hiển thị i; span[i] = dòng đó chiếm bao nhiêu dòng thật; ids[i] = mã khối nếu là dòng thu gọn
    Doc.prototype.layout = function (lines) {
        var ol = new Array(lines.length), span = new Array(lines.length), ids = new Array(lines.length), n = 0;
        for (var i = 0; i < lines.length; i++) { var id = this.idOf(lines[i]); ol[i] = n; ids[i] = id; span[i] = id ? this.folds[id].n : 1; n += span[i]; }
        return { ol: ol, span: span, ids: ids, total: n };
    };
    Doc.prototype.lastLine = function (line) {
        var id = this.idOf(line); if (!id) return line;
        var o = this.folds[id].orig, k = o.lastIndexOf('\n'); return this.lastLine(k < 0 ? o : o.slice(k + 1));
    };
    Doc.prototype.expandLines = function (lines) {
        if (!this.count) return lines;
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var id = this.idOf(lines[i]);
            if (id) { var inner = this.expandLines(this.folds[id].orig.split('\n')); for (var k = 0; k < inner.length; k++) out.push(inner[k]); }
            else out.push(lines[i]);
        }
        return out;
    };
    Doc.prototype.expand = function (text) { return (!this.count || text.indexOf(MARK) < 0) ? text : this.expandLines(text.split('\n')).join('\n'); };

    // thu gọn các dòng thật s..e (h = hiện dòng đóng ở cuối). Sửa thẳng mảng `lines` (các dòng hiển thị). Trả về true nếu thu gọn được.
    Doc.prototype.fold = function (lines, s, e, h) {
        var lay = this.layout(lines), i = lay.ol.indexOf(s);
        if (i < 0 || lay.ids[i]) return false;                          // dòng bắt đầu đang bị ẩn / đã thu gọn
        var j = i + 1; while (j < lines.length && lay.ol[j] + lay.span[j] - 1 < e) j++;
        if (j >= lines.length || lay.ol[j] + lay.span[j] - 1 !== e) return false;      // khối cắt ngang một khối đã thu gọn khác
        var id = this.nextId++, first = lines[i].replace(/\s+$/, ''), tail = h ? this.lastLine(lines[j]).trim() : '';
        this.folds[id] = { orig: lines.slice(i, j + 1).join('\n'), n: e - s + 1, flen: first.length };
        this.count++;
        lines.splice(i, j - i + 1, first + DOTS + (tail ? ' ' + tail : '') + encId(id));      // thay i..j bằng 1 dòng
        return true;
    };
    Doc.prototype.unfold = function (lines, i) {      // mở 1 dòng thu gọn; trả về số dòng chèn vào (0 nếu dòng đó không phải khối thu gọn)
        var id = this.idOf(lines[i]); if (!id) return 0;
        var rep = this.folds[id].orig.split('\n'); delete this.folds[id]; this.count--;
        splice1(lines, i, rep); return rep.length;
    };
    // dòng nào (chỉ số hiển thị) bị chạm bởi 1 thao tác sửa [a,b) — mode: insert | newline | range
    Doc.prototype.touched = function (lines, a, b, mode) {
        var res = [], pos = 0;
        for (var i = 0; i < lines.length; i++) {
            var ls = pos, le = pos + lines[i].length; pos = le + 1;
            if (ls > b) break;
            if (!this.idOf(lines[i])) continue;
            if (mode === 'insert' ? (ls <= a && a <= le) : mode === 'newline' ? (ls < a && a < le) : (a < le + 1 && b >= ls)) res.push(i);
        }
        return res;
    };
    Doc.prototype.unfoldMany = function (lines, idxs, pts) {      // mở các dòng idxs (tăng dần), dời luôn các điểm pts {line,col}
        for (var q = idxs.length - 1; q >= 0; q--) {
            var p = idxs[q], f = this.folds[this.idOf(lines[p])], rep = f.orig.split('\n'), lastLen = rep[rep.length - 1].length, add = rep.length - 1;
            this.unfold(lines, p);
            for (var t = 0; t < pts.length; t++) {
                var pt = pts[t];
                if (pt.line > p) pt.line += add;
                else if (pt.line === p && pt.col > f.flen) { pt.line = p + add; pt.col = lastLen; }
            }
        }
    };
    Doc.prototype.foldAll = function (lines, ranges) { var did = false; for (var k = ranges.length - 1; k >= 0; k--) did = this.fold(lines, ranges[k].s, ranges[k].e, ranges[k].h) || did; return did; };
    Doc.prototype.unfoldAll = function (lines) {
        if (!this.count) return false;
        var ex = this.expandLines(lines); lines.length = 0; for (var i = 0; i < ex.length; i++) lines.push(ex[i]);
        this.folds = {}; this.count = 0; return true;
    };

    // ---------- vị trí con trỏ ----------
    function toPt(lines, off) {
        var pos = 0;
        for (var i = 0; i < lines.length; i++) { var len = lines[i].length; if (off <= pos + len) return { line: i, col: off - pos }; pos += len + 1; }
        return { line: lines.length - 1, col: lines[lines.length - 1].length };
    }
    function toOff(lines, pt) { var pos = 0; for (var i = 0; i < pt.line; i++) pos += lines[i].length + 1; return pos + Math.min(pt.col, lines[pt.line].length); }

    // ---------- gắn vào <textarea> + lề số dòng ----------
    function attach(ed, gutter, opts) {
        opts = opts || {};
        var cfg = cfgFor(opts.lang, opts.file);
        if (!cfg || !ed || !gutter) return null;
        var F = new Doc(), ranges = [], rmap = {}, sig = '', stale = false, lastLines = -1, timer = null, cache = { d: null, f: null };

        function countLines(v) { var n = 1, i = -1; while ((i = v.indexOf('\n', i + 1)) >= 0) n++; return n; }
        function getText() { var v = ed.value; if (!F.count) return v; if (cache.d !== v) { cache.f = F.expand(v); cache.d = v; } return cache.f; }

        function render() {
            var lines = ed.value.split('\n'), lay = F.layout(lines), h = new Array(lines.length);
            for (var i = 0; i < lines.length; i++) {
                var ol = lay.ol[i], cls = lay.ids[i] ? 'c' : (!stale && rmap[ol] ? 'o' : '');
                h[i] = '<div class="fg-r">' + (ol + 1) + '<i class="fg-a' + (cls ? ' ' + cls + '" data-i="' + i + '" title="' + (cls === 'c' ? 'Mở rộng (Ctrl+Shift+])' : 'Thu gọn (Ctrl+Shift+[)') : '') + '"></i></div>';
            }
            gutter.innerHTML = h.join('');
            gutter.scrollTop = ed.scrollTop;
            lastLines = lines.length;
        }
        function recompute() {
            clearTimeout(timer);
            var full = getText(); ranges = full.length > MAXLEN ? [] : computeRanges(full, cfg);
            rmap = {}; ranges.forEach(function (r) { rmap[r.s] = r; });
            var s2 = ranges.map(function (r) { return r.s + ':' + r.e + (r.h ? 'h' : ''); }).join(',');
            var need = stale || s2 !== sig; sig = s2; stale = false;
            if (need) render();
        }
        function onInput() {          // gọi sau mỗi lần gõ (thay cho việc tự dựng lề số dòng)
            if (countLines(ed.value) !== lastLines) { stale = true; render(); }      // đổi số dòng: tạm ẩn mũi tên ▾ cho tới khi dò lại
            clearTimeout(timer); timer = setTimeout(recompute, 150);
        }

        // đổi nội dung hiển thị nhưng giữ vị trí con trỏ + cuộn (pts: điểm {line,col} theo mảng lines MỚI)
        function put(lines, pts) {
            var st = ed.scrollTop, sl = ed.scrollLeft;
            ed.value = lines.join('\n'); ed.scrollTop = st; ed.scrollLeft = sl;
            ed.setSelectionRange(toOff(lines, pts[0]), toOff(lines, pts[1]));
            render();
        }
        function fullPt(lay, lines, pt) { return { fl: lay.ol[pt.line], col: Math.min(pt.col, F.flen(lines[pt.line])) }; }
        function backPt(lay, lines, f) {
            var k = 0, lo = 0, hi = lines.length - 1;
            while (lo < hi) { var m = (lo + hi + 1) >> 1; if (lay.ol[m] <= f.fl) lo = m; else hi = m - 1; }
            k = lo; return { line: k, col: lay.ol[k] === f.fl ? f.col : F.flen(lines[k]) };
        }
        function mutate(fn) {         // fn(lines) sửa mảng dòng hiển thị, trả true nếu có đổi
            var lines = ed.value.split('\n'), lay0 = F.layout(lines);
            var a = fullPt(lay0, lines, toPt(lines, ed.selectionStart)), b = fullPt(lay0, lines, toPt(lines, ed.selectionEnd));
            if (!fn(lines)) return false;
            var lay1 = F.layout(lines);
            put(lines, [backPt(lay1, lines, a), backPt(lay1, lines, b)]);
            return true;
        }

        function foldAll() { recompute(); var rs = ranges.slice(); return mutate(function (l) { return F.foldAll(l, rs); }); }
        function unfoldAll() { return mutate(function (l) { return F.unfoldAll(l); }); }
        function foldAtCaret() {
            recompute();
            var lines = ed.value.split('\n'), lay = F.layout(lines), ol = lay.ol[toPt(lines, ed.selectionStart).line], best = null;
            ranges.forEach(function (r) {
                if (r.s > ol || ol > r.e) return;
                var i = lay.ol.indexOf(r.s); if (i < 0 || lay.ids[i]) return;
                if (!best || r.s > best.s) best = r;
            });
            return !!best && mutate(function (l) { return F.fold(l, best.s, best.e, best.h); });
        }
        function unfoldAtCaret() {
            var lines = ed.value.split('\n'), i = toPt(lines, ed.selectionStart).line;
            return !!F.idOf(lines[i]) && mutate(function (l) { return F.unfold(l, i) > 0; });
        }

        // trước khi sửa: mở các khối thu gọn mà thao tác sửa sẽ chạm vào (không phá dòng thu gọn, không mất code ẩn)
        function guard(kind) {
            if (!F.count || ed.readOnly) return false;
            var v = ed.value; if (v.indexOf(MARK) < 0) return false;
            var lines = v.split('\n'), s = ed.selectionStart, en = ed.selectionEnd, a = s, b = en, mode = 'range', i;
            if (kind === 'lines') {
                var e2 = (en > s && v.charAt(en - 1) === '\n') ? en - 1 : en, ps = toPt(lines, s), pe = toPt(lines, e2);
                a = 0; for (i = 0; i < ps.line; i++) a += lines[i].length + 1;
                b = 0; for (i = 0; i < pe.line; i++) b += lines[i].length + 1; b += lines[pe.line].length;
            } else if (kind === 'enter') mode = s === en ? 'newline' : 'range';
            else if (kind === 'back') { if (s === en) { if (s === 0) return false; a = s - 1; } }
            else if (kind === 'del') { if (s === en) { if (s >= v.length) return false; b = s + 1; } }
            else mode = s === en ? 'insert' : 'range';
            var idx = F.touched(lines, a, b, mode); if (!idx.length) return false;
            var pts = [toPt(lines, s), toPt(lines, en)];
            F.unfoldMany(lines, idx, pts);
            put(lines, pts);
            return true;
        }

        function keyKind(e) {         // phím này sẽ sửa văn bản theo kiểu nào?
            var k = e.key, mod = e.ctrlKey || e.metaKey;
            if (e.isComposing || e.keyCode === 229) return 'type';
            if (mod && !e.altKey) {
                var kl = (k || '').toLowerCase();
                if (kl === 'v') return 'type'; if (kl === 'x') return ed.selectionStart === ed.selectionEnd ? 'lines' : 'type';
                if (k === '/' || e.code === 'Slash') return 'lines';
                return null;
            }
            if (k === 'Enter') return 'enter'; if (k === 'Backspace') return 'back'; if (k === 'Delete') return 'del';
            if (k === 'Tab') return (e.shiftKey || ed.value.slice(ed.selectionStart, ed.selectionEnd).indexOf('\n') >= 0) ? 'lines' : 'type';
            if (k && k.length === 1) return 'type';
            return null;
        }
        // PHẢI gắn trước EditorKit.attach để chạy trước các xử lý Tab/Enter/ngoặc của EditorKit
        ed.addEventListener('keydown', function (e) {
            var mod = e.ctrlKey || e.metaKey;
            if (mod && (e.shiftKey || e.altKey) && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
                e.preventDefault(); if (e.code === 'BracketLeft') foldAtCaret(); else unfoldAtCaret(); return;
            }
            if (!F.count || ed.readOnly) return;
            var kind = keyKind(e); if (kind) guard(kind);
        });
        ed.addEventListener('compositionstart', function () { guard('type'); });
        ed.addEventListener('beforeinput', function (e) {      // lưới an toàn: dán/kéo thả/menu chuột phải... đụng dòng thu gọn → mở ra rồi để người dùng thao tác lại
            if (!F.count || ed.readOnly) return;
            var t = e.inputType || ''; if (t.indexOf('history') === 0) return;
            var kind = (t === 'insertParagraph' || t === 'insertLineBreak') ? 'enter' : t === 'deleteContentBackward' ? 'back' : t === 'deleteContentForward' ? 'del' : t.indexOf('delete') === 0 ? 'lines' : 'type';
            if (guard(kind)) e.preventDefault();
        });
        function selectedFull() {      // đoạn đang chọn, đã bung các dòng thu gọn (mép chọn rơi giữa dòng thu gọn thì lấy trọn dòng đó)
            var lines = ed.value.split('\n'), ps = toPt(lines, ed.selectionStart), pe = toPt(lines, ed.selectionEnd);
            if (F.idOf(lines[ps.line])) ps.col = 0;
            if (F.idOf(lines[pe.line])) pe.col = lines[pe.line].length;
            var part = lines.slice(ps.line, pe.line + 1);
            if (ps.line === pe.line) part[0] = part[0].slice(ps.col, pe.col); else { part[0] = part[0].slice(ps.col); part[part.length - 1] = part[part.length - 1].slice(0, pe.col); }
            return F.expandLines(part).join('\n');
        }
        function onClip(e) {
            if (!F.count || ed.selectionStart === ed.selectionEnd || ed.value.slice(ed.selectionStart, ed.selectionEnd).indexOf(MARK) < 0 || !e.clipboardData) return;
            e.clipboardData.setData('text/plain', selectedFull()); e.preventDefault();
            if (e.type === 'cut' && !ed.readOnly) { guard('type'); try { document.execCommand('delete'); } catch (_) { /* */ } }
        }
        ed.addEventListener('copy', onClip); ed.addEventListener('cut', onClip);
        ed.addEventListener('click', function () {      // bấm vào phần … của dòng thu gọn → mở
            if (!F.count || ed.selectionStart !== ed.selectionEnd) return;
            var lines = ed.value.split('\n'), pt = toPt(lines, ed.selectionStart), id = F.idOf(lines[pt.line]);
            if (id && pt.col > F.folds[id].flen) mutate(function (l) { return F.unfold(l, pt.line) > 0; });
        });
        gutter.addEventListener('click', function (e) {
            var a = e.target && e.target.closest ? e.target.closest('.fg-a') : null;
            if (!a || a.getAttribute('data-i') === null) return;
            var i = +a.getAttribute('data-i'), lines = ed.value.split('\n');
            if (stale || lines.length !== lastLines || i >= lines.length) return;
            if (a.classList.contains('c')) mutate(function (l) { return F.unfold(l, i) > 0; });
            else { var r = rmap[F.layout(lines).ol[i]]; if (r) mutate(function (l) { return F.fold(l, r.s, r.e, r.h); }); }
            try { ed.focus({ preventScroll: true }); } catch (_) { /* */ }
        });

        function reset() { F.folds = {}; F.count = 0; cache.d = null; stale = true; recompute(); }      // sau khi code bên ngoài gán lại ed.value
        recompute();
        return { cfg: cfg, getText: getText, refresh: onInput, reset: reset, foldAll: foldAll, unfoldAll: unfoldAll, foldAtCaret: foldAtCaret, unfoldAtCaret: unfoldAtCaret,
            beforeEdit: function () { return guard('lines'); }, count: function () { return F.count; } };
    }

    var api = { attach: attach, cfgFor: cfgFor, computeRanges: computeRanges, Doc: Doc, MARK: MARK };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FoldKit = api;
})(typeof window !== 'undefined' ? window : this);
