// public/js/xlsxView.js — XEM file Excel (.xlsx / .xlsm / .xltx) ngay trong trình duyệt, dạng lưới như Google Sheets.
//
//   File .xlsx thực chất là 1 file .zip chứa các file XML (giống cách thư viện Python openpyxl đọc):
//     xl/workbook.xml (danh sách sheet) · xl/sharedStrings.xml (chuỗi dùng chung) · xl/styles.xml (font, màu nền, viền, định dạng số)
//     · xl/theme/theme1.xml (bảng màu) · xl/worksheets/sheetN.xml (các ô: <c r="B3" t="s" s="5"><v>12</v></c>)
//   Ở đây: giải nén bằng DecompressionStream('deflate-raw') → đọc XML bằng DOMParser → vẽ bảng HTML (tiêu đề cột A, B, C…, số dòng, ô gộp,
//   màu nền / viền / chữ đậm nghiêng / căn lề, độ rộng cột & chiều cao dòng, định dạng số – ngày – % – tiền tệ như Excel, nhiều sheet ở thanh tab dưới,
//   thanh công thức (fx) hiện giá trị / công thức của ô đang chọn, phím mũi tên di chuyển ô, Ctrl+C chép nội dung ô).
//   Dữ liệu KHÔNG rời trình duyệt: file đã được giải mã ở máy người xem (mnhaFiles.js) rồi mới tới đây.
//
//   API:  XlsxView.canView(tên) → true với .xlsx .xlsm .xltx .xltm
//         XlsxView.render(phầnTử, ArrayBuffer, { height, name, onError }) → Promise<{ destroy(), workbook }>
//         XlsxView.load(ArrayBuffer) → Promise<workbook>  (workbook.sheetNames, workbook.sheet(i) → Promise<sheet>)  — dùng cho kiểm thử
//         XlsxView.formatNumber(giáTrị, mãĐịnhDạng, date1904) → chuỗi hiển thị
//   Không hỗ trợ: .xls đời cũ, .xlsb, .ods; biểu đồ / ảnh / định dạng có điều kiện không được vẽ (có ghi chú ở thanh dưới).
(function (root) {
    'use strict';
    var VIEW_EXTS = ['xlsx', 'xlsm', 'xltx', 'xltm'];
    function canView(name) { var e = String(name || '').split('.').pop().toLowerCase(); return VIEW_EXTS.indexOf(e) >= 0; }
    function fail(msg, code) { var e = new Error(msg); e.code = code || ''; return e; }

    // ================================================================ ZIP (chỉ đọc)
    async function inflateRaw(u8) {
        if (typeof DecompressionStream !== 'function') throw fail('Trình duyệt quá cũ, chưa giải nén được .xlsx (thiếu DecompressionStream). Hãy cập nhật Chrome / Edge / Firefox / Safari.', 'NO_DS');
        var ds = new DecompressionStream('deflate-raw');
        return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
    }
    function openZip(buf) {
        var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        var i = u8.length - 22, min = Math.max(0, u8.length - 65557);
        for (; i >= min; i--) if (dv.getUint32(i, true) === 0x06054b50) break;
        if (i < min) throw fail('Không phải file .xlsx hợp lệ (file có thể đặt mật khẩu, hỏng, hoặc là Excel đời cũ .xls). Hãy bấm Tải để mở bằng Excel.', 'NOT_ZIP');
        var n = dv.getUint16(i + 10, true), off = dv.getUint32(i + 16, true), dec = new TextDecoder('utf-8'), ent = {}, low = {};
        for (var k = 0; k < n; k++) {
            if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
            var nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
            var name = dec.decode(u8.subarray(off + 46, off + 46 + nl));
            ent[name] = { method: dv.getUint16(off + 10, true), cs: dv.getUint32(off + 20, true), us: dv.getUint32(off + 24, true), lo: dv.getUint32(off + 42, true) };
            low[name.toLowerCase()] = name;
            off += 46 + nl + el + cl;
        }
        function real(name) { return ent[name] ? name : low[String(name).toLowerCase()]; }
        async function read(name) {
            var nm = real(name); if (!nm) return null;
            var e = ent[nm]; if (e.cs === 0xFFFFFFFF || e.us === 0xFFFFFFFF) throw fail('File Excel quá lớn (zip64) — hãy bấm Tải để mở bằng Excel.', 'ZIP64');
            var p = e.lo, s = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true), data = u8.subarray(s, s + e.cs);
            if (e.method === 0) return data;
            if (e.method === 8) return inflateRaw(data);
            throw fail('File Excel dùng kiểu nén không hỗ trợ (' + e.method + ').', 'ZIP_METHOD');
        }
        return {
            has: function (n) { return !!real(n); },
            read: read,
            text: async function (n) { var d = await read(n); return d ? dec.decode(d) : null; }
        };
    }

    // ================================================================ XML
    function parseXml(text) {
        if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        var doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw fail('File Excel bị lỗi cấu trúc XML.', 'BAD_XML');
        return doc;
    }
    function kids(el, name) {
        var out = [];
        if (!el) return out;
        for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name) out.push(n);
        return out;
    }
    function kid(el, name) {
        if (!el) return null;
        for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name) return n;
        return null;
    }
    var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    function relId(el) { return el.getAttributeNS(NS_R, 'id') || el.getAttribute('r:id') || ''; }
    function parseRels(text) {
        var map = {};
        if (!text) return map;
        kids(parseXml(text).documentElement, 'Relationship').forEach(function (r) { map[r.getAttribute('Id')] = { target: r.getAttribute('Target') || '', type: r.getAttribute('Type') || '' }; });
        return map;
    }
    function resolvePath(baseDir, target) {
        if (target.charAt(0) === '/') return target.slice(1);
        var parts = (baseDir + target).split('/'), out = [];
        parts.forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
        return out.join('/');
    }
    function richText(si) {         // <si><t>…</t></si> hoặc <si><r><t>…</t></r>…</si> (bỏ phiên âm <rPh>)
        var s = '';
        for (var n = si.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1) continue;
            if (n.localName === 't') s += n.textContent;
            else if (n.localName === 'r') { var t = kid(n, 't'); if (t) s += t.textContent; }
        }
        return s;
    }

    // ================================================================ MÀU
    var INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333', '000000', 'FFFFFF'];
    var DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
    function hexToRgb(h) { return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    function rgbToHex(r, g, b) { return [r, g, b].map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
    function applyTint(hex, tint) {
        var c = hexToRgb(hex), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2;
        if (mx !== mn) {
            var d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
            h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
        }
        l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
        function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
        if (s === 0) return rgbToHex(l * 255, l * 255, l * 255);
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        return rgbToHex(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255);
    }
    function parseTheme(text) {
        var out = DEFAULT_THEME.slice();
        if (!text) return out;
        try {
            var scheme = parseXml(text).getElementsByTagNameNS('*', 'clrScheme')[0], names = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'], by = {};
            if (!scheme) return out;
            names.forEach(function (nm) {
                var el = kid(scheme, nm), c = el && el.firstElementChild;
                if (c) by[nm] = (c.getAttribute('val') && c.localName === 'srgbClr') ? c.getAttribute('val') : (c.getAttribute('lastClr') || null);
            });
            var order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
            order.forEach(function (nm, i) { if (by[nm]) out[i] = by[nm].replace('#', ''); });
        } catch (_) { /* dùng bảng màu mặc định */ }
        return out;
    }
    function colorOf(el, theme) {
        if (!el) return null;
        var rgb = el.getAttribute('rgb'), th = el.getAttribute('theme'), ix = el.getAttribute('indexed'), c = null;
        if (rgb) c = rgb.slice(-6);
        else if (th !== null && th !== '') c = theme[+th] || null;
        else if (ix !== null && ix !== '') c = INDEXED[+ix] || null;
        if (!c) return null;
        var tint = parseFloat(el.getAttribute('tint') || '0');
        return '#' + (tint ? applyTint(c, tint) : c);
    }

    // ================================================================ STYLES (font, nền, viền, căn lề, mã định dạng số)
    var BORDER_CSS = { thin: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', dotted: '1px dotted', hair: '1px dotted', double: '3px double', mediumDashed: '2px dashed', dashDot: '1px dashed', dashDotDot: '1px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed' };
    function parseStyles(text, theme) {
        var st = { numFmts: {}, fonts: [], fills: [], borders: [], xfs: [] };
        if (!text) { st.xfs.push({ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0 }); return st; }
        var root = parseXml(text).documentElement;
        kids(kid(root, 'numFmts'), 'numFmt').forEach(function (n) { st.numFmts[n.getAttribute('numFmtId')] = n.getAttribute('formatCode'); });
        kids(kid(root, 'fonts'), 'font').forEach(function (f) {
            function flag(nm) { var e = kid(f, nm); return !!e && e.getAttribute('val') !== '0' && e.getAttribute('val') !== 'false'; }
            var u = kid(f, 'u'), sz = kid(f, 'sz'), nm = kid(f, 'name');
            st.fonts.push({ b: flag('b'), i: flag('i'), strike: flag('strike'), u: !!u && u.getAttribute('val') !== 'none', sz: sz ? parseFloat(sz.getAttribute('val')) : 11, name: nm ? nm.getAttribute('val') : '', color: colorOf(kid(f, 'color'), theme) });
        });
        kids(kid(root, 'fills'), 'fill').forEach(function (f) {
            var p = kid(f, 'patternFill'), g = kid(f, 'gradientFill'), bg = null;
            if (p && p.getAttribute('patternType') === 'solid') bg = colorOf(kid(p, 'fgColor'), theme);
            else if (p && p.getAttribute('patternType') && p.getAttribute('patternType') !== 'none' && p.getAttribute('patternType') !== 'gray125') bg = colorOf(kid(p, 'fgColor'), theme);
            else if (g) { var stp = kid(g, 'stop'); bg = stp ? colorOf(kid(stp, 'color'), theme) : null; }
            st.fills.push({ bg: bg });
        });
        kids(kid(root, 'borders'), 'border').forEach(function (b) {
            var o = {};
            [['l', 'left', 'start'], ['r', 'right', 'end'], ['t', 'top'], ['b', 'bottom']].forEach(function (d) {
                var e = kid(b, d[1]) || (d[2] && kid(b, d[2]));
                if (e && e.getAttribute('style')) o[d[0]] = { style: e.getAttribute('style'), color: colorOf(kid(e, 'color'), theme) || '#000000' };
            });
            st.borders.push(o);
        });
        kids(kid(root, 'cellXfs'), 'xf').forEach(function (x) {
            var a = kid(x, 'alignment');
            st.xfs.push({
                numFmtId: +x.getAttribute('numFmtId') || 0, fontId: +x.getAttribute('fontId') || 0, fillId: +x.getAttribute('fillId') || 0, borderId: +x.getAttribute('borderId') || 0,
                h: a ? a.getAttribute('horizontal') : null, v: a ? a.getAttribute('vertical') : null, wrap: !!a && (a.getAttribute('wrapText') === '1' || a.getAttribute('wrapText') === 'true'), indent: a ? (+a.getAttribute('indent') || 0) : 0
            });
        });
        if (!st.xfs.length) st.xfs.push({ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0 });
        return st;
    }

    // ================================================================ ĐỊNH DẠNG SỐ / NGÀY (như Excel)
    var BUILTIN = {
        0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
        14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm',
        37: '#,##0_);(#,##0)', 38: '#,##0_);(#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);(#,##0.00)',
        41: '#,##0_);(#,##0);"-"_)', 42: '#,##0_);(#,##0);"-"_)', 43: '#,##0.00_);(#,##0.00);"-"??_)', 44: '#,##0.00_);(#,##0.00);"-"??_)',
        45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@'
    };
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    function splitSections(code) {
        var out = [], cur = '', q = false;
        for (var i = 0; i < code.length; i++) {
            var ch = code.charAt(i);
            if (ch === '\\' && i + 1 < code.length) { cur += ch + code.charAt(++i); }
            else if (ch === '"') { q = !q; cur += ch; }
            else if (ch === ';' && !q) { out.push(cur); cur = ''; }
            else cur += ch;
        }
        out.push(cur);
        return out;
    }
    function stripMeta(sec) {       // bỏ [Red], [Color1], điều kiện [>100], giữ [$₫-42A] → ₫ và [h] [m] [s]
        return sec.replace(/\[([^\]]*)\]/g, function (all, inner) {
            if (/^(h+|m+|s+)$/i.test(inner)) return all;
            if (inner.charAt(0) === '$') { var m = inner.slice(1).split('-')[0]; return m ? '"' + m + '"' : ''; }
            return '';
        });
    }
    function isDateSection(sec) {
        var c = sec.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
        if (/\[(h+|m+|s+)\]/i.test(c)) return true;
        c = c.replace(/\[[^\]]*\]/g, '');
        if (/[eE][+-]/.test(c) && /[0#?]/.test(c)) return false;
        return /[ymdhs]/i.test(c.replace(/AM\/PM|A\/P/ig, ''));
    }
    function fmtGeneral(v) {
        if (!isFinite(v)) return String(v);
        if (v === 0) return '0';
        var a = Math.abs(v);
        if (a >= 1e11 || a < 1e-4) {
            var ex = v.toExponential(5).split('e'), mant = ex[0].replace(/\.?0+$/, ''), e = parseInt(ex[1], 10);
            return mant + 'E' + (e < 0 ? '-' : '+') + (Math.abs(e) < 10 ? '0' : '') + Math.abs(e);
        }
        return String(Number(v.toPrecision(10)));
    }
    function roundTo(x, dec) {
        if (x >= 1e15) return x.toFixed(dec);
        var p = Number(x.toPrecision(15) + 'e' + dec), r = Math.round(p);
        return Number(r + 'e-' + dec).toFixed(dec);
    }
    function groupInt(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

    function serialParts(n, d1904) {
        var days = Math.floor(n), ms = Math.round((n - days) * 86400000);
        if (ms >= 86400000) { days += 1; ms -= 86400000; }
        var y, m, d, wd;
        if (!d1904 && days === 60) { y = 1900; m = 2; d = 29; wd = 4; }
        else {
            var t = d1904 ? Date.UTC(1904, 0, 1) + days * 86400000 : (days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)) + days * 86400000, dt = new Date(t);
            y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate(); wd = dt.getUTCDay();
        }
        return { y: y, m: m, d: d, wd: wd, hh: Math.floor(ms / 3600000), mi: Math.floor(ms / 60000) % 60, ss: Math.floor(ms / 1000) % 60, ms: ms % 1000, total: n };
    }
    function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    function fmtDate(v, sec, d1904) {
        if (v < 0 || v > 2958465.99999) return '#'.repeat(10);
        var re = /\[(h+|m+|s+)\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\.0+|"[^"]*"|\\.|_.|\*.|\[[^\]]*\]|./gi, toks = [], m, ampm = /AM\/PM|A\/P/i.test(sec);
        while ((m = re.exec(sec))) toks.push(m[0]);
        var low = toks.map(function (t) { return t.toLowerCase(); });
        function kindIdx(i, dir) { for (var j = i + dir; j >= 0 && j < low.length; j += dir) { var t = low[j]; if (/^(h+|\[h+\])$/.test(t)) return 'h'; if (/^(s+|\[s+\])$/.test(t)) return 's'; if (/^(y+|d+|mmm+)$/.test(t)) return 'd'; } return ''; }
        var p = serialParts(v, d1904), out = '';
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i], l = low[i];
            if (l.charAt(0) === '[' && /^\[(h+|m+|s+)\]$/.test(l)) {
                var u = l.charAt(1), tot = u === 'h' ? Math.floor(v * 24) : u === 'm' ? Math.floor(v * 1440) : Math.floor(v * 86400);
                out += pad(tot, l.length - 2); continue;
            }
            if (l.charAt(0) === '[') continue;
            if (l.charAt(0) === '"') { out += t.slice(1, -1); continue; }
            if (l.charAt(0) === '\\') { out += t.charAt(1); continue; }
            if (l.charAt(0) === '_') { out += ' '; continue; }
            if (l.charAt(0) === '*') continue;
            if (l === 'yyyy') out += pad(p.y, 4);
            else if (l === 'yy') out += pad(p.y % 100, 2);
            else if (l === 'mmmmm') out += MONTHS[p.m - 1].charAt(0);
            else if (l === 'mmmm') out += MONTHS[p.m - 1];
            else if (l === 'mmm') out += MONTHS[p.m - 1].slice(0, 3);
            else if (l === 'mm' || l === 'm') {
                var isMin = kindIdx(i, -1) === 'h' || kindIdx(i, 1) === 's';
                var val = isMin ? p.mi : p.m; out += l === 'mm' ? pad(val, 2) : String(val);
            }
            else if (l === 'dddd') out += DAYS[p.wd];
            else if (l === 'ddd') out += DAYS[p.wd].slice(0, 3);
            else if (l === 'dd') out += pad(p.d, 2);
            else if (l === 'd') out += p.d;
            else if (l === 'hh' || l === 'h') { var hv = ampm ? ((p.hh % 12) || 12) : p.hh; out += l === 'hh' ? pad(hv, 2) : String(hv); }
            else if (l === 'ss') out += pad(p.ss, 2);
            else if (l === 's') out += p.ss;
            else if (l === 'am/pm') out += p.hh < 12 ? 'AM' : 'PM';
            else if (l === 'a/p') out += p.hh < 12 ? 'A' : 'P';
            else if (l.charAt(0) === '.' && l.length > 1) out += '.' + pad(p.ms, 3).slice(0, l.length - 1).padEnd(l.length - 1, '0');
            else out += t;
        }
        return out;
    }
    function fmtFraction(x, sec) {
        var m = sec.match(/^(.*?)([#0?]*)\s*([#0?]+)\/(\d+|[#0?]+)(.*)$/);
        if (!m) return null;
        var den = /^\d+$/.test(m[4]) ? +m[4] : Math.pow(10, m[4].length) - 1, whole = Math.floor(x), frac = x - whole, best = [0, 1], err = frac;
        if (/^\d+$/.test(m[4])) best = [Math.round(frac * den), den];
        else for (var d = 1; d <= den; d++) { var n = Math.round(frac * d), e = Math.abs(frac - n / d); if (e < err - 1e-12) { err = e; best = [n, d]; } }
        var hasWhole = /[#0?]/.test(m[2]);
        if (!hasWhole) best[0] += whole * best[1];
        var core = best[0] === 0 ? (hasWhole ? String(whole) : '0') : (hasWhole && whole > 0 ? whole + ' ' : '') + best[0] + '/' + best[1];
        if (best[0] === 0 && hasWhole && /\?/.test(m[3])) core = whole + ' ' + ' '.repeat(String(best[1]).length * 2 + 1);
        return literals(m[1]) + core + literals(m[5]);
    }
    function literals(s) {
        var out = '';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === '"') { var j = s.indexOf('"', i + 1); if (j < 0) j = s.length; out += s.slice(i + 1, j); i = j; }
            else if (c === '\\') { out += s.charAt(++i); }
            else if (c === '_') { i++; out += ' '; }
            else if (c === '*') { i++; }
            else out += c;
        }
        return out;
    }
    // Định dạng số 1 section (giá trị tuyệt đối). neg: có thêm dấu '-' phía trước không.
    function fmtNumber(abs, sec, neg) {
        if (/\/(\d+|[#?0]+)/.test(sec.replace(/"[^"]*"/g, '')) && /[?#0]\s*[?#0]*\/[#?0\d]/.test(sec.replace(/"[^"]*"/g, ''))) {
            var fr = fmtFraction(abs, sec); if (fr !== null) return (neg ? '-' : '') + fr;
        }
        var toks = [], i = 0, runs = [], pct = 0;
        while (i < sec.length) {
            var c = sec.charAt(i);
            if (c === '"') { var j = sec.indexOf('"', i + 1); if (j < 0) j = sec.length; toks.push({ lit: sec.slice(i + 1, j) }); i = j + 1; }
            else if (c === '\\') { toks.push({ lit: sec.charAt(i + 1) }); i += 2; }
            else if (c === '_') { toks.push({ lit: ' ' }); i += 2; }
            else if (c === '*') { i += 2; }
            else if (c === '%') { pct++; toks.push({ lit: '%' }); i++; }
            else if (/[0#?.,]/.test(c) || ((c === 'E' || c === 'e') && /[+-]/.test(sec.charAt(i + 1)) && /[0#]/.test(sec.charAt(i + 2)) && runs.length)) {
                var run = '';
                if (c === 'E' || c === 'e') { run = c + sec.charAt(i + 1); i += 2; while (/[0#]/.test(sec.charAt(i))) run += sec.charAt(i++); runs[runs.length - 1].exp = run; continue; }
                while (i < sec.length && /[0#?.,]/.test(sec.charAt(i))) run += sec.charAt(i++);
                var tk = { run: run }; runs.push(tk); toks.push(tk);
            }
            else { toks.push({ lit: c }); i++; }
        }
        if (!runs.length) return (neg ? '-' : '') + toks.map(function (t) { return t.lit || ''; }).join('');
        var x = abs * Math.pow(100, pct), outStr = {};
        if (runs.length > 1 && !runs.some(function (r) { return r.run.indexOf('.') >= 0; })) {      // vd 000-000-0000: điền chữ số từ phải sang trái
            var total = runs.reduce(function (n, r) { return n + r.run.replace(/,/g, '').length; }, 0), minD = runs.reduce(function (n, r) { return n + (r.run.match(/0/g) || []).length; }, 0);
            var ds = roundTo(x, 0); if (ds.length < minD) ds = pad(ds, minD);
            for (var k = runs.length - 1; k >= 0; k--) { var w = runs[k].run.replace(/,/g, '').length; var take = k === 0 ? ds : ds.slice(-w); ds = k === 0 ? '' : ds.slice(0, ds.length - take.length); runs[k].out = take.length < w && k > 0 ? pad(take, w) : take; }
            return (neg ? '-' : '') + toks.map(function (t) { return t.run ? t.out : t.lit; }).join('');
        }
        var r0 = runs[0], R = r0.run, trail = (R.match(/,+$/) || [''])[0].length;
        if (trail) { R = R.replace(/,+$/, ''); x /= Math.pow(1000, trail); }
        var dot = R.indexOf('.'), intPat = (dot < 0 ? R : R.slice(0, dot)), decPat = dot < 0 ? '' : R.slice(dot + 1).replace(/,/g, ''), thousands = /,/.test(intPat);
        intPat = intPat.replace(/,/g, '');
        var s, minInt = (intPat.match(/0/g) || []).length, body;
        if (r0.exp) {
            var dec = decPat.length, e = 0, mant = x;
            if (x !== 0) { e = Math.floor(Math.log10(x)); mant = x / Math.pow(10, e); if (Number(roundTo(mant, dec)) >= 10) { mant /= 10; e++; } }
            var ed = r0.exp.length - 2;
            body = roundTo(mant, dec) + 'E' + (e < 0 ? '-' : (r0.exp.charAt(1) === '+' ? '+' : '')) + pad(Math.abs(e), ed);
        } else {
            s = roundTo(x, decPat.length); var parts = s.split('.'), ip = parts[0], dp = parts[1] || '';
            if (ip === '0' && minInt === 0) ip = '';
            if (ip.length < minInt) ip = pad(ip, minInt);
            if (thousands) ip = groupInt(ip);
            var dd = '';
            if (decPat) {
                var chars = dp.split('');
                for (var q = decPat.length - 1; q >= 0; q--) { if (chars[q] === '0' && decPat.charAt(q) !== '0') chars[q] = decPat.charAt(q) === '?' ? ' ' : null; else break; }
                dd = chars.filter(function (ch) { return ch !== null; }).join('');
            }
            body = ip + (decPat ? '.' + dd : '');
            if (decPat && /^[\s]*$/.test(dd) && !/0/.test(decPat) && ip === '') body = '';
        }
        return (neg ? '-' : '') + toks.map(function (t) { return t.run ? (t === r0 ? body : '') : t.lit; }).join('');
    }
    function formatNumber(v, code, d1904) {
        if (code === undefined || code === null || code === '' || code === 'General') return fmtGeneral(v);
        var secs = splitSections(code).map(stripMeta), sec, neg = false;
        if (v < 0 && secs.length > 1) { sec = secs[1]; } else { sec = (v === 0 && secs.length > 2) ? secs[2] : secs[0]; neg = v < 0; }
        if (/^general$/i.test(sec.trim())) return (neg ? '-' : '') + fmtGeneral(Math.abs(v));
        if (isDateSection(sec)) return fmtDate(v, sec, d1904);
        if (sec.trim() === '@') return fmtGeneral(v);
        return fmtNumber(Math.abs(v), sec, neg);
    }
    function formatText(s, code) {
        if (!code || code === 'General' || code === '@') return s;
        var secs = splitSections(code).map(stripMeta), t = secs.length >= 4 ? secs[3] : (secs.length === 1 && secs[0].indexOf('@') >= 0 ? secs[0] : null);
        if (!t || t.indexOf('@') < 0) return s;
        return t.split('@').map(literals).join(s);
    }

    // ================================================================ WORKBOOK / SHEET
    function colIndex(letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n; }
    function colName(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
    function parseRef(ref) { var m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref || ''); return m ? { c: colIndex(m[1].toUpperCase()), r: +m[2] } : null; }

    async function load(buf) {
        var z = openZip(buf), rootRels = parseRels(await z.text('_rels/.rels')), wbPath = 'xl/workbook.xml';
        Object.keys(rootRels).forEach(function (k) { if (/officeDocument$/.test(rootRels[k].type)) wbPath = resolvePath('', rootRels[k].target); });
        var wbText = await z.text(wbPath);
        if (!wbText) throw fail('Không tìm thấy xl/workbook.xml — đây không phải file Excel .xlsx.', 'NO_WORKBOOK');
        var wbDir = wbPath.indexOf('/') >= 0 ? wbPath.slice(0, wbPath.lastIndexOf('/') + 1) : '', wb = parseXml(wbText).documentElement;
        var rels = parseRels(await z.text(wbDir + '_rels/' + wbPath.split('/').pop() + '.rels')), pathOfType = function (re) { var f = null; Object.keys(rels).forEach(function (k) { if (re.test(rels[k].type)) f = resolvePath(wbDir, rels[k].target); }); return f; };
        var pr = kid(wb, 'workbookPr'), date1904 = !!pr && (pr.getAttribute('date1904') === '1' || pr.getAttribute('date1904') === 'true');
        var theme = parseTheme(await z.text(pathOfType(/\/theme$/) || 'xl/theme/theme1.xml'));
        var styles = parseStyles(await z.text(pathOfType(/\/styles$/) || 'xl/styles.xml'), theme);
        var shared = [], ssPath = pathOfType(/\/sharedStrings$/) || 'xl/sharedStrings.xml', ssText = await z.text(ssPath);
        if (ssText) kids(parseXml(ssText).documentElement, 'si').forEach(function (si) { shared.push(richText(si)); });
        var sheets = [];
        kids(kid(wb, 'sheets'), 'sheet').forEach(function (s) {
            var rel = rels[relId(s)];
            if (rel) sheets.push({ name: s.getAttribute('name') || 'Sheet', path: resolvePath(wbDir, rel.target), state: s.getAttribute('state') || 'visible' });
        });
        sheets = sheets.filter(function (s) { return s.state === 'visible' && z.has(s.path); });
        if (!sheets.length) throw fail('File Excel không có sheet nào để hiển thị.', 'NO_SHEET');
        var cache = {};
        var book = {
            sheetNames: sheets.map(function (s) { return s.name; }), styles: styles, date1904: date1904,
            sheet: async function (i) { return cache[i] || (cache[i] = parseSheet(parseXml(await z.text(sheets[i].path)), shared, sheets[i].name)); },
            display: function (cell) { return cellDisplay(cell, styles, date1904); }
        };
        return book;
    }
    function numFmtCode(styles, xf) { var id = xf.numFmtId; return styles.numFmts[id] !== undefined ? styles.numFmts[id] : (BUILTIN[id] !== undefined ? BUILTIN[id] : 'General'); }
    var dateCache = {};
    function isDateCode(code) { if (dateCache[code] === undefined) dateCache[code] = splitSections(code).some(function (s) { return isDateSection(stripMeta(s)); }); return dateCache[code]; }
    function cellDisplay(cell, styles, d1904) {
        if (!cell || cell.k === null || cell.k === undefined) return '';
        if (cell.k === 'b') return cell.v ? 'TRUE' : 'FALSE';
        if (cell.k === 'e') return String(cell.v);
        var xf = styles.xfs[cell.s || 0] || styles.xfs[0], code = numFmtCode(styles, xf);
        if (cell.k === 's') return formatText(String(cell.v), code);
        try { return formatNumber(cell.v, code, d1904); } catch (_) { return fmtGeneral(cell.v); }
    }
    function parseSheet(doc, shared, name) {
        var ws = doc.documentElement, out = { name: name, rows: [], rowPx: {}, rowHidden: {}, rowCustom: {}, cols: {}, merges: [], maxR: 0, maxC: 0, defRowPx: 20, defColPx: 64, hasDrawing: false, hasCondFmt: false, freeze: null };
        var fp = kid(ws, 'sheetFormatPr');
        if (fp) {
            if (fp.getAttribute('defaultRowHeight')) out.defRowPx = Math.round(parseFloat(fp.getAttribute('defaultRowHeight')) * 96 / 72);
            if (fp.getAttribute('defaultColWidth')) out.defColPx = Math.round(parseFloat(fp.getAttribute('defaultColWidth')) * 7);
            else if (fp.getAttribute('baseColWidth')) out.defColPx = Math.round((parseFloat(fp.getAttribute('baseColWidth')) * 7 + 5));
        }
        kids(kid(ws, 'cols'), 'col').forEach(function (c) {
            var min = +c.getAttribute('min'), max = Math.min(+c.getAttribute('max'), 16384), w = c.getAttribute('width'), hid = c.getAttribute('hidden') === '1' || c.getAttribute('hidden') === 'true';
            if (!(min >= 1)) return;
            if (max - min > 2000) max = min + 2000;      // cột định nghĩa cả dải 1..16384: chỉ ghi nhận phần đầu, các cột còn lại dùng độ rộng mặc định
            for (var k = min; k <= max; k++) out.cols[k] = { px: w ? Math.round(parseFloat(w) * 7) : null, hidden: hid };
        });
        var sd = kid(ws, 'sheetData'), runR = 0;
        kids(sd, 'row').forEach(function (row) {
            var r = +row.getAttribute('r') || (runR + 1); runR = r;
            var ht = row.getAttribute('ht'), hid = row.getAttribute('hidden') === '1' || row.getAttribute('hidden') === 'true';
            if (ht) { out.rowPx[r] = Math.round(parseFloat(ht) * 96 / 72); if (row.getAttribute('customHeight') === '1' || row.getAttribute('customHeight') === 'true') out.rowCustom[r] = true; }
            if (hid) out.rowHidden[r] = true;
            var arr = out.rows[r] || (out.rows[r] = []), runC = 0;
            kids(row, 'c').forEach(function (c) {
                var ref = parseRef(c.getAttribute('r')), col = ref ? ref.c : runC + 1; runC = col;
                var t = c.getAttribute('t') || 'n', s = +c.getAttribute('s') || 0, vEl = kid(c, 'v'), fEl = kid(c, 'f'), v = vEl ? vEl.textContent : null, k = null, val = null;
                if (t === 'inlineStr') { var is = kid(c, 'is'); if (is) { k = 's'; val = richText(is); } }
                else if (v !== null && v !== '') {
                    if (t === 's') { k = 's'; val = shared[+v]; if (val === undefined) val = ''; }
                    else if (t === 'str' || t === 'd') { k = 's'; val = v; }
                    else if (t === 'b') { k = 'b'; val = v === '1' || v === 'true'; }
                    else if (t === 'e') { k = 'e'; val = v; }
                    else { var num = Number(v); if (isNaN(num)) { k = 's'; val = v; } else { k = 'n'; val = num; } }
                }
                var f = fEl ? fEl.textContent : null;
                if (k === null && !s && !f) return;
                arr[col] = { k: k, v: val, f: f || null, s: s };
                if (k !== null && col > out.maxC) out.maxC = col;
                if (k !== null && r > out.maxR) out.maxR = r;
            });
        });
        kids(kid(ws, 'mergeCells'), 'mergeCell').forEach(function (m) {
            var p = (m.getAttribute('ref') || '').split(':'), a = parseRef(p[0]), b = parseRef(p[1] || p[0]);
            if (a && b && (b.r > a.r || b.c > a.c)) { out.merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: Math.min(b.c, 16384) }); if (b.c > out.maxC && b.c < 200) out.maxC = b.c; if (b.r > out.maxR) out.maxR = Math.min(b.r, a.r + 5000); }
        });
        out.hasDrawing = !!kid(ws, 'drawing') || !!kid(ws, 'legacyDrawing');
        out.hasCondFmt = !!kid(ws, 'conditionalFormatting');
        var sv = kid(kid(ws, 'sheetViews'), 'sheetView'), pane = sv && kid(sv, 'pane');
        if (pane && /frozen/.test(pane.getAttribute('state') || '')) out.freeze = { x: +pane.getAttribute('xSplit') || 0, y: +pane.getAttribute('ySplit') || 0 };
        return out;
    }

    // ================================================================ GIAO DIỆN
    var CSS_DONE = false, UID = 0;
    function injectCss() {
        if (CSS_DONE || typeof document === 'undefined') return; CSS_DONE = true;
        var st = document.createElement('style'); st.id = 'xv-css';
        st.textContent = [
            '.xv{display:flex;flex-direction:column;background:#fff;border:1px solid #dadce0;border-radius:8px;overflow:hidden;text-align:left;font:13px/1.3 Arial,"Helvetica Neue",sans-serif;color:#202124;outline:none}',
            '.xv-bar{display:flex;align-items:center;gap:0;border-bottom:1px solid #dadce0;background:#fff;height:28px;flex:none}',
            '.xv-name{width:76px;flex:none;padding:0 8px;font-size:12px;color:#202124;border-right:1px solid #dadce0;height:100%;display:flex;align-items:center}',
            '.xv-fx{flex:none;padding:0 10px;color:#80868b;font:italic 13px Georgia,serif;border-right:1px solid #dadce0;height:100%;display:flex;align-items:center}',
            '.xv-formula{flex:1;min-width:0;padding:0 10px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.xv-scroll{flex:1;min-height:120px;overflow:auto;position:relative;background:#fff}',
            '.xv-t{border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:10pt}',
            '.xv-t th{position:sticky;top:0;z-index:3;background:#f8f9fa;color:#5f6368;font-weight:400;font-size:11px;text-align:center;height:21px;padding:0;border-right:1px solid #c0c0c0;border-bottom:1px solid #c0c0c0;user-select:none;overflow:hidden}',
            '.xv-t th.xv-rh{position:sticky;left:0;top:auto;z-index:2;width:46px;min-width:46px;height:auto;border-bottom:1px solid #c0c0c0}',
            '.xv-t th.xv-corner{left:0;z-index:4;width:46px}',
            '.xv-t th.xv-hl{background:#d3e3fd;color:#041e49}',
            '.xv-t td{padding:0 3px;border-right:1px solid #e2e3e3;border-bottom:1px solid #e2e3e3;white-space:nowrap;overflow:hidden;vertical-align:bottom;background:#fff;scroll-margin:26px 0 0 50px}',
            '.xv-t td.xv-n{text-align:right}.xv-t td.xv-c{text-align:center}',
            '.xv-t td.xv-sel{outline:2px solid #1a73e8;outline-offset:-2px;position:relative;z-index:1}',
            '.xv-more{display:block;margin:10px auto;padding:7px 14px;border:1px solid #dadce0;border-radius:16px;background:#fff;color:#1a73e8;font:13px Arial,sans-serif;cursor:pointer}',
            '.xv-tabs{display:flex;align-items:stretch;gap:2px;border-top:1px solid #dadce0;background:#f8f9fa;flex:none;min-height:34px;overflow-x:auto}',
            '.xv-tab{flex:none;border:0;background:transparent;padding:0 16px;font:500 13px Arial,sans-serif;color:#5f6368;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:3px solid transparent}',
            '.xv-tab:hover{background:#eceff1}',
            '.xv-tab.on{background:#e6f4ea;color:#137333;border-bottom-color:#188038}',
            '.xv-info{margin-left:auto;flex:none;align-self:center;padding:0 12px;font-size:11px;color:#80868b;white-space:nowrap}',
            '.xv-note{padding:6px 12px;background:#fef7e0;border-top:1px solid #f9e8a8;color:#7a5b00;font-size:12px;flex:none}'
        ].join('\n');
        document.head.appendChild(st);
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    async function render(host, buf, opts) {
        opts = opts || {};
        injectCss();
        var book = await load(buf), uid = 'xv' + (++UID), styles = book.styles, ruleEl = document.createElement('style'), classes = {}, ruleText = '';
        host.innerHTML = '';
        var rootEl = document.createElement('div'); rootEl.className = 'xv'; rootEl.tabIndex = 0; rootEl.style.height = opts.height || 'calc(100vh - 210px)';
        rootEl.innerHTML = '<div class="xv-bar"><div class="xv-name">A1</div><div class="xv-fx">fx</div><div class="xv-formula"></div></div><div class="xv-scroll"></div><div class="xv-note" hidden></div><div class="xv-tabs"></div>';
        host.appendChild(rootEl); host.appendChild(ruleEl);
        var elName = rootEl.querySelector('.xv-name'), elFormula = rootEl.querySelector('.xv-formula'), elScroll = rootEl.querySelector('.xv-scroll'), elNote = rootEl.querySelector('.xv-note'), elTabs = rootEl.querySelector('.xv-tabs');
        var cv = document.createElement('canvas').getContext('2d'), cur = { idx: -1, sheet: null, shown: 0, last: 0, colPx: [], hidCol: [], maxC: 0, merges: null, covered: null, sel: null, tbody: null };

        function fontCss(xf) {
            var f = styles.fonts[xf.fontId] || styles.fonts[0] || { sz: 11, name: 'Calibri' };
            return (f.i ? 'italic ' : '') + (f.b ? 'bold ' : '') + Math.round((f.sz || 11) * 96 / 72 * 10) / 10 + 'px ' + (f.name ? '"' + f.name + '",' : '') + 'Arial,sans-serif';
        }
        function xfClass(s) {
            if (classes[s] !== undefined) return classes[s];
            var xf = styles.xfs[s] || styles.xfs[0], f = styles.fonts[xf.fontId] || {}, fl = styles.fills[xf.fillId] || {}, b = styles.borders[xf.borderId] || {}, css = '', base = styles.fonts[0] || {};
            if (f.b) css += 'font-weight:700;'; if (f.i) css += 'font-style:italic;';
            if (f.u || f.strike) css += 'text-decoration:' + (f.u ? 'underline ' : '') + (f.strike ? 'line-through' : '') + ';';
            if (f.sz && f.sz !== base.sz) css += 'font-size:' + f.sz + 'pt;';
            if (f.name && f.name !== base.name) css += 'font-family:"' + f.name.replace(/"/g, '') + '",Arial,sans-serif;';
            if (f.color) css += 'color:' + f.color + ';';
            if (fl.bg) css += 'background:' + fl.bg + ';';
            [['l', 'left'], ['r', 'right'], ['t', 'top'], ['b', 'bottom']].forEach(function (d) { if (b[d[0]]) css += 'border-' + d[1] + ':' + (BORDER_CSS[b[d[0]].style] || '1px solid') + ' ' + b[d[0]].color + ';'; });
            if (xf.h && xf.h !== 'general') css += 'text-align:' + (xf.h === 'centerContinuous' ? 'center' : xf.h === 'fill' || xf.h === 'distributed' ? 'left' : xf.h) + ';';
            if (xf.v) css += 'vertical-align:' + (xf.v === 'center' ? 'middle' : xf.v === 'justify' ? 'top' : xf.v) + ';';
            if (xf.wrap) css += 'white-space:pre-wrap;word-break:break-word;';
            if (xf.indent) css += 'padding-' + (xf.h === 'right' ? 'right' : 'left') + ':' + (3 + xf.indent * 9) + 'px;';
            var cls = '';
            if (css) { cls = uid + 's' + s; ruleText += '.' + uid + ' .' + cls + '{' + css + '}\n'; ruleEl.textContent = ruleText; }
            classes[s] = cls; return cls;
        }
        var defFont = (styles.fonts[0] && styles.fonts[0].name) || 'Calibri', defSz = (styles.fonts[0] && styles.fonts[0].sz) || 11;
        rootEl.classList.add(uid);
        ruleText += '.' + uid + ' .xv-t td,.' + uid + ' .xv-t{font-family:"' + defFont.replace(/"/g, '') + '",Arial,sans-serif;font-size:' + defSz + 'pt}\n'; ruleEl.textContent = ruleText;

        function colWidth(c) { var d = cur.sheet.cols[c]; return d && d.px != null ? d.px : cur.sheet.defColPx; }
        function colHidden(c) { var d = cur.sheet.cols[c]; return !!(d && d.hidden); }
        function visSpan(c1, c2) { var n = 0; for (var c = c1; c <= c2; c++) if (!colHidden(c)) n++; return n || 1; }

        function chunkHtml(from, to) {
            var sh = cur.sheet, html = '', r, c;
            for (r = from; r <= to; r++) {
                if (sh.rowHidden[r]) continue;
                var row = sh.rows[r] || [], h = sh.rowPx[r] || sh.defRowPx, skipUntil = 0;
                html += '<tr' + (sh.rowCustom[r] ? ' style="height:' + h + 'px"' : ' style="height:' + h + 'px"') + '><th class="xv-rh" data-rh="' + r + '">' + r + '</th>';
                for (c = 1; c <= cur.maxC; c++) {
                    if (colHidden(c) || c < skipUntil) continue;
                    var key = r * 20000 + c;
                    if (cur.covered.has(key)) continue;
                    var cell = row[c], mg = cur.merges.get(key), cls = '', txt = '', xf = null;
                    if (cell) { xf = styles.xfs[cell.s] || styles.xfs[0]; cls = xfClass(cell.s); txt = book.display(cell); }
                    var attrs = '', span = 1;
                    if (mg) {
                        var cs = visSpan(c, mg.c2); attrs += (cs > 1 ? ' colspan="' + cs + '"' : '') + (mg.r2 > mg.r1 ? ' rowspan="' + (mg.r2 - mg.r1 + 1) + '"' : '');
                    } else if (cell && cell.k === 's' && txt && !(xf && xf.wrap) && (!xf || !xf.h || xf.h === 'general' || xf.h === 'left')) {          // chữ dài tràn sang các ô trống bên phải
                        var avail = colWidth(c), est = txt.length * 7 + 8;
                        if (est > avail) {
                            cv.font = fontCss(xf); var need = cv.measureText(txt).width + 8, c2 = c + 1;
                            while (avail < need && c2 <= cur.maxC) {
                                if (cur.covered.has(r * 20000 + c2) || cur.merges.has(r * 20000 + c2) || (row[c2] && row[c2].k !== null)) break;
                                if (!colHidden(c2)) { avail += colWidth(c2); span++; } c2++;
                            }
                            if (span > 1) { attrs += ' colspan="' + span + '"'; skipUntil = c2; }
                        }
                    }
                    var al = cls ? ' ' + cls : '';
                    if (cell && cell.k !== null && !(xf && xf.h && xf.h !== 'general')) al += cell.k === 'n' ? ' xv-n' : (cell.k === 'b' || cell.k === 'e') ? ' xv-c' : '';
                    html += '<td data-r="' + r + '" data-c="' + c + '"' + (al ? ' class="' + al.trim() + '"' : '') + attrs + '>' + esc(txt) + '</td>';
                }
                html += '</tr>';
            }
            return html;
        }
        function nextEnd(from, count) {         // không cắt giữa ô gộp nhiều dòng
            var end = Math.min(from + count - 1, cur.totalR);
            cur.sheet.merges.forEach(function (m) { if (m.r1 <= end && m.r2 > end && m.r1 >= from) end = Math.min(m.r2, cur.totalR); });
            return end;
        }
        function selectCell(td) {
            if (!td) return;
            if (cur.sel) { cur.sel.classList.remove('xv-sel'); }
            clearHl(); cur.sel = td; td.classList.add('xv-sel');
            var r = +td.dataset.r, c = +td.dataset.c, cell = (cur.sheet.rows[r] || [])[c];
            elName.textContent = colName(c) + r;
            var shown = '';
            if (cell) {
                if (cell.f) shown = '=' + cell.f;
                else if (cell.k === 'n') { var xf = styles.xfs[cell.s] || styles.xfs[0]; shown = isDateCode(numFmtCode(styles, xf)) ? book.display(cell) : fmtGeneral(cell.v); }
                else shown = cell.k === null ? '' : book.display({ k: cell.k, v: cell.v, s: 0 });
            }
            elFormula.textContent = shown; elFormula.title = shown;
            var hc = elScroll.querySelector('th[data-ch="' + c + '"]'), hr = elScroll.querySelector('th[data-rh="' + r + '"]');
            if (hc) hc.classList.add('xv-hl'); if (hr) hr.classList.add('xv-hl');
        }
        function clearHl() { Array.prototype.forEach.call(elScroll.querySelectorAll('th.xv-hl'), function (t) { t.classList.remove('xv-hl'); }); }
        function cellAt(r, c) { return elScroll.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]'); }

        async function showSheet(i) {
            var sh = await book.sheet(i);
            cur.idx = i; cur.sheet = sh; cur.sel = null;
            cur.maxC = Math.min(Math.max(sh.maxC, 26), 1000); cur.totalR = Math.max(sh.maxR, 40);
            cur.merges = new Map(); cur.covered = new Set();
            sh.merges.forEach(function (m) {
                cur.merges.set(m.r1 * 20000 + m.c1, m);
                var rr = Math.min(m.r2, m.r1 + 5000);
                for (var r = m.r1; r <= rr; r++) for (var c = m.c1; c <= Math.min(m.c2, cur.maxC); c++) if (r !== m.r1 || c !== m.c1) cur.covered.add(r * 20000 + c);
            });
            var head = '<th class="xv-corner"></th>', cols = '<col style="width:46px">', total = 46, c;
            for (c = 1; c <= cur.maxC; c++) { if (colHidden(c)) continue; var w = colWidth(c); total += w; cols += '<col style="width:' + w + 'px">'; head += '<th data-ch="' + c + '">' + colName(c) + '</th>'; }
            var end = nextEnd(1, 300);
            elScroll.innerHTML = '<table class="xv-t" style="width:' + total + 'px"><colgroup>' + cols + '</colgroup><thead><tr>' + head + '</tr></thead><tbody>' + chunkHtml(1, end) + '</tbody></table>';
            cur.tbody = elScroll.querySelector('tbody'); cur.last = end;
            if (end < cur.totalR) addMore();
            var first = cellAt(1, 1) || elScroll.querySelector('td'); if (first) selectCell(first);
            elScroll.scrollTop = 0; elScroll.scrollLeft = 0;
            Array.prototype.forEach.call(elTabs.querySelectorAll('.xv-tab'), function (b, k) { b.classList.toggle('on', k === i); });
            var info = elTabs.querySelector('.xv-info'); if (info) info.textContent = sh.maxR + ' dòng × ' + sh.maxC + ' cột (' + colName(Math.max(sh.maxC, 1)) + ')';
            var notes = []; if (sh.hasDrawing) notes.push('biểu đồ / hình ảnh'); if (sh.hasCondFmt) notes.push('định dạng có điều kiện');
            elNote.hidden = !notes.length; elNote.textContent = notes.length ? 'Sheet này có ' + notes.join(' và ') + ' — chưa hiển thị ở chế độ xem nhanh; bấm Tải để mở đầy đủ bằng Excel.' : '';
        }
        function addMore() {
            var old = elScroll.querySelector('.xv-more'); if (old) old.remove();
            var b = document.createElement('button'); b.type = 'button'; b.className = 'xv-more';
            b.textContent = 'Hiện thêm dòng (đã hiện ' + cur.last + ' / ' + cur.totalR + ')';
            b.onclick = function () {
                var end = nextEnd(cur.last + 1, 400); cur.tbody.insertAdjacentHTML('beforeend', chunkHtml(cur.last + 1, end)); cur.last = end;
                if (end >= cur.totalR) b.remove(); else b.textContent = 'Hiện thêm dòng (đã hiện ' + cur.last + ' / ' + cur.totalR + ')';
            };
            elScroll.appendChild(b);
        }
        // tab sheet
        book.sheetNames.forEach(function (nm, i) {
            var b = document.createElement('button'); b.type = 'button'; b.className = 'xv-tab'; b.textContent = nm; b.title = nm;
            b.onclick = function () { showSheet(i).catch(function (e) { elScroll.innerHTML = '<div style="padding:16px;color:#b91c1c">' + esc(e.message) + '</div>'; }); };
            elTabs.appendChild(b);
        });
        var info = document.createElement('span'); info.className = 'xv-info'; elTabs.appendChild(info);

        elScroll.addEventListener('click', function (e) { var td = e.target.closest && e.target.closest('td[data-r]'); if (td) { selectCell(td); rootEl.focus({ preventScroll: true }); } });
        rootEl.addEventListener('keydown', function (e) {
            if (!cur.sel || e.altKey) return;
            var r = +cur.sel.dataset.r, c = +cur.sel.dataset.c, dr = 0, dc = 0, k = e.key;
            if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'C')) { var t = cur.sel.textContent; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(function () { }); return; }
            if (e.ctrlKey || e.metaKey) return;
            if (k === 'ArrowUp') dr = -1; else if (k === 'ArrowDown' || k === 'Enter') dr = 1; else if (k === 'ArrowLeft') dc = -1; else if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) dc = 1; else if (k === 'Tab') dc = -1; else return;
            e.preventDefault(); e.stopPropagation();           // không để phím ← → chuyển sang file khác ở trang cha
            var nr = r, nc = c, el = null, tries = 0;
            while (tries++ < 60) { nr += dr; nc += dc; if (nr < 1 || nc < 1 || nc > cur.maxC) break; if (nr > cur.last) break; el = cellAt(nr, nc); if (el) break; }
            if (el) { selectCell(el); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        });
        await showSheet(0);
        var tab0 = elTabs.querySelector('.xv-tab'); if (tab0) tab0.classList.add('on');
        return { workbook: book, destroy: function () { rootEl.remove(); ruleEl.remove(); } };
    }

    var api = { canView: canView, render: render, load: load, formatNumber: formatNumber, openZip: openZip, VIEW_EXTS: VIEW_EXTS };
    root.XlsxView = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
