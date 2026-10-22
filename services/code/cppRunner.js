// services/code/cppRunner.js — biên dịch + chạy C++ (g++), có nhập tương tác và freopen file .txt
// Thư mục chạy tạm chứa main.cpp + các file .txt cùng thư mục của người dùng
// → freopen("input.txt","r",stdin) / freopen("output.txt","w",stdout) chạy được như Dev-C++.
// ⚠ ĐÂY KHÔNG PHẢI SANDBOX ĐẦY ĐỦ. Triển khai thật nên chạy trong Docker/nsjail (xem README).
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { LIMITS } = require('../../config/codeConfig');

const IS_WIN = process.platform === 'win32';
const CXX = process.env.CPP_COMPILER || 'g++';
const PRELUDE = `#include <cstdio>
namespace { struct MnhaInit { MnhaInit() { setvbuf(stdout, NULL, _IONBF, 0); setvbuf(stderr, NULL, _IONBF, 0); } } mnhaInitObj; }
`;
// Danh sách chặn đơn giản (lớp phòng thủ nông — không thay thế sandbox)
const FORBIDDEN = [
    [/\bsystem\s*\(/, 'system()'], [/\bpopen\s*\(/, 'popen()'], [/\bfork\s*\(/, 'fork()'],
    [/\bexec[lv]p?e?\s*\(/, 'exec*()'], [/\b(__asm__|asm)\b\s*(volatile)?\s*\(/, 'asm'],
    [/#\s*include\s*[<"]\s*(\/|\.\.|[A-Za-z]:|sys\/|unistd\.h|windows\.h|winsock|netinet|arpa\/|dirent\.h)/, '#include hệ thống/đường dẫn'],
    [/#\s*embed\b/, '#embed'], [/\b(socket|connect|bind)\s*\(/, 'socket']
];
let _unshare = null;
function canUnshare() {
    if (_unshare === null) {
        _unshare = false;
        if (!IS_WIN) { try { _unshare = spawnSync('unshare', ['-rn', 'true'], { timeout: 3000 }).status === 0; } catch (_) { /* không có */ } }
    }
    return _unshare;
}

function checkSource(code) {
    for (const [re, label] of FORBIDDEN) if (re.test(code)) return `Mã nguồn dùng "${label}" — không được phép trên máy chủ chạy code.`;
    return null;
}
function safeName(n) { return /^[A-Za-z0-9_\-]{1,60}\.txt$/i.test(n); }
function cleanMsg(s, dir) { return String(s).split(dir + path.sep).join('').split(dir).join('').replace(/\r/g, ''); }

class CppSession {
    /**
     * @param {{code:string, files?:{name:string,content:string}[]}} opt
     */
    constructor(opt) {
        this.code = opt.code; this.inFiles = opt.files || [];
        this.chunks = [];               // {t:'out'|'err'|'in', s}
        this.consoleText = '';
        this.inputs = [];
        this.status = 'compiling';      // compiling | running | waiting | finished
        this.waiting = false;
        this.compileOutput = '';
        this.compileOk = null;
        this.exitCode = null; this.signal = null; this.error = null;
        this.outFiles = {};
        this.startedAt = Date.now();
        this.listeners = [];
        this._lastOut = Date.now();
        this._cpuMs = 0;
        this.dir = path.join(os.tmpdir(), 'mnha-cpp-' + crypto.randomBytes(8).toString('hex'));
    }
    onFinish(fn) { this.listeners.push(fn); }
    _append(t, s) {
        if (this.consoleText.length > LIMITS.MAX_CONSOLE_BYTES) { if (!this._trunc) { this._trunc = true; this.chunks.push({ t: 'err', s: '\n[Đã cắt bớt: đầu ra quá dài]\n' }); this.consoleText += '\n[Đã cắt bớt: đầu ra quá dài]\n'; } return; }
        this.chunks.push({ t, s }); this.consoleText += s;
    }

    async start() {
        const bad = checkSource(this.code);
        if (bad) return this._fail('forbidden', bad);
        try {
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(this.dir, 'main.cpp'), this.code);
            fs.writeFileSync(path.join(this.dir, 'mnha_prelude.h'), PRELUDE);
            this.snapshotFiles = {};
            for (const f of this.inFiles) {
                if (!safeName(f.name)) continue;
                fs.writeFileSync(path.join(this.dir, f.name), f.content);
                this.snapshotFiles[f.name] = f.content;
            }
        } catch (e) { return this._fail('internal', 'Không tạo được thư mục chạy: ' + e.message); }

        const exe = path.join(this.dir, IS_WIN ? 'main.exe' : 'main');
        const args = ['-std=c++17', '-O1', '-Wno-unused-result', '-include', 'mnha_prelude.h', 'main.cpp', '-o', path.basename(exe)];
        const cenv = { PATH: process.env.PATH || '', TMPDIR: this.dir, TEMP: this.dir, TMP: this.dir };
        if (IS_WIN && process.env.SystemRoot) cenv.SystemRoot = process.env.SystemRoot;
        const c = spawn(CXX, args, { cwd: this.dir, env: cenv, stdio: ['ignore', 'pipe', 'pipe'] });
        let cout = '';
        c.stdout.on('data', (d) => { cout += d; }); c.stderr.on('data', (d) => { cout += d; });
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (_) { /* */ } cout += '\n[Biên dịch quá thời gian]\n'; }, LIMITS.COMPILE_MS);
        c.on('error', (e) => { clearTimeout(t); this._fail('compile', `Không chạy được trình biên dịch "${CXX}": ${e.message}`); });
        c.on('close', (code) => {
            clearTimeout(t);
            this.compileOutput = cleanMsg(cout, this.dir).slice(0, 20000);
            if (code !== 0) { this.compileOk = false; return this._fail('compile', null); }
            this.compileOk = true; this._run(exe);
        });
    }

    _run(exe) {
        this.status = 'running';
        const base = [exe];
        let cmd = exe, args = [];
        if (!IS_WIN) {
            // giới hạn tài nguyên: CPU 10s, RAM ảo 512MB, tạo file ≤ 8MB, ≤ 64 tiến trình
            const sh = `ulimit -t 10 -v 524288 -f 8192 -u 64 2>/dev/null; exec "$0"`;
            cmd = 'sh'; args = ['-c', sh, exe];
            if (canUnshare()) { args = ['-c', sh, exe]; cmd = 'unshare'; args = ['-rn', 'sh', '-c', sh, exe]; }
        }
        const env = { PATH: process.env.PATH || '' };
        const p = spawn(cmd, args, { cwd: this.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc = p;
        p.stdout.on('data', (d) => { this._lastOut = Date.now(); this._append('out', d.toString('utf8')); });
        p.stderr.on('data', (d) => { this._lastOut = Date.now(); this._append('err', d.toString('utf8')); });
        p.stdin.on('error', () => { /* tiến trình đã đóng stdin */ });
        p.on('error', (e) => this._fail('run', 'Không chạy được chương trình: ' + e.message));
        p.on('close', (code, sig) => { this.exitCode = code; this.signal = sig; this._finish(); });
        this._tick = setInterval(() => this._watch(), 100);
        this._runStart = Date.now(); this._waitStart = null;
    }

    _isBlockedOnStdin() {
        const pid = this.proc && this.proc.pid;
        if (!pid) return false;
        if (process.platform === 'linux') {
            try {
                const sc = fs.readFileSync(`/proc/${pid}/syscall`, 'utf8').trim().split(' ');
                // read(0,...) → x86_64: 0 ; arm64: 63 ; đối số đầu = fd 0
                const nr = Number(sc[0]);
                return (nr === 0 || nr === 63) && (sc[1] === '0x0' || sc[1] === '0');
            } catch (_) { /* rơi xuống heuristic */ }
        }
        return Date.now() - this._lastOut > 400;     // Windows/macOS: im lặng 0,4s → coi là đang chờ nhập
    }
    _watch() {
        if (this.status === 'finished') return;
        const now = Date.now();
        const blocked = this._isBlockedOnStdin() && now - this._lastOut > 60;
        if (blocked && !this.waiting) { this.waiting = true; this.status = 'waiting'; this._waitStart = now; }
        else if (!blocked && this.waiting) { this.waiting = false; this.status = 'running'; this._waitStart = null; }
        if (this.waiting) {
            if (now - this._waitStart > LIMITS.IDLE_INPUT_MS) { this.error = 'Chờ nhập quá lâu — đã dừng.'; this.kill(); }
        } else {
            this._cpuMs += 100;
            if (this._cpuMs > LIMITS.RUN_WALL_MS) { this.error = 'Chạy quá thời gian cho phép (60 giây) — đã dừng.'; this.kill(); }
        }
    }

    sendInput(text) {
        if (this.status === 'finished' || !this.proc || !this.proc.stdin.writable) return false;
        const line = String(text).replace(/\r/g, '').slice(0, 10000);
        this.inputs.push(line);
        this._append('in', line + '\n');
        this.proc.stdin.write(line + '\n');
        this._lastOut = Date.now(); this.waiting = false; this.status = 'running';
        return true;
    }
    kill() { try { if (this.proc) this.proc.kill('SIGKILL'); } catch (_) { /* */ } }
    stop() { if (this.status !== 'finished') { this.error = this.error || 'Đã dừng bởi người dùng.'; this.kill(); if (!this.proc) this._finish(); } }

    _fail(kind, msg) {
        this.error = msg || (kind === 'compile' ? 'Lỗi biên dịch' : 'Lỗi');
        if (kind === 'compile' && !msg) this.error = 'Lỗi biên dịch';
        this.failKind = kind; this._finish();
    }
    _finish() {
        if (this.status === 'finished') return;
        clearInterval(this._tick);
        // thu các file .txt (output.txt ...) chương trình đã ghi
        try {
            let n = 0;
            for (const f of fs.readdirSync(this.dir)) {
                if (!safeName(f) || n >= 20) continue;
                const fp = path.join(this.dir, f); const st = fs.statSync(fp);
                if (!st.isFile()) continue;
                let content = fs.readFileSync(fp, 'utf8').slice(0, LIMITS.MAX_OUT_FILE_BYTES);
                const before = this.snapshotFiles && this.snapshotFiles[f];
                this.outFiles[f] = { content, changed: before !== content, isNew: before === undefined };
                n++;
            }
        } catch (_) { /* bỏ qua */ }
        this.status = 'finished'; this.waiting = false; this.finishedAt = Date.now();
        try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (_) { /* */ }
        for (const fn of this.listeners) { try { fn(this); } catch (_) { /* */ } }
    }

    view(since = 0) {
        return {
            status: this.status, waiting: this.waiting, compileOk: this.compileOk, compileOutput: this.compileOutput,
            chunks: this.chunks.slice(since), next: this.chunks.length, exitCode: this.exitCode, signal: this.signal,
            error: this.error, files: this.status === 'finished' ? this.outFiles : undefined
        };
    }
    result() {
        return {
            kind: 'cpp', status: this.error ? 'error' : (this.exitCode === 0 ? 'ok' : 'error'),
            compile: { ok: this.compileOk, output: this.compileOutput },
            console: this.consoleText, inputs: this.inputs, exitCode: this.exitCode, signal: this.signal, error: this.error,
            outputFiles: this.outFiles, inputFiles: this.inFiles.map((f) => f.name),
            startedAt: new Date(this.startedAt).toISOString(), finishedAt: new Date(this.finishedAt || Date.now()).toISOString(),
            durationMs: (this.finishedAt || Date.now()) - this.startedAt
        };
    }
}
module.exports = { CppSession, checkSource };
