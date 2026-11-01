// services/emu8086/machine.js
// CPU 8086 + bộ nhớ 1MB + màn hình văn bản 80x25 + ngắt DOS/BIOS cơ bản.
// Khi chương trình cần nhập (INT 21h/01,07,08,0A; INT 16h/00) mà chưa có dữ liệu
// → máy chuyển sang trạng thái 'waiting' để giao diện hiện ô nhập.
'use strict';
const { assemble, AsmError, R8, R16 } = require('./assembler');

const WAIT = Symbol('wait');
const MASK = { 8: 0xff, 16: 0xffff };
const SIGN = { 8: 0x80, 16: 0x8000 };

class Screen {
    constructor() { this.cols = 80; this.rows = 25; this.clear(); this.raw = ''; }
    clear() {
        this.buf = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
        this.r = 0; this.c = 0;
    }
    write(code) {
        const ch = String.fromCharCode(code & 0xff);
        this.raw += ch;
        if (this.raw.length > 400000) this.raw = this.raw.slice(-300000);
        if (code === 13) { this.c = 0; return; }
        if (code === 10) { this.nl(); return; }
        if (code === 8) { if (this.c > 0) this.c--; return; }
        if (code === 7) return;
        this.buf[this.r][this.c] = ch;
        this.c++;
        if (this.c >= this.cols) { this.c = 0; this.nl(); }
    }
    nl() {
        this.r++;
        if (this.r >= this.rows) { this.buf.shift(); this.buf.push(Array(this.cols).fill(' ')); this.r = this.rows - 1; }
    }
    lines() {
        const out = this.buf.map((l) => l.join('').replace(/\s+$/, ''));
        while (out.length && out[out.length - 1] === '') out.pop();
        return out;
    }
}

class Machine {
    constructor(source, opts = {}) {
        const prog = assemble(source);
        this.prog = prog;
        this.code = prog.code;
        this.mem = new Uint8Array(0x100000);
        for (const [a, v] of prog.mem) this.mem[a] = v;
        this.screen = new Screen();
        this.inq = [];               // hàng đợi ký tự nhập (mã byte)
        this.inputLog = [];          // lịch sử đã nhập
        this.waiting = null;         // {mode:'char'|'line'}
        this.status = 'running';     // running | waiting | halted | error
        this.error = null;
        this.steps = 0;
        this.maxTotalSteps = opts.maxTotalSteps || 20000000;
        this.r = { AX: 0, BX: 0, CX: 0, DX: 0, SP: 0, BP: 0, SI: 0, DI: 0 };
        this.s = { ES: prog.psp, CS: prog.codeSeg, SS: prog.stackSeg, DS: prog.psp };
        this.f = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, TF: 0, IF: 1, DF: 0, OF: 0 };
        this.ip = prog.start;
        if (prog.mode === 'com') { this.r.SP = 0xfffe; } else { this.r.SP = (prog.stackSize - 2) & 0xffff; }
        this.write16(this.phys('SS', this.r.SP), 0xffff); // địa chỉ trả về giả → kết thúc chương trình
        if (prog.mode === 'com') { this.s.DS = this.s.ES = this.s.SS = prog.psp; }
        this.exitCode = null;
    }

    // ------------------------------------------------------------------ bộ nhớ
    phys(seg, off) { return (((typeof seg === 'string' ? this.s[seg] : seg) << 4) + (off & 0xffff)) & 0xfffff; }
    read8(a) { return this.mem[a & 0xfffff]; }
    read16(a) { return this.mem[a & 0xfffff] | (this.mem[(a + 1) & 0xfffff] << 8); }
    write8(a, v) { this.mem[a & 0xfffff] = v & 0xff; }
    write16(a, v) { this.mem[a & 0xfffff] = v & 0xff; this.mem[(a + 1) & 0xfffff] = (v >> 8) & 0xff; }

    // ------------------------------------------------------------------ thanh ghi
    getReg(n) {
        if (n.length === 2 && n[1] === 'X' || R16.includes(n)) return this.r[n];
        const i = R8.indexOf(n);
        const base = ['AX', 'CX', 'DX', 'BX'][i & 3];
        return i < 4 ? this.r[base] & 0xff : (this.r[base] >> 8) & 0xff;
    }
    setReg(n, v) {
        if (R16.includes(n)) { this.r[n] = v & 0xffff; return; }
        const i = R8.indexOf(n);
        const base = ['AX', 'CX', 'DX', 'BX'][i & 3];
        if (i < 4) this.r[base] = (this.r[base] & 0xff00) | (v & 0xff);
        else this.r[base] = (this.r[base] & 0x00ff) | ((v & 0xff) << 8);
    }
    ea(op) {
        let a = op.disp || 0;
        if (op.base) a += this.r[op.base];
        if (op.index) a += this.r[op.index];
        return a & 0xffff;
    }
    memAddr(op) {
        const seg = op.seg || (op.base === 'BP' ? 'SS' : 'DS');
        return this.phys(seg, this.ea(op));
    }
    get(op, size) {
        switch (op.t) {
            case 'reg': return this.getReg(op.n);
            case 'sreg': return this.s[op.n];
            case 'imm': return op.v & MASK[size];
            case 'mem': { const a = this.memAddr(op); return size === 8 ? this.read8(a) : this.read16(a); }
        }
        throw new Error('bad operand');
    }
    set(op, size, v) {
        switch (op.t) {
            case 'reg': this.setReg(op.n, v); return;
            case 'sreg': this.s[op.n] = v & 0xffff; return;
            case 'mem': { const a = this.memAddr(op); if (size === 8) this.write8(a, v); else this.write16(a, v); return; }
        }
        throw new Error('bad destination');
    }
    push(v) { this.r.SP = (this.r.SP - 2) & 0xffff; this.write16(this.phys('SS', this.r.SP), v); }
    pop() { const v = this.read16(this.phys('SS', this.r.SP)); this.r.SP = (this.r.SP + 2) & 0xffff; return v; }

    // ------------------------------------------------------------------ cờ
    static parity(v) { let p = 0; for (let x = v & 0xff; x; x >>= 1) p ^= x & 1; return p ? 0 : 1; }
    setSZP(res, size) {
        const m = MASK[size]; res &= m;
        this.f.ZF = res === 0 ? 1 : 0; this.f.SF = res & SIGN[size] ? 1 : 0; this.f.PF = Machine.parity(res);
    }
    flagsWord() {
        const f = this.f;
        return f.CF | 2 | (f.PF << 2) | (f.AF << 4) | (f.ZF << 6) | (f.SF << 7) | (f.TF << 8) | (f.IF << 9) | (f.DF << 10) | (f.OF << 11);
    }
    setFlagsWord(w) {
        const f = this.f;
        f.CF = w & 1; f.PF = (w >> 2) & 1; f.AF = (w >> 4) & 1; f.ZF = (w >> 6) & 1; f.SF = (w >> 7) & 1;
        f.TF = (w >> 8) & 1; f.IF = (w >> 9) & 1; f.DF = (w >> 10) & 1; f.OF = (w >> 11) & 1;
    }
    static sx(v, size) { return v & SIGN[size] ? v - (MASK[size] + 1) : v; }

    alu(op, a, b, size) {
        const m = MASK[size], f = this.f;
        let res;
        switch (op) {
            case 'ADD': case 'ADC': {
                const c = op === 'ADC' ? f.CF : 0;
                const full = a + b + c; res = full & m;
                f.CF = full > m ? 1 : 0;
                f.AF = ((a & 0xf) + (b & 0xf) + c) > 0xf ? 1 : 0;
                f.OF = (~(a ^ b) & (a ^ res) & SIGN[size]) ? 1 : 0;
                break;
            }
            case 'SUB': case 'SBB': case 'CMP': {
                const c = op === 'SBB' ? f.CF : 0;
                const full = a - b - c; res = full & m;
                f.CF = full < 0 ? 1 : 0;
                f.AF = ((a & 0xf) - (b & 0xf) - c) < 0 ? 1 : 0;
                f.OF = ((a ^ b) & (a ^ res) & SIGN[size]) ? 1 : 0;
                break;
            }
            case 'AND': case 'TEST': res = a & b; f.CF = 0; f.OF = 0; f.AF = 0; break;
            case 'OR': res = a | b; f.CF = 0; f.OF = 0; f.AF = 0; break;
            case 'XOR': res = a ^ b; f.CF = 0; f.OF = 0; f.AF = 0; break;
        }
        res &= m; this.setSZP(res, size);
        return res;
    }

    cond(m) {
        const f = this.f;
        switch (m) {
            case 'JA': case 'JNBE': return !f.CF && !f.ZF;
            case 'JAE': case 'JNB': case 'JNC': return !f.CF;
            case 'JB': case 'JNAE': case 'JC': return !!f.CF;
            case 'JBE': case 'JNA': return !!(f.CF || f.ZF);
            case 'JE': case 'JZ': return !!f.ZF;
            case 'JNE': case 'JNZ': return !f.ZF;
            case 'JG': case 'JNLE': return !f.ZF && f.SF === f.OF;
            case 'JGE': case 'JNL': return f.SF === f.OF;
            case 'JL': case 'JNGE': return f.SF !== f.OF;
            case 'JLE': case 'JNG': return !!f.ZF || f.SF !== f.OF;
            case 'JO': return !!f.OF; case 'JNO': return !f.OF;
            case 'JP': case 'JPE': return !!f.PF; case 'JNP': case 'JPO': return !f.PF;
            case 'JS': return !!f.SF; case 'JNS': return !f.SF;
        }
        return false;
    }

    fault(msg) { this.status = 'error'; this.error = msg; }

    // ------------------------------------------------------------------ nhập
    feed(text) {
        const s = String(text);
        for (const ch of s) this.inq.push(ch.charCodeAt(0) & 0xff);
        this.inputLog.push(s.replace(/\r/g, ''));
        if (this.status === 'waiting') { this.status = 'running'; this.waiting = null; }
    }
    // lấy 1 ký tự; trả null nếu chưa có
    takeChar() { return this.inq.length ? this.inq.shift() : null; }

    // ------------------------------------------------------------------ thực thi
    run(budget = 200000) {
        if (this.status === 'halted' || this.status === 'error') return this.status;
        if (this.status === 'waiting') return 'waiting';
        let n = 0;
        while (n < budget) {
            if (this.ip === 0xffff || this.ip >= this.code.length || this.ip < 0) { this.status = 'halted'; break; }
            const ins = this.code[this.ip];
            const cur = this.ip;
            this.ip = cur + 1;
            let r;
            try { r = this.exec(ins); }
            catch (e) { this.fault(`Dòng ${ins.line}: ${e.message}`); break; }
            if (r === WAIT) { this.ip = cur; this.status = 'waiting'; break; }
            if (this.status === 'halted' || this.status === 'error') break;
            n++; this.steps++;
            if (this.steps > this.maxTotalSteps) { this.fault(`Dòng ${ins.line}: Vượt giới hạn ${this.maxTotalSteps.toLocaleString('en-US')} lệnh (nghi vòng lặp vô hạn)`); break; }
        }
        return this.status;
    }

    target(op) {
        if (op.t === 'imm') return op.v;
        return this.get(op, 16);
    }

    exec(ins) {
        const o = ins.ops, sz = ins.size, m = ins.m;
        switch (m) {
            case 'MOV': this.set(o[0], sz, this.get(o[1], sz)); return;
            case 'XCHG': { const a = this.get(o[0], sz), b = this.get(o[1], sz); this.set(o[0], sz, b); this.set(o[1], sz, a); return; }
            case 'PUSH': this.push(this.get(o[0], 16)); return;
            case 'POP': this.set(o[0], 16, this.pop()); return;
            case 'PUSHF': this.push(this.flagsWord()); return;
            case 'POPF': this.setFlagsWord(this.pop()); return;
            case 'LEA': this.set(o[0], 16, this.ea(o[1])); return;
            case 'LDS': case 'LES': {
                const a = this.memAddr(o[1]); this.set(o[0], 16, this.read16(a)); this.s[m === 'LDS' ? 'DS' : 'ES'] = this.read16(a + 2); return;
            }
            case 'XLAT': case 'XLATB': this.setReg('AL', this.read8(this.phys('DS', this.r.BX + this.getReg('AL')))); return;
            case 'LAHF': this.setReg('AH', this.flagsWord() & 0xff); return;
            case 'SAHF': { const w = (this.flagsWord() & 0xff00) | this.getReg('AH'); this.setFlagsWord(w); return; }
            case 'ADD': case 'ADC': case 'SUB': case 'SBB': case 'AND': case 'OR': case 'XOR': {
                const res = this.alu(m, this.get(o[0], sz), this.get(o[1], sz), sz); this.set(o[0], sz, res); return;
            }
            case 'CMP': case 'TEST': this.alu(m, this.get(o[0], sz), this.get(o[1], sz), sz); return;
            case 'INC': case 'DEC': {
                const cf = this.f.CF; const a = this.get(o[0], sz);
                const res = this.alu(m === 'INC' ? 'ADD' : 'SUB', a, 1, sz); this.f.CF = cf; this.set(o[0], sz, res); return;
            }
            case 'NEG': { const a = this.get(o[0], sz); const res = this.alu('SUB', 0, a, sz); this.f.CF = a !== 0 ? 1 : 0; this.set(o[0], sz, res); return; }
            case 'NOT': this.set(o[0], sz, ~this.get(o[0], sz) & MASK[sz]); return;
            case 'MUL': case 'IMUL': return this.mul(m === 'IMUL', o[0], sz);
            case 'DIV': case 'IDIV': return this.div(m === 'IDIV', o[0], sz);
            case 'CBW': this.r.AX = ((this.getReg('AL') & 0x80) ? 0xff00 : 0) | this.getReg('AL'); return;
            case 'CWD': this.r.DX = (this.r.AX & 0x8000) ? 0xffff : 0; return;
            case 'SHL': case 'SAL': case 'SHR': case 'SAR': case 'ROL': case 'ROR': case 'RCL': case 'RCR':
                return this.shift(m, o[0], o[1], sz);
            case 'JMP': this.ip = this.target(o[0]); return;
            case 'CALL': this.push(this.ip); this.ip = this.target(o[0]); return;
            case 'RET': case 'RETN': case 'RETF': {
                this.ip = this.pop();
                if (o[0]) this.r.SP = (this.r.SP + o[0].v) & 0xffff;
                return;
            }
            case 'LOOP': this.r.CX = (this.r.CX - 1) & 0xffff; if (this.r.CX) this.ip = this.target(o[0]); return;
            case 'LOOPE': case 'LOOPZ': this.r.CX = (this.r.CX - 1) & 0xffff; if (this.r.CX && this.f.ZF) this.ip = this.target(o[0]); return;
            case 'LOOPNE': case 'LOOPNZ': this.r.CX = (this.r.CX - 1) & 0xffff; if (this.r.CX && !this.f.ZF) this.ip = this.target(o[0]); return;
            case 'JCXZ': if (this.r.CX === 0) this.ip = this.target(o[0]); return;
            case 'INT': return this.interrupt(o[0].v & 0xff, ins);
            case 'INTO': if (this.f.OF) this.fault('INTO: tràn số'); return;
            case 'IRET': this.ip = this.pop(); this.pop(); this.setFlagsWord(this.pop()); return;
            case 'MOVSB': case 'MOVSW': case 'STOSB': case 'STOSW': case 'LODSB': case 'LODSW': case 'SCASB': case 'SCASW': case 'CMPSB': case 'CMPSW':
                return this.str(m, ins.prefix);
            case 'CLC': this.f.CF = 0; return; case 'STC': this.f.CF = 1; return; case 'CMC': this.f.CF ^= 1; return;
            case 'CLD': this.f.DF = 0; return; case 'STD': this.f.DF = 1; return;
            case 'CLI': this.f.IF = 0; return; case 'STI': this.f.IF = 1; return;
            case 'NOP': case 'WAIT': case 'IN': case 'OUT': return;
            case 'HLT': this.status = 'halted'; return;
            case 'DAA': case 'DAS': {
                let al = this.getReg('AL'), cf = this.f.CF; const old = al;
                if ((al & 0xf) > 9 || this.f.AF) { al += m === 'DAA' ? 6 : -6; this.f.AF = 1; } else this.f.AF = 0;
                if (old > 0x99 || cf) { al += m === 'DAA' ? 0x60 : -0x60; this.f.CF = 1; } else this.f.CF = 0;
                this.setReg('AL', al); this.setSZP(al & 0xff, 8); return;
            }
            case 'AAA': case 'AAS': {
                let al = this.getReg('AL'), ah = this.getReg('AH');
                if ((al & 0xf) > 9 || this.f.AF) {
                    if (m === 'AAA') { al += 6; ah += 1; } else { al -= 6; ah -= 1; }
                    this.f.AF = 1; this.f.CF = 1;
                } else { this.f.AF = 0; this.f.CF = 0; }
                this.setReg('AL', al & 0xf); this.setReg('AH', ah); return;
            }
            case 'AAM': {
                const base = o[0] ? o[0].v : 10; const al = this.getReg('AL');
                if (!base) throw new Error('Chia cho 0 (AAM)');
                this.setReg('AH', Math.floor(al / base)); this.setReg('AL', al % base); this.setSZP(this.getReg('AL'), 8); return;
            }
            case 'AAD': {
                const base = o[0] ? o[0].v : 10; const v = (this.getReg('AH') * base + this.getReg('AL')) & 0xff;
                this.setReg('AL', v); this.setReg('AH', 0); this.setSZP(v, 8); return;
            }
        }
        if (m[0] === 'J') { if (this.cond(m)) this.ip = this.target(o[0]); return; }
        throw new Error(`Chưa hỗ trợ lệnh ${m}`);
    }

    mul(signed, op, sz) {
        const b = this.get(op, sz);
        if (sz === 8) {
            const a = this.getReg('AL');
            const res = signed ? Machine.sx(a, 8) * Machine.sx(b, 8) : a * b;
            this.r.AX = res & 0xffff;
            const hi = signed ? (res < -128 || res > 127) : (res > 0xff);
            this.f.CF = this.f.OF = hi ? 1 : 0;
        } else {
            const a = this.r.AX;
            const res = signed ? Machine.sx(a, 16) * Machine.sx(b, 16) : a * b;
            const u = ((res % 4294967296) + 4294967296) % 4294967296;
            this.r.AX = u & 0xffff; this.r.DX = Math.floor(u / 65536) & 0xffff;
            const hi = signed ? (res < -32768 || res > 32767) : (res > 0xffff);
            this.f.CF = this.f.OF = hi ? 1 : 0;
        }
    }
    div(signed, op, sz) {
        const b = this.get(op, sz);
        if (b === 0) throw new Error('Lỗi chia cho 0 (Divide error)');
        if (sz === 8) {
            const a = this.r.AX;
            const dv = signed ? Machine.sx(b, 8) : b, dd = signed ? Machine.sx(a, 16) : a;
            const q = Math.trunc(dd / dv), r = dd - q * dv;
            if (signed ? (q > 127 || q < -128) : q > 0xff) throw new Error('Lỗi chia: thương vượt quá 8 bit (Divide overflow)');
            this.setReg('AL', q); this.setReg('AH', r);
        } else {
            const a = this.r.DX * 65536 + this.r.AX;
            const dd = signed ? (a >= 2147483648 ? a - 4294967296 : a) : a;
            const dv = signed ? Machine.sx(b, 16) : b;
            const q = Math.trunc(dd / dv), r = dd - q * dv;
            if (signed ? (q > 32767 || q < -32768) : q > 0xffff) throw new Error('Lỗi chia: thương vượt quá 16 bit (Divide overflow)');
            this.r.AX = q & 0xffff; this.r.DX = r & 0xffff;
        }
    }
    shift(m, dst, cnt, sz) {
        let c = (cnt.t === 'imm' ? cnt.v : this.getReg('CL')) & 0xff;
        if (c === 0) return;
        const bits = sz, mask = MASK[sz], sign = SIGN[sz];
        let v = this.get(dst, sz); const f = this.f;
        const n = Math.min(c, 64);
        for (let i = 0; i < n; i++) {
            switch (m) {
                case 'SHL': case 'SAL': f.CF = (v & sign) ? 1 : 0; v = (v << 1) & mask; f.OF = ((v & sign) ? 1 : 0) ^ f.CF; break;
                case 'SHR': f.CF = v & 1; f.OF = (v & sign) ? 1 : 0; v = v >>> 1; break;
                case 'SAR': f.CF = v & 1; v = (v >>> 1) | (v & sign); f.OF = 0; break;
                case 'ROL': f.CF = (v & sign) ? 1 : 0; v = ((v << 1) | f.CF) & mask; f.OF = ((v & sign) ? 1 : 0) ^ f.CF; break;
                case 'ROR': f.CF = v & 1; v = (v >>> 1) | (f.CF ? sign : 0); f.OF = ((v & sign) ? 1 : 0) ^ ((v & (sign >> 1)) ? 1 : 0); break;
                case 'RCL': { const out = (v & sign) ? 1 : 0; v = ((v << 1) | f.CF) & mask; f.CF = out; f.OF = ((v & sign) ? 1 : 0) ^ f.CF; break; }
                case 'RCR': { const out = v & 1; v = (v >>> 1) | (f.CF ? sign : 0); f.CF = out; f.OF = ((v & sign) ? 1 : 0) ^ ((v & (sign >> 1)) ? 1 : 0); break; }
            }
        }
        if (m === 'SHL' || m === 'SAL' || m === 'SHR' || m === 'SAR') this.setSZP(v, sz);
        this.set(dst, sz, v);
    }
    str(m, prefix) {
        const size = m.endsWith('B') ? 8 : 16; const step = (this.f.DF ? -1 : 1) * (size / 8);
        const once = () => {
            const sa = this.phys('DS', this.r.SI), da = this.phys('ES', this.r.DI);
            switch (m.slice(0, -1)) {
                case 'MOVS': { const v = size === 8 ? this.read8(sa) : this.read16(sa); size === 8 ? this.write8(da, v) : this.write16(da, v); this.r.SI = (this.r.SI + step) & 0xffff; this.r.DI = (this.r.DI + step) & 0xffff; break; }
                case 'STOS': { const v = size === 8 ? this.getReg('AL') : this.r.AX; size === 8 ? this.write8(da, v) : this.write16(da, v); this.r.DI = (this.r.DI + step) & 0xffff; break; }
                case 'LODS': { const v = size === 8 ? this.read8(sa) : this.read16(sa); if (size === 8) this.setReg('AL', v); else this.r.AX = v; this.r.SI = (this.r.SI + step) & 0xffff; break; }
                case 'SCAS': { const v = size === 8 ? this.read8(da) : this.read16(da); this.alu('CMP', size === 8 ? this.getReg('AL') : this.r.AX, v, size); this.r.DI = (this.r.DI + step) & 0xffff; break; }
                case 'CMPS': { const a = size === 8 ? this.read8(sa) : this.read16(sa), b = size === 8 ? this.read8(da) : this.read16(da); this.alu('CMP', a, b, size); this.r.SI = (this.r.SI + step) & 0xffff; this.r.DI = (this.r.DI + step) & 0xffff; break; }
            }
        };
        if (!prefix || prefix === 'LOCK') { once(); return; }
        while (this.r.CX !== 0) {
            once(); this.r.CX = (this.r.CX - 1) & 0xffff;
            const cmp = m.startsWith('SCAS') || m.startsWith('CMPS');
            if (cmp) {
                if ((prefix === 'REPE' || prefix === 'REPZ' || prefix === 'REP') && !this.f.ZF) break;
                if ((prefix === 'REPNE' || prefix === 'REPNZ') && this.f.ZF) break;
            }
        }
    }

    // ------------------------------------------------------------------ ngắt
    interrupt(n) {
        const ah = this.getReg('AH'), al = this.getReg('AL');
        if (n === 0x20) { this.status = 'halted'; return; }
        if (n === 0x21) return this.dos(ah, al);
        if (n === 0x10) return this.bios10(ah, al);
        if (n === 0x16) {
            if (ah === 0x00 || ah === 0x10) {
                const c = this.takeChar(); if (c === null) { this.waiting = { mode: 'char' }; return WAIT; }
                this.r.AX = (c << 8 & 0xff00) | c; return;
            }
            if (ah === 0x01 || ah === 0x11) { this.f.ZF = this.inq.length ? 0 : 1; if (this.inq.length) this.r.AX = (this.inq[0] << 8) | this.inq[0]; return; }
            return;
        }
        if (n === 0x1a) { const d = new Date(); const t = Math.floor((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 18.2065); this.r.CX = (t >>> 16) & 0xffff; this.r.DX = t & 0xffff; this.setReg('AL', 0); return; }
        if (n === 0x11 || n === 0x12 || n === 0x15 || n === 0x33) return;
        throw new Error(`Chưa hỗ trợ ngắt INT ${n.toString(16).toUpperCase()}h`);
    }
    bios10(ah, al) {
        const s = this.screen;
        switch (ah) {
            case 0x00: s.clear(); return;
            case 0x02: s.r = Math.min(24, this.getReg('DH')); s.c = Math.min(79, this.getReg('DL')); return;
            case 0x03: this.setReg('DH', s.r); this.setReg('DL', s.c); this.r.CX = 0x0607; return;
            case 0x06: case 0x07: if (al === 0) { s.clear(); } else { for (let i = 0; i < al; i++) { s.buf.shift(); s.buf.push(Array(s.cols).fill(' ')); } } return;
            case 0x09: case 0x0a: { const cnt = Math.max(1, this.r.CX); for (let i = 0; i < cnt && s.c + i < s.cols; i++) s.buf[s.r][s.c + i] = String.fromCharCode(al); s.raw += String.fromCharCode(al); return; }
            case 0x0e: s.write(al); return;
            case 0x0f: this.setReg('AL', 3); this.setReg('AH', 80); this.setReg('BH', 0); return;
            default: return;
        }
    }
    dos(ah, al) {
        const s = this.screen;
        switch (ah) {
            case 0x00: this.status = 'halted'; return;
            case 0x01: case 0x07: case 0x08: {
                const c = this.takeChar();
                if (c === null) { this.waiting = { mode: 'char' }; return WAIT; }
                this.setReg('AL', c); if (ah === 0x01) s.write(c); return;
            }
            case 0x02: s.write(this.getReg('DL')); this.setReg('AL', this.getReg('DL')); return;
            case 0x06: { const dl = this.getReg('DL'); if (dl !== 0xff) { s.write(dl); } else { const c = this.takeChar(); if (c === null) this.f.ZF = 1; else { this.f.ZF = 0; this.setReg('AL', c); } } return; }
            case 0x09: {
                let a = this.phys('DS', this.r.DX), n = 0;
                while (this.read8(a) !== 0x24 && n < 65536) { s.write(this.read8(a)); a++; n++; }
                return;
            }
            case 0x0a: {
                const base = this.phys('DS', this.r.DX);
                const max = this.read8(base);
                const idx = this.inq.indexOf(13);
                const nl = this.inq.indexOf(10);
                const end = idx >= 0 ? idx : nl;
                if (end < 0) { this.waiting = { mode: 'line' }; return WAIT; }
                const chars = this.inq.splice(0, end + 1).filter((c) => c !== 13 && c !== 10);
                const keep = chars.slice(0, Math.max(0, max - 1));
                keep.forEach((c, i) => { this.write8(base + 2 + i, c); s.write(c); });
                this.write8(base + 1, keep.length); this.write8(base + 2 + keep.length, 13);
                s.write(13); s.write(10);
                if (this.inq[0] === 10) this.inq.shift();
                return;
            }
            case 0x0b: this.setReg('AL', this.inq.length ? 0xff : 0); return;
            case 0x0c: this.inq.length = 0; return;
            case 0x25: case 0x35: case 0x30: case 0x2f: return;
            case 0x2a: { const d = new Date(); this.r.CX = d.getFullYear(); this.setReg('DH', d.getMonth() + 1); this.setReg('DL', d.getDate()); this.setReg('AL', d.getDay()); return; }
            case 0x2c: { const d = new Date(); this.setReg('CH', d.getHours()); this.setReg('CL', d.getMinutes()); this.setReg('DH', d.getSeconds()); this.setReg('DL', Math.floor(d.getMilliseconds() / 10)); return; }
            case 0x4c: this.exitCode = al; this.status = 'halted'; return;
            default: throw new Error(`Chưa hỗ trợ INT 21h, AH=${ah.toString(16).toUpperCase()}h`);
        }
    }

    // ------------------------------------------------------------------ ảnh chụp trạng thái
    snapshot() {
        const hex = (v, w = 4) => v.toString(16).toUpperCase().padStart(w, '0');
        const regs = {};
        for (const k of ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP']) regs[k] = hex(this.r[k]);
        for (const k of ['CS', 'DS', 'ES', 'SS']) regs[k] = hex(this.s[k]);
        regs.IP = hex(this.ip & 0xffff);
        return {
            status: this.status, error: this.error, waiting: this.waiting,
            screen: this.screen.lines(), cursor: { r: this.screen.r, c: this.screen.c },
            regs, flags: { ...this.f }, steps: this.steps, exitCode: this.exitCode
        };
    }
}

module.exports = { Machine, AsmError };
