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
//   Hình vẽ trong sheet (ảnh PNG/JPG/GIF/SVG, oval / chữ nhật / tam giác…, đường nối + mũi tên, hộp chữ, nhóm hình) được vẽ thành lớp SVG đúng vị trí ô.
//   Không hỗ trợ: .xls đời cũ, .xlsb, .ods; biểu đồ (chart), ảnh EMF/WMF và định dạng có điều kiện không được vẽ (có ghi chú ở thanh dưới).
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

    function richRuns(si, theme) {   // chữ có định dạng từng đoạn (đỏ / đậm / cỡ riêng…) → [{t, c, b, i, u, strike, sz, f}] hoặc null nếu cả ô cùng 1 kiểu
        var runs = [], fmt = false;
        for (var n = si.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1 || n.localName !== 'r') continue;
            var t = kid(n, 't'), rp = kid(n, 'rPr'), run = { t: t ? t.textContent : '' };
            if (rp) {
                function flag(nm) { var e = kid(rp, nm); return !!e && e.getAttribute('val') !== '0' && e.getAttribute('val') !== 'false'; }
                var col = colorOf(kid(rp, 'color'), theme), sz = kid(rp, 'sz'), fn = kid(rp, 'rFont');
                run.c = col; run.b = flag('b'); run.i = flag('i'); run.u = flag('u'); run.strike = flag('strike'); run.sz = sz ? parseFloat(sz.getAttribute('val')) : 0; run.f = fn ? fn.getAttribute('val') : '';
                fmt = true;
            }
            runs.push(run);
        }
        return fmt ? runs : null;
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
        var shared = [], sharedRich = [], ssPath = pathOfType(/\/sharedStrings$/) || 'xl/sharedStrings.xml', ssText = await z.text(ssPath);
        if (ssText) kids(parseXml(ssText).documentElement, 'si').forEach(function (si) { shared.push(richText(si)); sharedRich.push(richRuns(si, theme)); });
        var sheets = [];
        kids(kid(wb, 'sheets'), 'sheet').forEach(function (s) {
            var rel = rels[relId(s)];
            if (rel) sheets.push({ name: s.getAttribute('name') || 'Sheet', path: resolvePath(wbDir, rel.target), state: s.getAttribute('state') || 'visible' });
        });
        sheets = sheets.filter(function (s) { return s.state === 'visible' && z.has(s.path); });
        if (!sheets.length) throw fail('File Excel không có sheet nào để hiển thị.', 'NO_SHEET');
        var cache = {};
        async function buildSheet(i) {
            var sh = parseSheet(parseXml(await z.text(sheets[i].path)), shared, sheets[i].name, sharedRich, theme);
            if (sh.drawRid) { try { sh.drawing = await loadDrawing(z, sheets[i].path, sh.drawRid, theme); } catch (e) { sh.drawing = null; sh.drawErr = e.message; } }
            return sh;
        }
        var book = {
            sheetNames: sheets.map(function (s) { return s.name; }), styles: styles, date1904: date1904,
            sheet: async function (i) { return cache[i] || (cache[i] = buildSheet(i)); },
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
    function parseSheet(doc, shared, name, sharedRich, theme) {
        var ws = doc.documentElement, out = { name: name, rows: [], rowPx: {}, rowHidden: {}, rowCustom: {}, cols: {}, merges: [], maxR: 0, maxC: 0, defRowPx: 20, defColPx: 64, hasDrawing: false, hasCondFmt: false, freeze: null };
        var fp = kid(ws, 'sheetFormatPr');
        if (fp) {
            if (fp.getAttribute('defaultRowHeight')) out.defRowPx = Math.round(parseFloat(fp.getAttribute('defaultRowHeight')) * 96 / 72 * 100) / 100;
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
            if (ht) { out.rowPx[r] = Math.round(parseFloat(ht) * 96 / 72 * 100) / 100; if (row.getAttribute('customHeight') === '1' || row.getAttribute('customHeight') === 'true') out.rowCustom[r] = true; }
            if (hid) out.rowHidden[r] = true;
            var arr = out.rows[r] || (out.rows[r] = []), runC = 0;
            kids(row, 'c').forEach(function (c) {
                var ref = parseRef(c.getAttribute('r')), col = ref ? ref.c : runC + 1; runC = col;
                var t = c.getAttribute('t') || 'n', s = +c.getAttribute('s') || 0, vEl = kid(c, 'v'), fEl = kid(c, 'f'), v = vEl ? vEl.textContent : null, k = null, val = null, rich = null;
                if (t === 'inlineStr') { var is = kid(c, 'is'); if (is) { k = 's'; val = richText(is); rich = richRuns(is, theme); } }
                else if (v !== null && v !== '') {
                    if (t === 's') { k = 's'; val = shared[+v]; if (val === undefined) val = ''; rich = (sharedRich && sharedRich[+v]) || null; }
                    else if (t === 'str' || t === 'd') { k = 's'; val = v; }
                    else if (t === 'b') { k = 'b'; val = v === '1' || v === 'true'; }
                    else if (t === 'e') { k = 'e'; val = v; }
                    else { var num = Number(v); if (isNaN(num)) { k = 's'; val = v; } else { k = 'n'; val = num; } }
                }
                var f = fEl ? fEl.textContent : null;
                if (k === null && !s && !f) return;
                arr[col] = { k: k, v: val, f: f || null, s: s, rich: rich, maxSz: rich ? Math.max.apply(null, rich.map(function (x) { return x.sz || 0; })) : 0 };
                if (k !== null && col > out.maxC) out.maxC = col;
                if (k !== null && r > out.maxR) out.maxR = r;
            });
        });
        kids(kid(ws, 'mergeCells'), 'mergeCell').forEach(function (m) {
            var p = (m.getAttribute('ref') || '').split(':'), a = parseRef(p[0]), b = parseRef(p[1] || p[0]);
            if (a && b && (b.r > a.r || b.c > a.c)) { out.merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: Math.min(b.c, 16384) }); if (b.c > out.maxC && b.c < 200) out.maxC = b.c; if (b.r > out.maxR) out.maxR = Math.min(b.r, a.r + 5000); }
        });
        var drEl = kid(ws, 'drawing'); out.drawRid = drEl ? relId(drEl) : '';
        out.hasDrawing = !!drEl || !!kid(ws, 'legacyDrawing');
        out.hasCondFmt = !!kid(ws, 'conditionalFormatting');
        var sv = kid(kid(ws, 'sheetViews'), 'sheetView'), pane = sv && kid(sv, 'pane');
        if (pane && /frozen/.test(pane.getAttribute('state') || '')) out.freeze = { x: +pane.getAttribute('xSplit') || 0, y: +pane.getAttribute('ySplit') || 0 };
        return out;
    }

    // ================================================================ HÌNH VẼ TRONG SHEET (xl/drawings/drawingN.xml): ảnh, hình khối (oval, chữ nhật…), đường nối + mũi tên, hộp chữ
    //   Mỗi hình có "neo" (từ ô nào đến ô nào) → quy ra pixel theo độ rộng cột / chiều cao dòng của sheet → vẽ thành 1 lớp SVG phủ lên bảng, cuộn cùng bảng.
    var THEME_IDX = { lt1: 0, bg1: 0, dk1: 1, tx1: 1, lt2: 2, bg2: 2, dk2: 3, tx2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9, hlink: 10, folHlink: 11 };
    var PRESET_RGB = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', lime: '00FF00', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', purple: '800080', cyan: '00FFFF', magenta: 'FF00FF', pink: 'FFC0CB', brown: 'A52A2A', navy: '000080' };
    var IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
    var LN_PX = [0, 0.67, 1.33, 2];          // độ dày đường theo lnRef idx (theme Office: 0.5 / 1 / 1.5 pt)
    function toHsl(hex) {
        var c = hexToRgb(hex), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2;
        if (mx !== mn) { var d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
        return [h, s, l];
    }
    function fromHsl(h, s, l) {
        if (s === 0) return rgbToHex(l * 255, l * 255, l * 255);
        function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        return rgbToHex(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255);
    }
    function drawColor(ce, theme) {          // <a:schemeClr val="accent1"><a:lumMod …/></a:schemeClr> → { c:'#4472c4', a:1 }
        if (!ce) return null;
        var n = ce.localName, hex = null, v = ce.getAttribute('val');
        if (n === 'srgbClr') hex = v;
        else if (n === 'schemeClr') hex = THEME_IDX[v] !== undefined ? theme[THEME_IDX[v]] : null;
        else if (n === 'sysClr') hex = ce.getAttribute('lastClr') || (v === 'window' ? 'FFFFFF' : '000000');
        else if (n === 'prstClr') hex = PRESET_RGB[v] || '000000';
        else if (n === 'scrgbClr') hex = rgbToHex(+ce.getAttribute('r') / 1000, +ce.getAttribute('g') / 1000, +ce.getAttribute('b') / 1000) ;
        if (!hex || !/^[0-9a-fA-F]{6}$/.test(String(hex).replace('#', ''))) return null;
        hex = String(hex).replace('#', '').toUpperCase();
        var alpha = 1;
        for (var t = ce.firstChild; t; t = t.nextSibling) {
            if (t.nodeType !== 1) continue;
            var x = (+t.getAttribute('val')) / 100000, k = t.localName;
            if (k === 'lumMod') { var a = toHsl(hex); hex = fromHsl(a[0], a[1], Math.min(1, a[2] * x)); }
            else if (k === 'lumOff') { var b = toHsl(hex); hex = fromHsl(b[0], b[1], Math.max(0, Math.min(1, b[2] + x))); }
            else if (k === 'tint') { var c1 = hexToRgb(hex); hex = rgbToHex(c1[0] * x + 255 * (1 - x), c1[1] * x + 255 * (1 - x), c1[2] * x + 255 * (1 - x)); }
            else if (k === 'shade') { var c2 = hexToRgb(hex); hex = rgbToHex(c2[0] * x, c2[1] * x, c2[2] * x); }
            else if (k === 'alpha') alpha = x;
        }
        return { c: '#' + hex, a: alpha };
    }
    function firstEl(el) { for (var n = el && el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return n; return null; }
    function paintOf(holder, theme) {        // undefined = không nói gì · null = noFill · {c,a}
        if (!holder) return undefined;
        for (var n = holder.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1) continue;
            if (n.localName === 'noFill') return null;
            if (n.localName === 'solidFill') return drawColor(firstEl(n), theme) || undefined;
            if (n.localName === 'gradFill') { var gs = kid(kid(n, 'gsLst'), 'gs'); return (gs && drawColor(firstEl(gs), theme)) || undefined; }
            if (n.localName === 'pattFill') return drawColor(firstEl(kid(n, 'fgClr')), theme) || undefined;
        }
        return undefined;
    }
    function unwrapMc(el) {                   // <mc:AlternateContent><mc:Choice>…</mc:Choice></mc:AlternateContent> → phần tử bên trong
        while (el && el.localName === 'AlternateContent') {
            var ch = kid(el, 'Choice'), inner = ch && firstEl(ch);
            if (!inner || !SHAPE_TAGS[inner.localName]) { var fb = kid(el, 'Fallback'); if (fb && firstEl(fb)) inner = firstEl(fb); }      // nét viết tay (ink) / contentPart: Excel lưu sẵn ảnh có màu ở Fallback
            el = inner;
        }
        return el;
    }
    var SHAPE_TAGS = { sp: 1, cxnSp: 1, pic: 1, grpSp: 1, graphicFrame: 1 };
    function parseXfrm(x) {
        if (!x) return null;
        var off = kid(x, 'off'), ext = kid(x, 'ext'), co = kid(x, 'chOff'), ce = kid(x, 'chExt');
        return {
            x: off ? +off.getAttribute('x') || 0 : 0, y: off ? +off.getAttribute('y') || 0 : 0, cx: ext ? +ext.getAttribute('cx') || 0 : 0, cy: ext ? +ext.getAttribute('cy') || 0 : 0,
            chx: co ? +co.getAttribute('x') || 0 : 0, chy: co ? +co.getAttribute('y') || 0 : 0, chcx: ce ? +ce.getAttribute('cx') || 0 : 0, chcy: ce ? +ce.getAttribute('cy') || 0 : 0,
            rot: (+x.getAttribute('rot') || 0) / 60000, flipH: x.getAttribute('flipH') === '1' || x.getAttribute('flipH') === 'true', flipV: x.getAttribute('flipV') === '1' || x.getAttribute('flipV') === 'true'
        };
    }
    function parseEnd(e) { var t = e && e.getAttribute('type'); return t && t !== 'none' ? { type: t, w: e.getAttribute('w') || 'med' } : null; }
    var NS_M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
    function mathRuns(node, out, pos, fontRefColor, theme) {      // công thức Office Math (a14:m) → các đoạn chữ; chỉ số dưới / trên được đánh dấu pos
        for (var n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1 || n.localName === 'rPr' || n.localName === 'ctrlPr') continue;
            if (n.namespaceURI === NS_M && n.localName === 'r') {
                var t = kid(n, 't'), rp = n.getElementsByTagNameNS('*', 'rPr')[0], col = rp ? paintOf(rp, theme) : null, lat = rp && kid(rp, 'latin');
                out.push({ t: t ? t.textContent : '', sz: rp && rp.getAttribute('sz') ? +rp.getAttribute('sz') / 100 : 0, b: false, i: !!rp && rp.getAttribute('i') === '1', u: false, c: col ? col.c : fontRefColor, f: lat ? lat.getAttribute('typeface') : null, pos: pos });
            } else if (n.localName === 'sSub') { mathRuns(kid(n, 'e') || n, out, pos, fontRefColor, theme); mathRuns(kid(n, 'sub') || n, out, 'sub', fontRefColor, theme); }
            else if (n.localName === 'sSup') { mathRuns(kid(n, 'e') || n, out, pos, fontRefColor, theme); mathRuns(kid(n, 'sup') || n, out, 'sup', fontRefColor, theme); }
            else mathRuns(n, out, pos, fontRefColor, theme);
        }
    }
    function parseText(tx, style, theme) {
        if (!tx) return null;
        var bp = kid(tx, 'bodyPr'), fontRefColor = null;
        if (style) { var fr = kid(style, 'fontRef'); fontRefColor = fr ? drawColor(firstEl(fr), theme) : null; }
        var paras = [], any = false;
        kids(tx, 'p').forEach(function (p) {
            var pp = kid(p, 'pPr'), runs = [], endSz = kid(p, 'endParaRPr');
            for (var n = p.firstChild; n; n = n.nextSibling) {
                if (n.nodeType !== 1) continue;
                if (n.localName === 'br') { runs.push({ br: true }); continue; }
                if (n.localName === 'm') { var mr = []; mathRuns(n, mr, '', fontRefColor ? fontRefColor.c : null, theme); mr.forEach(function (x) { runs.push(x); if (x.t) any = true; }); continue; }
                if (n.localName !== 'r' && n.localName !== 'fld') continue;
                var rp = kid(n, 'rPr'), t = kid(n, 't'), txt = t ? t.textContent : '';
                var col = paintOf(rp, theme), lat = rp && kid(rp, 'latin');
                runs.push({ t: txt, sz: rp && rp.getAttribute('sz') ? +rp.getAttribute('sz') / 100 : 0, b: !!rp && (rp.getAttribute('b') === '1' || rp.getAttribute('b') === 'true'), i: !!rp && (rp.getAttribute('i') === '1' || rp.getAttribute('i') === 'true'), u: !!rp && !!rp.getAttribute('u') && rp.getAttribute('u') !== 'none', c: col ? col.c : (fontRefColor ? fontRefColor.c : null), f: lat && lat.getAttribute('typeface') && lat.getAttribute('typeface').charAt(0) !== '+' ? lat.getAttribute('typeface') : null });
                if (txt) any = true;
            }
            paras.push({ algn: pp ? pp.getAttribute('algn') || 'l' : 'l', runs: runs, endSz: endSz && endSz.getAttribute('sz') ? +endSz.getAttribute('sz') / 100 : 0 });
        });
        if (!any) return null;
        function ins(a, d) { var v = bp && bp.getAttribute(a); return v !== null && v !== undefined && v !== '' ? +v / 9525 : d; }
        return { paras: paras, anchor: (bp && bp.getAttribute('anchor')) || 't', l: ins('lIns', 9.6), t: ins('tIns', 4.8), r: ins('rIns', 9.6), b: ins('bIns', 4.8), wrap: !(bp && bp.getAttribute('wrap') === 'none') };
    }
    function parseShape(el, theme, rels, dir) {
        var tag = el.localName, spPr = kid(el, 'spPr') || kid(el, 'grpSpPr'), xf = parseXfrm(spPr && kid(spPr, 'xfrm') || (tag === 'graphicFrame' ? kid(el, 'xfrm') : null));
        var nv = firstEl(el), cNv = nv && kid(nv, 'cNvPr'), style = kid(el, 'style');
        var sh = { kind: tag, name: cNv ? cNv.getAttribute('name') || '' : '', xf: xf, geom: 'rect', fill: null, line: null, text: null, img: null, children: [], hidden: !!cNv && (cNv.getAttribute('hidden') === '1' || cNv.getAttribute('hidden') === 'true') };
        if (tag === 'grpSp') { for (var n = el.firstChild; n; n = n.nextSibling) { var inner = n.nodeType === 1 ? unwrapMc(n) : null; if (inner && SHAPE_TAGS[inner.localName]) { var c = parseShape(inner, theme, rels, dir); if (c) sh.children.push(c); } } return sh; }
        if (tag === 'graphicFrame') { sh.chart = /chart/.test((kid(kid(el, 'graphic'), 'graphicData') || { getAttribute: function () { return ''; } }).getAttribute('uri') || ''); return sh; }
        var pg = spPr && kid(spPr, 'prstGeom'); sh.geom = pg ? pg.getAttribute('prst') || 'rect' : (spPr && kid(spPr, 'custGeom') ? 'rect' : 'rect');
        var av = pg && kid(pg, 'avLst'), gd = av && kid(av, 'gd'); if (gd) { var m = /val\s+(-?\d+)/.exec(gd.getAttribute('fmla') || ''); if (m) sh.adj = +m[1]; }
        // nền
        var fl = paintOf(spPr, theme);
        if (fl === undefined && style && tag === 'sp') { var fr = kid(style, 'fillRef'); if (fr && +fr.getAttribute('idx') > 0) fl = drawColor(firstEl(fr), theme) || null; else fl = null; }
        sh.fill = fl || null;
        // viền
        var ln = spPr && kid(spPr, 'ln'), lp = paintOf(ln, theme), lr = style && kid(style, 'lnRef'), lidx = lr ? +lr.getAttribute('idx') || 0 : 0;
        if (lp === undefined) lp = lidx > 0 ? (drawColor(firstEl(lr), theme) || null) : null;
        if (lp) {
            var w = ln && ln.getAttribute('w') ? +ln.getAttribute('w') / 9525 : (LN_PX[lidx] || 1), pd = ln && kid(ln, 'prstDash');
            sh.line = { c: lp.c, a: lp.a, w: Math.max(1, w), dash: pd ? pd.getAttribute('val') : 'solid', head: parseEnd(ln && kid(ln, 'headEnd')), tail: parseEnd(ln && kid(ln, 'tailEnd')) };
        }
        var er = style && kid(style, 'effectRef'); if (er && +er.getAttribute('idx') >= 3) sh.shadow = true;
        if (tag === 'pic') {
            var blip = el.getElementsByTagNameNS('*', 'blip')[0], rid = blip && (blip.getAttributeNS(NS_R, 'embed') || blip.getAttribute('r:embed')), rel = rid && rels[rid], sr = el.getElementsByTagNameNS('*', 'srcRect')[0];
            if (rel) {
                var path = resolvePath(dir, rel.target);
                sh.img = { path: path, mime: IMG_MIME[path.split('.').pop().toLowerCase()] || '', data: null, crop: sr ? { l: (+sr.getAttribute('l') || 0) / 100000, t: (+sr.getAttribute('t') || 0) / 100000, r: (+sr.getAttribute('r') || 0) / 100000, b: (+sr.getAttribute('b') || 0) / 100000 } : null };
            }
            return sh;
        }
        sh.text = parseText(kid(el, 'txBody'), style, theme);
        return sh;
    }
    async function loadDrawing(z, sheetPath, rid, theme) {
        var sDir = sheetPath.indexOf('/') >= 0 ? sheetPath.slice(0, sheetPath.lastIndexOf('/') + 1) : '', sRels = parseRels(await z.text(sDir + '_rels/' + sheetPath.split('/').pop() + '.rels'));
        var rel = sRels[rid]; if (!rel) return null;
        var dPath = resolvePath(sDir, rel.target), dText = await z.text(dPath); if (!dText) return null;
        var dDir = dPath.slice(0, dPath.lastIndexOf('/') + 1), dRels = parseRels(await z.text(dDir + '_rels/' + dPath.split('/').pop() + '.rels'));
        var root = parseXml(dText).documentElement, items = [], maxRow = 0, maxCol = 0, hasChart = false, badPics = 0;
        function pt(el) { return el ? { col: +(kid(el, 'col') || { textContent: 0 }).textContent, co: +(kid(el, 'colOff') || { textContent: 0 }).textContent, row: +(kid(el, 'row') || { textContent: 0 }).textContent, ro: +(kid(el, 'rowOff') || { textContent: 0 }).textContent } : null; }
        for (var a = root.firstChild; a; a = a.nextSibling) {
            if (a.nodeType !== 1 || !/Anchor$/.test(a.localName)) continue;
            var content = null;
            for (var n = a.firstChild; n; n = n.nextSibling) { var u = n.nodeType === 1 ? unwrapMc(n) : null; if (u && SHAPE_TAGS[u.localName]) { content = u; break; } }
            if (!content) continue;
            var sh = parseShape(content, theme, dRels, dDir); if (!sh || sh.hidden) continue;
            var ext = kid(a, 'ext'), pos = kid(a, 'pos');
            var anc = { type: a.localName, from: pt(kid(a, 'from')), to: pt(kid(a, 'to')), cx: ext ? +ext.getAttribute('cx') || 0 : 0, cy: ext ? +ext.getAttribute('cy') || 0 : 0, px: pos ? +pos.getAttribute('x') || 0 : 0, py: pos ? +pos.getAttribute('y') || 0 : 0 };
            sh.anchor = anc; items.push(sh);
            if (anc.from) { maxRow = Math.max(maxRow, anc.from.row + 1); maxCol = Math.max(maxCol, anc.from.col + 1); }
            if (anc.to) { maxRow = Math.max(maxRow, anc.to.row + 1); maxCol = Math.max(maxCol, anc.to.col + 1); }
        }
        async function fill(list) {
            for (var i = 0; i < list.length; i++) {
                var s = list[i];
                if (s.chart) hasChart = true;
                if (s.img) { try { s.img.data = await z.read(s.img.path); } catch (_) { s.img.data = null; } if (!s.img.data || !s.img.mime) { badPics++; s.img.data = null; } }
                if (s.children.length) await fill(s.children);
            }
        }
        await fill(items);
        return { items: items, maxRow: maxRow, maxCol: maxCol, hasChart: hasChart, badPics: badPics };
    }

    // ---- bố trí + vẽ SVG
    function layoutItems(items, geo) {         // → danh sách phẳng [{ sh, x, y, w, h }] (px, gốc = góc trên-trái ô A1)
        var out = [];
        function box(sh) {
            var a = sh.anchor, E = 9525;
            if (a.type === 'twoCellAnchor' && a.from && a.to) { var x1 = geo.colX(a.from.col) + a.from.co / E, y1 = geo.rowY(a.from.row) + a.from.ro / E, x2 = geo.colX(a.to.col) + a.to.co / E, y2 = geo.rowY(a.to.row) + a.to.ro / E; return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }; }
            if (a.type === 'oneCellAnchor' && a.from) return { x: geo.colX(a.from.col) + a.from.co / E, y: geo.rowY(a.from.row) + a.from.ro / E, w: a.cx / E, h: a.cy / E };
            if (a.type === 'absoluteAnchor') return { x: a.px / E, y: a.py / E, w: a.cx / E, h: a.cy / E };
            return { x: sh.xf ? sh.xf.x / E : 0, y: sh.xf ? sh.xf.y / E : 0, w: sh.xf ? sh.xf.cx / E : 0, h: sh.xf ? sh.xf.cy / E : 0 };
        }
        function walk(sh, b, parent) {
            if (sh.kind === 'grpSp') {
                var x = sh.xf || {}, sx = x.chcx ? b.w / (x.chcx / 9525) : 1, sy = x.chcy ? b.h / (x.chcy / 9525) : 1;
                sh.children.forEach(function (c) {
                    if (!c.xf) return;
                    walk(c, { x: b.x + (c.xf.x - (x.chx || 0)) / 9525 * sx, y: b.y + (c.xf.y - (x.chy || 0)) / 9525 * sy, w: c.xf.cx / 9525 * sx, h: c.xf.cy / 9525 * sy }, sh);
                });
                return;
            }
            out.push({ sh: sh, x: b.x, y: b.y, w: b.w, h: b.h });
        }
        items.forEach(function (sh) { walk(sh, box(sh), null); });
        return out;
    }
    var SVGNS = 'http://www.w3.org/2000/svg';
    function f1(n) { return Math.round(n * 100) / 100; }
    function drawingSvg(laid, imgUrl, measure, defFont) {
        var defs = {}, body = '', maxX = 0, maxY = 0, uid = 'xd' + (++UID);
        function marker(end, color, lw, which) {
            var id = uid + 'm' + which + end.type + color.replace('#', '') + end.w;
            if (defs[id]) return id;
            var size = Math.max(8, lw * 3.5) * (end.w === 'sm' ? 0.7 : end.w === 'lg' ? 1.5 : 1), shape, ref = 10;
            if (end.type === 'arrow') shape = '<path d="M1,1 L10,5 L1,9" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-linejoin="round"/>';
            else if (end.type === 'stealth') shape = '<path d="M0,0 L10,5 L0,10 L3,5 z" fill="' + color + '"/>';
            else if (end.type === 'diamond') { shape = '<path d="M0,5 L5,0 L10,5 L5,10 z" fill="' + color + '"/>'; ref = 5; }
            else if (end.type === 'oval') { shape = '<circle cx="5" cy="5" r="4.5" fill="' + color + '"/>'; ref = 5; }
            else shape = '<path d="M0,0 L10,5 L0,10 z" fill="' + color + '"/>';
            defs[id] = '<marker id="' + id + '" viewBox="0 0 10 10" refX="' + ref + '" refY="5" markerUnits="userSpaceOnUse" markerWidth="' + f1(size) + '" markerHeight="' + f1(size) + '" orient="auto-start-reverse" overflow="visible">' + shape + '</marker>';
            return id;
        }
        function strokeAttrs(ln) {
            if (!ln) return ' stroke="none"';
            var d = { dash: '4 3', sysDash: '3 1', dot: '1 2', sysDot: '1 1', lgDash: '8 3', dashDot: '4 3 1 3', lgDashDot: '8 3 1 3', lgDashDotDot: '8 3 1 3 1 3', sysDashDot: '3 1 1 1', sysDashDotDot: '3 1 1 1 1 1' }[ln.dash];
            return ' stroke="' + ln.c + '" stroke-width="' + f1(ln.w) + '"' + (ln.a < 1 ? ' stroke-opacity="' + ln.a + '"' : '') + (d ? ' stroke-dasharray="' + d.split(' ').map(function (v) { return f1(v * Math.max(1, ln.w)); }).join(' ') + '"' : '');
        }
        function textSvg(sh, w, h, inset) {
            var t = sh.text; if (!t) return '';
            var L = t.l + inset.x, R = t.r + inset.x, T = t.t + inset.y, B = t.b + inset.y, avail = Math.max(10, w - L - R), lines = [], total = 0;
            t.paras.forEach(function (p) {
                var toks = [];
                p.runs.forEach(function (r) {
                    if (r.br) { toks.push({ br: true }); return; }
                    String(r.t).split(/(\s+)/).forEach(function (piece) { if (piece !== '') toks.push({ t: piece, r: r }); });
                });
                var cur = { toks: [], w: 0, sz: 0 }, plines = [cur];
                function fontOf(r) { var sz = (r.sz || p.endSz || 11); return { sz: sz, css: (r.i ? 'italic ' : '') + (r.b ? 'bold ' : '') + f1(sz * 96 / 72) + 'px ' + (r.f ? '"' + r.f.replace(/"/g, '') + '",' : '') + '"' + defFont + '",Arial,sans-serif' }; }
                toks.forEach(function (k) {
                    if (k.br) { cur = { toks: [], w: 0, sz: cur.sz }; plines.push(cur); return; }
                    var fo = fontOf(k.r), wd = measure(k.t, fo.css), ws = /^\s+$/.test(k.t);
                    if (t.wrap && !ws && cur.w + wd > avail && cur.toks.length) { cur = { toks: [], w: 0, sz: 0 }; plines.push(cur); }
                    if (ws && !cur.toks.length && plines.length > 1 && t.wrap) return;
                    cur.toks.push({ t: k.t, r: k.r, css: fo.css, sz: fo.sz }); cur.w += wd; cur.sz = Math.max(cur.sz, fo.sz);
                });
                plines.forEach(function (ln) { ln.px = (ln.sz || p.endSz || 11) * 96 / 72; ln.algn = p.algn; lines.push(ln); total += ln.px * 1.22; });
            });
            var y0 = t.anchor === 'ctr' ? (h - total) / 2 : t.anchor === 'b' ? h - B - total : T, s = '', y = y0;
            lines.forEach(function (ln) {
                var lh = ln.px * 1.22, base = y + ln.px * 1.0, x, anchor;
                if (ln.algn === 'ctr') { x = L + avail / 2; anchor = 'middle'; } else if (ln.algn === 'r') { x = w - R; anchor = 'end'; } else { x = L; anchor = 'start'; }
                if (ln.toks.length) {
                    s += '<text x="' + f1(x) + '" y="' + f1(base) + '" text-anchor="' + anchor + '" xml:space="preserve">';
                    ln.toks.forEach(function (k) {
                        var fam = k.css.replace(/^(italic )?(bold )?[\d.]+px /, '');
                        s += '<tspan font-size="' + f1(k.sz * 96 / 72 * (k.r.pos ? 0.72 : 1)) + '"' + (k.r.pos ? ' baseline-shift="' + (k.r.pos === 'sub' ? 'sub' : 'super') + '"' : '') + (k.r.b ? ' font-weight="bold"' : '') + (k.r.i ? ' font-style="italic"' : '') + (k.r.u ? ' text-decoration="underline"' : '') + ' font-family="' + esc(fam) + '" fill="' + (k.r.c || '#000') + '">' + esc(k.t) + '</tspan>';
                    });
                    s += '</text>';
                }
                y += lh;
            });
            return s;
        }
        laid.forEach(function (it) {
            var sh = it.sh, x = it.x, y = it.y, w = it.w, h = it.h, xf = sh.xf || {}, rot = xf.rot || 0, g = '', geom = sh.geom;
            maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
            var cx = x + w / 2, cy = y + h / 2, uw = w, uh = h;
            if (rot) { var q = ((Math.round(rot / 90) % 4) + 4) % 4; if (Math.abs(rot - Math.round(rot / 90) * 90) < 1 && q % 2 === 1) { uw = h; uh = w; } }
            var tf = 'translate(' + f1(cx - uw / 2) + ',' + f1(cy - uh / 2) + ')' + (rot ? ' rotate(' + f1(rot) + ',' + f1(uw / 2) + ',' + f1(uh / 2) + ')' : '');
            w = uw; h = uh;
            if (sh.kind === 'graphicFrame') {
                g = '<rect x="0" y="0" width="' + f1(w) + '" height="' + f1(h) + '" fill="#f8f9fa" stroke="#9aa0a6" stroke-dasharray="4 3"/><text x="' + f1(w / 2) + '" y="' + f1(h / 2) + '" text-anchor="middle" font-size="12" fill="#5f6368">' + (sh.chart ? 'Biểu đồ — bấm Tải để xem đầy đủ bằng Excel' : 'Đối tượng nhúng') + '</text>';
            } else if (sh.kind === 'pic') {
                var im = sh.img;
                if (im && im.data && imgUrl(im)) {
                    var cr = im.crop || { l: 0, t: 0, r: 0, b: 0 }, fw = w / Math.max(0.01, 1 - cr.l - cr.r), fh = h / Math.max(0.01, 1 - cr.t - cr.b);
                    g = '<svg x="0" y="0" width="' + f1(w) + '" height="' + f1(h) + '" overflow="hidden"><image href="' + imgUrl(im) + '" x="' + f1(-cr.l * fw) + '" y="' + f1(-cr.t * fh) + '" width="' + f1(fw) + '" height="' + f1(fh) + '" preserveAspectRatio="none"/></svg>';
                    if (sh.line) g += '<rect x="0" y="0" width="' + f1(w) + '" height="' + f1(h) + '" fill="none"' + strokeAttrs(sh.line) + '/>';
                } else g = '<rect x="0" y="0" width="' + f1(w) + '" height="' + f1(h) + '" fill="#f1f3f4" stroke="#9aa0a6" stroke-dasharray="4 3"/><text x="' + f1(w / 2) + '" y="' + f1(h / 2) + '" text-anchor="middle" font-size="12" fill="#5f6368">Ảnh định dạng chưa xem được trên web (EMF/WMF…)</text>';
            } else {
                var fill = sh.fill ? ' fill="' + sh.fill.c + '"' + (sh.fill.a < 1 ? ' fill-opacity="' + sh.fill.a + '"' : '') : ' fill="none"', st = strokeAttrs(sh.line), inset = { x: 0, y: 0 };
                var isLine = sh.kind === 'cxnSp' || /^(line|straightConnector1)$/.test(geom), isBent = /^bentConnector/.test(geom), isCurve = /^curvedConnector/.test(geom);
                if (isLine || isBent || isCurve) {
                    var x1 = xf.flipH ? w : 0, x2 = xf.flipH ? 0 : w, y1 = xf.flipV ? h : 0, y2 = xf.flipV ? 0 : h, mk = '';
                    if (sh.line && sh.line.head) mk += ' marker-start="url(#' + marker(sh.line.head, sh.line.c, sh.line.w, 'h') + ')"';
                    if (sh.line && sh.line.tail) mk += ' marker-end="url(#' + marker(sh.line.tail, sh.line.c, sh.line.w, 't') + ')"';
                    if (isBent) { var ad = (sh.adj !== undefined ? sh.adj : 50000) / 100000, xm = x1 + (x2 - x1) * ad; g = '<path d="M' + f1(x1) + ',' + f1(y1) + ' L' + f1(xm) + ',' + f1(y1) + ' L' + f1(xm) + ',' + f1(y2) + ' L' + f1(x2) + ',' + f1(y2) + '" fill="none"' + st + mk + '/>'; }
                    else if (isCurve) g = '<path d="M' + f1(x1) + ',' + f1(y1) + ' C' + f1((x1 + x2) / 2) + ',' + f1(y1) + ' ' + f1((x1 + x2) / 2) + ',' + f1(y2) + ' ' + f1(x2) + ',' + f1(y2) + '" fill="none"' + st + mk + '/>';
                    else g = '<line x1="' + f1(x1) + '" y1="' + f1(y1) + '" x2="' + f1(x2) + '" y2="' + f1(y2) + '"' + st + mk + ' stroke-linecap="round"/>';
                } else if (geom === 'ellipse') {
                    g = '<ellipse cx="' + f1(w / 2) + '" cy="' + f1(h / 2) + '" rx="' + f1(w / 2) + '" ry="' + f1(h / 2) + '"' + fill + st + '/>'; inset = { x: w * 0.1464, y: h * 0.1464 };
                } else if (geom === 'roundRect') {
                    var rr = Math.min(w, h) * ((sh.adj !== undefined ? sh.adj : 16667) / 100000);
                    g = '<rect x="0" y="0" width="' + f1(w) + '" height="' + f1(h) + '" rx="' + f1(rr) + '"' + fill + st + '/>';
                } else if (geom === 'triangle') g = '<path d="M' + f1(w / 2) + ',0 L' + f1(w) + ',' + f1(h) + ' L0,' + f1(h) + ' z"' + fill + st + '/>';
                else if (geom === 'diamond') g = '<path d="M' + f1(w / 2) + ',0 L' + f1(w) + ',' + f1(h / 2) + ' L' + f1(w / 2) + ',' + f1(h) + ' L0,' + f1(h / 2) + ' z"' + fill + st + '/>';
                else if (geom === 'rightArrow') g = '<path d="M0,' + f1(h * 0.25) + ' L' + f1(w * 0.6) + ',' + f1(h * 0.25) + ' L' + f1(w * 0.6) + ',0 L' + f1(w) + ',' + f1(h / 2) + ' L' + f1(w * 0.6) + ',' + f1(h) + ' L' + f1(w * 0.6) + ',' + f1(h * 0.75) + ' L0,' + f1(h * 0.75) + ' z"' + fill + st + '/>';
                else g = '<rect x="0" y="0" width="' + f1(w) + '" height="' + f1(h) + '"' + fill + st + '/>';
                if (sh.shadow && sh.fill) g = '<g filter="url(#' + uid + 'sh)">' + g + '</g>';
                g += textSvg(sh, w, h, inset);
            }
            body += '<g transform="' + tf + '">' + g + '</g>';
        });
        var dstr = Object.keys(defs).map(function (k) { return defs[k]; }).join('');
        dstr += '<filter id="' + uid + 'sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity="0.45"/></filter>';
        return { svg: '<svg class="xv-draw" xmlns="' + SVGNS + '" width="' + Math.ceil(maxX + 2) + '" height="' + Math.ceil(maxY + 2) + '" style="font-family:\'' + defFont.replace(/['"]/g, '') + '\',Arial,sans-serif"><defs>' + dstr + '</defs>' + body + '</svg>', w: maxX, h: maxY };
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
            '.xv-draw{position:absolute;left:0;top:0;z-index:1;pointer-events:none;overflow:visible}',
            '.xv-zoom{position:relative;width:max-content}',
            '.xv-zb{margin-left:auto;flex:none;align-self:center;display:flex;gap:2px;padding:0 6px}',
            '.xv-zb button{border:1px solid #dadce0;background:#fff;border-radius:6px;min-width:28px;height:24px;font:13px Arial,sans-serif;color:#3c4043;cursor:pointer;padding:0 6px}',
            '.xv-zb button:hover{background:#eceff1}',
            '.xv-more{display:block;margin:10px auto;padding:7px 14px;border:1px solid #dadce0;border-radius:16px;background:#fff;color:#1a73e8;font:13px Arial,sans-serif;cursor:pointer}',
            '.xv-tabs{display:flex;align-items:stretch;gap:2px;border-top:1px solid #dadce0;background:#f8f9fa;flex:none;min-height:34px;overflow-x:auto}',
            '.xv-tab{flex:none;border:0;background:transparent;padding:0 16px;font:500 13px Arial,sans-serif;color:#5f6368;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:3px solid transparent}',
            '.xv-tab:hover{background:#eceff1}',
            '.xv-tab.on{background:#e6f4ea;color:#137333;border-bottom-color:#188038}',
            '.xv-info{flex:none;align-self:center;padding:0 12px;font-size:11px;color:#80868b;white-space:nowrap}',
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
        var cv = document.createElement('canvas').getContext('2d'), cur = { zoom: 100, urls: [], idx: -1, sheet: null, shown: 0, last: 0, colPx: [], hidCol: [], maxC: 0, merges: null, covered: null, sel: null, tbody: null };

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
            var cls = '';      // quy tắc 'td.lớp' có độ ưu tiên cao hơn font mặc định của bảng → cỡ chữ / phông riêng từng ô mới có tác dụng
            if (css) { cls = uid + 's' + s; ruleText += '.' + uid + ' .xv-t td.' + cls + '{' + css + '}\n'; ruleEl.textContent = ruleText; }
            classes[s] = cls; return cls;
        }
        var defFont = (styles.fonts[0] && styles.fonts[0].name) || 'Calibri', defSz = (styles.fonts[0] && styles.fonts[0].sz) || 11;
        rootEl.classList.add(uid);
        ruleText += '.' + uid + ' .xv-t td,.' + uid + ' .xv-t{font-family:"' + defFont.replace(/"/g, '') + '",Arial,sans-serif;font-size:' + defSz + 'pt}\n'; ruleEl.textContent = ruleText;

        function colWidth(c) { var d = cur.sheet.cols[c]; return d && d.px != null ? d.px : cur.sheet.defColPx; }
        function colHidden(c) { var d = cur.sheet.cols[c]; return !!(d && d.hidden); }
        function visSpan(c1, c2) { var n = 0; for (var c = c1; c <= c2; c++) if (!colHidden(c)) n++; return n || 1; }

        // chiều cao dòng: dòng có "ht" thì theo đó; không có thì tự giãn theo cỡ chữ lớn nhất trong dòng như Excel (11pt → 15pt, 14pt → 18pt, 16pt → 21pt)
        function rowH(r) {
            var sh = cur.sheet; if (sh.rowPx[r]) return sh.rowPx[r];
            var row = sh.rows[r], m = 0, h = sh.defRowPx;
            if (row) row.forEach(function (cell) { if (cell && cell.k !== null) { var f = styles.fonts[(styles.xfs[cell.s] || styles.xfs[0]).fontId]; if (f && f.sz > m) m = f.sz; if (cell.maxSz > m) m = cell.maxSz; } });
            return m ? Math.max(h, Math.round(m * 1.3636 * 96 / 72 * 100) / 100) : h;
        }
        function richHtml(runs) {
            return runs.map(function (r) {
                var css = (r.c ? 'color:' + r.c + ';' : '') + (r.b ? 'font-weight:700;' : '') + (r.i ? 'font-style:italic;' : '') + ((r.u || r.strike) ? 'text-decoration:' + (r.u ? 'underline ' : '') + (r.strike ? 'line-through' : '') + ';' : '') + (r.sz ? 'font-size:' + r.sz + 'pt;' : '') + (r.f ? 'font-family:"' + r.f.replace(/"/g, '') + '",Arial,sans-serif;' : '');
                return css ? '<span style="' + css + '">' + esc(r.t) + '</span>' : esc(r.t);
            }).join('');
        }
        function richWidth(runs, xf) {
            var w = 0; runs.forEach(function (r) { var f = fontCss(xf); cv.font = (r.i ? 'italic ' : '') + (r.b ? 'bold ' : '') + (r.sz ? Math.round(r.sz * 96 / 72 * 10) / 10 + 'px ' : f.replace(/^(italic )?(bold )?/, '')) + (r.sz ? (r.f ? '"' + r.f + '",' : '') + 'Arial,sans-serif' : ''); w += cv.measureText(r.t).width; }); return w;
        }
        function chunkHtml(from, to) {
            var sh = cur.sheet, html = '', r, c;
            for (r = from; r <= to; r++) {
                if (sh.rowHidden[r]) continue;
                var row = sh.rows[r] || [], h = rowH(r), skipUntil = 0;
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
                            var need = (cell.rich ? richWidth(cell.rich, xf) : (cv.font = fontCss(xf), cv.measureText(txt).width)) + 8, c2 = c + 1;
                            while (avail < need && c2 <= cur.maxC) {
                                if (cur.covered.has(r * 20000 + c2) || cur.merges.has(r * 20000 + c2) || (row[c2] && row[c2].k !== null)) break;
                                if (!colHidden(c2)) { avail += colWidth(c2); span++; } c2++;
                            }
                            if (span > 1) { attrs += ' colspan="' + span + '"'; skipUntil = c2; }
                        }
                    }
                    var al = cls ? ' ' + cls : '';
                    if (cell && cell.k !== null && !(xf && xf.h && xf.h !== 'general')) al += cell.k === 'n' ? ' xv-n' : (cell.k === 'b' || cell.k === 'e') ? ' xv-c' : '';
                    html += '<td data-r="' + r + '" data-c="' + c + '"' + (al ? ' class="' + al.trim() + '"' : '') + attrs + '>' + (cell && cell.rich && cell.k === 's' ? richHtml(cell.rich) : esc(txt)) + '</td>';
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
            var dr = sh.drawing || { maxRow: 0, maxCol: 0 };
            cur.maxC = Math.min(Math.max(sh.maxC, 26, dr.maxCol), 1000); cur.totalR = Math.max(sh.maxR, 40, Math.min(dr.maxRow, sh.maxR + 3000));
            cur.merges = new Map(); cur.covered = new Set();
            sh.merges.forEach(function (m) {
                cur.merges.set(m.r1 * 20000 + m.c1, m);
                var rr = Math.min(m.r2, m.r1 + 5000);
                for (var r = m.r1; r <= rr; r++) for (var c = m.c1; c <= Math.min(m.c2, cur.maxC); c++) if (r !== m.r1 || c !== m.c1) cur.covered.add(r * 20000 + c);
            });
            var head = '<th class="xv-corner"></th>', cols = '<col style="width:46px">', total = 46, c;
            for (c = 1; c <= cur.maxC; c++) { if (colHidden(c)) continue; var w = colWidth(c); total += w; cols += '<col style="width:' + w + 'px">'; head += '<th data-ch="' + c + '">' + colName(c) + '</th>'; }
            var end = nextEnd(1, 300);
            elScroll.innerHTML = '<div class="xv-zoom"><table class="xv-t" style="width:' + total + 'px"><colgroup>' + cols + '</colgroup><thead><tr>' + head + '</tr></thead><tbody>' + chunkHtml(1, end) + '</tbody></table></div>';
            cur.tbody = elScroll.querySelector('tbody'); cur.last = end;
            drawOverlay(); applyZoom();
            if (end < cur.totalR) addMore();
            var first = cellAt(1, 1) || elScroll.querySelector('td'); if (first) selectCell(first);
            elScroll.scrollTop = 0; elScroll.scrollLeft = 0;
            Array.prototype.forEach.call(elTabs.querySelectorAll('.xv-tab'), function (b, k) { b.classList.toggle('on', k === i); });
            var info = elTabs.querySelector('.xv-info'); if (info) info.textContent = sh.maxR + ' dòng × ' + sh.maxC + ' cột (' + colName(Math.max(sh.maxC, 1)) + ')';
            var notes = []; if (sh.hasDrawing && !sh.drawing) notes.push('hình vẽ / biểu đồ'); else if (sh.drawing && sh.drawing.hasChart) notes.push('biểu đồ'); if (sh.hasCondFmt) notes.push('định dạng có điều kiện');
            elNote.hidden = !notes.length; elNote.textContent = notes.length ? 'Sheet này có ' + notes.join(' và ') + ' — chưa hiển thị đầy đủ ở chế độ xem nhanh; bấm Tải để mở bằng Excel.' : '';
        }
        // ---- lớp hình vẽ (ảnh, hình khối, đường nối) phủ lên bảng
        function revokeUrls() { cur.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) { } }); cur.urls = []; }
        function drawOverlay() {
            revokeUrls();
            var d = cur.sheet.drawing; if (!d || !d.items.length) return;
            var cx = [0], ry = [0];
            function colX(c0) { for (var c = cx.length; c <= c0; c++) cx[c] = cx[c - 1] + (colHidden(c) ? 0 : colWidth(c)); return cx[c0]; }
            function rowY(r0) { for (var r = ry.length; r <= r0; r++) ry[r] = ry[r - 1] + (cur.sheet.rowHidden[r] ? 0 : rowH(r)); return ry[r0]; }
            var urlOf = new Map();
            function imgUrl(im) { if (!urlOf.has(im)) { var u = URL.createObjectURL(new Blob([im.data], { type: im.mime })); cur.urls.push(u); urlOf.set(im, u); } return urlOf.get(im); }
            var laid = layoutItems(d.items, { colX: colX, rowY: rowY }), r = drawingSvg(laid, imgUrl, function (t, font) { cv.font = font; return cv.measureText(t).width; }, defFont);
            var tb = elScroll.querySelector('table'), corner = tb && tb.querySelector('th.xv-corner'), host = document.createElement('div');
            host.innerHTML = r.svg; var svg = host.firstChild;
            svg.style.left = (corner ? corner.offsetWidth : 46) + 'px'; svg.style.top = (tb && tb.tHead ? tb.tHead.offsetHeight : 21) + 'px';
            elScroll.querySelector('.xv-zoom').appendChild(svg);
        }
        function addMore() {
            var old = elScroll.querySelector('.xv-more'); if (old) old.remove();
            var b = document.createElement('button'); b.type = 'button'; b.className = 'xv-more';
            b.textContent = 'Hiện thêm dòng (đã hiện ' + cur.last + ' / ' + cur.totalR + ')';
            b.onclick = function () {
                var end = nextEnd(cur.last + 1, 400); cur.tbody.insertAdjacentHTML('beforeend', chunkHtml(cur.last + 1, end)); cur.last = end;
                if (end >= cur.totalR) b.remove(); else b.textContent = 'Hiện thêm dòng (đã hiện ' + cur.last + ' / ' + cur.totalR + ')';
            };
            elScroll.querySelector('.xv-zoom').appendChild(b);
        }
        // ---- phóng to / thu nhỏ (nút − + ở thanh dưới, hoặc Ctrl + lăn chuột / chụm hai ngón)
        function applyZoom() { var w = elScroll.querySelector('.xv-zoom'); if (w) w.style.zoom = cur.zoom / 100; elZoomTxt.textContent = cur.zoom + '%'; }
        function setZoom(z) { z = Math.max(30, Math.min(300, Math.round(z / 5) * 5)); if (z === cur.zoom) return; var cx = elScroll.scrollLeft + elScroll.clientWidth / 2, cy = elScroll.scrollTop + elScroll.clientHeight / 2, k = z / cur.zoom; cur.zoom = z; applyZoom(); elScroll.scrollLeft = cx * k - elScroll.clientWidth / 2; elScroll.scrollTop = cy * k - elScroll.clientHeight / 2; try { localStorage.setItem('xvZoom', String(z)); } catch (_) { } }
        // tab sheet
        book.sheetNames.forEach(function (nm, i) {
            var b = document.createElement('button'); b.type = 'button'; b.className = 'xv-tab'; b.textContent = nm; b.title = nm;
            b.onclick = function () { showSheet(i).catch(function (e) { elScroll.innerHTML = '<div style="padding:16px;color:#b91c1c">' + esc(e.message) + '</div>'; }); };
            elTabs.appendChild(b);
        });
        var info = document.createElement('span'); info.className = 'xv-info'; elTabs.appendChild(info);
        var zb = document.createElement('span'); zb.className = 'xv-zb'; zb.innerHTML = '<button type="button" title="Thu nhỏ">−</button><button type="button" class="xv-zt" title="Về 100%">100%</button><button type="button" title="Phóng to">+</button>';
        elTabs.insertBefore(zb, info);
        var elZoomTxt = zb.querySelector('.xv-zt'), zbs = zb.querySelectorAll('button');
        try { var z0 = +localStorage.getItem('xvZoom'); if (z0 >= 30 && z0 <= 300) cur.zoom = z0; } catch (_) { }
        zbs[0].onclick = function () { setZoom(cur.zoom - 10); }; zbs[2].onclick = function () { setZoom(cur.zoom + 10); }; zbs[1].onclick = function () { setZoom(100); };
        elScroll.addEventListener('wheel', function (e) { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(cur.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });

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
        return { workbook: book, destroy: function () { revokeUrls(); rootEl.remove(); ruleEl.remove(); } };
    }

    var api = { canView: canView, render: render, load: load, formatNumber: formatNumber, openZip: openZip, VIEW_EXTS: VIEW_EXTS };
    root.XlsxView = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
