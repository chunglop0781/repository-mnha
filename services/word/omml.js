// services/word/omml.js — công thức Word (OMML: m:oMath / m:oMathPara) ⇄ MathML.
//
//   ommlToMathml(xmlNode)  → chuỗi HTML "<math>…</math>" (xmlNode là m:oMath hoặc m:oMathPara đã parse bằng xml.js)
//   mathmlToOmml(htmlNode) → { xml } "<m:oMath>…</m:oMath>" (hoặc m:oMathPara khi display="block")
//                            (htmlNode là nút <math> do htmlSanitize.parseHtml tạo ra)
//
// Vì sao cần: trước đây công thức chỉ được lấy phần chữ nên "R^4", "x₁", ma trận, phân số… bị dẹt thành "R4", "x1".
// Hai chiều đều giữ: chỉ số trên/dưới, phân số, căn, ngoặc, ma trận, dấu trên đầu (vector), tổng/tích/tích phân, giới hạn, hàm.
// Chỉ dùng các thẻ MathML nằm trong danh sách cho phép của htmlSanitize (math, mrow, mi, mn, mo, mtext, msub, msup, …).
'use strict';
const { local, escapeText, escapeAttr } = require('./xml');

const MAX_DEPTH = 60;

// ---------------------------------------------------------------- tiện ích XML (OMML)
const els = (n) => ((n && n.children) || []).filter((c) => c && c.text == null && c.name);
const ln = (n) => local(n.name);
const kid = (n, name) => els(n).find((c) => ln(c) === name) || null;
const kids = (n, name) => els(n).filter((c) => ln(c) === name);
function attr(n, name) {
    if (!n || !n.attrs) return undefined;
    if (Object.prototype.hasOwnProperty.call(n.attrs, name)) return n.attrs[name];
    for (const k of Object.keys(n.attrs)) if (local(k) === name) return n.attrs[k];
    return undefined;
}
const valOf = (n) => (n ? attr(n, 'val') : undefined);
const onOf = (n) => !!n && !/^(0|false|off)$/i.test(String(valOf(n) == null ? '1' : valOf(n)));
function textOfNode(n) {
    let s = '';
    for (const c of (n && n.children) || []) s += c.text != null ? c.text : textOfNode(c);
    return s;
}

// ---------------------------------------------------------------- ký tự đặc biệt
const COMBINING_TO_SPACING = {
    '\u0300': '`', '\u0301': '\u00b4', '\u0302': '^', '\u0303': '~', '\u0304': '\u00af', '\u0305': '\u00af', '\u0306': '\u02d8',
    '\u0307': '\u02d9', '\u0308': '\u00a8', '\u030a': '\u02da', '\u030c': '\u02c7', '\u20d6': '\u2190', '\u20d7': '\u2192',
    '\u20e1': '\u2194', '\u20db': '\u20db'
};
const SPACING_TO_COMBINING = {};
for (const k of Object.keys(COMBINING_TO_SPACING)) SPACING_TO_COMBINING[COMBINING_TO_SPACING[k]] = k;
SPACING_TO_COMBINING['\u2192'] = '\u20d7'; SPACING_TO_COMBINING['\u2190'] = '\u20d6'; SPACING_TO_COMBINING['\u00af'] = '\u0304';

const NARY = new Set(['\u2211', '\u220f', '\u2210', '\u222b', '\u222c', '\u222d', '\u222e', '\u222f', '\u2230', '\u22c3', '\u22c2', '\u22c0', '\u22c1', '\u2a01', '\u2a02', '\u2a00']);
const OPEN = { '(': ')', '[': ']', '{': '}', '|': '|', '\u2016': '\u2016', '\u27e8': '\u27e9', '\u2308': '\u2309', '\u230a': '\u230b', '\u27ea': '\u27eb', '\u2329': '\u232a' };
const CLOSE = new Set(Object.values(OPEN));
const FUNC_APPLY = '\u2061';

const VARIANT_OF_STY = { p: 'normal', b: 'bold', i: 'italic', bi: 'bold-italic' };
const VARIANT_OF_SCR = { 'double-struck': 'double-struck', script: 'script', fraktur: 'fraktur', 'sans-serif': 'sans-serif', monospace: 'monospace' };

const isLetter = (ch) => /\p{L}/u.test(ch);
const isDigit = (ch) => /[0-9]/.test(ch);

// ================================================================ OMML → MathML
function runToMathml(r) {
    // m:r (hoặc w:r nằm trong công thức): gom chữ trong m:t / w:t
    let text = '';
    for (const c of els(r)) { const l = ln(c); if (l === 't') text += textOfNode(c); }
    if (!text) return '';
    const mPr = kid(r, 'rPr');
    const sty = mPr ? valOf(kid(mPr, 'sty')) : undefined;
    const scr = mPr ? valOf(kid(mPr, 'scr')) : undefined;
    const nor = !!mPr && onOf(kid(mPr, 'nor')) && kid(mPr, 'nor') !== null;
    const lit = !!mPr && kid(mPr, 'lit') !== null && onOf(kid(mPr, 'lit'));
    const variant = (scr && VARIANT_OF_SCR[scr]) || (sty && VARIANT_OF_STY[sty]) || null;
    if (nor || lit) return `<mtext>${escapeText(text.replace(/ /g, '\u00a0'))}</mtext>`;
    const va = variant ? ` mathvariant="${variant}"` : '';
    const out = [];
    const chars = Array.from(text);
    for (let i = 0; i < chars.length;) {
        const ch = chars[i];
        if (/\s/.test(ch)) { i++; continue; }                 // Word tự giãn cách trong công thức
        if (isDigit(ch)) {
            let j = i + 1;
            while (j < chars.length && (isDigit(chars[j]) || ((chars[j] === '.' || chars[j] === ',') && j + 1 < chars.length && isDigit(chars[j + 1])))) j++;
            out.push(`<mn${va}>${escapeText(chars.slice(i, j).join(''))}</mn>`);
            i = j;
        } else if (isLetter(ch)) {
            if (variant === 'normal') {                         // chữ đứng (sin, det, …) → gom cả từ
                let j = i + 1;
                while (j < chars.length && isLetter(chars[j])) j++;
                out.push(`<mi${va}>${escapeText(chars.slice(i, j).join(''))}</mi>`);
                i = j;
            } else { out.push(`<mi${va}>${escapeText(ch)}</mi>`); i++; }
        } else { out.push(`<mo>${escapeText(ch)}</mo>`); i++; }
    }
    return out.join('');
}

function mrow(s) { return `<mrow>${s}</mrow>`; }

function oArgs(n, depth) {
    let out = '';
    for (const c of els(n)) {
        if (/Pr$/.test(ln(c))) continue;                        // sSubPr, dPr, ctrlPr, … (thuộc tính)
        out += oNode(c, depth + 1);
    }
    return out;
}
const oArg = (n, name, depth) => { const c = n && kid(n, name); return c ? mrow(oArgs(c, depth)) : '<mrow></mrow>'; };

function chrOf(pr, name, dflt) {
    const c = pr && kid(pr, name);
    if (!c) return dflt;
    const v = valOf(c);
    return v == null ? dflt : v;                                // val="" = không có ký tự
}
function accentChar(ch) { return COMBINING_TO_SPACING[ch] || ch; }

function oNode(n, depth) {
    if (depth > MAX_DEPTH) return '';
    const l = ln(n);
    switch (l) {
        case 'r': return runToMathml(n);
        case 't': return `<mtext>${escapeText(textOfNode(n))}</mtext>`;
        case 'e': case 'num': case 'den': case 'sub': case 'sup': case 'lim': case 'deg': case 'fName': return mrow(oArgs(n, depth));
        case 'sSub': return `<msub>${oArg(n, 'e', depth)}${oArg(n, 'sub', depth)}</msub>`;
        case 'sSup': return `<msup>${oArg(n, 'e', depth)}${oArg(n, 'sup', depth)}</msup>`;
        case 'sSubSup': return `<msubsup>${oArg(n, 'e', depth)}${oArg(n, 'sub', depth)}${oArg(n, 'sup', depth)}</msubsup>`;
        case 'sPre': return `<mmultiscripts>${oArg(n, 'e', depth)}<mprescripts></mprescripts>${oArg(n, 'sub', depth)}${oArg(n, 'sup', depth)}</mmultiscripts>`;
        case 'f': {
            const type = valOf(kid(kid(n, 'fPr') || { children: [] }, 'type')) || 'bar';
            const num = oArg(n, 'num', depth), den = oArg(n, 'den', depth);
            if (type === 'lin' || type === 'skw') return mrow(`${num}<mo>/</mo>${den}`);
            return `<mfrac${type === 'noBin' ? ' linethickness="0"' : ''}>${num}${den}</mfrac>`;
        }
        case 'd': {
            const pr = kid(n, 'dPr');
            const beg = chrOf(pr, 'begChr', '('), end = chrOf(pr, 'endChr', ')'), sep = chrOf(pr, 'sepChr', '|');
            const parts = kids(n, 'e').map((e) => mrow(oArgs(e, depth)));
            let body = '';
            parts.forEach((p, i) => { if (i && sep) body += `<mo separator="true">${escapeText(sep)}</mo>`; body += p; });
            return mrow((beg ? `<mo fence="true" stretchy="true">${escapeText(beg)}</mo>` : '') + body + (end ? `<mo fence="true" stretchy="true">${escapeText(end)}</mo>` : ''));
        }
        case 'm': {
            const rows = kids(n, 'mr').map((mr) => `<mtr>${kids(mr, 'e').map((e) => `<mtd>${mrow(oArgs(e, depth))}</mtd>`).join('')}</mtr>`);
            return `<mtable>${rows.join('')}</mtable>`;
        }
        case 'eqArr': return `<mtable>${kids(n, 'e').map((e) => `<mtr><mtd>${mrow(oArgs(e, depth))}</mtd></mtr>`).join('')}</mtable>`;
        case 'acc': {
            const ch = accentChar(chrOf(kid(n, 'accPr'), 'chr', '\u0302'));
            return `<mover accent="true">${oArg(n, 'e', depth)}<mo>${escapeText(ch)}</mo></mover>`;
        }
        case 'bar': {
            const top = valOf(kid(kid(n, 'barPr') || { children: [] }, 'pos')) === 'top';
            return top ? `<mover accent="true">${oArg(n, 'e', depth)}<mo>\u00af</mo></mover>` : `<munder>${oArg(n, 'e', depth)}<mo>\u005f</mo></munder>`;
        }
        case 'groupChr': {
            const pr = kid(n, 'groupChrPr');
            const ch = chrOf(pr, 'chr', '\u23df');
            const top = valOf(kid(pr || { children: [] }, 'pos')) === 'top';
            return top ? `<mover>${oArg(n, 'e', depth)}<mo>${escapeText(ch)}</mo></mover>` : `<munder>${oArg(n, 'e', depth)}<mo>${escapeText(ch)}</mo></munder>`;
        }
        case 'rad': {
            const rp = kid(n, 'radPr');
            const hide = !!rp && !!kid(rp, 'degHide') && onOf(kid(rp, 'degHide'));
            const deg = kid(n, 'deg');
            if (hide || !deg || (!els(deg).length && !textOfNode(deg).trim())) return `<msqrt>${oArg(n, 'e', depth)}</msqrt>`;
            return `<mroot>${oArg(n, 'e', depth)}${oArg(n, 'deg', depth)}</mroot>`;
        }
        case 'nary': {
            const pr = kid(n, 'naryPr');
            const ch = chrOf(pr, 'chr', '\u222b');
            const under = valOf(kid(pr || { children: [] }, 'limLoc')) === 'undOvr';
            const subHide = !!pr && !!kid(pr, 'subHide') && onOf(kid(pr, 'subHide'));
            const supHide = !!pr && !!kid(pr, 'supHide') && onOf(kid(pr, 'supHide'));
            const op = `<mo largeop="true">${escapeText(ch)}</mo>`;
            const sub = oArg(n, 'sub', depth), sup = oArg(n, 'sup', depth);
            let head;
            if (subHide && supHide) head = op;
            else if (under) head = subHide ? `<mover>${op}${sup}</mover>` : supHide ? `<munder>${op}${sub}</munder>` : `<munderover>${op}${sub}${sup}</munderover>`;
            else head = subHide ? `<msup>${op}${sup}</msup>` : supHide ? `<msub>${op}${sub}</msub>` : `<msubsup>${op}${sub}${sup}</msubsup>`;
            return mrow(head + oArg(n, 'e', depth));
        }
        case 'func': return mrow(`${oArg(n, 'fName', depth)}<mo>${FUNC_APPLY}</mo>${oArg(n, 'e', depth)}`);
        case 'limLow': return `<munder>${oArg(n, 'e', depth)}${oArg(n, 'lim', depth)}</munder>`;
        case 'limUpp': return `<mover>${oArg(n, 'e', depth)}${oArg(n, 'lim', depth)}</mover>`;
        case 'box': case 'borderBox': case 'phant': case 'oMath': return mrow(oArgs(n, depth));
        default: return oArgs(n, depth);
    }
}

/** m:oMath / m:oMathPara → chuỗi MathML. oMathPara (công thức riêng một dòng) → display="block". */
function ommlToMathml(node) {
    if (!node) return '';
    if (ln(node) === 'oMathPara') {
        const maths = kids(node, 'oMath');
        return maths.map((m) => `<math display="block">${oArgs(m, 0)}</math>`).join('');
    }
    const inner = oArgs(node, 0);
    return inner ? `<math>${inner}</math>` : '';
}

// ================================================================ MathML → OMML
const MFONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';
const hEls = (n) => ((n && n.children) || []).filter((c) => c && c.text == null && c.tag);
const hText = (n) => { let s = ''; for (const c of (n && n.children) || []) s += c.text != null ? c.text : hText(c); return s; };
const a = (n, k) => (n && n.attrs && n.attrs[k] != null ? String(n.attrs[k]) : '');

function mrun(text, { sty, nor, scr } = {}) {
    if (text === '') return '';
    let pr = '';
    if (nor) pr = '<m:rPr><m:nor/></m:rPr>';
    else if (sty || scr) pr = `<m:rPr>${scr ? `<m:scr m:val="${escapeAttr(scr)}"/>` : ''}${sty ? `<m:sty m:val="${escapeAttr(sty)}"/>` : ''}</m:rPr>`;
    return `<m:r>${pr}${MFONT}<m:t xml:space="preserve">${escapeText(text)}</m:t></m:r>`;
}
const STY_OF_VARIANT = { normal: 'p', bold: 'b', italic: 'i', 'bold-italic': 'bi' };
function tokenOmml(n) {
    const t = n.tag, raw = hText(n);
    const v = a(n, 'mathvariant');
    const opt = {};
    if (STY_OF_VARIANT[v]) opt.sty = STY_OF_VARIANT[v];
    else if (VARIANT_OF_SCR[v]) opt.scr = v;
    if (t === 'mtext') return mrun(raw.replace(/\u00a0/g, ' '), { nor: true });
    if (t === 'mo' && raw === FUNC_APPLY) return '';
    if (t === 'mspace') return mrun(' ', { nor: true });
    if (t === 'mi' && !opt.sty && raw.length > 1 && /^\p{L}+$/u.test(raw)) opt.sty = 'p';   // tên hàm nhiều chữ → chữ đứng
    return mrun(raw.replace(/\s+/g, ''), opt);
}

function mArgsOmml(nodes, depth) {
    let out = '';
    for (const c of nodes || []) {
        if (c.text != null) continue;                          // chữ rời trong <math>: bỏ (khoảng trắng)
        out += mNode(c, depth + 1);
    }
    return out;
}
function mE(nodes, depth) { return `<m:e>${mArgsOmml(nodes, depth)}</m:e>`; }
const mOf = (tag, node, depth) => (node ? `<m:${tag}>${mArgsOmml(node.tag === 'mrow' ? node.children : [node], depth)}</m:${tag}>` : `<m:${tag}/>`);

function isNaryBase(n) {
    return n && n.tag === 'mo' && NARY.has(hText(n).trim());
}
function naryHead(n) {
    // msubsup/msub/msup/munderover/munder/mover có đáy là toán tử lớn (∑ ∫ …)
    if (!n || !hEls(n).length) return null;
    const c = hEls(n);
    if (!['msubsup', 'msub', 'msup', 'munderover', 'munder', 'mover'].includes(n.tag) || !isNaryBase(c[0])) return null;
    const under = n.tag.startsWith('munder') || n.tag === 'mover';
    let sub = null, sup = null;
    if (n.tag === 'msubsup' || n.tag === 'munderover') { sub = c[1]; sup = c[2]; }
    else if (n.tag === 'msub' || n.tag === 'munder') sub = c[1];
    else sup = c[1];
    return { chr: hText(c[0]).trim(), under, sub, sup };
}
function naryOmml(h, body, depth) {
    const pr = `<m:naryPr><m:chr m:val="${escapeAttr(h.chr)}"/><m:limLoc m:val="${h.under ? 'undOvr' : 'subSup'}"/>${h.sub ? '' : '<m:subHide m:val="1"/>'}${h.sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>`;
    return `<m:nary>${pr}${mOf('sub', h.sub, depth)}${mOf('sup', h.sup, depth)}<m:e>${mArgsOmml(body, depth)}</m:e></m:nary>`;
}

function fencedOmml(n, depth) {
    // mrow bắt đầu bằng ngoặc mở và kết thúc bằng ngoặc đóng → m:d
    const c = hEls(n);
    if (c.length < 2) return null;
    const f = c[0], l = c[c.length - 1];
    if (f.tag !== 'mo' || l.tag !== 'mo') return null;
    const beg = hText(f).trim(), end = hText(l).trim();
    if (!OPEN[beg] && !(a(f, 'fence') === 'true' && beg.length === 1)) return null;
    if (!CLOSE.has(end) && !(a(l, 'fence') === 'true' && end.length === 1)) return null;
    if (OPEN[beg] && OPEN[beg] !== end && a(f, 'fence') !== 'true') return null;
    const mid = c.slice(1, -1);
    const groups = [[]];
    let sepChr = '';
    for (const x of mid) {
        if (x.tag === 'mo' && a(x, 'separator') === 'true') { sepChr = sepChr || hText(x).trim(); groups.push([]); }
        else groups[groups.length - 1].push(x);
    }
    const pr = `<m:dPr>${beg === '(' ? '' : `<m:begChr m:val="${escapeAttr(beg)}"/>`}${groups.length > 1 && sepChr && sepChr !== '|' ? `<m:sepChr m:val="${escapeAttr(sepChr)}"/>` : ''}${end === ')' ? '' : `<m:endChr m:val="${escapeAttr(end)}"/>`}</m:dPr>`;
    return `<m:d>${pr}${groups.map((g) => `<m:e>${mArgsOmml(g, depth)}</m:e>`).join('')}</m:d>`;
}

function mNode(n, depth) {
    if (depth > MAX_DEPTH) return '';
    const c = hEls(n);
    switch (n.tag) {
        case 'mi': case 'mn': case 'mo': case 'mtext': case 'mspace': return tokenOmml(n);
        case 'mrow': {
            const d = fencedOmml(n, depth);
            if (d) return d;
            if (c.length && naryHead(c[0])) return naryOmml(naryHead(c[0]), c.slice(1), depth);
            return mArgsOmml(c, depth);
        }
        case 'msub': { const h = naryHead(n); if (h) return naryOmml(h, [], depth); return `<m:sSub><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e>${mOf('sub', c[1], depth)}</m:sSub>`; }
        case 'msup': { const h = naryHead(n); if (h) return naryOmml(h, [], depth); return `<m:sSup><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e>${mOf('sup', c[1], depth)}</m:sSup>`; }
        case 'msubsup': { const h = naryHead(n); if (h) return naryOmml(h, [], depth); return `<m:sSubSup><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e>${mOf('sub', c[1], depth)}${mOf('sup', c[2], depth)}</m:sSubSup>`; }
        case 'mmultiscripts': {
            const pi = c.findIndex((x) => x.tag === 'mprescripts');
            const pre = pi >= 0 ? c.slice(pi + 1) : [];
            const post = pi >= 0 ? c.slice(1, pi) : c.slice(1);
            if (pre.length && !post.length) return `<m:sPre><m:sub>${mArgsOmml(pre[0] ? [pre[0]] : [], depth)}</m:sub><m:sup>${mArgsOmml(pre[1] ? [pre[1]] : [], depth)}</m:sup><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e></m:sPre>`;
            return `<m:sSubSup><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e>${mOf('sub', post[0], depth)}${mOf('sup', post[1], depth)}</m:sSubSup>`;
        }
        case 'mfrac': {
            const nb = a(n, 'linethickness') === '0';
            return `<m:f>${nb ? '<m:fPr><m:type m:val="noBin"/></m:fPr>' : ''}${mOf('num', c[0], depth)}${mOf('den', c[1], depth)}</m:f>`;
        }
        case 'msqrt': return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mArgsOmml(c, depth)}</m:e></m:rad>`;
        case 'mroot': return `<m:rad>${mOf('deg', c[1], depth)}<m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e></m:rad>`;
        case 'munderover': {
            const h = naryHead(n); if (h) return naryOmml(h, [], depth);
            return `<m:limUpp><m:e><m:limLow><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e>${mOf('lim', c[1], depth)}</m:limLow></m:e>${mOf('lim', c[2], depth)}</m:limUpp>`;
        }
        case 'munder': { const h = naryHead(n); if (h) return naryOmml(h, [], depth); return `<m:limLow><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e>${mOf('lim', c[1], depth)}</m:limLow>`; }
        case 'mover': {
            const h = naryHead(n); if (h) return naryOmml(h, [], depth);
            const ac = c[1] && c[1].tag === 'mo' ? hText(c[1]).trim() : '';
            if (a(n, 'accent') === 'true' && ac) {
                const chr = SPACING_TO_COMBINING[ac] || ac;
                return `<m:acc><m:accPr><m:chr m:val="${escapeAttr(chr)}"/></m:accPr><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e></m:acc>`;
            }
            return `<m:limUpp><m:e>${mArgsOmml(c[0] ? [c[0]] : [], depth)}</m:e>${mOf('lim', c[1], depth)}</m:limUpp>`;
        }
        case 'mtable': {
            const rows = c.filter((x) => x.tag === 'mtr');
            const cellsOf = (tr) => hEls(tr).filter((x) => x.tag === 'mtd');
            if (rows.length && rows.every((r) => cellsOf(r).length === 1)) {
                return `<m:eqArr>${rows.map((r) => `<m:e>${mArgsOmml(hEls(cellsOf(r)[0]), depth)}</m:e>`).join('')}</m:eqArr>`;
            }
            const cols = Math.max(1, ...rows.map((r) => cellsOf(r).length));
            return `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>` +
                rows.map((r) => `<m:mr>${cellsOf(r).map((td) => `<m:e>${mArgsOmml(hEls(td), depth)}</m:e>`).join('')}</m:mr>`).join('') + '</m:m>';
        }
        case 'mtr': case 'mtd': case 'mstyle': case 'mpadded': case 'semantics': case 'math': return mArgsOmml(c, depth);
        default: return mArgsOmml(c, depth);
    }
}

/** <math> (nút từ htmlSanitize.parseHtml) → { xml } gồm m:oMath (hoặc m:oMathPara khi display="block"). */
function mathmlToOmml(node) {
    const inner = mArgsOmml(hEls(node), 0);
    const body = `<m:oMath>${inner}</m:oMath>`;
    return { xml: a(node, 'display') === 'block' ? `<m:oMathPara>${body}</m:oMathPara>` : body };
}

module.exports = { ommlToMathml, mathmlToOmml };
