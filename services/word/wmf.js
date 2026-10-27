// services/word/wmf.js — chuyển ảnh Windows Metafile (.wmf) → SVG, không dùng thư viện ngoài.
//
//  Vì sao cần: công thức viết bằng MathType / Equation Editor trong Word được lưu dưới dạng
//  "đối tượng OLE + ảnh xem trước .wmf". Trình duyệt không hiển thị được .wmf nên trước đây mọi công thức
//  dạng này biến mất khi tải file Word lên. WMF của MathType chỉ gồm chữ (Times New Roman / Symbol) và vài
//  nét kẻ → dựng lại thành SVG là đủ để hiển thị đúng và rõ ở mọi độ phóng.
//
//  Hỗ trợ: chữ (TextOut / ExtTextOut kèm khoảng cách từng ký tự), phông + đậm/nghiêng/gạch chân, màu chữ,
//  bảng mã Symbol → Unicode, đoạn thẳng, polyline, polygon, hình chữ nhật, elip, cung tròn, bút/cọ, SaveDC/RestoreDC.
//  Không hỗ trợ ảnh bitmap nhúng trong WMF (bỏ qua, không lỗi).
//  SVG đầu ra mang thuộc tính data-wmf (WMF gốc dạng base64) để khi xuất lại .docx có thể nhúng nguyên bản WMF.
'use strict';

const MAX_RECORDS = 40000;
const MAX_SVG_BYTES = 400 * 1024;

// Bảng mã phông Symbol (Adobe Symbol) → Unicode
const SYMBOL = (() => {
    const m = {};
    const set = (from, str) => { Array.from(str).forEach((ch, i) => { m[from + i] = ch; }); };
    set(0x20, ' !∀#∃%&∋()∗+,−./0123456789:;<=>?');
    set(0x40, '≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾');
    set(0x61, 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼');
    set(0xa0, '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…|―↵');
    set(0xc0, 'ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊⟨®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪');
    set(0xf1, '⟩∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭');
    return m;
})();

// Windows-1252: các mã 0x80–0x9F khác với Latin-1
const CP1252 = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
    0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (n) => Math.round(n * 100) / 100;
const rgb = (b, o) => '#' + [b[o], b[o + 1], b[o + 2]].map((v) => (v < 16 ? '0' : '') + v.toString(16)).join('');

function decodeText(bytes, face, charset) {
    const symbolic = /symbol/i.test(face) && !/^mt\s*symbol/i.test(face) || charset === 2 && /^symbol$/i.test(face);
    let out = '';
    for (const c of bytes) {
        if (symbolic) out += SYMBOL[c] != null ? SYMBOL[c] : String.fromCharCode(c);
        else out += CP1252[c] != null ? CP1252[c] : String.fromCharCode(c);
    }
    return out;
}

function fontFamily(face) {
    const f = String(face || '').replace(/['"<>&\\]/g, '').trim();
    if (!f || /^(symbol|mt\s*extra|mt\s*symbol|mt\s*italic)/i.test(f)) return "'Times New Roman','Liberation Serif','Cambria Math','STIX Two Math',Times,serif";
    if (/times/i.test(f)) return "'Times New Roman','Liberation Serif',Times,serif";
    if (/arial|helvetica|calibri|tahoma|verdana/i.test(f)) return `'${f}','Liberation Sans',Arial,sans-serif`;
    if (/courier|consolas|mono/i.test(f)) return `'${f}','Liberation Mono','Courier New',monospace`;
    return `'${f}','Times New Roman','Liberation Serif',serif`;
}

/**
 * wmfToSvg(buf) → chuỗi SVG, hoặc null nếu không đọc được.
 * @param {Buffer} buf  nội dung file .wmf
 * @param {{embedSource?:boolean}} [opt]
 */
function wmfToSvg(buf, opt = {}) {
    try { return convert(buf, opt); } catch (_) { return null; }
}

function convert(buf, opt) {
    if (!buf || buf.length < 30) return null;
    const s16 = (o) => buf.readInt16LE(o);
    const u16 = (o) => buf.readUInt16LE(o);
    let off = 0, bbox = null, inch = 1440;
    if (buf.readUInt32LE(0) === 0x9ac6cdd7) {
        bbox = { l: s16(6), t: s16(8), r: s16(10), b: s16(12) };
        inch = u16(14) || 1440;
        off = 22;
    }
    const headerSize = u16(off + 2);
    if (u16(off) > 2 || headerSize < 9) return null;      // không phải WMF
    off += headerSize * 2;

    const win = { ox: 0, oy: 0, ex: 0, ey: 0, has: false };
    const objs = [];
    const addObj = (o) => { let i = objs.findIndex((x) => x == null); if (i < 0) i = objs.length; objs[i] = o; };
    let st = {
        font: null, pen: { style: 0, w: 1, color: '#000000' }, brush: { style: 1, color: '#000000' },
        color: '#000000', align: 0, fill: 'nonzero'
    };
    const stack = [];
    const cp = { x: 0, y: 0 };
    const out = [];
    let n = 0;

    const stroke = () => (st.pen.style === 5 ? 'stroke="none"' : `stroke="${st.pen.color}" stroke-width="${r2(Math.max(st.pen.w, 1))}" stroke-linecap="round" stroke-linejoin="round"`);
    const fill = () => (st.brush.style === 1 ? 'fill="none"' : `fill="${st.brush.color}" fill-rule="${st.fill}"`);
    const pt = (x, y) => r2(x) + ',' + r2(y);

    const drawText = (txtBytes, x, y, dx) => {
        const f = st.font || { h: -200, wt: 400, it: 0, ul: 0, face: 'Times New Roman', cs: 0 };
        const size = f.h < 0 ? -f.h : (f.h || 200) * 0.85;
        const text = decodeText(txtBytes, f.face, f.cs);
        if (!text.length) return 0;
        let a = st.align;
        if (a & 1) { x = cp.x; y = cp.y; }                    // TA_UPDATECP: vẽ tại vị trí hiện tại
        const vert = a & 24;
        if (vert === 0) y += size * 0.86;                     // TA_TOP → quy về đường cơ sở
        else if (vert === 8) y -= size * 0.22;                // TA_BOTTOM
        const chars = Array.from(text);
        let xs = '';
        let adv = 0;
        const hasDx = dx && dx.length >= txtBytes.length;
        if (hasDx) {
            const pos = []; let cx = x;
            for (let i = 0; i < chars.length; i++) { pos.push(r2(cx)); cx += dx[i] || 0; }
            adv = cx - x;
            xs = pos.join(' ');
        } else {
            adv = chars.length * size * 0.5;
            xs = r2(x);
        }
        let anchor = '';
        if (!hasDx) { const h = a & 6; if (h === 6) anchor = ' text-anchor="middle"'; else if (h === 2) anchor = ' text-anchor="end"'; }
        const attrs = [
            `x="${xs}"`, `y="${r2(y)}"`, `font-family="${esc(fontFamily(f.face))}"`, `font-size="${r2(size)}"`,
            `fill="${st.color}"`
        ];
        if (f.it) attrs.push('font-style="italic"');
        if (f.wt >= 600) attrs.push('font-weight="bold"');
        if (f.ul) attrs.push('text-decoration="underline"');
        out.push(`<text ${attrs.join(' ')}${anchor} xml:space="preserve">${esc(chars.join(''))}</text>`);
        if (a & 1) cp.x += adv;
        return adv;
    };

    const arcPath = (box, sx, sy, ex, ey) => {
        const cx = (box.l + box.r) / 2, cy = (box.t + box.b) / 2;
        const rx = Math.abs(box.r - box.l) / 2, ry = Math.abs(box.b - box.t) / 2;
        if (!rx || !ry) return '';
        const onEllipse = (px, py) => {
            const a = Math.atan2((py - cy) / ry, (px - cx) / rx);
            return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), a };
        };
        const A = onEllipse(sx, sy), B = onEllipse(ex, ey);
        let ccw = A.a - B.a; while (ccw < 0) ccw += Math.PI * 2;
        return `M${pt(A.x, A.y)}A${r2(rx)},${r2(ry)} 0 ${ccw > Math.PI ? 1 : 0} 0 ${pt(B.x, B.y)}`;
    };

    while (off + 6 <= buf.length && n++ < MAX_RECORDS) {
        const size = buf.readUInt32LE(off), fn = u16(off + 4);
        if (size < 3) break;
        const p = off + 6;                                   // đầu tham số
        const end = off + size * 2;
        if (end > buf.length) break;
        switch (fn) {
            case 0x0000: off = buf.length; continue;         // META_EOF
            case 0x020b: win.oy = s16(p); win.ox = s16(p + 2); break;                       // SetWindowOrg
            case 0x020c: win.ey = s16(p); win.ex = s16(p + 2); win.has = true; break;        // SetWindowExt
            case 0x0209: st.color = rgb(buf, p); break;                                      // SetTextColor
            case 0x012e: st.align = u16(p); break;                                           // SetTextAlign
            case 0x0106: st.fill = u16(p) === 2 ? 'nonzero' : 'evenodd'; break;              // SetPolyFillMode
            case 0x001e: stack.push({ ...st }); break;                                       // SaveDC
            case 0x0127: { const k = s16(p); let c = k < 0 ? -k : 1; while (c-- > 0 && stack.length) st = stack.pop(); break; }
            case 0x02fb: {                                                                   // CreateFontIndirect
                let q = p + 18, e = q;
                while (e < end && buf[e] !== 0) e++;
                addObj({
                    t: 'font', h: s16(p), wt: s16(p + 8), it: buf[p + 10], ul: buf[p + 11], cs: buf[p + 13],
                    face: buf.toString('latin1', q, e)
                });
                break;
            }
            case 0x02fa: addObj({ t: 'pen', style: u16(p) & 0xf, w: Math.abs(s16(p + 2)), color: rgb(buf, p + 6) }); break;
            case 0x02fc: addObj({ t: 'brush', style: u16(p), color: rgb(buf, p + 2) }); break;
            case 0x02fd: case 0x00f7: case 0x01f9: addObj({ t: 'other' }); break;            // palette / region / pattern brush
            case 0x012d: {                                                                   // SelectObject
                const o = objs[u16(p)];
                if (o && o.t === 'font') st.font = o;
                else if (o && o.t === 'pen') st.pen = o;
                else if (o && o.t === 'brush') st.brush = o;
                break;
            }
            case 0x01f0: { const i = u16(p); if (i < objs.length) objs[i] = null; break; }   // DeleteObject
            case 0x0214: cp.y = s16(p); cp.x = s16(p + 2); break;                            // MoveTo
            case 0x0213: {                                                                   // LineTo
                const y = s16(p), x = s16(p + 2);
                if (st.pen.style !== 5) out.push(`<line x1="${r2(cp.x)}" y1="${r2(cp.y)}" x2="${r2(x)}" y2="${r2(y)}" ${stroke()}/>`);
                cp.x = x; cp.y = y; break;
            }
            case 0x0325: case 0x0324: {                                                      // Polyline / Polygon
                const c = s16(p); const pts = [];
                for (let i = 0; i < c && p + 2 + i * 4 + 4 <= end; i++) pts.push(pt(s16(p + 2 + i * 4), s16(p + 4 + i * 4)));
                if (pts.length > 1) out.push(fn === 0x0325
                    ? `<polyline points="${pts.join(' ')}" fill="none" ${stroke()}/>`
                    : `<polygon points="${pts.join(' ')}" ${fill()} ${stroke()}/>`);
                break;
            }
            case 0x0538: {                                                                   // PolyPolygon
                const np = s16(p); let q = p + 2 + np * 2, d = '';
                for (let k = 0; k < np; k++) {
                    const c = u16(p + 2 + k * 2);
                    for (let i = 0; i < c && q + 4 <= end; i++, q += 4) d += (i ? 'L' : 'M') + pt(s16(q), s16(q + 2));
                    d += 'Z';
                }
                if (d) out.push(`<path d="${d}" ${fill()} ${stroke()}/>`);
                break;
            }
            case 0x041b: case 0x0418: {                                                      // Rectangle / Ellipse
                const b = s16(p), r = s16(p + 2), t = s16(p + 4), l = s16(p + 6);
                out.push(fn === 0x041b
                    ? `<rect x="${r2(Math.min(l, r))}" y="${r2(Math.min(t, b))}" width="${r2(Math.abs(r - l))}" height="${r2(Math.abs(b - t))}" ${fill()} ${stroke()}/>`
                    : `<ellipse cx="${r2((l + r) / 2)}" cy="${r2((t + b) / 2)}" rx="${r2(Math.abs(r - l) / 2)}" ry="${r2(Math.abs(b - t) / 2)}" ${fill()} ${stroke()}/>`);
                break;
            }
            case 0x0817: {                                                                   // Arc
                const d = arcPath({ l: s16(p + 14), t: s16(p + 12), r: s16(p + 10), b: s16(p + 8) }, s16(p + 6), s16(p + 4), s16(p + 2), s16(p));
                if (d) out.push(`<path d="${d}" fill="none" ${stroke()}/>`);
                break;
            }
            case 0x0521: {                                                                   // TextOut
                const len = u16(p), padded = len + (len & 1);
                const y = s16(p + 2 + padded), x = s16(p + 4 + padded);
                drawText(buf.subarray(p + 2, p + 2 + len), x, y, null);
                break;
            }
            case 0x0a32: {                                                                   // ExtTextOut
                const y = s16(p), x = s16(p + 2), len = u16(p + 4), opts = u16(p + 6);
                let q = p + 8;
                if (opts & 0x6) q += 8;
                const txt = buf.subarray(q, q + len);
                q += len + (len & 1);
                let dx = null;
                if (q + len * 2 <= end) { dx = []; for (let i = 0; i < len; i++) dx.push(s16(q + i * 2)); }
                drawText(txt, x, y, dx);
                break;
            }
            default: break;                                                                  // Escape, SetBkMode, SetROP2, v.v. → bỏ qua
        }
        off = end;
    }

    if (!out.length) return null;
    let vx = win.ox, vy = win.oy, vw = win.ex, vh = win.ey;
    if (!win.has || !vw || !vh) {
        if (!bbox) return null;
        vx = bbox.l; vy = bbox.t; vw = bbox.r - bbox.l; vh = bbox.b - bbox.t;
    }
    if (vw < 0) { vx += vw; vw = -vw; }
    if (vh < 0) { vy += vh; vh = -vh; }
    if (!(vw > 0 && vh > 0)) return null;
    // kích thước tự nhiên (px CSS, 96dpi); nếu không có khung "placeable" thì quy ước 1 đơn vị = 1/inch
    const bw = bbox ? bbox.r - bbox.l : vw, bh = bbox ? bbox.b - bbox.t : vh;
    const wPx = Math.max(4, r2(Math.abs(bw) / inch * 96)), hPx = Math.max(4, r2(Math.abs(bh) / inch * 96));
    const src = opt.embedSource === false || buf.length > 96 * 1024 ? '' : ` data-wmf="${buf.toString('base64')}"`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(vx)} ${r2(vy)} ${r2(vw)} ${r2(vh)}" width="${wPx}" height="${hPx}" preserveAspectRatio="none"${src}>${out.join('')}</svg>`;
    return Buffer.byteLength(svg) > MAX_SVG_BYTES ? null : svg;
}

module.exports = { wmfToSvg, SYMBOL };
