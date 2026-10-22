// services/emu8086/assembler.js
// Trình dịch hợp ngữ 8086 (cú pháp giống emu8086) viết lại bằng Node.js từ đặc tả 8086.
// Đầu ra: danh sách lệnh đã "giải mã" (không phải mã máy) + ảnh bộ nhớ dữ liệu ban đầu.
'use strict';

const R8 = ['AL', 'CL', 'DL', 'BL', 'AH', 'CH', 'DH', 'BH'];
const R16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
const SREG = ['ES', 'CS', 'SS', 'DS'];

const JCC = ['JA', 'JAE', 'JB', 'JBE', 'JC', 'JE', 'JG', 'JGE', 'JL', 'JLE', 'JNA', 'JNAE', 'JNB', 'JNBE', 'JNC', 'JNE',
    'JNG', 'JNGE', 'JNL', 'JNLE', 'JNO', 'JNP', 'JNS', 'JNZ', 'JO', 'JP', 'JPE', 'JPO', 'JS', 'JZ'];
const MNEMONICS = new Set([
    'MOV', 'XCHG', 'PUSH', 'POP', 'PUSHF', 'POPF', 'LEA', 'LDS', 'LES', 'XLAT', 'XLATB', 'LAHF', 'SAHF',
    'ADD', 'ADC', 'SUB', 'SBB', 'CMP', 'INC', 'DEC', 'NEG', 'NOT', 'AND', 'OR', 'XOR', 'TEST',
    'MUL', 'IMUL', 'DIV', 'IDIV', 'CBW', 'CWD', 'SHL', 'SAL', 'SHR', 'SAR', 'ROL', 'ROR', 'RCL', 'RCR',
    'JMP', 'LOOP', 'LOOPE', 'LOOPZ', 'LOOPNE', 'LOOPNZ', 'JCXZ', 'CALL', 'RET', 'RETN', 'RETF', 'INT', 'INTO', 'IRET',
    'MOVSB', 'MOVSW', 'STOSB', 'STOSW', 'LODSB', 'LODSW', 'SCASB', 'SCASW', 'CMPSB', 'CMPSW',
    'CLC', 'STC', 'CMC', 'CLD', 'STD', 'CLI', 'STI', 'NOP', 'HLT', 'WAIT',
    'DAA', 'DAS', 'AAA', 'AAS', 'AAM', 'AAD', 'IN', 'OUT', ...JCC
]);
const PREFIXES = new Set(['REP', 'REPE', 'REPZ', 'REPNE', 'REPNZ', 'LOCK']);

class AsmError extends Error {
    constructor(errors) {
        super(errors.map((e) => `Dòng ${e.line}: ${e.message}`).join('\n'));
        this.name = 'AsmError';
        this.errors = errors;
    }
}

function stripComment(line) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === ';') return line.slice(0, i);
    }
    return line;
}

// tách theo dấu phẩy ở mức ngoài cùng (bỏ qua trong nháy / ngoặc)
function splitTop(s) {
    const out = []; let depth = 0, q = null, cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { cur += c; if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; cur += c; continue; }
        if (c === '(' || c === '[') depth++;
        if (c === ')' || c === ']') depth--;
        if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim() !== '' || out.length) out.push(cur.trim());
    return out;
}

function parseNumber(tok) {
    let m;
    if ((m = /^0x([0-9a-f]+)$/i.exec(tok))) return parseInt(m[1], 16);
    if ((m = /^([0-9][0-9a-f]*)h$/i.exec(tok))) return parseInt(m[1], 16);
    if ((m = /^([01]+)b$/i.exec(tok))) return parseInt(m[1], 2);
    if ((m = /^([0-7]+)[qo]$/i.exec(tok))) return parseInt(m[1], 8);
    if ((m = /^[0-9]+d?$/i.exec(tok))) return parseInt(tok, 10);
    return null;
}

class Assembler {
    constructor(source) {
        this.src = String(source || '').replace(/\r\n?/g, '\n').split('\n');
        this.errors = [];
        this.sym = new Map();        // name(UPPER) → {kind:'var'|'label'|'const'|'seg', value, size, seg}
        this.model = null;           // null = COM, 'SMALL'...
        this.stackSize = 0x100;
        this.stmts = [];
        this.code = [];
        this.mem = new Map();        // địa chỉ vật lý → byte (chỉ phần dữ liệu khởi tạo)
        this.org = 0;
    }

    err(line, message) { this.errors.push({ line, message }); }

    // ------------------------------------------------------------------ biểu thức
    evalExpr(text, line, loc, allowUndef) {
        const toks = [];
        const re = /\s*(0x[0-9a-f]+|[0-9][0-9a-z]*|'[^']*'|"[^"]*"|[A-Za-z_@?.$][\w@?.$]*|[-+*/%()])/giy;
        let m, pos = 0;
        const s = String(text).trim();
        while (pos < s.length) {
            re.lastIndex = pos;
            m = re.exec(s);
            if (!m) { this.err(line, `bad expression: ${s}`); return { v: 0, vars: [] }; }
            toks.push(m[1]); pos = re.lastIndex;
            if (/^\s*$/.test(s.slice(pos))) break;
        }
        let i = 0;
        const info = { vars: [], offset: false, label: false };
        const self = this;
        function prim() {
            const t = toks[i++];
            if (t === undefined) throw new Error('unexpected end');
            if (t === '(') { const v = add(); if (toks[i++] !== ')') throw new Error('missing )'); return v; }
            if (t === '-') return -prim();
            if (t === '+') return prim();
            if (t[0] === "'" || t[0] === '"') {
                const body = t.slice(1, -1);
                let v = 0; for (const ch of body) v = v * 256 + ch.charCodeAt(0);
                return v;
            }
            const n = parseNumber(t);
            if (n !== null) return n;
            const up = t.toUpperCase();
            if (up === '$') return loc;
            if (up === 'OFFSET') { info.offset = true; return prim(); }
            if (up === 'SEG') { return prim(); }
            if (up === '@DATA' || up === '@CODE') { return self.segValue(up === '@DATA' ? 'data' : 'code'); }
            const sy = self.sym.get(up);
            if (!sy) { if (allowUndef) return 0; throw new Error(`undefined symbol: ${t}`); }
            if (sy.kind === 'var') info.vars.push(sy);
            if (sy.kind === 'label') info.label = true;
            return sy.value;
        }
        function mul() {
            let v = prim();
            while (toks[i] === '*' || toks[i] === '/' || toks[i] === '%' || /^(mod)$/i.test(toks[i] || '')) {
                const op = toks[i++]; const r = prim();
                v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r;
            }
            return v;
        }
        function add() {
            let v = mul();
            while (toks[i] === '+' || toks[i] === '-') { const op = toks[i++]; const r = mul(); v = op === '+' ? v + r : v - r; }
            return v;
        }
        try {
            const v = add();
            if (i < toks.length) throw new Error(`unexpected: ${toks[i]}`);
            return Object.assign(info, { v });
        } catch (e) {
            this.err(line, e.message);
            return Object.assign(info, { v: 0 });
        }
    }

    segValue(kind) {
        return kind === 'data' ? this.dataSeg : this.codeSeg;
    }

    // ------------------------------------------------------------------ pass 1 : bố cục
    assemble() {
        // ---- đọc dòng → câu lệnh
        const items = [];
        for (let n = 0; n < this.src.length; n++) {
            let line = stripComment(this.src[n]).trim();
            if (!line) continue;
            const ln = n + 1;
            // nhãn
            let m;
            while ((m = /^([A-Za-z_@$?.][\w@$?.]*)\s*:(?!:)\s*(.*)$/.exec(line)) && !SREG.includes(m[1].toUpperCase())) {
                items.push({ type: 'label', name: m[1], line: ln });
                line = m[2].trim();
            }
            if (!line) continue;
            items.push(this.parseStatement(line, ln));
        }
        if (this.errors.length) throw new AsmError(this.errors);

        // ---- xác định chế độ
        const hasModel = items.some((s) => s.type === 'dir' && s.name === '.MODEL');
        const hasSegment = items.some((s) => s.type === 'seg');
        this.mode = hasModel ? 'exe-model' : hasSegment ? 'exe-seg' : 'com';
        for (const s of items) if (s.type === 'dir' && s.name === '.STACK') {
            const e = s.arg ? this.evalExpr(s.arg, s.line, 0, true).v : 0x400; this.stackSize = e || 0x400;
        }

        // ---- gán segment
        this.PSP = 0x0700;
        // pass 1: chỉ cần kích thước → tính offset theo từng section
        const loc = { data: 0, code: 0 };
        let section = this.mode === 'com' ? 'com' : 'data';
        let comLoc = 0x100;
        this.dataSize = 0;
        const dataItems = [];
        let segName = null; const segKinds = new Map();
        let currentSegName = null;
        let curSegIsStack = false;
        let instrIndex = 0;

        for (const s of items) {
            s.section = section;
            if (s.type === 'dir') {
                if (s.name === '.DATA') section = 'data';
                else if (s.name === '.CODE') section = 'code';
                else if (s.name === '.STACK') section = 'stack';
                else if (s.name === 'ORG' && this.mode === 'com') { comLoc = this.evalExpr(s.arg, s.line, comLoc, true).v; this.org = comLoc; }
                else if (s.name === '.STARTUP' || s.name === '.EXIT') { instrIndex += 2; }
                s.section = section;
                continue;
            }
            if (s.type === 'seg') {
                if (s.end) { section = 'none'; currentSegName = null; continue; }
                currentSegName = s.name.toUpperCase();
                curSegIsStack = /stack/i.test(s.combine || '') || /stack/i.test(s.name);
                section = curSegIsStack ? 'stack' : 'data';
                segKinds.set(currentSegName, section);
                s.segSection = section;
                loc[section] = 0;
                continue;
            }
            // lệnh đầu tiên trong "segment" kiểu cũ → đó là code
            if (this.mode === 'exe-seg' && s.type === 'instr' && section === 'data') {
                section = 'code'; if (currentSegName) segKinds.set(currentSegName, 'code');
                s.section = section;
            }
            if (this.mode === 'exe-seg' && s.type === 'label' && section === 'data') {
                // nhãn đầu segment code (vd start:) – chưa biết; xét lại sau: nhìn tiếp mục kế
            }
            const L = this.mode === 'com' ? 'com' : section;
            const getLoc = () => (L === 'com' ? comLoc : loc[L] || 0);
            const setLoc = (v) => { if (L === 'com') comLoc = v; else loc[L] = v; };
            s.loc = getLoc();
            if (s.type === 'label') {
                // nhãn code → chỉ số lệnh kế tiếp; nhãn trong data → offset
                this.defineSym(s, 'label', instrIndex, s.name);
                s.isCodeLabel = true; s._pendingSection = section;
            } else if (s.type === 'equ') {
                const e = this.evalExpr(s.expr, s.line, s.loc, true);
                this.defineSym(s, 'const', e.v, s.name);
            } else if (s.type === 'proc') {
                this.defineSym(s, 'label', instrIndex, s.name);
            } else if (s.type === 'data') {
                const size = this.dataSize1(s);
                if (s.name) this.defineSym(s, 'var', s.loc, s.name, s.unit);
                setLoc(s.loc + size);
                if (L === 'data' || L === 'com' || L === 'code') s.bytes = size;
                if (L === 'data') this.dataSize = Math.max(this.dataSize, loc.data);
            } else if (s.type === 'instr') {
                if (L === 'com') comLoc += 3; else loc[L] = (loc[L] || 0) + 3;
                s.index = instrIndex++;
            }
        }
        // nhãn: chỉnh lại các nhãn mà chỉ số lệnh chưa đúng (nhãn khai báo trước lệnh)
        // → ta tính lại: nhãn nhận chỉ số lệnh KẾ TIẾP (đã đúng vì instrIndex tăng dần).
        if (this.errors.length) throw new AsmError(this.errors);

        // ---- segment values
        const dsize = this.mode === 'com' ? 0 : Math.ceil((this.dataSize + 1) / 16);
        const exeBase = this.PSP + 0x10;
        this.dataSeg = this.mode === 'com' ? this.PSP : exeBase;
        this.codeSeg = this.mode === 'com' ? this.PSP : exeBase + dsize;
        this.stackSeg = this.mode === 'com' ? this.PSP : this.codeSeg + Math.ceil((instrIndex * 3 + 16) / 16);
        // tên segment (kiểu cũ) → giá trị
        for (const [nm, kind] of segKinds) {
            this.sym.set(nm, { kind: 'seg', value: kind === 'data' ? this.dataSeg : kind === 'stack' ? this.stackSeg : this.codeSeg });
        }
        if (this.mode === 'exe-seg') { // data nằm trong mọi segment không-code; var offsets giữ nguyên
        }

        // ---- pass 2: phát sinh
        const dataSegBase = (this.dataSeg << 4);
        let startIndex = 0, entryLabel = null;
        for (const s of items) {
            if (s.type === 'dir' && s.name === 'END' && s.arg) entryLabel = s.arg.trim();
            if (s.type === 'dir' && s.name === '.STARTUP') {
                this.code.push({ m: 'MOV', ops: [{ t: 'reg', n: 'AX', size: 16 }, { t: 'imm', v: this.dataSeg }], size: 16, line: s.line, synthetic: true });
                this.code.push({ m: 'MOV', ops: [{ t: 'sreg', n: 'DS' }, { t: 'reg', n: 'AX', size: 16 }], size: 16, line: s.line, synthetic: true });
                continue;
            }
            if (s.type === 'dir' && s.name === '.EXIT') {
                this.code.push({ m: 'MOV', ops: [{ t: 'reg', n: 'AH', size: 8 }, { t: 'imm', v: 0x4c }], size: 8, line: s.line });
                this.code.push({ m: 'INT', ops: [{ t: 'imm', v: 0x21 }], size: 8, line: s.line });
                continue;
            }
            if (s.type === 'data') {
                const base = (this.mode === 'com' ? this.PSP << 4 : dataSegBase) + s.loc;
                this.emitData(s, base);
            } else if (s.type === 'instr') {
                const ins = this.buildInstr(s);
                if (ins) this.code.push(ins);
            }
        }
        // .STARTUP / chỉ số lệnh bị lệch do chèn thêm → đã tính ở pass 1 chưa tính .STARTUP/.EXIT.
        // Để chính xác, tính lại chỉ số nhãn bằng cách đếm theo thứ tự thực tế:
        if (entryLabel) {
            const sy = this.sym.get(entryLabel.toUpperCase());
            if (sy && sy.kind === 'label') startIndex = sy.value;
        }
        if (this.errors.length) throw new AsmError(this.errors);
        return {
            code: this.code, mem: this.mem, mode: this.mode, start: startIndex,
            dataSeg: this.dataSeg, codeSeg: this.codeSeg, stackSeg: this.stackSeg,
            stackSize: this.stackSize, psp: this.PSP, symbols: this.sym
        };
    }

    defineSym(s, kind, value, name, size) {
        const up = name.toUpperCase();
        const exist = this.sym.get(up);
        if (exist && exist.kind !== 'label' && exist.kind !== 'seg') { this.err(s.line, `duplicate declaration of ${name}`); return; }
        if (exist && exist.defined && kind === 'label' && s.type === 'label') { this.err(s.line, `duplicate label ${name}`); return; }
        this.sym.set(up, { kind, value, size: size || 0, defined: true, name });
    }

    // ------------------------------------------------------------------ phân tích câu lệnh
    parseStatement(line, ln) {
        let m;
        // .MODEL / .STACK / .DATA / .CODE / .STARTUP / .EXIT
        if ((m = /^(\.[A-Za-z]+)\s*(.*)$/.exec(line))) {
            return { type: 'dir', name: m[1].toUpperCase(), arg: m[2].trim(), line: ln };
        }
        if ((m = /^(ORG|END|ASSUME|PAGE|TITLE|NAME)\b\s*(.*)$/i.exec(line))) {
            return { type: 'dir', name: m[1].toUpperCase(), arg: m[2].trim(), line: ln };
        }
        // name SEGMENT / name ENDS / name PROC / name ENDP / name EQU / name = / name DB..
        if ((m = /^([A-Za-z_@$?.][\w@$?.]*)\s+(SEGMENT)\b\s*(.*)$/i.exec(line))) return { type: 'seg', name: m[1], combine: m[3], line: ln };
        if ((m = /^([A-Za-z_@$?.][\w@$?.]*)\s+(ENDS)\b/i.exec(line))) return { type: 'seg', name: m[1], end: true, line: ln };
        if ((m = /^([A-Za-z_@$?.][\w@$?.]*)\s+PROC\b/i.exec(line))) return { type: 'proc', name: m[1], line: ln };
        if ((m = /^([A-Za-z_@$?.][\w@$?.]*)\s+ENDP\b/i.exec(line))) return { type: 'endp', line: ln };
        if ((m = /^([A-Za-z_@$?.][\w@$?.]*)\s+(?:EQU|=)\s*(.+)$/i.exec(line))) return { type: 'equ', name: m[1], expr: m[2], line: ln };
        if ((m = /^([A-Za-z_@$?.][\w@$?.]*)\s*=\s*(.+)$/.exec(line))) return { type: 'equ', name: m[1], expr: m[2], line: ln };
        if ((m = /^(?:([A-Za-z_@$?.][\w@$?.]*)\s+)?(DB|DW|DD|DQ|DT)\b\s*(.*)$/i.exec(line)) && !MNEMONICS.has((m[1] || '').toUpperCase())) {
            const unit = { DB: 1, DW: 2, DD: 4, DQ: 8, DT: 10 }[m[2].toUpperCase()];
            return { type: 'data', name: m[1] || null, unit, list: splitTop(m[3]), line: ln };
        }
        // lệnh (có thể có tiền tố REP)
        let prefix = '';
        let rest = line;
        const pm = /^([A-Za-z]+)\s+(.*)$/.exec(rest);
        if (pm && PREFIXES.has(pm[1].toUpperCase())) { prefix = pm[1].toUpperCase(); rest = pm[2]; }
        const im = /^([A-Za-z]+)\b\s*(.*)$/.exec(rest);
        if (!im) { this.err(ln, `syntax error: ${line}`); return { type: 'none', line: ln }; }
        const mn = im[1].toUpperCase();
        if (!MNEMONICS.has(mn)) { this.err(ln, `unknown opcode or directive: ${im[1]}`); return { type: 'none', line: ln }; }
        const args = im[2].trim() === '' ? [] : splitTop(im[2]);
        return { type: 'instr', m: mn, rawOps: args, prefix, line: ln };
    }

    dataSize1(s) {
        let total = 0;
        const sizeOfList = (list) => {
            let t = 0;
            for (const it of list) {
                if (it === '') continue;
                let m;
                if ((m = /^(.+?)\s+DUP\s*\((.*)\)\s*$/i.exec(it))) {
                    const cnt = this.evalExpr(m[1], s.line, 0, true).v;
                    t += cnt * sizeOfList(splitTop(m[2]));
                } else if (/^(['"]).*\1$/.test(it) && it.length > 3) {
                    t += (it.length - 2) * s.unit;
                } else t += s.unit;
            }
            return t;
        };
        total = sizeOfList(s.list);
        return total;
    }

    emitData(s, base) {
        let addr = base;
        const put = (val, unit) => {
            let v = val;
            for (let i = 0; i < unit; i++) { this.mem.set(addr++ & 0xfffff, v & 0xff); v = Math.floor(v / 256); }
        };
        const emitList = (list) => {
            for (const it of list) {
                if (it === '') continue;
                let m;
                if ((m = /^(.+?)\s+DUP\s*\((.*)\)\s*$/i.exec(it))) {
                    const cnt = this.evalExpr(m[1], s.line, 0).v;
                    const inner = splitTop(m[2]);
                    for (let k = 0; k < cnt; k++) emitList(inner);
                } else if (it === '?') { put(0, s.unit); }
                else if (/^(['"]).*\1$/.test(it) && it.length > 3) {
                    for (const ch of it.slice(1, -1)) put(ch.charCodeAt(0), s.unit);
                } else {
                    const e = this.evalExpr(it, s.line, s.loc);
                    put(e.v, s.unit);
                }
            }
        };
        emitList(s.list);
    }

    // ------------------------------------------------------------------ toán hạng
    parseOperand(raw, line, hintSize, quiet) {
        let t = raw.trim();
        let size = 0;
        let m;
        if ((m = /^(BYTE|WORD|DWORD)\s+PTR\s+(.+)$/i.exec(t))) { size = m[1].toUpperCase() === 'BYTE' ? 8 : m[1].toUpperCase() === 'WORD' ? 16 : 32; t = m[2].trim(); }
        else if ((m = /^(BYTE|WORD)\s+(.+)$/i.exec(t))) { size = m[1].toUpperCase() === 'BYTE' ? 8 : 16; t = m[2].trim(); }
        const up = t.toUpperCase();
        if (R8.includes(up)) return { t: 'reg', n: up, size: 8 };
        if (R16.includes(up)) return { t: 'reg', n: up, size: 16 };
        if (SREG.includes(up)) return { t: 'sreg', n: up, size: 16 };
        // bộ nhớ
        let seg = null;
        if ((m = /^(ES|CS|SS|DS)\s*:\s*(.+)$/i.exec(t))) { seg = m[1].toUpperCase(); t = m[2].trim(); }
        if (t.includes('[')) {
            // gộp [bx][si] → [bx+si]
            let body = '', pre = '';
            const bi = t.indexOf('[');
            pre = t.slice(0, bi).trim();
            body = t.slice(bi).replace(/\]\s*\[/g, '+').replace(/^\[/, '').replace(/\]$/, '');
            const mem = { t: 'mem', seg, base: null, index: null, disp: 0, size, varSize: 0 };
            const terms = body.replace(/\s+/g, '').replace(/-/g, '+-').split('+').filter(Boolean);
            const dispTerms = [];
            if (pre) dispTerms.push(pre);
            for (const term of terms) {
                const tu = term.toUpperCase();
                if (tu === 'BX' || tu === 'BP') mem.base = tu;
                else if (tu === 'SI' || tu === 'DI') mem.index = tu;
                else dispTerms.push(term);
            }
            if (dispTerms.length) {
                const e = this.evalExpr(dispTerms.join('+').replace(/\+-/g, '-'), line, 0, quiet);
                mem.disp = e.v;
                if (e.vars.length && !mem.size) mem.varSize = e.vars[0].size * 8;
            }
            if (!mem.size && mem.varSize) mem.size = mem.varSize;
            return mem;
        }
        // số / ký hiệu
        const e = this.evalExpr(t, line, 0, quiet);
        if (e.vars.length && !e.offset) {
            // biến nhớ truy cập trực tiếp
            const mem = { t: 'mem', seg, base: null, index: null, disp: e.v, size: size || e.vars[0].size * 8, varSize: e.vars[0].size * 8 };
            return mem;
        }
        return { t: 'imm', v: e.v, label: e.label, size };
    }

    buildInstr(s) {
        const ins = { m: s.m, rawOps: s.rawOps, prefix: s.prefix, line: s.line, index: s.index, ops: [] };
        ins.ops = s.rawOps.map((r) => this.parseOperand(r, s.line, 0, false));
        this.finalizeInstr(ins);
        return ins;
    }

    // kiểm tra tham số & xác định kích thước thao tác
    finalizeInstr(ins) {
        const o = ins.ops; const m = ins.m; const ln = ins.line;
        const bad = () => this.err(ln, `wrong parameters: ${m} ${ins.rawOps.join(',')}`);
        const sizeOf = (op) => (op.t === 'reg' || op.t === 'sreg' ? op.size : op.t === 'mem' ? op.size : 0);
        const n = o.length;
        const two = ['MOV', 'XCHG', 'ADD', 'ADC', 'SUB', 'SBB', 'CMP', 'AND', 'OR', 'XOR', 'TEST'];
        const shifts = ['SHL', 'SAL', 'SHR', 'SAR', 'ROL', 'ROR', 'RCL', 'RCR'];
        const one = ['INC', 'DEC', 'NEG', 'NOT', 'MUL', 'IMUL', 'DIV', 'IDIV'];
        if (two.includes(m)) {
            if (n !== 2) return bad();
            if (o[0].t === 'imm') return bad();
            if (o[0].t === 'mem' && o[1].t === 'mem') return bad();
            let sz = sizeOf(o[0]) || sizeOf(o[1]);
            if (o[0].t === 'sreg' && m !== 'MOV') return bad();
            if (!sz) { this.err(ln, `operand size not specified (use BYTE PTR / WORD PTR): ${m} ${ins.rawOps.join(',')}`); return; }
            const s0 = sizeOf(o[0]), s1 = sizeOf(o[1]);
            if (s0 && s1 && s0 !== s1) return bad();
            if (o[1].t === 'imm' && sz === 8 && (o[1].v > 255 || o[1].v < -128)) { this.err(ln, `value out of range for byte: ${o[1].v}`); return; }
            ins.size = sz;
            if (o[0].t === 'mem' && !o[0].size) o[0].size = sz;
            if (o[1].t === 'mem' && !o[1].size) o[1].size = sz;
        } else if (one.includes(m)) {
            if (n !== 1 || o[0].t === 'imm' || o[0].t === 'sreg') return bad();
            const sz = sizeOf(o[0]);
            if (!sz) { this.err(ln, `operand size not specified: ${m} ${ins.rawOps.join(',')}`); return; }
            ins.size = sz;
        } else if (shifts.includes(m)) {
            if (n !== 2 || o[0].t === 'imm') return bad();
            const sz = sizeOf(o[0]);
            if (!sz) { this.err(ln, `operand size not specified: ${m}`); return; }
            if (!(o[1].t === 'imm' || (o[1].t === 'reg' && o[1].n === 'CL'))) return bad();
            ins.size = sz;
        } else if (m === 'PUSH' || m === 'POP') {
            if (n !== 1 || o[0].t === 'imm' && m === 'POP') return bad();
            if (o[0].t === 'reg' && o[0].size !== 16) return bad();
            ins.size = 16;
            if (o[0].t === 'mem') o[0].size = 16;
        } else if (m === 'LEA' || m === 'LDS' || m === 'LES') {
            if (n !== 2 || o[0].t !== 'reg' || o[0].size !== 16 || o[1].t !== 'mem') return bad();
            ins.size = 16;
        } else if (m === 'INT') {
            if (n !== 1 || o[0].t !== 'imm') return bad();
        } else if (m === 'JMP' || m === 'CALL' || JCC.includes(m) || m === 'LOOP' || m === 'LOOPE' || m === 'LOOPZ' || m === 'LOOPNE' || m === 'LOOPNZ' || m === 'JCXZ') {
            if (n !== 1) return bad();
            ins.size = 16;
            if (o[0].t === 'mem' && !o[0].size) o[0].size = 16;
        } else if (m === 'RET' || m === 'RETN' || m === 'RETF') {
            if (n > 1) return bad();
        } else if (m === 'IN' || m === 'OUT') {
            if (n !== 2) return bad();
        } else if (m === 'AAM' || m === 'AAD') {
            // tuỳ chọn 1 tham số
        } else if (n !== 0) {
            return bad();
        }
        ins.pendingSize = ins.size;
    }
}

function assemble(source) {
    const a = new Assembler(source);
    return a.assemble();
}

module.exports = { assemble, AsmError, R8, R16, SREG };
