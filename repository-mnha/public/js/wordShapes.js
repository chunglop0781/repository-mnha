// public/js/wordShapes.js — Hình khối đặt TỰ DO ở bất kỳ chỗ nào của trang Word
//   • Chèn: nút "Hình khối" (thư viện) — bấm để chèn hoặc KÉO THẢ thẳng vào vị trí muốn đặt
//   • Di chuyển bằng chuột/cảm ứng, đổi kích thước 8 điểm (Shift giữ tỉ lệ), xoay (Shift = bước 15°), phím mũi tên (Shift = 10px)
//   • Nháy đúp (hoặc Enter) để gõ chữ trong hình; Delete để xoá; thẻ ngữ cảnh "Định dạng hình" như Word
//   • Dữ liệu lưu là <div class="word-shape" data-shape=".." style="position:absolute;left;top;width;height;z-index;…">
//     (toạ độ tính từ góc trên-trái vùng nội dung; data-oy = lệch so với đoạn văn neo, dùng khi xuất .docx)
// Nạp TRƯỚC wordEditor.js; wordEditor.js gọi wdShapes.init() sau khi có window.__wd.
(function () {
    'use strict';
    var C = null, app, body, page, canvas;
    var PX_CM = 37.7953;
    var MIN = 14;
    var MIME = 'application/x-wd-shape';
    var SHAPES = [
        { id: 'rect', label: 'Chữ nhật' }, { id: 'round', label: 'Bo góc' }, { id: 'ellipse', label: 'Elip' },
        { id: 'triangle', label: 'Tam giác' }, { id: 'diamond', label: 'Hình thoi' }, { id: 'hexagon', label: 'Lục giác' },
        { id: 'arrow', label: 'Mũi tên' }, { id: 'star', label: 'Ngôi sao' }, { id: 'plus', label: 'Dấu cộng' }, { id: 'line', label: 'Đường thẳng' }
    ];
    var KINDS = {}; SHAPES.forEach(function (s) { KINDS[s.id] = true; });
    var CLIPPED = { triangle: 1, diamond: 1, hexagon: 1, arrow: 1, star: 1, plus: 1 };
    var COLORS = ['#000000', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
    var HANDLE = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
    var sel = null, ov = null, menu = null, tab = null, editing = null, gesture = null, prevTab = 'home', placed = 0, inited = false;

    // ------------------------------------------------------------ tiện ích
    function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
    function rnd(n) { return Math.round(n * 10) / 10; }
    function toast(m, bad) { if (C) C.toast(m, bad); }
    function dirty() { if (C) C.markDirty(); }
    function canEdit() { return !!C && body.isContentEditable && !app.classList.contains('wd-read'); }
    function shapeOf(node) {
        var el = node && node.nodeType === 1 ? node : node && node.parentElement;
        var s = el && el.closest ? el.closest('.word-shape') : null;
        return s && body.contains(s) ? s : null;
    }
    function kindOf(el) { var k = el && el.getAttribute('data-shape'); return KINDS[k] ? k : 'rect'; }
    function isFree(el) { return /absolute/i.test(el.style.position || ''); }
    function angleOf(el) { var m = /rotate\((-?[\d.]+)deg\)/.exec(el.style.transform || ''); return m ? parseFloat(m[1]) : 0; }
    function scale() {
        var r = body.getBoundingClientRect();
        var k = body.offsetWidth ? r.width / body.offsetWidth : 0;
        return k > 0.2 && k < 5 ? k : (C.getZoom() / 100 || 1);
    }
    function toBody(cx, cy) {
        var r = body.getBoundingClientRect(), k = scale();
        return { x: (cx - r.left) / k, y: (cy - r.top) / k };
    }
    function toHex(c) {
        var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c || '');
        if (!m) return /^#[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : null;
        if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
        return '#' + [1, 2, 3].map(function (i) { return ('0' + (+m[i]).toString(16)).slice(-2); }).join('');
    }
    function mix(hex, t) {
        var n = parseInt(hex.slice(1), 16), ch = [n >> 16 & 255, n >> 8 & 255, n & 255];
        return '#' + ch.map(function (x) { return ('0' + Math.round(x + (255 - x) * t).toString(16)).slice(-2); }).join('');
    }
    function lum(hex) {
        var n = parseInt(hex.slice(1), 16);
        return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
    }
    function pad() { var m = C.getPage().marginsPx || {}; return { t: m.top || 0, r: m.right || 0, b: m.bottom || 0, l: m.left || 0 }; }
    function areaSize() {
        var d = C.dims(), p = pad();
        return { w: body.clientWidth || (d.w - p.l - p.r), h: Math.max(120, d.h - p.t - p.b) };
    }

    // ------------------------------------------------------------ tạo / neo vào đoạn văn
    function create(kind, x, y) {
        var isText = kind === 'textbox', type = isText ? 'rect' : (KINDS[kind] ? kind : 'rect');
        var w = 150, h = 90;
        if (type === 'ellipse') { w = 150; h = 96; }
        if (CLIPPED[type] && type !== 'arrow') { w = 120; h = 110; }
        if (type === 'arrow') { w = 160; h = 80; }
        if (type === 'line') { w = 180; h = 0; }
        var el = document.createElement('div');
        el.className = 'word-shape';
        el.setAttribute('data-shape', type);
        var st = el.style;
        st.position = 'absolute'; st.left = rnd(x - w / 2) + 'px'; st.top = rnd(y - h / 2) + 'px';
        st.width = w + 'px'; st.height = h + 'px'; st.zIndex = '1';
        if (type === 'line') {
            st.padding = '0'; st.minHeight = '0'; st.backgroundColor = 'transparent'; st.borderTop = '3px solid #2563eb';
        } else if (isText) {
            st.backgroundColor = '#ffffff'; st.border = '1px solid #94a3b8'; st.color = '#0f172a';
            st.textAlign = 'left'; st.justifyContent = 'flex-start'; st.alignItems = 'flex-start'; st.borderRadius = '0px';
            el.textContent = 'Nhập văn bản';
        } else {
            st.backgroundColor = '#dbeafe'; st.border = '2px solid #2563eb'; st.color = '#0f172a';
        }
        el.setAttribute('contenteditable', 'false');
        return el;
    }
    function clampPos(el, l, t) {
        var p = pad(), a = areaSize(), w = el.offsetWidth, h = el.offsetHeight;
        var maxY = Math.max(page.offsetHeight - body.offsetTop - h, 0);
        return { l: Math.max(-p.l, Math.min(l, a.w + p.r - w)), t: Math.max(-p.t, Math.min(t, maxY)) };
    }
    function setPos(el, l, t) {
        var c = clampPos(el, l, t);
        el.style.left = rnd(c.l) + 'px'; el.style.top = rnd(c.t) + 'px';
    }
    function blocks() {
        return Array.prototype.filter.call(body.children, function (c) { return !c.classList.contains('word-shape'); });
    }
    /** Đặt node hình ngay TRƯỚC khối văn bản nằm ở/dưới toạ độ top → thứ tự trong HTML khớp thứ tự trên trang. */
    function anchorTo(el) {
        var top = px(el.style.top), list = blocks(), target = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].offsetTop + list[i].offsetHeight > top) { target = list[i]; break; }
        }
        var wantNext = target;
        var cur = el.nextElementSibling;
        while (cur && cur.classList.contains('word-shape')) cur = cur.nextElementSibling;
        if (el.parentNode === body && (cur || null) === (wantNext || null)) return;
        body.insertBefore(el, wantNext || null);
    }
    /** Ghi data-oy (lệch so với đoạn neo) cho mọi hình tự do — dùng khi xuất .docx. */
    function syncAnchors() {
        Array.prototype.forEach.call(body.querySelectorAll('.word-shape'), function (el) {
            if (!isFree(el)) { el.removeAttribute('data-oy'); return; }
            var anchor = el.nextElementSibling;
            while (anchor && anchor.classList.contains('word-shape')) anchor = anchor.nextElementSibling;
            if (!anchor) { anchor = el.previousElementSibling; while (anchor && anchor.classList.contains('word-shape')) anchor = anchor.previousElementSibling; }
            var oy = px(el.style.top) - (anchor ? anchor.offsetTop : 0);
            el.setAttribute('data-oy', String(Math.round(oy)));
        });
    }
    function makeFree(el) {
        if (isFree(el)) return;
        var w = el.offsetWidth, h = el.offsetHeight, l = el.offsetLeft, t = el.offsetTop;
        el.style.display = ''; el.style.verticalAlign = '';
        el.style.width = w + 'px'; el.style.height = h + 'px';
        el.style.position = 'absolute'; el.style.left = l + 'px'; el.style.top = t + 'px';
        if (!el.style.zIndex) el.style.zIndex = '1';
    }
    function insertShape(kind, x, y) {
        if (!canEdit()) { toast('Tài liệu đang khoá hoặc ở chế độ đọc.', true); return null; }
        var el = create(kind, x, y);
        body.appendChild(el);                      // cần có trong DOM để đo kích thước
        setPos(el, px(el.style.left), px(el.style.top));
        anchorTo(el);
        prepare(el);
        select(el);
        dirty();
        return el;
    }
    function insertAtView(kind) {
        var cr = canvas.getBoundingClientRect();
        var pt = toBody(cr.left + cr.width / 2, cr.top + Math.min(cr.height / 2, 260));
        var off = (placed++ % 6) * 14;
        var a = areaSize();
        pt.x = Math.max(60, Math.min(pt.x, a.w - 60)) + off; pt.y = Math.max(50, pt.y) + off;
        insertShape(kind, pt.x, pt.y);
    }
    function prepare(el) {
        if (el !== editing) el.setAttribute('contenteditable', 'false');
    }
    function prepareAll() { Array.prototype.forEach.call(body.querySelectorAll('.word-shape'), prepare); }

    // ------------------------------------------------------------ khung chọn (overlay trong .wd-page, không nằm trong nội dung)
    function buildOverlay() {
        ov = document.createElement('div');
        ov.className = 'wd-shape-ov';
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rot'].forEach(function (h) {
            var i = document.createElement('i'); i.setAttribute('data-h', h); ov.appendChild(i);
        });
        page.appendChild(ov);
        ov.addEventListener('pointerdown', function (e) {
            var h = e.target.getAttribute && e.target.getAttribute('data-h');
            if (!h || !sel || !canEdit()) return;
            e.preventDefault(); e.stopPropagation();
            makeFree(sel);
            if (h === 'rot') startRotate(e); else startResize(e, h);
        });
    }
    function place() {
        if (!ov) return;
        if (!sel || !body.contains(sel)) { ov.classList.remove('on'); return; }
        ov.style.left = (body.offsetLeft + sel.offsetLeft) + 'px';
        ov.style.top = (body.offsetTop + sel.offsetTop) + 'px';
        ov.style.width = sel.offsetWidth + 'px';
        ov.style.height = sel.offsetHeight + 'px';
        ov.style.transform = sel.style.transform || '';
        ov.style.transformOrigin = '50% 50%';
        ov.classList.toggle('wd-line-ov', kindOf(sel) === 'line');
        ov.classList.toggle('editing', sel === editing);
        ov.classList.add('on');
    }

    // ------------------------------------------------------------ chọn / bỏ chọn
    function select(el) {
        if (el === sel) { place(); return; }
        endEdit();
        var had = !!sel;
        sel = el || null;
        if (!sel) {
            if (ov) ov.classList.remove('on');
            tab.classList.remove('show');
            if (tab.classList.contains('active')) C.setTab(prevTab || 'home');
            return;
        }
        if (!had) {
            var act = app.querySelector('.wd-tab.active');
            if (act && act !== tab) prevTab = act.getAttribute('data-tab') || 'home';
        }
        tab.classList.add('show');
        C.setTab('shape');
        syncControls();
        place();
    }

    // ------------------------------------------------------------ kéo / đổi kích thước / xoay
    function listen() {
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        document.body.classList.add('wd-dragging-shape');
    }
    function unlisten() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('wd-dragging-shape');
    }
    function startMove(e, el) {
        gesture = { type: 'move', el: el, sx: e.clientX, sy: e.clientY, k: scale(), moved: false, l: 0, t: 0 };
        listen();
    }
    function startResize(e, h) {
        var el = sel;
        gesture = {
            type: 'resize', el: el, f: HANDLE[h], sx: e.clientX, sy: e.clientY, k: scale(),
            l: px(el.style.left), t: px(el.style.top), w: el.offsetWidth, h: el.offsetHeight,
            th: angleOf(el) * Math.PI / 180, line: kindOf(el) === 'line', moved: true
        };
        listen();
    }
    function startRotate(e) {
        var r = sel.getBoundingClientRect();
        gesture = { type: 'rotate', el: sel, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: true };
        listen();
    }
    function onMove(e) {
        var g = gesture; if (!g) return;
        var el = g.el;
        if (g.type === 'move') {
            var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
            if (!g.moved) {
                if (Math.abs(dx) + Math.abs(dy) < 4) return;
                g.moved = true;
                makeFree(el);
                g.l = px(el.style.left); g.t = px(el.style.top);
            }
            setPos(el, g.l + dx / g.k, g.t + dy / g.k);
        } else if (g.type === 'resize') {
            var ddx = (e.clientX - g.sx) / g.k, ddy = (e.clientY - g.sy) / g.k;
            var c = Math.cos(g.th), s = Math.sin(g.th);
            var lx = ddx * c + ddy * s, ly = -ddx * s + ddy * c;            // độ lệch theo trục của hình (đã xoay)
            var nw = g.w, nh = g.h;
            if (g.f[0]) nw = Math.max(MIN, g.w + g.f[0] * lx);
            if (g.f[1] && !g.line) nh = Math.max(MIN, g.h + g.f[1] * ly);
            if (e.shiftKey && g.f[0] && g.f[1] && g.w > 0 && g.h > 0) {
                var r = g.w / g.h;
                if (Math.abs(nw / g.w - 1) > Math.abs(nh / g.h - 1)) nh = nw / r; else nw = nh * r;
            }
            var cx = g.f[0] * (nw - g.w) / 2, cy = g.f[1] * (nh - g.h) / 2;   // dịch tâm (hệ cục bộ) để cạnh đối diện đứng yên
            var gx = cx * c - cy * s, gy = cx * s + cy * c;
            el.style.width = rnd(nw) + 'px';
            if (!g.line) el.style.height = rnd(nh) + 'px';
            el.style.left = rnd(g.l + g.w / 2 + gx - nw / 2) + 'px';
            el.style.top = rnd(g.t + g.h / 2 + gy - (g.line ? 0 : nh / 2)) + 'px';
        } else if (g.type === 'rotate') {
            var a = Math.atan2(e.clientY - g.cy, e.clientX - g.cx) * 180 / Math.PI + 90;
            if (e.shiftKey) a = Math.round(a / 15) * 15;
            setRotation(el, a);
        }
        place();
    }
    function onUp() {
        var g = gesture; gesture = null; unlisten();
        if (!g) return;
        if (g.moved) {
            if (g.type !== 'rotate') anchorTo(g.el);
            dirty(); syncControls(); place();
        }
    }
    function setRotation(el, deg) {
        deg = ((Math.round(deg) % 360) + 360) % 360;
        el.style.transform = deg ? 'rotate(' + deg + 'deg)' : '';
    }

    // ------------------------------------------------------------ soạn chữ trong hình
    function startEdit(el) {
        if (!el || kindOf(el) === 'line' || !canEdit()) return;
        editing = el;
        el.setAttribute('contenteditable', 'true');
        el.focus();
        var r = document.createRange(); r.selectNodeContents(el);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        place();
    }
    function endEdit() {
        if (!editing) return;
        var el = editing; editing = null;
        el.setAttribute('contenteditable', 'false');
        dirty(); place();
    }

    // ------------------------------------------------------------ định dạng
    function setFill(hex) {
        if (!sel) return;
        if (kindOf(sel) === 'line') { sel.style.borderTopColor = hex; return; }
        sel.style.backgroundColor = hex;
    }
    function setLine(hex) {
        if (!sel) return;
        if (kindOf(sel) === 'line') { sel.style.borderTopColor = hex; return; }
        if (!px(sel.style.borderWidth || sel.style.borderTopWidth)) sel.style.border = '2px solid ' + hex;
        else sel.style.borderColor = hex;
    }
    function setLineWidth(n) {
        if (!sel) return;
        if (kindOf(sel) === 'line') { sel.style.borderTopWidth = Math.max(1, n) + 'px'; return; }
        sel.style.borderStyle = 'solid'; sel.style.borderWidth = n + 'px';
    }
    function applyPreset(kind, color) {
        if (!sel) return;
        var fill, line = color, text = '#0f172a';
        if (kind === 'solid') { fill = color; text = lum(color) > 0.62 ? '#0f172a' : '#ffffff'; }
        else if (kind === 'light') fill = mix(color, 0.78);
        else fill = CLIPPED[kindOf(sel)] ? mix(color, 0.82) : '#ffffff';
        if (kindOf(sel) === 'line') { sel.style.borderTopColor = color; }
        else {
            sel.style.backgroundColor = fill;
            if (!px(sel.style.borderWidth || sel.style.borderTopWidth)) sel.style.border = '2px solid ' + line; else sel.style.borderColor = line;
            sel.style.color = text;
        }
        dirty(); syncControls();
    }
    function changeKind(kind) {
        if (!sel || !KINDS[kind]) return;
        var was = kindOf(sel);
        sel.setAttribute('data-shape', kind);
        if (kind === 'line' && was !== 'line') {
            sel.style.height = '0px'; sel.style.minHeight = '0px'; sel.style.padding = '0';
            sel.style.borderTop = '3px solid ' + (toHex(sel.style.borderColor) || '#2563eb'); sel.style.backgroundColor = 'transparent';
        } else if (kind !== 'line' && was === 'line') {
            sel.style.height = '80px'; sel.style.minHeight = ''; sel.style.padding = '';
            sel.style.border = '2px solid ' + (toHex(sel.style.borderTopColor) || '#2563eb'); sel.style.backgroundColor = '#dbeafe';
        }
        dirty(); syncControls(); place();
    }
    function placeAt(hx, vy) {
        if (!sel) return;
        makeFree(sel);
        var a = areaSize(), w = sel.offsetWidth, h = sel.offsetHeight;
        var l = px(sel.style.left), t = px(sel.style.top);
        if (hx) l = hx === 'l' ? 0 : hx === 'c' ? (a.w - w) / 2 : a.w - w;
        if (vy) t = vy === 't' ? 0 : vy === 'm' ? (a.h - h) / 2 : a.h - h;
        setPos(sel, l, t); anchorTo(sel);
        dirty(); syncControls(); place();
    }
    function setWrap(mode) {
        if (!sel) return;
        if (mode === 'inline') {
            var w = sel.offsetWidth, h = sel.offsetHeight;
            sel.style.position = ''; sel.style.left = ''; sel.style.top = ''; sel.style.zIndex = '';
            sel.removeAttribute('data-oy');
            sel.style.width = w + 'px'; sel.style.height = h + 'px';
        } else {
            makeFree(sel);
            var z = parseInt(sel.style.zIndex, 10) || 1;
            sel.style.zIndex = String(mode === 'behind' ? (z < 0 ? z : -1) : (z > 0 ? z : 1));
        }
        dirty(); syncControls(); place();
    }
    function layer(d) {
        if (!sel) { toast('Hãy bấm vào hình khối cần sắp xếp.', true); return; }
        if (!isFree(sel)) { toast('Hình đang "cùng dòng với văn bản" — đổi sang Trước/Sau văn bản để xếp lớp.', true); return; }
        var z = parseInt(sel.style.zIndex, 10) || 1, nz = z + (d > 0 ? 1 : -1);
        if (z > 0) nz = Math.max(1, Math.min(99, nz)); else nz = Math.max(-50, Math.min(-1, nz));
        if (nz === z) { toast(d > 0 ? 'Đã ở lớp trên cùng.' : 'Đã ở lớp dưới cùng (chọn "Sau văn bản" để đưa ra sau chữ).'); return; }
        sel.style.zIndex = String(nz);
        dirty(); toast(d > 0 ? 'Đã đưa lên một lớp.' : 'Đã lùi xuống một lớp.');
    }
    function remove() {
        if (!sel) return;
        var el = sel; select(null);
        if (el.parentNode) el.parentNode.removeChild(el);
        dirty(); toast('Đã xoá hình.');
    }
    function duplicate() {
        if (!sel) return;
        makeFree(sel);
        var c = sel.cloneNode(true);
        c.removeAttribute('data-oy');
        sel.parentNode.insertBefore(c, sel.nextSibling);
        setPos(c, px(sel.style.left) + 20, px(sel.style.top) + 20);
        anchorTo(c); prepare(c); select(c); dirty();
    }
    function nudge(dx, dy) {
        if (!sel) return;
        makeFree(sel);
        setPos(sel, px(sel.style.left) + dx, px(sel.style.top) + dy);
        anchorTo(sel); dirty(); syncControls(); place();
    }

    // ------------------------------------------------------------ đồng bộ ô điều khiển
    function ctl(name) { return app.querySelector('[data-shape-ctl="' + name + '"]'); }
    function setCtl(name, v) { var e = ctl(name); if (e && document.activeElement !== e) e.value = v; }
    function nearestOption(select, n) {
        var best = null, d = 1e9;
        Array.prototype.forEach.call(select.options, function (o) { var x = Math.abs(Number(o.value) - n); if (x < d) { d = x; best = o.value; } });
        return best;
    }
    function syncControls() {
        if (!sel) return;
        var cs = window.getComputedStyle(sel), line = kindOf(sel) === 'line';
        setCtl('fill', (line ? toHex(cs.borderTopColor) : toHex(cs.backgroundColor)) || '#ffffff');
        setCtl('line', toHex(line ? cs.borderTopColor : cs.borderTopColor) || '#475569');
        var lw = ctl('lineWidth'); if (lw) lw.value = nearestOption(lw, px(line ? cs.borderTopWidth : cs.borderTopWidth));
        setCtl('textColor', toHex(cs.color) || '#0f172a');
        var fs = ctl('fontSize'); if (fs) fs.value = nearestOption(fs, px(cs.fontSize));
        setCtl('hAlign', /right|end/.test(cs.textAlign) ? 'right' : /center/.test(cs.textAlign) ? 'center' : 'left');
        setCtl('vAlign', cs.alignItems === 'flex-start' || cs.alignItems === 'start' ? 'flex-start' : cs.alignItems === 'flex-end' || cs.alignItems === 'end' ? 'flex-end' : 'center');
        setCtl('wrap', !isFree(sel) ? 'inline' : (parseInt(sel.style.zIndex, 10) < 0 ? 'behind' : 'front'));
        setCtl('position', ''); setCtl('align', ''); setCtl('kind', '');
        setCtl('wCm', rnd(sel.offsetWidth / PX_CM)); setCtl('hCm', rnd(sel.offsetHeight / PX_CM));
        var h = ctl('hCm'); if (h) h.disabled = line;
        var b = app.querySelector('[data-shape-act="bold"]'); if (b) b.classList.toggle('on', Number(cs.fontWeight) >= 600);
        var sh = app.querySelector('[data-shape-act="shadow"]'); if (sh) sh.classList.toggle('on', !!sel.style.boxShadow && sel.style.boxShadow !== 'none');
    }
    function onCtl(e) {
        var t = e.target, k = t.getAttribute && t.getAttribute('data-shape-ctl');
        if (!k || !sel) return;
        var v = t.value;
        switch (k) {
            case 'fill': setFill(v); break;
            case 'line': setLine(v); break;
            case 'lineWidth': setLineWidth(Number(v)); break;
            case 'textColor': sel.style.color = v; break;
            case 'fontSize': sel.style.fontSize = v + 'px'; break;
            case 'hAlign': sel.style.textAlign = v; break;
            case 'vAlign': sel.style.alignItems = v; break;
            case 'kind': if (v) changeKind(v); return;
            case 'position': if (v) placeAt(v.charAt(1), v.charAt(0)); return;
            case 'align':
                if (v) { var m = { left: ['l', null], center: ['c', null], right: ['r', null], top: [null, 't'], middle: [null, 'm'], bottom: [null, 'b'] }[v]; placeAt(m[0], m[1]); }
                return;
            case 'wrap': setWrap(v); return;
            case 'wCm': { var w = Number(v); if (w > 0) { sel.style.width = Math.max(MIN, Math.round(w * PX_CM)) + 'px'; } break; }
            case 'hCm': { var h = Number(v); if (h > 0 && kindOf(sel) !== 'line') { sel.style.height = Math.max(MIN, Math.round(h * PX_CM)) + 'px'; } break; }
        }
        dirty(); place();
    }
    function onAct(act) {
        if (!sel && act !== 'noop') return;
        switch (act) {
            case 'nofill': if (kindOf(sel) !== 'line') { sel.style.backgroundColor = 'transparent'; dirty(); syncControls(); } break;
            case 'shadow': sel.style.boxShadow = sel.style.boxShadow && sel.style.boxShadow !== 'none' ? 'none' : '0 4px 10px rgba(15, 23, 42, 0.35)'; dirty(); syncControls(); break;
            case 'bold': sel.style.fontWeight = Number(window.getComputedStyle(sel).fontWeight) >= 600 ? '400' : '700'; dirty(); syncControls(); break;
            case 'forward': layer(1); break;
            case 'backward': layer(-1); break;
            case 'rotl': makeFree(sel); setRotation(sel, angleOf(sel) - 90); dirty(); place(); break;
            case 'rotr': makeFree(sel); setRotation(sel, angleOf(sel) + 90); dirty(); place(); break;
            case 'duplicate': duplicate(); break;
            case 'delete': remove(); break;
            case 'alt': {
                var cur = sel.getAttribute('title') || '';
                var v = window.prompt('Văn bản thay thế (mô tả hình cho người dùng trình đọc màn hình):', cur);
                if (v != null) { if (v.trim()) sel.setAttribute('title', v.trim().slice(0, 300)); else sel.removeAttribute('title'); dirty(); }
                break;
            }
        }
    }

    // ------------------------------------------------------------ thư viện hình + kéo thả từ ribbon
    function buildGallery(host) {
        host.innerHTML = '';
        SHAPES.forEach(function (sh) {
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'wd-shp-btn'; b.title = sh.label + ' — bấm để chèn hoặc kéo thả vào trang';
            b.setAttribute('data-shape-insert', sh.id); b.draggable = true;
            var m = document.createElement('span'); m.className = 'wd-shp-mini'; m.setAttribute('data-shape', sh.id);
            b.appendChild(m); host.appendChild(b);
        });
    }
    function paintStyles() {
        var host = app.querySelector('[data-shape-styles]'); if (!host) return;
        host.innerHTML = '';
        ['outline', 'solid', 'light'].forEach(function (kind) {
            COLORS.forEach(function (c) {
                var b = document.createElement('button');
                b.type = 'button'; b.className = 'wd-shp-style'; b.textContent = 'Abc'; b.title = 'Kiểu hình';
                b.setAttribute('data-shape-style', kind); b.setAttribute('data-color', c);
                var fill = kind === 'solid' ? c : kind === 'light' ? mix(c, 0.78) : '#ffffff';
                b.style.background = fill; b.style.borderColor = c;
                b.style.color = kind === 'solid' && lum(c) <= 0.62 ? '#ffffff' : '#0f172a';
                host.appendChild(b);
            });
        });
    }
    function closeMenu() {
        if (!menu) return;
        if (menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
        document.removeEventListener('pointerdown', menuOutside, true);
    }
    function menuOutside(e) {
        if (menu && !menu.contains(e.target) && !(e.target.closest && e.target.closest('#wdShapeMenu'))) closeMenu();
    }
    function toggleMenu(btn) {
        if (menu) { closeMenu(); return; }
        menu = document.createElement('div');
        menu.className = 'wd-shape-menu';
        menu.innerHTML = '<h4>Hình khối cơ bản</h4><div class="wd-shp-gallery"></div>' +
            '<div class="wd-row" style="margin-top:8px"><button type="button" class="wd-btn" data-shape-insert="textbox" draggable="true">Hộp văn bản</button></div>' +
            '<p>Bấm một hình để chèn, hoặc <b>kéo thả</b> vào bất kỳ chỗ nào của trang. Sau đó kéo để di chuyển, kéo chấm vuông để đổi cỡ, chấm tròn để xoay; nháy đúp để gõ chữ.</p>';
        buildGallery(menu.querySelector('.wd-shp-gallery'));
        app.appendChild(menu);
        var r = btn.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 270)) + 'px';
        menu.style.top = (r.bottom + 6) + 'px';
        document.addEventListener('pointerdown', menuOutside, true);
    }

    // ------------------------------------------------------------ chặn dính/xoá nhầm hình khi gõ xoá ở đoạn kề hình
    function guardJoin(e) {
        if (e.key !== 'Backspace' && e.key !== 'Delete') return;
        var s = window.getSelection();
        if (!s || !s.rangeCount || !s.isCollapsed || !body.contains(s.anchorNode) || shapeOf(s.anchorNode)) return;
        var n = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
        while (n && n.parentElement !== body) n = n.parentElement;
        if (!n) return;
        var r = s.getRangeAt(0), probe = document.createRange();
        if (e.key === 'Backspace') {
            probe.selectNodeContents(n); probe.setEnd(r.startContainer, r.startOffset);
            var prev = n.previousElementSibling;
            if (probe.toString() === '' && prev && prev.classList.contains('word-shape')) {
                e.preventDefault();
                var p = prev; while (p && p.classList.contains('word-shape')) p = p.previousElementSibling;
                if (p) { var rr = document.createRange(); rr.selectNodeContents(p); rr.collapse(false); s.removeAllRanges(); s.addRange(rr); }
            }
        } else {
            probe.selectNodeContents(n); probe.setStart(r.endContainer, r.endOffset);
            var next = n.nextElementSibling;
            if (probe.toString() === '' && next && next.classList.contains('word-shape')) {
                e.preventDefault();
                var q = next; while (q && q.classList.contains('word-shape')) q = q.nextElementSibling;
                if (q) { var r2 = document.createRange(); r2.selectNodeContents(q); r2.collapse(true); s.removeAllRanges(); s.addRange(r2); }
            }
        }
    }

    // ------------------------------------------------------------ khởi tạo
    function init() {
        if (inited) return;
        C = window.__wd; if (!C) return;
        inited = true;
        app = C.app; body = C.body; page = C.page; canvas = C.canvas;
        tab = document.getElementById('wdTabShape');
        buildOverlay();
        paintStyles();
        Array.prototype.forEach.call(app.querySelectorAll('[data-shape-gallery]'), buildGallery);

        // nút "Hình khối" ở thẻ Chèn
        var mb = document.getElementById('wdShapeMenu');
        if (mb) mb.addEventListener('click', function () { toggleMenu(mb); });

        // chèn bằng click / bắt đầu kéo thả
        app.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('[data-shape-insert]');
            if (b) { insertAtView(b.getAttribute('data-shape-insert')); closeMenu(); return; }
            var st = e.target.closest && e.target.closest('[data-shape-style]');
            if (st) { applyPreset(st.getAttribute('data-shape-style'), st.getAttribute('data-color')); return; }
            var ac = e.target.closest && e.target.closest('[data-shape-act]');
            if (ac) onAct(ac.getAttribute('data-shape-act'));
        });
        app.addEventListener('dragstart', function (e) {
            var b = e.target.closest && e.target.closest('[data-shape-insert]');
            if (!b || !e.dataTransfer) return;
            e.dataTransfer.setData(MIME, b.getAttribute('data-shape-insert'));
            e.dataTransfer.setData('text/plain', '');
            e.dataTransfer.effectAllowed = 'copy';
        });
        app.addEventListener('dragend', function () { closeMenu(); });
        app.addEventListener('input', onCtl);
        app.addEventListener('change', onCtl);

        // thả vào trang (kể cả vùng lề)
        function hasShape(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], MIME) >= 0; }
        page.addEventListener('dragover', function (e) { if (hasShape(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
        page.addEventListener('drop', function (e) {
            if (!hasShape(e)) return;
            e.preventDefault(); e.stopPropagation();
            var kind = e.dataTransfer.getData(MIME);
            var pt = toBody(e.clientX, e.clientY);
            insertShape(kind, pt.x, pt.y);
            closeMenu();
        });

        // chọn / kéo hình
        body.addEventListener('pointerdown', function (e) {
            if (!canEdit()) return;
            var el = shapeOf(e.target);
            if (!el) { if (sel) select(null); return; }
            if (editing === el) return;
            if (e.button !== 0) return;
            e.preventDefault();
            select(el);
            startMove(e, el);
        }, true);
        document.addEventListener('pointerdown', function (e) {
            if (!sel) return;
            var t = e.target;
            if (body.contains(t) || ov.contains(t) || (t.closest && t.closest('.wd-ribbon,.wd-shape-menu,.wd-modal'))) return;
            if (canvas.contains(t)) select(null);
        }, true);
        body.addEventListener('dblclick', function (e) {
            var el = shapeOf(e.target);
            if (!el || !canEdit()) return;
            e.preventDefault(); select(el); startEdit(el);
        });
        body.addEventListener('focusout', function (e) { if (editing && e.target === editing) endEdit(); });
        body.addEventListener('input', function () { if (sel) place(); });
        body.addEventListener('keydown', guardJoin);

        document.addEventListener('keydown', function (e) {
            if (!sel) return;
            if (editing) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(); } return; }
            var t = e.target;
            if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
            if (!canEdit()) return;
            var step = e.shiftKey ? 10 : 1, k = e.key;
            if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(); }
            else if (k === 'ArrowLeft') { e.preventDefault(); nudge(-step, 0); }
            else if (k === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
            else if (k === 'ArrowUp') { e.preventDefault(); nudge(0, -step); }
            else if (k === 'ArrowDown') { e.preventDefault(); nudge(0, step); }
            else if (k === 'Enter') { e.preventDefault(); startEdit(sel); }
            else if (k === 'Escape') { select(null); }
        }, true);

        // nội dung nạp lại / hình bị xoá bởi thao tác khác
        new MutationObserver(function () {
            prepareAll();
            if (sel && !body.contains(sel)) select(null); else if (sel) place();
        }).observe(body, { childList: true, subtree: true });
        window.addEventListener('resize', place);
        prepareAll();
    }

    window.wdShapes = {
        init: init,
        current: function () { return sel; },
        layer: layer,
        beforeSave: function () { endEdit(); syncAnchors(); }
    };
})();
