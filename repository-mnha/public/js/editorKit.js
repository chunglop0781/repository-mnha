// public/js/editorKit.js — tính năng soạn code DÙNG CHUNG cho mọi ngôn ngữ (emu8086, C++, HTML/CSS/JS...)
//   • Ctrl + /        : chú thích / bỏ chú thích các dòng đang chọn (// cho C++/JS, ; cho emu8086, <!-- --> cho HTML, /* */ cho CSS)
//   • Tự đóng ngoặc   : gõ ( [ { " ' ` → tự thêm ) ] } " ' `; gõ ký tự đóng thì nhảy qua; Backspace giữa cặp xoá cả cặp; bôi đen rồi gõ ( → bọc lại
//   • Enter           : giữ nguyên độ thụt của dòng trên; Enter giữa { } (hoặc ( ) [ ], <tag></tag>) → '}' nằm dòng dưới, con trỏ ở dòng giữa đã thụt vào
//   • Tab / Shift+Tab : thụt / lùi 1 cấp (nhiều dòng đang chọn thì áp cho tất cả các dòng)
//   • Gõ '}' ở dòng chỉ có khoảng trắng → tự lùi 1 cấp
// Phần xử lý văn bản là HÀM THUẦN (text, start, end → thay đổi) nên test được bằng node (test/editor-kit.js).
(function (root) {
    'use strict';
    var PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    var CLOSERS = { ')': 1, ']': 1, '}': 1 };
    var WORD = /[A-Za-z0-9_]/;
    var escRe = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); };

    // ---------- cấu hình theo ngôn ngữ / đuôi file ----------
    function cfgFor(lang, file) {
        var ext = String(file || '').split('.').pop().toLowerCase();
        var c = { unit: '    ', pairs: true, backtick: false, tags: false, comment: null };
        if (lang === 'emu8086') { c.comment = { line: ';' }; return c; }
        if (lang === 'cpp') {
            if (ext === 'txt') { c.pairs = false; return c; }          // file dữ liệu (input.txt...): không tự đóng ngoặc
            c.comment = { line: '//' }; return c;
        }
        if (lang === 'html') {
            c.unit = '  ';
            if (ext === 'html' || ext === 'htm' || ext === 'svg') { c.comment = { block: ['<!--', '-->'] }; c.tags = true; }
            else if (ext === 'css') c.comment = { block: ['/*', '*/'] };
            else if (ext === 'js') { c.comment = { line: '//' }; c.backtick = true; }
            else if (ext === 'json') c.comment = null;
            else c.pairs = false;                                        // .txt
            return c;
        }
        c.comment = { line: '//' };
        return c;
    }

    // ---------- tiện ích ----------
    function lineRange(text, s, e) {      // [ls, le): các dòng chứa vùng chọn (con trỏ ở đầu dòng cuối khi bôi nhiều dòng thì không tính dòng đó)
        var ls = s > 0 ? text.lastIndexOf('\n', s - 1) + 1 : 0;
        var eAdj = (e > s && text.charAt(e - 1) === '\n') ? e - 1 : e;
        var le = text.indexOf('\n', eAdj);
        if (le < 0) le = text.length;
        return { ls: ls, le: le };
    }

    // ---------- gõ 1 ký tự ----------
    function type(text, s, e, ch, cfg) {
        if (!cfg.pairs) return null;
        var isQuote = ch === '"' || ch === "'" || ch === '`';
        var isOpen = (ch === '(' || ch === '[' || ch === '{') || isQuote;
        if (ch === '`' && !cfg.backtick) return null;
        if (s !== e) {      // đang bôi đen → bọc lại
            if (!isOpen) return null;
            var sel = text.slice(s, e);
            return { start: s, end: e, text: ch + sel + PAIRS[ch], selStart: s + 1, selEnd: s + 1 + sel.length };
        }
        var before = text.slice(0, s), next = text.charAt(s), prev = before.slice(-1);
        if ((CLOSERS[ch] || isQuote) && next === ch) return { start: s, end: s, text: '', selStart: s + 1, selEnd: s + 1 };      // nhảy qua ký tự đóng đã có
        if (CLOSERS[ch]) {      // gõ } ) ] ở dòng chỉ có khoảng trắng → lùi 1 cấp
            var line = before.slice(before.lastIndexOf('\n') + 1);
            if (line.length && /^[ \t]+$/.test(line)) {
                var cut = line.slice(-cfg.unit.length) === cfg.unit ? cfg.unit.length : (line.slice(-1) === '\t' ? 1 : 0);
                if (cut) return { start: s - cut, end: s, text: ch, selStart: s - cut + 1, selEnd: s - cut + 1 };
            }
            return null;
        }
        if (!isOpen) return null;
        if (isQuote) {
            if (WORD.test(prev)) return null;                                    // don't, 5' ... hoặc ký tự đóng
            var ln = before.slice(before.lastIndexOf('\n') + 1), n = 0;
            for (var i = 0; i < ln.length; i++) if (ln.charAt(i) === ch) n++;
            if (n % 2 === 1) return null;                                        // đang ở trong chuỗi → ký tự này là ký tự đóng
        }
        if (!(next === '' || /[\s)\]}>;,.:]/.test(next))) return null;           // đứng trước chữ khác thì không tự đóng
        return { start: s, end: s, text: ch + PAIRS[ch], selStart: s + 1, selEnd: s + 1 };
    }

    // ---------- Backspace giữa cặp ngoặc ----------
    function backspace(text, s, e, cfg) {
        if (!cfg.pairs || s !== e || s < 1) return null;
        var p = text.charAt(s - 1), n = text.charAt(s);
        if (PAIRS[p] && !CLOSERS[p] && PAIRS[p] === n) return { start: s - 1, end: s + 1, text: '', selStart: s - 1, selEnd: s - 1 };
        return null;
    }

    // ---------- Enter: giữ độ thụt, mở khối ----------
    function enter(text, s, e, cfg) {
        var before = text.slice(0, s), after = text.slice(e);
        var line = before.slice(before.lastIndexOf('\n') + 1);
        var indent = /^[ \t]*/.exec(line)[0];
        var prev = before.slice(-1), next = after.charAt(0);
        var last = line.replace(/\s+$/, '').slice(-1);
        var between = cfg.pairs && (prev === '{' || prev === '(' || prev === '[') && next === PAIRS[prev];
        var tagBetween = cfg.tags && prev === '>' && /^<\//.test(after);
        if (between || tagBetween) {
            var mid = indent + cfg.unit;
            return { start: s, end: e, text: '\n' + mid + '\n' + indent, selStart: s + 1 + mid.length, selEnd: s + 1 + mid.length };
        }
        var extra = cfg.pairs && (last === '{' || last === '[' || last === '(') ? cfg.unit : '';
        var ins = '\n' + indent + extra;
        return { start: s, end: e, text: ins, selStart: s + ins.length, selEnd: s + ins.length };
    }

    // ---------- Tab / Shift+Tab ----------
    function tab(text, s, e, shift, cfg) {
        var multi = text.slice(s, e).indexOf('\n') >= 0;
        if (!shift && !multi) return { start: s, end: e, text: cfg.unit, selStart: s + cfg.unit.length, selEnd: s + cfg.unit.length };
        var r = lineRange(text, s, e), lines = text.slice(r.ls, r.le).split('\n'), d1 = 0;
        var out = lines.map(function (l, i) {
            var n = l;
            if (shift) {
                if (l.slice(0, cfg.unit.length) === cfg.unit) n = l.slice(cfg.unit.length);
                else if (l.charAt(0) === '\t') n = l.slice(1);
                else n = l.replace(/^ {1,4}/, '');
            } else if (l.length) n = cfg.unit + l;
            if (i === 0) d1 = n.length - l.length;
            return n;
        }).join('\n');
        if (s === e) { var c1 = Math.max(r.ls, s + d1); return { start: r.ls, end: r.le, text: out, selStart: c1, selEnd: c1 }; }
        return { start: r.ls, end: r.le, text: out, selStart: r.ls, selEnd: r.ls + out.length };
    }

    // ---------- Ctrl + / ----------
    function toggleComment(text, s, e, cfg) {
        if (!cfg.comment) return null;
        var r = lineRange(text, s, e), lines = text.slice(r.ls, r.le).split('\n');
        var filled = lines.filter(function (l) { return l.trim(); });
        if (!filled.length) return null;
        var c = cfg.comment, isC, un, cm;
        if (c.line) {
            var tok = c.line, reC = new RegExp('^\\s*' + escRe(tok)), reU = new RegExp('^(\\s*)' + escRe(tok) + ' ?');
            isC = function (l) { return reC.test(l); };
            un = function (l) { return l.replace(reU, '$1'); };
            cm = function (l, col) { return l.slice(0, col) + tok + ' ' + l.slice(col); };
        } else {
            var o = c.block[0], cl = c.block[1];
            var reB = new RegExp('^\\s*' + escRe(o) + '[\\s\\S]*' + escRe(cl) + '\\s*$'), reUb = new RegExp('^(\\s*)' + escRe(o) + ' ?([\\s\\S]*?) ?' + escRe(cl) + '(\\s*)$');
            isC = function (l) { return reB.test(l); };
            un = function (l) { return l.replace(reUb, '$1$2'); };
            cm = function (l, col) { return l.slice(0, col) + o + ' ' + l.slice(col).replace(/\s+$/, '') + ' ' + cl; };
        }
        var uncomment = filled.every(isC), col = Infinity;
        filled.forEach(function (l) { col = Math.min(col, /^[ \t]*/.exec(l)[0].length); });
        var out = lines.map(function (l) { return !l.trim() ? l : (uncomment ? un(l) : cm(l, col)); }).join('\n');
        var oldFirst = lines[0].length, newFirst = out.split('\n')[0].length;
        if (s === e) { var c1 = Math.max(r.ls, s + (newFirst - oldFirst)); return { start: r.ls, end: r.le, text: out, selStart: c1, selEnd: c1 }; }
        return { start: r.ls, end: r.le, text: out, selStart: r.ls, selEnd: r.ls + out.length };
    }

    var edits = { type: type, backspace: backspace, enter: enter, tab: tab, toggleComment: toggleComment, lineRange: lineRange };

    // ---------- gắn vào <textarea> ----------
    function attach(ed, opts) {
        opts = opts || {};
        var cfg = cfgFor(opts.lang, opts.file);
        function apply(r) {      // dùng execCommand để giữ được Ctrl+Z; không có thì ghi thẳng vào value
            if (!r) return;
            var cur = ed.value, want = cur.slice(0, r.start) + r.text + cur.slice(r.end);
            if (want !== cur) {
                ed.focus(); ed.setSelectionRange(r.start, r.end);
                var ok = false;
                try { ok = r.text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, r.text); } catch (_) { ok = false; }
                if (!ok || ed.value !== want) { ed.value = want; ed.dispatchEvent(new Event('input', { bubbles: true })); }
            }
            ed.setSelectionRange(r.selStart, r.selEnd);
        }
        function comment() {
            if (!cfg.comment || ed.readOnly) return false;
            var r = toggleComment(ed.value, ed.selectionStart, ed.selectionEnd, cfg);
            if (r) apply(r);
            return true;
        }
        ed.addEventListener('keydown', function (e) {
            if (ed.readOnly || opts.readOnly || e.isComposing || e.keyCode === 229) return;      // bộ gõ tiếng Việt đang soạn → để nguyên
            var k = e.key, mod = e.ctrlKey || e.metaKey, s = ed.selectionStart, en = ed.selectionEnd, t = ed.value, r = null;
            if (mod && !e.altKey && (k === '/' || e.code === 'Slash')) { if (cfg.comment) { e.preventDefault(); comment(); } return; }
            if (mod || e.altKey) return;
            if (k === 'Tab') { e.preventDefault(); apply(tab(t, s, en, e.shiftKey, cfg)); return; }
            if (k === 'Enter') r = enter(t, s, en, cfg);
            else if (k === 'Backspace') r = backspace(t, s, en, cfg);
            else if (k && k.length === 1) r = type(t, s, en, k, cfg);
            if (r) { e.preventDefault(); apply(r); }
        });
        return { cfg: cfg, comment: comment, canComment: !!cfg.comment };
    }

    var api = { attach: attach, cfgFor: cfgFor, edits: edits };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EditorKit = api;
})(typeof window !== 'undefined' ? window : this);
