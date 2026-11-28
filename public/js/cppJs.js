// public/js/cppJs.js — Trình thông dịch C++ thuần JavaScript + thư viện chuẩn <bits/stdc++.h> tích hợp sẵn.
// Chạy 100% trong trình duyệt (Chrome, Safari iOS/macOS, Firefox), KHÔNG cần server, KHÔNG cần WASM/SharedArrayBuffer/COOP-COEP.
(function (root) {
    'use strict';

    var RUN_LIMIT_MS = 60000;
    var CHECK_MASK = 255;                           // kiểm tra dừng/bộ nhớ/đồng hồ mỗi 256 bước thay vì mỗi bước (Date.now() mỗi bước rất tốn)
    var SLICE_MS = 12;                              // mỗi lát chạy ≈12ms rồi nhường trình duyệt (UI/nút Dừng vẫn mượt, vòng lặp nặng chạy hết tốc lực)
    // Giới hạn bộ nhớ tạm (ước lượng): từ giây thứ 5 trở đi, nếu bộ nhớ vẫn đang TĂNG nhanh và vượt ngưỡng mềm → dừng + cảnh báo.
    // Nếu không tràn (bộ nhớ ổn định/đã giải phóng) → cho chạy tiếp. Ngưỡng cứng chặn ngay để tab trình duyệt không bị sập.
    var MEM_CHECK_AFTER_MS = 5000;
    var MEM_GROW_MIN_BYTES = 2 * 1024 * 1024;       // dưới mức này luôn coi là bình thường
    var MEM_SOFT_BYTES = 96 * 1024 * 1024;          // từ giây 5: vượt mức này là dừng dù tốc độ tăng chậm
    var MEM_HARD_BYTES = 768 * 1024 * 1024;         // vượt mức này dừng ngay (không đợi giây 5)
    var MAX_CALL_DEPTH = 150000;                    // đệ quy sâu hơn → tràn ngăn xếp
    var FRAME_BYTES = 256;


    // Nhường trình duyệt bằng MessageChannel: không bị khoá tối thiểu ~4ms của setTimeout(0) lồng nhau (Chrome/Safari) → nhanh hơn nhiều lần.
    // Cứ ~50ms lại nhường 1 lần bằng setTimeout để timer/sự kiện khác (nút Dừng, ô nhập) không bao giờ bị MessageChannel làm đói.
    var yChan = null, yQueue = [], lastTimerYield = 0;
    function yieldNow() {
        return new Promise(function (resolve) {
            var now = Date.now();
            if (typeof root.MessageChannel !== 'function' || now - lastTimerYield >= 50) { lastTimerYield = now; return void setTimeout(resolve, 0); }
            if (!yChan) {
                yChan = new root.MessageChannel();
                yChan.port1.onmessage = function () { var f = yQueue.shift(); if (f) f(); };
                if (typeof yChan.port1.unref === 'function') yChan.port1.unref();      // Node: không giữ tiến trình sống
            }
            yQueue.push(resolve); yChan.port2.postMessage(0);
        });
    }

    // =========================================================================
    // 1. TIỀN XỬ LÝ (PREPROCESSOR): comments, #include, #define, typedef
    // =========================================================================
    function preprocess(code, fileMap, seenFiles, depth) {
        seenFiles = seenFiles || {};
        depth = depth || 0;
        if (depth > 16) throw new Error('Lỗi #include lồng nhau quá sâu (> 16 cấp).');

        // Giữ nguyên số dòng khi xóa comment
        var src = stripComments(String(code || ''));
        var lines = src.split('\n');
        var out = [];
        var macros = {}; // { name: { params: null | string[], body: string } }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var trimmed = line.trim();

            if (trimmed.charAt(0) === '#') {
                // Xử lý dòng tiếp nối '\'
                while (trimmed.endsWith('\\') && i + 1 < lines.length) {
                    trimmed = trimmed.slice(0, -1) + ' ' + lines[++i].trim();
                    out.push('');
                }
                var mIncLocal = /^#\s*include\s*"([^"]+)"/.exec(trimmed);
                if (mIncLocal) {
                    var fname = mIncLocal[1];
                    if (fileMap && Object.prototype.hasOwnProperty.call(fileMap, fname) && !seenFiles[fname]) {
                        seenFiles[fname] = true;
                        var sub = preprocess(fileMap[fname], fileMap, seenFiles, depth + 1);
                        Object.assign(macros, sub.macros);
                        out.push(sub.code);
                    } else {
                        out.push('');
                    }
                    continue;
                }
                if (/^#\s*include\s*<[^>]+>/.test(trimmed) || /^#\s*pragma\b/.test(trimmed)) {
                    out.push('');
                    continue;
                }
                var mDefFn = /^#\s*define\s+([A-Za-z_]\w*)\(([^)]*)\)\s*(.*)$/.exec(trimmed);
                if (mDefFn) {
                    var params = mDefFn[2].trim() ? mDefFn[2].split(',').map(function (p) { return p.trim(); }) : [];
                    macros[mDefFn[1]] = { params: params, body: mDefFn[3] || '' };
                    out.push('');
                    continue;
                }
                var mDef = /^#\s*define\s+([A-Za-z_]\w*)(?:\s+(.*))?$/.exec(trimmed);
                if (mDef) {
                    macros[mDef[1]] = { params: null, body: (mDef[2] || '').trim() };
                    out.push('');
                    continue;
                }
                if (/^#\s*undef\s+([A-Za-z_]\w*)/.test(trimmed)) {
                    delete macros[RegExp.$1];
                    out.push('');
                    continue;
                }
                out.push('');
                continue;
            }
            out.push(applyMacros(line, macros));
        }
        return { code: out.join('\n'), macros: macros };
    }

    function stripComments(s) {
        var res = '', i = 0, n = s.length;
        while (i < n) {
            var c = s[i];
            if (c === '"' || c === "'") {
                var q = c; res += c; i++;
                while (i < n) {
                    if (s[i] === '\\' && i + 1 < n) { res += s[i] + s[i + 1]; i += 2; continue; }
                    res += s[i];
                    if (s[i] === q) { i++; break; }
                    i++;
                }
            } else if (c === '/' && s[i + 1] === '/') {
                while (i < n && s[i] !== '\n') i++;
            } else if (c === '/' && s[i + 1] === '*') {
                i += 2;
                while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
                    if (s[i] === '\n') res += '\n';
                    i++;
                }
                i += 2;
                res += ' ';
            } else {
                res += c; i++;
            }
        }
        return res;
    }

    function applyMacros(line, macros) {
        var keys = Object.keys(macros);
        if (!keys.length) return line;
        // Thay thế ngoài chuỗi ký tự
        var out = '', i = 0, n = line.length;
        while (i < n) {
            var c = line[i];
            if (c === '"' || c === "'") {
                var q = c; out += c; i++;
                while (i < n) {
                    if (line[i] === '\\' && i + 1 < n) { out += line[i] + line[i + 1]; i += 2; continue; }
                    out += line[i];
                    if (line[i] === q) { i++; break; }
                    i++;
                }
            } else if (/[A-Za-z_]/.test(c)) {
                var j = i + 1;
                while (j < n && /\w/.test(line[j])) j++;
                var id = line.slice(i, j);
                if (Object.prototype.hasOwnProperty.call(macros, id)) {
                    var m = macros[id];
                    if (m.params === null) {
                        out += m.body;
                        i = j;
                        continue;
                    } else {
                        var k = j;
                        while (k < n && /\s/.test(line[k])) k++;
                        if (line[k] === '(') {
                            var depth = 1, p = k + 1, args = [], cur = '';
                            while (p < n && depth > 0) {
                                if (line[p] === '(') depth++;
                                else if (line[p] === ')') { depth--; if (depth === 0) break; }
                                else if (line[p] === ',' && depth === 1) { args.push(cur.trim()); cur = ''; p++; continue; }
                                cur += line[p++];
                            }
                            if (cur.trim() || args.length) args.push(cur.trim());
                            var body = m.body;
                            for (var ai = 0; ai < m.params.length; ai++) {
                                body = body.replace(new RegExp('\\b' + m.params[ai] + '\\b', 'g'), args[ai] || '');
                            }
                            out += body;
                            i = p + 1;
                            continue;
                        }
                    }
                }
                out += id; i = j;
            } else {
                out += c; i++;
            }
        }
        return out;
    }

    // =========================================================================
    // 2. BỘ TÁCH TỪ KHÓA (LEXER)
    // =========================================================================
    var KEYWORDS = new Set([
        'auto', 'bool', 'break', 'case', 'char', 'class', 'const', 'continue', 'default', 'delete',
        'do', 'double', 'else', 'enum', 'false', 'float', 'for', 'if', 'int', 'long', 'namespace',
        'new', 'nullptr', 'NULL', 'operator', 'private', 'public', 'return', 'short', 'signed',
        'sizeof', 'static', 'static_cast', 'struct', 'switch', 'this', 'true', 'typedef',
        'unsigned', 'using', 'void', 'while', 'try', 'catch', 'throw'
    ]);

    var EXC_PARENT = {
        exception: null, logic_error: 'exception', runtime_error: 'exception', bad_alloc: 'exception', bad_cast: 'exception',
        invalid_argument: 'logic_error', domain_error: 'logic_error', length_error: 'logic_error', out_of_range: 'logic_error',
        range_error: 'runtime_error', overflow_error: 'runtime_error', underflow_error: 'runtime_error'
    };

    var MULTI_OPS = [
        '<<=', '>>=', '->*', '...', '::', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
        '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->'
    ];

    function tokenize(src) {
        var tokens = [], i = 0, n = src.length, line = 1;
        while (i < n) {
            var c = src[i];
            if (c === '\n') { line++; i++; continue; }
            if (/\s/.test(c)) { i++; continue; }

            // Chuỗi "..."
            if (c === '"') {
                var s = '', startLine = line; i++;
                while (i < n && src[i] !== '"') {
                    if (src[i] === '\n') line++;
                    if (src[i] === '\\' && i + 1 < n) {
                        s += unescapeChar(src[i + 1]); i += 2;
                    } else { s += src[i++]; }
                }
                if (src[i] === '"') i++;
                tokens.push({ type: 'str', val: s, line: startLine });
                continue;
            }
            // Ký tự '...'
            if (c === "'") {
                var ch = '', startL = line; i++;
                if (src[i] === '\\' && i + 1 < n) { ch = unescapeChar(src[i + 1]); i += 2; }
                else if (i < n) { ch = src[i++]; }
                while (i < n && src[i] !== "'") i++;
                if (src[i] === "'") i++;
                tokens.push({ type: 'char', val: ch.charCodeAt(0) || 0, line: startL });
                continue;
            }
            // Số
            if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
                var j = i, isFloat = false;
                if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
                    j += 2; while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
                } else if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
                    j += 2; while (j < n && /[01]/.test(src[j])) j++;
                } else {
                    while (j < n && /[0-9]/.test(src[j])) j++;
                    if (src[j] === '.') { isFloat = true; j++; while (j < n && /[0-9]/.test(src[j])) j++; }
                    if (src[j] === 'e' || src[j] === 'E') {
                        isFloat = true; j++;
                        if (src[j] === '+' || src[j] === '-') j++;
                        while (j < n && /[0-9]/.test(src[j])) j++;
                    }
                }
                var numStr = src.slice(i, j);
                // Bỏ hậu tố u, l, ll, f
                while (j < n && /[uUlLfF]/.test(src[j])) { if (src[j] === 'f' || src[j] === 'F') isFloat = true; j++; }
                var val = numStr.startsWith('0b') || numStr.startsWith('0B') ? parseInt(numStr.slice(2), 2)
                    : numStr.startsWith('0x') || numStr.startsWith('0X') ? parseInt(numStr, 16)
                        : isFloat ? parseFloat(numStr) : parseInt(numStr, 10);
                if (!isFloat && typeof val === 'number' && !Number.isSafeInteger(val)) {        // số nguyên 64-bit: giữ chính xác bằng BigInt
                    try { var bv = numStr.startsWith('0b') || numStr.startsWith('0B') ? BigInt('0b' + numStr.slice(2)) : BigInt(numStr); if (bv >= -9007199254740991n && bv <= 9007199254740991n) val = Number(bv); else val = bv; } catch (e) { }
                }
                tokens.push({ type: 'num', val: val, isFloat: isFloat, line: line });
                i = j; continue;
            }
            // Định danh / từ khóa
            if (/[A-Za-z_]/.test(c)) {
                var k = i + 1;
                while (k < n && /\w/.test(src[k])) k++;
                var word = src.slice(i, k);
                if (word === 'true') tokens.push({ type: 'bool', val: true, line: line });
                else if (word === 'false') tokens.push({ type: 'bool', val: false, line: line });
                else if (word === 'NULL' || word === 'nullptr') tokens.push({ type: 'num', val: 0, isFloat: false, line: line });
                else if (KEYWORDS.has(word)) tokens.push({ type: 'kw', val: word, line: line });
                else tokens.push({ type: 'id', val: word, line: line });
                i = k; continue;
            }
            // Toán tử nhiều ký tự
            var matched = null;
            for (var mo = 0; mo < MULTI_OPS.length; mo++) {
                var op = MULTI_OPS[mo];
                if (src.slice(i, i + op.length) === op) { matched = op; break; }
            }
            if (matched) {
                tokens.push({ type: 'op', val: matched, line: line });
                i += matched.length; continue;
            }
            // Ký tự đơn
            tokens.push({ type: 'op', val: c, line: line });
            i++;
        }
        tokens.push({ type: 'eof', val: '', line: line });
        return tokens;
    }

    function unescapeChar(ch) {
        var map = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };
        return map[ch] !== undefined ? map[ch] : ch;
    }

    // =========================================================================
    // 3. BỘ PHÂN TÍCH CÚ PHÁP (PARSER → AST)
    // =========================================================================
    var BASE_TYPES = new Set(['void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'auto', 'string', 'size_t']);
    var STL_TYPES = new Set(['thread', 'jthread', 'mutex', 'recursive_mutex', 'lock_guard', 'unique_lock', 'scoped_lock', 'atomic', 'vector', 'pair', 'map', 'unordered_map', 'set', 'unordered_set', 'stack', 'queue', 'deque', 'ifstream', 'ofstream', 'stringstream', 'istringstream', 'ostringstream', 'priority_queue', 'multiset', 'multimap', 'unordered_multiset', 'list', 'tuple', 'bitset', 'function']);

    function parse(tokens) {
        var pos = 0;
        var typedefs = { ll: 'long long', ull: 'unsigned long long', ld: 'double', pii: 'pair<int,int>', vi: 'vector<int>', pll: 'pair<long long,long long>', vll: 'vector<long long>', int64_t: 'long long', uint64_t: 'unsigned long long', int32_t: 'int', uint32_t: 'unsigned int', int16_t: 'short', uintmax_t: 'unsigned long long', streamsize: 'long long', ostream: 'ostream', istream: 'istream' };
        var structNames = new Set();

        function peek(offset) { return tokens[pos + (offset || 0)] || tokens[tokens.length - 1]; }
        function next() { return tokens[pos++]; }
        function match(type, val) {
            var t = peek();
            if (t.type === type && (val === undefined || val === null || t.val === val)) { pos++; return t; }
            return null;
        }
        function expect(type, val, msg) {
            var t = match(type, val);
            if (!t) throw new Error('Dòng ' + peek().line + ': ' + (msg || ('Thiếu "' + (val || type) + '" trước "' + peek().val + '"')));
            return t;
        }

        function isTypeStart(idx) {
            var t = tokens[idx];
            if (!t || t.type === 'eof') return false;
            if (t.type === 'kw' && (t.val === 'const' || t.val === 'unsigned' || t.val === 'signed' || t.val === 'static' || t.val === 'struct' || t.val === 'class' || BASE_TYPES.has(t.val))) return true;
            if (t.type === 'id') {
                if (t.val === 'std' && tokens[idx + 1] && tokens[idx + 1].val === '::') return isTypeStart(idx + 2);
                if (BASE_TYPES.has(t.val) || STL_TYPES.has(t.val) || typedefs[t.val] || structNames.has(t.val) || Object.prototype.hasOwnProperty.call(EXC_PARENT, t.val)) return true;
            }
            return false;
        }

        function parseType() {
            var isConst = false, isRef = false, ptr = 0;
            while (match('kw', 'const') || match('kw', 'static') || match('kw', 'struct') || match('kw', 'class')) {
                if (tokens[pos - 1].val === 'const') isConst = true;
            }
            if (peek().type === 'id' && peek().val === 'std' && peek(1).val === '::') { pos += 2; }
            var nameParts = [];
            while (true) {
                var t = peek();
                if ((t.type === 'kw' && (t.val === 'unsigned' || t.val === 'signed' || t.val === 'long' || t.val === 'short' || BASE_TYPES.has(t.val))) ||
                    (t.type === 'id' && (BASE_TYPES.has(t.val) || STL_TYPES.has(t.val) || typedefs[t.val] || structNames.has(t.val) || t.val === 'greater' || t.val === 'less' || Object.prototype.hasOwnProperty.call(EXC_PARENT, t.val))) ||
                    (t.type === 'id' && t.val === 'std' && peek(1).val === '::')) {
                    if (t.type === 'id' && t.val === 'std') { pos += 2; continue; }
                    nameParts.push(next().val);
                    if (nameParts[nameParts.length - 1] !== 'unsigned' && nameParts[nameParts.length - 1] !== 'signed' && nameParts[nameParts.length - 1] !== 'long' && nameParts[nameParts.length - 1] !== 'short') break;
                    // Cho phép "long long", "long double", "unsigned int"...
                    var nx = peek();
                    if (!(nx.type === 'kw' && (nx.val === 'int' || nx.val === 'long' || nx.val === 'double' || nx.val === 'char' || nx.val === 'short'))) break;
                } else break;
            }
            var base = nameParts.join(' ');
            if (typedefs[base]) base = typedefs[base];
            if (base.indexOf('<') > 0) base = base.slice(0, base.indexOf('<'));
            base = base.replace(/^signed (?=int|long|short|char)/, '').replace(/^(long long|long|short|unsigned long long|unsigned long|unsigned short|unsigned) int$/, '$1').replace(/^long unsigned$/, 'unsigned long');
            var templateArgs = null;
            if (match('op', '<')) {
                templateArgs = [];
                if (base === 'function') {
                    // std::function<R(Args...)>: runtime chỉ cần biết đây là một callable.
                    // Vẫn parse/nuốt đúng danh sách kiểu để không nhầm int trong R(Args...) thành
                    // một khai báo mới.
                    if (peek().val !== '>') {
                        templateArgs.push(parseType());
                        if (match('op', '(')) {
                            var fnDepth = 1;
                            while (peek().type !== 'eof' && fnDepth > 0) {
                                var ft = next();
                                if (ft.val === '(') fnDepth++;
                                else if (ft.val === ')') fnDepth--;
                            }
                        }
                        while (match('op', ',')) {
                            if (peek().val === '>') break;
                            templateArgs.push(parseType());
                        }
                    }
                } else {
                    while (peek().val !== '>' && peek().type !== 'eof') {
                        if (peek().type === 'num') templateArgs.push({ base: '#num', val: next().val, ptr: 0, isRef: false });
                        else templateArgs.push(parseType());
                        if (!match('op', ',')) break;
                    }
                }
                // Xử lý '>>' đóng 2 template lồng nhau (vd: vector<pair<int,int>>)
                if (peek().type === 'op' && peek().val === '>>') {
                    peek().val = '>';
                } else {
                    expect('op', '>', 'Thiếu ">" đóng kiểu dữ liệu');
                }
            }
            if (match('kw', 'const')) isConst = true;
            while (match('op', '*')) ptr++;
            if (match('op', '&')) isRef = true;
            if (base === 'atomic' && templateArgs && templateArgs.length === 1) { var aTy = templateArgs[0]; return { base: aTy.base, templateArgs: aTy.templateArgs, ptr: aTy.ptr + ptr, isRef: isRef, isConst: isConst }; }    // atomic<int> chạy như int (1 luồng)
            if (base === 'lock_guard' || base === 'unique_lock' || base === 'scoped_lock' || base === 'recursive_mutex') base = 'mutex';
            if (base === 'jthread') base = 'thread';
            return { base: base, templateArgs: templateArgs, ptr: ptr, isRef: isRef, isConst: isConst };
        }

        function parseProgram() {
            var items = [];
            while (peek().type !== 'eof') {
                if (match('op', ';')) continue;
                if (peek().type === 'id' && peek().val === 'template' && peek(1).val === '<') {
                    next(); next();
                    var depthT = 1;
                    while (peek().type !== 'eof' && depthT > 0) {
                        var tk = next();
                        if (tk.val === '<') depthT++;
                        else if (tk.val === '>') depthT--;
                        else if (tk.val === '>>') depthT -= 2;
                        else if ((tk.val === 'typename' || tk.val === 'class') && peek().type === 'id') typedefs[peek().val] = 'auto';
                    }
                    continue;
                }
                if (match('kw', 'using')) {
                    if (match('kw', 'namespace')) {
                        expect('id', null, 'Thiếu tên namespace');
                        expect('op', ';');
                    } else {
                        var alias = expect('id').val;
                        expect('op', '=');
                        var ty = parseType();
                        typedefs[alias] = ty.base;
                        expect('op', ';');
                    }
                    continue;
                }
                if (peek().val === 'enum') { items.push(parseEnum()); continue; }
                if (peek().val === 'typedef' && peek(1).val === 'enum') { next(); items.push(parseEnum()); continue; }
                if (peek().val === 'typedef' && (peek(1).val === 'struct' || peek(1).val === 'class') && (peek(2).val === '{' || (peek(2).type === 'id' && peek(3).val === '{'))) {
                    next();
                    var tsNode = parseStruct(true);
                    items.push(tsNode);
                    (tsNode.aliases || []).forEach(function (al) { items.push({ type: 'struct', name: al, fields: tsNode.fields, methods: tsNode.methods, trailingVars: [], line: tsNode.line }); });
                    while (extraFuncs.length) items.push(extraFuncs.shift());
                    continue;
                }
                if (peek().val === 'typedef' && (peek(1).val === 'struct' || peek(1).val === 'class') && peek(2).type === 'id') structNames.add(peek(2).val);
                if (match('kw', 'typedef')) {
                    var ty2 = parseType();
                    var alias2 = expect('id').val;
                    typedefs[alias2] = ty2.base;
                    expect('op', ';');
                    continue;
                }
                if (peek().type === 'kw' && (peek().val === 'struct' || peek().val === 'class')) {
                    if (peek(1).val === '{' || (peek(1).type === 'id' && (peek(2).val === '{' || peek(2).val === ':'))) {
                        items.push(parseStruct());
                        while (extraFuncs.length) items.push(extraFuncs.shift());
                        continue;
                    }
                    if (peek(1).type === 'id' && peek(2).val === ';') { structNames.add(peek(1).val); pos += 3; continue; }      // struct Node;  (khai báo trước)
                }
                items.push(parseTopDeclOrFunc());
            }
            return { type: 'program', items: items };
        }

        var anonCount = 0;
        function parseEnum() {
            var line = peek().line;
            next();                                   // enum
            match('kw', 'class'); match('kw', 'struct');
            var ename = peek().type === 'id' && peek().val !== '{' ? next().val : null;
            if (ename) typedefs[ename] = 'int';
            var items = [];
            if (match('op', '{')) {
                while (peek().val !== '}' && peek().type !== 'eof') {
                    var iname = expect('id').val, iexpr = match('op', '=') ? parseAssign() : null;
                    items.push({ name: iname, expr: iexpr });
                    if (!match('op', ',')) break;
                }
                expect('op', '}');
            }
            var trailing = [];
            if (peek().type === 'id') trailing = parseVarDeclsAfterType({ base: 'int', templateArgs: null, ptr: 0, isRef: false });
            expect('op', ';');
            return { type: 'enum_decl', items: items, trailing: trailing, line: line };
        }
        function parseStruct(typedefMode) {
            var line = peek().line;
            next(); // struct / class
            var name = peek().type === 'id' ? next().val : ('__anon' + (anonCount++));
            structNames.add(name);
            var baseName = null;
            if (match('op', ':')) {
                // class Derived : public Base
                while (/^(public|protected|private|virtual)$/.test(peek().val)) next();       // public/protected/private/virtual (có thể không ghi → mặc định)
                if (peek().type === 'id' && peek().val === 'std' && peek(1).val === '::') pos += 2;
                if (peek().type === 'id') baseName = next().val;
            }
            expect('op', '{');
            var fields = [], methods = [];
            while (!match('op', '}') && peek().type !== 'eof') {
                if ((peek().val === 'public' || peek().val === 'private' || peek().val === 'protected') && peek(1).val === ':') { pos += 2; continue; }
                if (match('op', ';')) continue;
                while (peek().type === 'id' && (peek().val === 'virtual' || peek().val === 'explicit' || peek().val === 'inline')) next();
                if (peek().type === 'id' && peek().val === 'friend') {
                    next();
                    var frTy = parseType(), frName = parseFuncName(), frLine = peek().line;
                    var frParams = parseParams();
                    match('kw', 'const');
                    if (peek().val === '{') extraFuncs.push({ type: 'func', name: frName, retType: frTy, params: frParams, body: parseBlock(), line: frLine });
                    else match('op', ';');
                    continue;
                }
                if (peek().val === '~') { next(); next(); parseParams(); if (peek().val === '{') parseBlock(); else match('op', ';'); continue; }
                // Constructor
                if (peek().type === 'id' && peek().val === name && peek(1).val === '(') {
                    next();
                    var cParams = parseParams();
                    var cInits = [];
                    if (match('op', ':')) {
                        do { if (peek().val === 'std' && peek(1).val === '::') pos += 2; var ciName = expect('id').val; cInits.push({ name: ciName, args: peek().val === '{' ? parseInitList().items : parseArgList() }); } while (match('op', ','));
                    }
                    var cBody = parseBlock();
                    methods.push({ name: name, params: cParams, body: cBody, isCtor: true, inits: cInits });
                    continue;
                }
                var ty = parseType();
                var mName = parseFuncName();
                if (peek().val === '(') {
                    var mParams = parseParams();
                    match('kw', 'const');
                    // Pure virtual: virtual double area() = 0;
                    if (match('op', '=')) {
                        parseAssign();
                        expect('op', ';');
                        methods.push({ name: mName, retType: ty, params: mParams, body: { type: 'block', stmts: [], line: line }, pure: true });
                    } else {
                        var mBody = parseBlock();
                        methods.push({ name: mName, retType: ty, params: mParams, body: mBody });
                    }
                } else {
                    pos--; // quay lại để parse danh sách field
                    var decls = parseVarDeclsAfterType(ty);
                    expect('op', ';');
                    fields.push.apply(fields, decls);
                }
            }
            // typedef struct { ... } Name, *PName;
            if (typedefMode) {
                var tdAlias = [];
                while (peek().type === 'id' || peek().val === '*') {
                    while (match('op', '*')) { }
                    tdAlias.push(expect('id').val);
                    if (!match('op', ',')) break;
                }
                expect('op', ';');
                if (tdAlias.length && name.indexOf('__anon') === 0) {      // struct vô danh: đặt tên theo alias đầu tiên
                    structNames.delete(name);
                    name = tdAlias[0]; structNames.add(name);
                } else tdAlias.forEach(function (al) { typedefs[al] = name; structNames.add(al); });
                return { type: 'struct', name: name, base: baseName, fields: fields, methods: methods, trailingVars: [], line: line, aliases: tdAlias.slice(1) };
            }
            // Hỗ trợ `struct Node { ... } root;`
            var trailingVars = [];
            if (peek().type === 'id') {
                trailingVars = parseVarDeclsAfterType({ base: name, templateArgs: null, ptr: 0, isRef: false });
            }
            expect('op', ';');
            return { type: 'struct', name: name, base: baseName, fields: fields, methods: methods, trailingVars: trailingVars, line: line };
        }

        function parseParams() {
            expect('op', '(');
            var params = [];
            while (peek().val !== ')' && peek().type !== 'eof') {
                if (peek().val === 'void' && peek(1).val === ')') { next(); break; }
                var ty = parseType();
                var pName = peek().type === 'id' ? next().val : ('_arg' + params.length);
                var isArr = false;
                while (match('op', '[')) {
                    isArr = true;
                    if (peek().val !== ']') parseExpr();
                    expect('op', ']');
                }
                var defVal = match('op', '=') ? parseAssign() : null;
                params.push({ type: ty, name: pName, isArr: isArr, defVal: defVal });
                if (!match('op', ',')) break;
            }
            expect('op', ')');
            return params;
        }

        var extraFuncs = [];
        function parseFuncName() {
            if (peek().val === 'operator') {
                next();
                var opn;
                if (peek().val === '(' && peek(1).val === ')') { pos += 2; opn = '()'; }
                else if (peek().val === '[' && peek(1).val === ']') { pos += 2; opn = '[]'; }
                else opn = next().val;
                return 'operator' + opn;
            }
            return expect('id', null, 'Thiếu tên hàm hoặc biến').val;
        }
        function parseTopDeclOrFunc() {
            var line = peek().line;
            var ty = parseType();
            var name = parseFuncName();
            if (peek().val === '(' && (peek(1).val === ')' || isTypeStart(pos + 1))) {      // hàm; còn `atomic<int> c(0);` / `vector<int> v(5);` ở ngoài hàm là biến toàn cục
                var params = parseParams();
                match('kw', 'const');
                if (match('op', ';')) return { type: 'func_decl', name: name, retType: ty, params: params, line: line };
                var body = parseBlock();
                return { type: 'func', name: name, retType: ty, params: params, body: body, line: line };
            }
            pos--; // quay lại trước tên biến
            var decls = parseVarDeclsAfterType(ty);
            expect('op', ';');
            return { type: 'vardecl', decls: decls, line: line };
        }

        function parseVarDeclsAfterType(ty) {
            var decls = [];
            while (true) {
                if (decls.length > 0) while (match('op', '*')) {} // hỗ trợ int *a, *b;
                var name = expect('id', null, 'Thiếu tên biến').val;
                var dims = [];
                while (match('op', '[')) {
                    dims.push(peek().val === ']' ? null : parseExpr());
                    expect('op', ']');
                }
                var init = null;
                if (match('op', '=')) {
                    init = peek().val === '{' ? parseInitList() : parseAssign();
                } else if (peek().val === '{' && !dims.length) {
                    init = parseInitList();            // N a{1, nullptr};  vector<int> v{1,2,3};  int x{5};
                } else if (peek().val === '(' && !dims.length) {
                    // Hỗ trợ vector<int> v(n, 0); hoặc string s("abc");
                    init = { type: 'ctor_args', args: parseArgList() };
                }
                decls.push({ varType: ty, name: name, dims: dims, init: init });
                if (!match('op', ',')) break;
            }
            return decls;
        }

        function parseInitList() {
            expect('op', '{');
            var items = [];
            while (peek().val !== '}' && peek().type !== 'eof') {
                items.push(peek().val === '{' ? parseInitList() : parseAssign());
                if (!match('op', ',')) break;
            }
            expect('op', '}');
            return { type: 'init_list', items: items };
        }

        function parseBlock() {
            var line = peek().line;
            expect('op', '{');
            var stmts = [];
            while (peek().val !== '}' && peek().type !== 'eof') {
                stmts.push(parseStmt());
            }
            expect('op', '}');
            return { type: 'block', stmts: stmts, line: line };
        }

        function parseStmt() {
            var t = peek(), line = t.line;
            if (match('op', ';')) return { type: 'empty', line: line };
            if (t.val === '{') return parseBlock();
            if (match('kw', 'if')) {
                expect('op', '(');
                var cond = parseExpr();
                expect('op', ')');
                var thenB = parseStmt();
                var elseB = match('kw', 'else') ? parseStmt() : null;
                return { type: 'if', cond: cond, thenB: thenB, elseB: elseB, line: line };
            }
            if (match('kw', 'while')) {
                expect('op', '(');
                var wCond = parseExpr();
                expect('op', ')');
                var wBody = parseStmt();
                return { type: 'while', cond: wCond, body: wBody, line: line };
            }
            if (match('kw', 'do')) {
                var dBody = parseStmt();
                expect('kw', 'while');
                expect('op', '(');
                var dCond = parseExpr();
                expect('op', ')');
                expect('op', ';');
                return { type: 'dowhile', cond: dCond, body: dBody, line: line };
            }
            if (match('kw', 'for')) {
                expect('op', '(');
                // Kiểm tra range-based for: for (auto x : vec)
                if (isTypeStart(pos)) {
                    var save = pos;
                    var fTy = parseType();
                    if (peek().val === '[') {
                        var bindNames = [];
                        next();
                        while (peek().val !== ']' && peek().type !== 'eof') { bindNames.push(expect('id').val); if (!match('op', ',')) break; }
                        expect('op', ']'); expect('op', ':');
                        var bRange = parseExpr();
                        expect('op', ')');
                        var bBody = parseStmt();
                        return { type: 'for_range', varType: fTy, varName: '__bind', bind: bindNames, range: bRange, body: bBody, line: line };
                    }
                    if (peek().type === 'id' && peek(1).val === ':') {
                        var fVar = next().val;
                        next(); // ':'
                        var fRange = parseExpr();
                        expect('op', ')');
                        var fBody = parseStmt();
                        return { type: 'for_range', varType: fTy, varName: fVar, range: fRange, body: fBody, line: line };
                    }
                    pos = save;
                }
                var init = null;
                if (!match('op', ';')) {
                    init = isTypeStart(pos) ? { type: 'vardecl', decls: parseVarDeclsAfterType(parseType()), line: line } : parseExpr();
                    expect('op', ';');
                }
                var fCond = match('op', ';') ? null : (function () { var e = parseExpr(); expect('op', ';'); return e; })();
                var step = match('op', ')') ? null : (function () { var e = parseExpr(); expect('op', ')'); return e; })();
                var body = parseStmt();
                return { type: 'for', init: init, cond: fCond, step: step, body: body, line: line };
            }
            if (match('kw', 'switch')) {
                expect('op', '(');
                var sExpr = parseExpr();
                expect('op', ')');
                expect('op', '{');
                var cases = [];
                while (peek().val !== '}' && peek().type !== 'eof') {
                    var cVal = null;
                    if (match('kw', 'case')) { cVal = parseExpr(); expect('op', ':'); }
                    else if (match('kw', 'default')) { expect('op', ':'); }
                    else throw new Error('Dòng ' + peek().line + ': Thiếu case/default trong switch');
                    var cStmts = [];
                    while (peek().val !== 'case' && peek().val !== 'default' && peek().val !== '}' && peek().type !== 'eof') {
                        cStmts.push(parseStmt());
                    }
                    cases.push({ val: cVal, stmts: cStmts });
                }
                expect('op', '}');
                return { type: 'switch', expr: sExpr, cases: cases, line: line };
            }
            if (match('kw', 'return')) {
                var rVal = match('op', ';') ? null : (function () { var e = parseExpr(); expect('op', ';'); return e; })();
                return { type: 'return', val: rVal, line: line };
            }
            if (peek().val === 'enum' && (peek(1).val === '{' || peek(1).type === 'id')) return parseEnum();
            if (match('kw', 'delete')) {
                if (match('op', '[')) expect('op', ']');
                var delE = parseUnary();
                expect('op', ';');
                return { type: 'delete', expr: delE, line: line };
            }
            if (match('kw', 'try')) {
                var tryBody = parseBlock();
                var handlers = [];
                while (match('kw', 'catch')) {
                    expect('op', '(');
                    var cAll = false, cTy = null, cName = null;
                    if (match('op', '...')) cAll = true;
                    else { cTy = parseType(); if (peek().type === 'id') cName = next().val; }
                    expect('op', ')');
                    handlers.push({ all: cAll, ty: cTy, name: cName, body: parseBlock() });
                }
                if (!handlers.length) throw new Error('Dòng ' + line + ': Thiếu khối catch sau try.');
                return { type: 'try', body: tryBody, handlers: handlers, line: line };
            }
            if (match('kw', 'throw')) {
                var thExpr = peek().val === ';' ? null : parseExpr();
                expect('op', ';');
                return { type: 'throw', expr: thExpr, line: line };
            }
            if (match('kw', 'break')) { expect('op', ';'); return { type: 'break', line: line }; }
            if (match('kw', 'continue')) { expect('op', ';'); return { type: 'continue', line: line }; }
            if (isTypeStart(pos)) {
                var vTy = parseType();
                if (peek().val === '[') {
                    next();
                    var bnames = [];
                    while (peek().val !== ']' && peek().type !== 'eof') { bnames.push(expect('id').val); if (!match('op', ',')) break; }
                    expect('op', ']');
                    expect('op', '=');
                    var bInit = peek().val === '{' ? parseInitList() : parseAssign();
                    expect('op', ';');
                    return { type: 'bind_decl', names: bnames, init: bInit, line: line };
                }
                var decls = parseVarDeclsAfterType(vTy);
                expect('op', ';');
                return { type: 'vardecl', decls: decls, line: line };
            }
            var expr = parseExpr();
            expect('op', ';');
            return { type: 'expr_stmt', expr: expr, line: line };
        }

        function parseArgList() {
            expect('op', '(');
            var args = [];
            while (peek().val !== ')' && peek().type !== 'eof') {
                args.push(parseAssign());
                if (!match('op', ',')) break;
            }
            expect('op', ')');
            return args;
        }

        function parseExpr() {
            var left = parseAssign();
            while (match('op', ',')) {
                left = { type: 'comma', left: left, right: parseAssign(), line: left.line };
            }
            return left;
        }

        function parseAssign() {
            var left = parseTernary();
            var t = peek();
            if (t.type === 'op' && (t.val === '=' || t.val === '+=' || t.val === '-=' || t.val === '*=' || t.val === '/=' || t.val === '%=' || t.val === '&=' || t.val === '|=' || t.val === '^=' || t.val === '<<=' || t.val === '>>=')) {
                next();
                return { type: 'assign', op: t.val, left: left, right: parseAssign(), line: t.line };
            }
            return left;
        }

        function parseTernary() {
            var cond = parseOr();
            if (match('op', '?')) {
                var tExpr = parseExpr();
                expect('op', ':');
                var fExpr = parseTernary();
                return { type: 'ternary', cond: cond, t: tExpr, f: fExpr, line: cond.line };
            }
            return cond;
        }

        function parseBin(ops, nextFn) {
            var left = nextFn();
            while (peek().type === 'op' && ops.indexOf(peek().val) >= 0) {
                var op = next();
                left = { type: 'bin', op: op.val, left: left, right: nextFn(), line: op.line };
            }
            return left;
        }
        function parseOr() { return parseBin(['||'], parseAnd); }
        function parseAnd() { return parseBin(['&&'], parseBitOr); }
        function parseBitOr() { return parseBin(['|'], parseBitXor); }
        function parseBitXor() { return parseBin(['^'], parseBitAnd); }
        function parseBitAnd() { return parseBin(['&'], parseEq); }
        function parseEq() { return parseBin(['==', '!='], parseRel); }
        function parseRel() { return parseBin(['<', '<=', '>', '>='], parseShift); }
        function parseShift() { return parseBin(['<<', '>>'], parseAdd); }
        function parseAdd() { return parseBin(['+', '-'], parseMul); }
        function parseMul() { return parseBin(['*', '/', '%'], parseUnary); }

        function parseUnary() {
            var t = peek();
            if (match('kw', 'static_cast')) {
                expect('op', '<');
                var ty = parseType();
                expect('op', '>');
                expect('op', '(');
                var ex = parseExpr();
                expect('op', ')');
                return { type: 'cast', target: ty, expr: ex, line: t.line };
            }
            if (match('kw', 'new')) {
                var nTy = parseType();
                if (nTy.ptr) nTy.ptr = 0;
                if (match('op', '[')) {
                    var nSize = parseExpr();
                    expect('op', ']');
                    return { type: 'new_arr', ty: nTy, size: nSize, line: t.line };
                }
                var nArgs = peek().val === '(' ? parseArgList() : (peek().val === '{' ? parseInitList().items : []);
                return { type: 'new_obj', ty: nTy, args: nArgs, line: t.line };
            }
            if (match('kw', 'sizeof')) {
                expect('op', '(');
                var sArg = isTypeStart(pos) ? { type: 'sizeof_type', ty: parseType() } : parseExpr();
                expect('op', ')');
                return { type: 'sizeof', arg: sArg, line: t.line };
            }
            // C-style cast: (double)x
            if (t.val === '(' && isTypeStart(pos + 1)) {
                var save = pos;
                next(); // '('
                var cTy = parseType();
                if (match('op', ')')) {
                    return { type: 'cast', target: cTy, expr: parseUnary(), line: t.line };
                }
                pos = save;
            }
            if (t.type === 'op' && (t.val === '++' || t.val === '--' || t.val === '+' || t.val === '-' || t.val === '!' || t.val === '~' || t.val === '*' || t.val === '&')) {
                next();
                return { type: 'unary', op: t.val, expr: parseUnary(), line: t.line };
            }
            return parsePostfix();
        }

        function parsePostfix() {
            var expr = parsePrimary();
            while (true) {
                var t = peek();
                if (match('op', '(')) {
                    var args = [];
                    while (peek().val !== ')' && peek().type !== 'eof') {
                        args.push(parseAssign());
                        if (!match('op', ',')) break;
                    }
                    expect('op', ')');
                    expr = { type: 'call', callee: expr, args: args, line: t.line };
                } else if (match('op', '[')) {
                    var idx = parseExpr();
                    expect('op', ']');
                    expr = { type: 'index', obj: expr, idx: idx, line: t.line };
                } else if (match('op', '.') || match('op', '->')) {
                    var prop = expect('id').val;
                    expr = { type: 'member', obj: expr, prop: prop, line: t.line };
                } else if (match('op', '++') || match('op', '--')) {
                    expr = { type: 'postfix', op: t.val, expr: expr, line: t.line };
                } else break;
            }
            return expr;
        }

        function parsePrimary() {
            var t = peek();
            if (match('num') || match('bool') || match('char')) {
                return { type: 'lit', kind: t.type, val: t.val, isFloat: !!t.isFloat, line: t.line };
            }
            if (match('str')) {
                var s = t.val;
                while (peek().type === 'str') s += next().val; // nối chuỗi liền kề "a" "b"
                return { type: 'lit', kind: 'str', val: s, line: t.line };
            }
            if (t.type === 'kw' && t.val === 'this') { next(); return { type: 'id', val: 'this', line: t.line }; }
            if (t.type === 'op' && t.val === '[') {            // lambda: [captures](params) { body }
                next();
                var capDepth = 1;
                while (peek().type !== 'eof' && capDepth > 0) { var ck = next(); if (ck.val === '[') capDepth++; else if (ck.val === ']') capDepth--; }
                var lParams = peek().val === '(' ? parseParams() : [];
                while (peek().type === 'id' && (peek().val === 'mutable' || peek().val === 'noexcept')) next();
                if (match('op', '->')) parseType();
                var lBody = parseBlock();
                return { type: 'lambda', params: lParams, body: lBody, line: t.line };
            }
            if (match('id')) {
                var id = t.val;
                // std::cout, greater<int>(), pair<int,int>(...)
                if (id === 'std' && match('op', '::')) {
                    id = expect('id').val;
                }
                if ((id === 'this_thread' || id === 'chrono') && peek().val === '::' && peek(1).type === 'id') { next(); id = id + '_' + next().val; }      // this_thread::sleep_for(...), chrono::milliseconds(n)
                if (id === 'get' && peek().val === '<' && peek(1).type === 'num' && peek(2).val === '>') {
                    next(); var gIdx = next().val; next();
                    expect('op', '(');
                    var gExpr = parseExpr();
                    expect('op', ')');
                    return { type: 'tuple_get', idx: gIdx, expr: gExpr, line: t.line };
                }
                if (id === 'numeric_limits' && peek().val === '<') {
                    next(); var nlTy = parseType(); expect('op', '>'); expect('op', '::');
                    var nlWhich = expect('id').val;
                    if (match('op', '(')) expect('op', ')');
                    return { type: 'numlim', ty: nlTy, which: nlWhich, line: t.line };
                }
                if ((id === 'ios' || id === 'ios_base' || id === 'string' || id === 'chrono') && peek().val === '::') {
                    next();
                    var qn = expect('id').val;
                    if (peek().val === '(') { parseArgList(); return { type: 'lit', kind: 'num', val: 0, line: t.line }; }
                    if (id === 'string' && qn === 'npos') return { type: 'lit', kind: 'num', val: -1, line: t.line };
                    return { type: 'id', val: qn, line: t.line };
                }
                if ((STL_TYPES.has(id) || id === 'string') && (peek().val === '<' || (peek().val === '(' && id !== 'string' && false))) {
                    pos--;
                    var cTyT = parseType();
                    if (peek().val === '(') return { type: 'construct', ty: cTyT, args: parseArgList(), line: t.line };
                    if (peek().val === '{') return { type: 'construct', ty: cTyT, args: [parseInitList()], line: t.line };
                    return { type: 'id', val: id, line: t.line };
                }
                if ((id === 'greater' || id === 'less') && peek().val === '<') {
                    next(); parseType(); expect('op', '>');
                    return { type: 'id', val: id, line: t.line };
                }
                return { type: 'id', val: id, line: t.line };
            }
            if (match('op', '(')) {
                var ex = parseExpr();
                expect('op', ')');
                return ex;
            }
            if (t.val === '{') return parseInitList();
            throw new Error('Dòng ' + t.line + ': Cú pháp không hợp lệ tại "' + t.val + '"');
        }

        return parseProgram();
    }

    // =========================================================================
    // 4. BỘ THÔNG DỊCH (INTERPRETER) + THƯ VIỆN CHUẨN <bits/stdc++.h>
    // =========================================================================
    function createRuntime(opts) {
        var userFiles = {};
        var virtualFiles = {};
        (opts.files || []).forEach(function (f) {
            if (!f.src) {
                userFiles[f.name] = f.content;
                virtualFiles[f.name] = f.content;
            }
        });

        var stdinBuf = '';
        var stdinPos = 0;
        var stdinWaiters = [];
        var stopped = false;
        var steps = 0;
        var startedAt = Date.now();
        var stdoutFile = null; // freopen(..., stdout)
        var fixedFmt = false;
        var precisionFmt = 6;
        var nextWidth = 0;
        var nextFill = ' ';
        var alignLeft = false;
        var rngState = 1;
        var memTotal = 0, memStrMax = 0, memPeak = 0, memSamples = [], memLastSample = 0, callDepth = 0;
        var memReg = (typeof FinalizationRegistry !== 'undefined') ? new FinalizationRegistry(function (rec) { memTotal -= rec.n; if (memTotal < 0) memTotal = 0; }) : null;
        function memOver(why) { return { __halt: 'memory', mb: Math.round(Math.max(memTotal, memStrMax, memPeak) / 1048576), why: why || '' }; }
        function memCharge(obj, bytes) {            // ghi nhận cấp phát (bytes > 0) hoặc giải phóng (bytes < 0) cho 1 đối tượng
            if (!obj || typeof obj !== 'object') return;
            var rec = obj.__rec;
            if (!rec) {
                rec = { n: 0 };
                Object.defineProperty(obj, '__rec', { value: rec, enumerable: false, writable: true });
                if (memReg) memReg.register(obj, rec);
            }
            rec.n += bytes; memTotal += bytes;
            if (rec.n < 0) { memTotal -= rec.n; rec.n = 0; }
            if (bytes > 0 && memTotal > MEM_HARD_BYTES) throw memOver('hard');
        }
        function memRelease(obj) { if (obj && obj.__rec) memCharge(obj, -obj.__rec.n); }
        function memReserve(bytes) { if (memTotal + bytes > MEM_HARD_BYTES) throw memOver('hard'); }   // kiểm tra TRƯỚC khi cấp phát khối lớn
        function memStr(len) { var b = len * 2; if (b > memStrMax) memStrMax = b; if (memStrMax > MEM_HARD_BYTES) throw memOver('hard'); }
        function strGrow(str) { if (typeof str === 'string' && str.length > 262144) memStr(str.length); return str; }
        function memCheck(now) {
            var used = Math.max(memTotal, memStrMax);
            if (used > memPeak) memPeak = used;
            if (used > MEM_HARD_BYTES) throw memOver('hard');
            if (now - memLastSample >= 500) {           // lấy mẫu mỗi 0,5 giây để biết bộ nhớ còn đang tăng hay đã ổn định
                memLastSample = now; memSamples.push({ t: now, u: used });
                if (memSamples.length > 40) memSamples.shift();
            }
            if (now - startedAt >= MEM_CHECK_AFTER_MS && used > MEM_GROW_MIN_BYTES) {
                if (used > MEM_SOFT_BYTES) throw memOver('soft');
                var old = null;
                for (var i = memSamples.length - 1; i >= 0; i--) if (memSamples[i].t <= now - 2000) { old = memSamples[i]; break; }
                if (old && used > old.u * 1.25 + 256 * 1024) throw memOver('growing');   // 2 giây qua vẫn tăng nhanh
            }
        }
        function heapNearLimit() {
            try {
                var pm = root.performance && root.performance.memory;
                if (pm && pm.jsHeapSizeLimit && pm.usedJSHeapSize > pm.jsHeapSizeLimit * 0.92) return true;
                if (typeof process !== 'undefined' && process.memoryUsage && process.memoryUsage().heapUsed > 1500 * 1048576) return true;
            } catch (e) { }
            return false;
        }

        function checkStop() {
            if (stopped) throw { __halt: 'stopped' };
            var now = Date.now();
            if (now - startedAt > RUN_LIMIT_MS) throw { __halt: 'timeout' };
            memCheck(now);
        }
        var lastYieldAt = startedAt;
        function tickStep() {                           // trả về Promise chỉ khi cần nhường; còn lại trả undefined (không tạo microtask)
            if (stopped) throw { __halt: 'stopped' };
            if ((++steps & CHECK_MASK) !== 0) return;
            checkStop();
            var now = Date.now();
            if (now - lastYieldAt < SLICE_MS) return;
            if (heapNearLimit()) throw memOver('heap');
            return yieldNow().then(function () { lastYieldAt = Date.now(); checkStop(); });
        }

        function emitOut(text, kind) {
            if (stdoutFile && kind === 'out') {
                virtualFiles[stdoutFile] = (virtualFiles[stdoutFile] || '') + text;
            } else {
                opts.onOut(text, kind || 'out');
            }
        }

        function feedStdin(text) {
            stdinBuf += text;
            while (stdinWaiters.length) {
                var w = stdinWaiters.shift();
                w();
            }
        }

        var inputClosed = false;
        async function ensureInput() {
            while (stdinPos >= stdinBuf.length && !inputClosed) {
                checkStop();
                await new Promise(function (r) { stdinWaiters.push(r); });
            }
        }

        async function readToken() {
            while (true) {
                await ensureInput();
                while (stdinPos < stdinBuf.length && /\s/.test(stdinBuf[stdinPos])) stdinPos++;
                if (stdinPos < stdinBuf.length) break;
                if (inputClosed) return null;
            }
            var start = stdinPos;
            while (stdinPos < stdinBuf.length && !/\s/.test(stdinBuf[stdinPos])) stdinPos++;
            return stdinBuf.slice(start, stdinPos);
        }

        async function readLineRaw() {                 // như fgets: giữ cả dấu xuống dòng
            await ensureInput();
            if (stdinPos >= stdinBuf.length) return '';
            var idx = stdinBuf.indexOf('\n', stdinPos), line;
            if (idx < 0) { line = stdinBuf.slice(stdinPos); stdinPos = stdinBuf.length; } else { line = stdinBuf.slice(stdinPos, idx + 1); stdinPos = idx + 1; }
            return line.replace(/\r\n$/, '\n');
        }
        async function readLine() {
            await ensureInput();
            if (inputClosed && stdinPos >= stdinBuf.length) return null;
            if (stdinBuf[stdinPos] === '\n') stdinPos++;
            var idx = stdinBuf.indexOf('\n', stdinPos);
            if (idx < 0) {
                var rest = stdinBuf.slice(stdinPos);
                stdinPos = stdinBuf.length;
                return rest.replace(/\r$/, '');
            }
            var line = stdinBuf.slice(stdinPos, idx).replace(/\r$/, '');
            stdinPos = idx + 1;
            return line;
        }

        async function readChar() {
            await ensureInput();
            if (stdinPos >= stdinBuf.length) return null;
            return stdinBuf[stdinPos++];
        }

        function formatFloat(num) {
            if (!isFinite(num)) return String(num);
            if (fixedFmt) return Number(num).toFixed(precisionFmt);
            return String(Number(Number(num).toPrecision(precisionFmt)));
        }

        function formatVal(v) {
            var s;
            if (typeof v === 'boolean') s = v ? '1' : '0';
            else if (v && v.__cppType === 'double') {
                s = formatFloat(v.val);
            } else if (typeof v === 'number') {
                s = Number.isInteger(v) ? String(v) : formatFloat(v);
            } else if (typeof v === 'bigint') {
                s = String(v);
            } else if (v && v.__stl === 'bitset') {
                s = bsStr(v);
            } else if (v && v.__cppType === 'char') {
                s = String.fromCharCode(v.val);
            } else {
                s = String(v);
            }
            if (nextWidth > 0) {
                if (s.length < nextWidth) s = alignLeft ? s + nextFill.repeat(nextWidth - s.length) : nextFill.repeat(nextWidth - s.length) + s;
                nextWidth = 0;
            }
            return s;
        }

        function toNum(v) {
            if (v && (v.__cppType === 'char' || v.__cppType === 'double')) return v.val;
            if (typeof v === 'boolean') return v ? 1 : 0;
            if (typeof v === 'number') return v;
            if (typeof v === 'bigint') return Number(v);
            if (v && typeof v === 'object') return 1;
            return Number(v) || 0;
        }
        // ---------- số nguyên lai: Number khi ≤ 2^53, BigInt khi lớn hơn (long long / unsigned long long chính xác) ----------
        function normBig(b) { return (b <= 9007199254740991n && b >= -9007199254740991n) ? Number(b) : b; }
        function toBig(v) { return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)) || 0); }
        function wrap64(r) { return (r > 18446744073709551615n || r < -9223372036854775808n) ? BigInt.asIntN(64, r) : r; }
        function bigArith(op, a, b, line) {
            if ((op === '+' || op === '-' || op === '*' || op === '/' || op === '%') && ((typeof a === 'number' && !Number.isInteger(a)) || (typeof b === 'number' && !Number.isInteger(b)))) {
                a = Number(a); b = Number(b);
                return op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b;
            }
            var A = toBig(a), B = toBig(b), r;
            switch (op) {
                case '+': r = A + B; break;
                case '-': r = A - B; break;
                case '*': r = A * B; break;
                case '/': if (B === 0n) throw new Error('Dòng ' + line + ': Lỗi chia cho 0.'); r = A / B; break;
                case '%': if (B === 0n) throw new Error('Dòng ' + line + ': Lỗi chia cho 0.'); r = A % B; break;
                case '<<': r = (B < 0n || B > 4096n) ? 0n : A << B; break;
                case '>>': r = (B < 0n || B > 4096n) ? (A < 0n ? -1n : 0n) : A >> B; break;
                case '&': r = A & B; break;
                case '|': r = A | B; break;
                case '^': r = A ^ B; break;
                default: r = 0n;
            }
            return normBig(wrap64(r));
        }
        function arith(op, a, b, line) {
            if (typeof a === 'bigint' || typeof b === 'bigint') return bigArith(op, a, b, line);
            var r = op === '+' ? a + b : op === '-' ? a - b : a * b;
            if (Number.isSafeInteger(r) || !Number.isInteger(a) || !Number.isInteger(b) || Math.abs(a) > 9.3e18 || Math.abs(b) > 9.3e18) return r;
            return bigArith(op, a, b, line);
        }
        function bitOp(op, a, b, line) {
            if (typeof a === 'number' && typeof b === 'number') {
                a = Math.trunc(a); b = Math.trunc(b);
                if (op === '<<' || op === '>>') {
                    if (b >= 0 && b <= 62) {
                        if (op === '>>') return Math.floor(a / Math.pow(2, b));
                        var r = a * Math.pow(2, b); if (Number.isSafeInteger(r)) return r;
                    }
                } else if (a >= -2147483648 && a <= 2147483647 && b >= -2147483648 && b <= 2147483647) return op === '&' ? a & b : op === '|' ? a | b : a ^ b;
            }
            return bigArith(op, a, b, line);
        }
        function binNum(op, lv, rv, lnode, rnode, line) {
            var a = typeof lv === 'bigint' ? lv : toNum(lv), b = typeof rv === 'bigint' ? rv : toNum(rv);
            switch (op) {
                case '+': case '-': case '*': return arith(op, a, b, line);
                case '/': {
                    if (b == 0) throw new Error('Dòng ' + line + ': Lỗi chia cho 0.');
                    var isFl = function (nd, v) { return nd && (nd.isFloat || (nd.type === 'cast' && /^(float|double|long double)$/.test(nd.target.base))) || (v && v.__cppType === 'double') || (typeof v === 'number' && !Number.isInteger(v)); };
                    var li = typeof a === 'bigint' || (!(lv && lv.__cppType === 'char') && Number.isInteger(a) && !isFl(lnode, a));
                    var ri = typeof b === 'bigint' || (!(rv && rv.__cppType === 'char') && Number.isInteger(b) && !isFl(rnode, b));
                    if (li && ri) return (typeof a === 'bigint' || typeof b === 'bigint' || Math.abs(a) > 1e15) ? bigArith('/', a, b, line) : Math.trunc(a / b);
                    return Number(a) / Number(b);
                }
                case '%': {
                    if (b == 0) throw new Error('Dòng ' + line + ': Lỗi chia cho 0.');
                    if (typeof a === 'bigint' || typeof b === 'bigint') return bigArith('%', a, b, line);
                    return Math.trunc(a) % Math.trunc(b);
                }
                case '<<': case '>>': case '&': case '|': case '^': return bitOp(op, a, b, line);
                case '==': return a == b;
                case '!=': return a != b;
                case '<': return a < b;
                case '<=': return a <= b;
                case '>': return a > b;
                case '>=': return a >= b;
            }
            return 0;
        }
        function parseTok(tok) {
            if (/^[+-]?\d+$/.test(tok)) return tok.length > 15 ? normBig(BigInt(tok)) : parseInt(tok, 10);
            return Number(tok) || 0;
        }
        function intInfo(b) {                       // {bits, uns} cho kiểu số nguyên; null nếu không phải
            b = String(b).replace(/^signed\s+/, '').replace(/\s+int$/, '');
            switch (b) {
                case 'short': return { bits: 16, uns: false };
                case 'unsigned short': return { bits: 16, uns: true };
                case 'int': case 'signed': case '': return { bits: 32, uns: false };
                case 'unsigned': case 'unsigned int': return { bits: 32, uns: true };
                case 'long': case 'long long': return { bits: 64, uns: false };
                case 'unsigned long': case 'unsigned long long': case 'size_t': return { bits: 64, uns: true };
            }
            return null;
        }
        function wrapInt(val, info) {
            var v = (typeof val === 'bigint') ? val : (typeof val === 'number' ? val : toNum(val));
            if (typeof v === 'number') {
                if (!isFinite(v)) return 0;
                v = Math.trunc(v);
                if (info.bits === 32) return info.uns ? v >>> 0 : v | 0;
                if (info.bits === 16) return info.uns ? v & 0xffff : (v << 16) >> 16;
                if (Number.isSafeInteger(v) && (!info.uns || v >= 0)) return v;
                v = BigInt(v);
            }
            if (info.bits === 32) return Number(info.uns ? BigInt.asUintN(32, v) : BigInt.asIntN(32, v));
            if (info.bits === 16) return Number(info.uns ? BigInt.asUintN(16, v) : BigInt.asIntN(16, v));
            return normBig(info.uns ? BigInt.asUintN(64, v) : BigInt.asIntN(64, v));
        }

        function isIntType(ty) {
            if (!ty) return false;
            var b = ty.base;
            return !!intInfo(b) && b !== '';
        }

        function castVal(val, ty) {
            if (!ty) return val;
            if (ty.ptr > 0) return val;
            var b = ty.base;
            if (b === 'bool') return !!toNum(val);
            if (b === 'char') {
                var cv = Math.trunc(toNum(val)) & 0xff;
                // GCC/Clang trên môi trường Linux dùng signed char mặc định.
                return { __cppType: 'char', val: cv >= 128 ? cv - 256 : cv };
            }
            if (isIntType(ty)) return wrapInt(val, intInfo(b));
            if (b === 'float' || b === 'double' || b === 'long double') return { __cppType: 'double', val: toNum(val) };
            if (b === 'string') return strGrow(String(val));
            if (b === 'bitset' && ty.templateArgs && ty.templateArgs[0] && !(val && val.__stl)) return makeBitset(Number(ty.templateArgs[0].val), val);
            if (Array.isArray(val) && (structs[b] || b === 'pair' || b === 'vector')) return coerceElem(ty, val);
            return val;
        }

        function cloneVal(v) {             // sao chép sâu (vector<vector<int>> v(n, vector<int>(m)) không được dùng chung 1 hàng)
            if (!v || typeof v !== 'object' || v.__cppType) return v;
            if (Array.isArray(v)) return v.map(cloneVal);
            if (v.__stl === 'map') { var cm = Object.assign({}, v); cm.data = new Map(Array.from(v.data.entries()).map(function (e) { return [e[0], cloneVal(e[1])]; })); cm.orig = new Map(v.orig); cm.ver = 0; cm.cache = null; return cm; }
            if (v.__stl === 'set') { var cs = Object.assign({}, v); cs.data = new Map(v.data); cs.cnt = new Map(v.cnt); cs.ver = 0; cs.cache = null; return cs; }
            if (v.__stl === 'vector' || v.__stl === 'stack' || v.__stl === 'queue' || v.__stl === 'deque' || v.__stl === 'pq') { var c = {}; Object.keys(v).forEach(function (k) { c[k] = k === 'data' ? v.data.map(cloneVal) : v[k]; }); return c; }
            if (v.__stl === 'pair') return { __stl: 'pair', first: cloneVal(v.first), second: cloneVal(v.second) };
            if (v.__stl === 'bitset') return { __stl: 'bitset', n: v.n, v: v.v };
            if (v.__struct) { var f = {}; Object.keys(v.fields).forEach(function (k) { f[k] = cloneVal(v.fields[k]); }); return { __struct: v.__struct, fields: f }; }
            return v;
        }


        // ---------- so sánh, khoá, iterator ----------
        var NOT_HANDLED = { __nh: true };
        var funcOv = {};
        function argScore(p, v) {
            var t = p.type; if (!t) return 1;
            var b = t.base;
            if (t.ptr > 0) return Array.isArray(v) || (v && v.__ptr) || typeof v === 'string' ? 2 : 0;
            if (structs[b]) return v && v.__struct === b ? 3 : 0;
            if (b === 'string') return typeof v === 'string' ? 3 : 0;
            if (b === 'char') return v && v.__cppType === 'char' ? 3 : (typeof v === 'number' ? 1 : 0);
            if (b === 'double' || b === 'float' || b === 'long double') return typeof v === 'number' ? (Number.isInteger(v) ? 1 : 3) : (typeof v === 'bigint' ? 1 : 0);
            if (intInfo(b) || b === 'bool') return (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint' || typeof v === 'boolean' ? 3 : (typeof v === 'number' ? 1 : (v && v.__cppType === 'char' ? 2 : 0));
            if (b === 'vector' || b === 'map' || b === 'set' || b === 'pair' || b === 'deque' || b === 'stack' || b === 'queue') return v && v.__stl ? 3 : 0;
            return 1;
        }
        function pickFunc(name, args) {
            var c = funcOv[name];
            if (!c || !c.length) return null;
            if (c.length === 1) return c[0];
            var best = null, bs = -1;
            for (var i = 0; i < c.length; i++) {
                var f = c[i], need = f.params.filter(function (q) { return !q.defVal && !q.defaultVal; }).length;
                if (args.length > f.params.length || args.length < need) continue;
                var sc = 0;
                for (var k = 0; k < args.length; k++) sc += argScore(f.params[k], args[k]);
                sc += (f.params.length === args.length) ? 0.5 : 0;
                if (sc > bs) { bs = sc; best = f; }
            }
            return best || c[c.length - 1];
        }
        // ---- toán tử người dùng (operator<, +, ==, <<, (), [] ...) ----
        async function tryUserOp(op, lv, rv, env) {
            var name = 'operator' + op, m;
            if (lv && lv.__struct && structs[lv.__struct]) {
                m = structs[lv.__struct].methods.filter(function (x) { return x.name === name && x.params.length === 1; })[0];
                if (m) return invokeFunc(m, [rv], [], env, lv);
            }
            var f = pickFunc(name, [lv, rv]);
            if (f && f.params.length === 2) return invokeFunc(f, [lv, rv], [], env, null);
            // suy ra từ toán tử khác (mở rộng cho tiện): > từ <, != từ ==, <= / >= từ <
            if (op === '>') { var r1 = await tryUserOp('<', rv, lv, env); if (r1 !== NOT_HANDLED) return r1; }
            if (op === '!=') { var r2 = await tryUserOp('==', lv, rv, env); if (r2 !== NOT_HANDLED) return !toNum(r2); }
            if (op === '<=') { var r3 = await tryUserOp('<', rv, lv, env); if (r3 !== NOT_HANDLED) return !toNum(r3); }
            if (op === '>=') { var r4 = await tryUserOp('<', lv, rv, env); if (r4 !== NOT_HANDLED) return !toNum(r4); }
            return NOT_HANDLED;
        }
        function keyStructed(m) { return !!m.keyStruct; }
        async function ensureSorted(m, env) {              // map/set có khoá là struct: sắp xếp bằng operator< của người dùng
            if (!m.ordered || !m.keyStruct || (m.cache && m.cacheVer === m.ver)) return;
            var og = m.__stl === 'map' ? m.orig : m.data, less = makeLess(null, env), ks = Array.from(m.data.keys());
            ks = await msortAsync(ks, async function (x, y) { return m.desc ? await less(og.get(y), og.get(x)) : await less(og.get(x), og.get(y)); });
            m.cache = ks; m.cacheVer = m.ver;
        }
        async function lowerPosA(m, key, upper, env) {
            var ks = mapKeys(m), og = m.__stl === 'map' ? m.orig : m.data, less = makeLess(null, env);
            for (var i = 0; i < ks.length; i++) {
                var k = og.get(ks[i]);
                var lt = m.desc ? await less(key, k) : await less(k, key);          // k đứng trước key
                var gt = m.desc ? await less(k, key) : await less(key, k);
                if (upper ? gt : !lt) return i;
            }
            return ks.length;
        }
        // ---- bitset ----
        function bsMask(n) { return (1n << BigInt(n)) - 1n; }
        function makeBitset(n, val) {
            var v = 0n;
            if (typeof val === 'string') { for (var i = 0; i < val.length; i++) v = (v << 1n) | (val[i] === '1' ? 1n : 0n); }
            else if (val !== undefined && val !== null) v = BigInt.asUintN(n, toBig(val));
            return { __stl: 'bitset', n: n, v: v & bsMask(n) };
        }
        function bsStr(b) { var t = b.v.toString(2); return t.padStart(b.n, '0'); }
        function bsBin(op, l, r, line) {
            var bs = l && l.__stl === 'bitset' ? l : r, n = bs.n;
            var A = l && l.__stl === 'bitset' ? l.v : toBig(l), B = r && r.__stl === 'bitset' ? r.v : toBig(r);
            switch (op) {
                case '&': return { __stl: 'bitset', n: n, v: A & B };
                case '|': return { __stl: 'bitset', n: n, v: A | B };
                case '^': return { __stl: 'bitset', n: n, v: A ^ B };
                case '<<': return { __stl: 'bitset', n: n, v: (A << B) & bsMask(n) };
                case '>>': return { __stl: 'bitset', n: n, v: A >> B };
                case '==': return A === B;
                case '!=': return A !== B;
            }
            throw new Error('Dòng ' + line + ': bitset không hỗ trợ toán tử ' + op);
        }
        function pfOf(x) { if (x && x.__stl === 'pair') return [x.first, x.second]; if (Array.isArray(x)) return x; if (x && x.__stl === 'vector') return x.data; return null; }
        function cmpVals(a, b) {
            a = toRaw(a); b = toRaw(b);
            if (a && b && typeof a === 'object' && typeof b === 'object') {
                var A = pfOf(a), B = pfOf(b);
                if (A && B) { for (var i = 0; i < Math.min(A.length, B.length); i++) { var c = cmpVals(A[i], B[i]); if (c) return c; } return A.length - B.length; }
                return 0;
            }
            return a < b ? -1 : a > b ? 1 : 0;
        }
        function keyStr(k) {
            k = toRaw(k);
            if (k && typeof k === 'object') {
                if (k.__stl === 'pair') return '(' + keyStr(k.first) + ',' + keyStr(k.second) + ')';
                var P = pfOf(k); if (P) return '[' + P.map(keyStr).join(',') + ']';
                if (k.__struct) return 'S' + k.__struct + '{' + Object.keys(k.fields).map(function (f) { return keyStr(k.fields[f]); }).join(',') + '}';
                if (k.__stl === 'bitset') return 'b' + k.v;
                return 'o' + String(k);
            }
            return typeof k === 'string' ? 's:' + k : 'n:' + k;
        }
        function mapKeys(m) {                       // danh sách khoá đã sắp xếp (map/set có thứ tự), có nhớ đệm
            if (m.cache && m.cacheVer === m.ver) return m.cache;
            var ks = Array.from(m.data.keys());
            if (m.ordered && !m.keyStruct) { var og = m.__stl === 'map' ? m.orig : m.data; ks.sort(function (x, y) { return m.desc ? cmpVals(og.get(y), og.get(x)) : cmpVals(og.get(x), og.get(y)); }); }
            m.cache = ks; m.cacheVer = m.ver; return ks;
        }
        function mapPairAt(m, ks) {
            if (m.__stl === 'set') return m.data.get(ks);
            var pr = { __stl: 'pair', first: m.orig.get(ks) };
            Object.defineProperty(pr, 'second', { get: function () { return m.data.get(ks); }, set: function (v) { m.data.set(ks, v); }, enumerable: true });
            return pr;
        }
        function mapGet(m, k) {                     // m[k] : tự thêm giá trị mặc định nếu chưa có (đúng như C++)
            var ks = keyStr(k);
            if (!m.data.has(ks)) { m.data.set(ks, m.vt ? defaultVal(m.vt, []) : 0); m.orig.set(ks, cloneVal(k)); if (k && k.__struct) m.keyStruct = true; m.ver++; memCharge(m, 48); }
            return m.data.get(ks);
        }
        function mapPut(m, k, v) {
            if (m.kt) k = coerceElem(m.kt, k);
            var ks = keyStr(k);
            if (!m.data.has(ks)) { m.orig.set(ks, cloneVal(k)); if (k && k.__struct) m.keyStruct = true; m.ver++; memCharge(m, 48); }
            m.data.set(ks, v);
        }
        function setAdd(m, k) {
            if (m.et) k = coerceElem(m.et, k);
            var ks = keyStr(k);
            if (!m.data.has(ks)) { m.data.set(ks, cloneVal(k)); if (k && k.__struct) m.keyStruct = true; m.ver++; memCharge(m, 48); if (m.multi) m.cnt.set(ks, 1); return true; }
            if (m.multi) { m.cnt.set(ks, (m.cnt.get(ks) || 1) + 1); memCharge(m, 8); }
            return false;
        }
        function mkMIt(m, pos) { return { __mit: true, owner: m, keys: mapKeys(m), pos: pos }; }
        function isIt(v) { return !!(v && (v.__iter || v.__mit || v.__sit)); }
        function itDeref(it) {
            if (it.__iter) return it.__iter[it.idx];
            if (it.__mit) { var ks = it.keys[it.pos]; return ks === undefined ? 0 : mapPairAt(it.owner, ks); }
            if (it.__sit) return { __cppType: 'char', val: it.str.charCodeAt(it.idx) || 0 };
            return undefined;
        }
        function itStep(it, d) {
            if (it.__iter) return { __iter: it.__iter, idx: it.idx + d };
            if (it.__mit) return { __mit: true, owner: it.owner, keys: it.keys, pos: it.pos + d };
            if (it.__sit) return { __sit: true, objNode: it.objNode, str: it.str, idx: it.idx + d };
            return it;
        }
        function itPos(it) { return it.__iter ? it.idx : it.__mit ? it.pos : it.idx; }
        function coerceElem(ty, x) {                // {a,b} → pair / vector / struct theo kiểu phần tử
            if (!ty || !Array.isArray(x)) return x;
            if (ty.base === 'pair') return { __stl: 'pair', first: coerceElem(ty.templateArgs && ty.templateArgs[0], x[0]), second: coerceElem(ty.templateArgs && ty.templateArgs[1], x[1]) };
            if (ty.base === 'vector') { var v = defaultVal(ty, []); v.data = x.map(function (e) { return coerceElem(ty.templateArgs && ty.templateArgs[0], e); }); memCharge(v, v.data.length * 8); return v; }
            if (structs[ty.base]) { var o = instantiateStruct(ty.base, []); var st = structs[ty.base]; for (var i = 0; i < st.fields.length && i < x.length; i++) o.fields[st.fields[i].name] = x[i]; return o; }
            return x;
        }
        function derefVal(p) {
            if (p && p.__ptr) return p.lv.get();
            if (isIt(p)) return itDeref(p);
            if (Array.isArray(p)) return p[0];
            return p;
        }
        function numLimit(ty, which) {
            var b = ty.base || 'int';
            var isF = b === 'double' || b === 'float' || b === 'long double';
            var uns = /unsigned/.test(b);
            if (which === 'infinity' || which === 'quiet_NaN') return which === 'infinity' ? Infinity : NaN;
            if (which === 'epsilon') return b === 'float' ? 1.1920929e-7 : Number.EPSILON;
            if (isF) return which === 'max' ? (b === 'float' ? 3.4028235e38 : Number.MAX_VALUE) : which === 'lowest' ? (b === 'float' ? -3.4028235e38 : -Number.MAX_VALUE) : 2.2250738585072014e-308;
            if (b === 'char') return which === 'max' ? 127 : -128;
            if (b === 'short') return which === 'max' ? 32767 : -32768;
            if (b === 'bool') return which === 'max' ? 1 : 0;
            if (b === 'long long' || b === 'long' || b === 'unsigned long long' || b === 'unsigned long' || b === 'size_t') return which === 'max' ? (uns ? 18446744073709551615n : 9223372036854775807n) : (uns ? 0 : -9223372036854775808n);
            return which === 'max' ? (uns ? 4294967295 : 2147483647) : (uns ? 0 : -2147483648);
        }
        function cloneIfValue(v, ty) {              // gán/khởi tạo/truyền tham số theo giá trị → sao chép đối tượng (struct, vector, map...)
            if (!ty || ty.ptr > 0 || ty.isRef || !v || typeof v !== 'object' || v.__cppType || Array.isArray(v) || v.__ptr || v.__lambda || v.__fn || v.__io || isIt(v)) return v;
            return cloneVal(v);
        }

        // ---------- bộ so sánh / gọi hàm (lambda, hàm người dùng, greater/less) ----------
        async function callFnVal(f, argVals, argNodes, env) {
            if (f && f.__lambda) return invokeFunc({ params: f.node.params, body: f.node.body, retType: null }, argVals, argNodes || [], env, null, f.env);
            if (f && f.__fn && funcs[f.__fn]) return invokeFunc(funcs[f.__fn], argVals, argNodes || [], env, null);
            return 0;
        }
        function makeLess(cmp, env) {               // trả về hàm async less(a,b)
            if (cmp && (cmp.__lambda || cmp.__fn)) return async function (a, b) { return !!toNum(await callFnVal(cmp, [a, b], [], env)); };
            if (cmp && cmp.__struct && structs[cmp.__struct]) {
                var fm = structs[cmp.__struct].methods.filter(function (x) { return x.name === 'operator()'; })[0];
                if (fm) return async function (a, b) { return !!toNum(await invokeFunc(fm, [a, b], [], env, cmp)); };
            }
            if (cmp && cmp.__cmp === 'desc') return async function (a, b) {
                if ((a && a.__struct) || (b && b.__struct)) { var r = await tryUserOp('>', a, b, env); if (r !== NOT_HANDLED) return !!toNum(r); }
                return cmpVals(a, b) > 0;
            };
            return async function (a, b) {
                if ((a && a.__struct) || (b && b.__struct)) { var r = await tryUserOp('<', a, b, env); if (r !== NOT_HANDLED) return !!toNum(r); }
                return cmpVals(a, b) < 0;
            };
        }
        async function msortAsync(a, less) {
            if (a.length < 2) return a;
            var mid = a.length >> 1, L = await msortAsync(a.slice(0, mid), less), R = await msortAsync(a.slice(mid), less), out = [], i = 0, j = 0;
            while (i < L.length && j < R.length) { if (await less(R[j], L[i])) out.push(R[j++]); else out.push(L[i++]); }
            while (i < L.length) out.push(L[i++]);
            while (j < R.length) out.push(R[j++]);
            return out;
        }
        async function sortArr(arr, l, r, cmp, env) {
            var sub = arr.slice(l, r), res;
            if ((cmp && (cmp.__lambda || cmp.__fn || cmp.__struct)) || sub.some(function (x) { return x && x.__struct; })) res = await msortAsync(sub, makeLess(cmp, env));
            else { var desc = cmp && cmp.__cmp === 'desc'; res = sub.sort(function (a, b) { return desc ? cmpVals(b, a) : cmpVals(a, b); }); }
            for (var i = 0; i < res.length; i++) arr[l + i] = res[i];
        }
        // priority_queue = đống nhị phân; less(a,b) đúng nghĩa "a có độ ưu tiên thấp hơn b"
        function pqLess(pq, env) {
            if (pq.cmp && (pq.cmp.__lambda || pq.cmp.__fn || pq.cmp.__struct)) return makeLess(pq.cmp, env);
            return makeLess(pq.mode === 'min' ? { __cmp: 'desc' } : null, env);
        }
        async function pqPush(pq, v, env) {
            var less = pqLess(pq, env), d = pq.data; d.push(v); memCharge(pq, 8);
            var i = d.length - 1;
            while (i > 0) { var par = (i - 1) >> 1; if (await less(d[par], d[i])) { var t = d[par]; d[par] = d[i]; d[i] = t; i = par; } else break; }
        }
        async function pqPop(pq, env) {
            var less = pqLess(pq, env), d = pq.data; if (!d.length) return;
            var last = d.pop(); memCharge(pq, -8);
            if (!d.length) return;
            d[0] = last;
            var i = 0, n = d.length;
            while (true) {
                var l = 2 * i + 1, r = l + 1, big = i;
                if (l < n && await less(d[big], d[l])) big = l;
                if (r < n && await less(d[big], d[r])) big = r;
                if (big === i) break;
                var t = d[i]; d[i] = d[big]; d[big] = t; i = big;
            }
        }
        // ---------- std::thread: chạy tuần tự ngay lúc tạo (1 luồng, kết quả hợp lệ với mọi thứ tự lên lịch của g++) ----------
        async function startThread(argVals, argNodes, env) {
            var f = argVals[0];
            if (f && (f.__lambda || f.__fn)) {
                var nodes = (argNodes || []).slice(1).map(function (n) { return n && n.type === 'call' && n.callee && n.callee.type === 'id' && (n.callee.val === 'ref' || n.callee.val === 'cref') && n.args.length === 1 ? n.args[0] : n; });
                await callFnVal(f, argVals.slice(1), nodes, env);
            }
            return { __stl: 'thread' };
        }
        // ---------- tạo đối tượng ----------
        async function constructObj(name, argVals, argNodes, env) {
            var obj = instantiateStruct(name, []);
            var ctors = structs[name].methods.filter(function (m) { return m.isCtor; });
            var pick = null;
            for (var i = 0; i < ctors.length && !pick; i++) if (ctors[i].params.length === argVals.length) pick = ctors[i];
            for (var i2 = 0; i2 < ctors.length && !pick; i2++) if (ctors[i2].params.length >= argVals.length && ctors[i2].params.slice(argVals.length).every(function (q) { return q.defVal; })) pick = ctors[i2];
            if (pick) await invokeFunc(pick, argVals, argNodes || [], env, obj);
            else if (argVals.length && !ctors.length) {      // khởi tạo kiểu tổng hợp: Point p(1,2)
                var st = structs[name];
                for (var k = 0; k < st.fields.length && k < argVals.length; k++) obj.fields[st.fields[k].name] = argVals[k];
            }
            return obj;
        }
        async function makeObj(ty, cArgs, argNodes, env) {
            var b = ty.base, ta = ty.templateArgs || [], a0 = cArgs[0];
            if (b === 'mutex') return { __stl: 'mutex' };
            if (b === 'thread') return startThread(cArgs, argNodes || [], env);
            if (structs[b]) return constructObj(b, cArgs, argNodes, env);
            if (b === 'vector' || b === 'list' || b === 'deque') {
                var o = defaultVal(ty, []);
                if (!cArgs.length) return o;
                if (a0 && (a0.__stl === 'vector' || a0.__stl === 'deque') && cArgs.length === 1) { o.data = a0.data.map(cloneVal); memCharge(o, o.data.length * 8); return o; }
                if (isIt(a0) && isIt(cArgs[1]) && a0.__iter) { o.data = a0.__iter.slice(a0.idx, cArgs[1].idx).map(cloneVal); memCharge(o, o.data.length * 8); return o; }
                if (Array.isArray(a0) && cArgs.length === 1) { o.data = a0.map(function (e) { return coerceElem(ta[0], e); }); memCharge(o, o.data.length * 8); return o; }
                var vn = Math.max(0, Math.trunc(toNum(a0)));
                var fill = cArgs[1] !== undefined ? cArgs[1] : (ta[0] ? defaultVal(ta[0], []) : 0);
                memReserve(vn * 8);
                o.data = new Array(vn);
                for (var q = 0; q < vn; q++) o.data[q] = (fill && typeof fill === 'object' && !fill.__cppType) ? cloneVal(fill) : fill;
                memCharge(o, vn * 8);
                return o;
            }
            if (b === 'string') {
                if (!cArgs.length) return '';
                if (cArgs.length >= 2 && typeof a0 !== 'string') { var cnt = Math.max(0, Math.trunc(toNum(a0))); memStr(cnt); return formatVal(cArgs[1]).charAt(0).repeat(cnt); }
                if (cArgs.length >= 2 && typeof a0 === 'string') return a0.substr(Math.trunc(toNum(cArgs[1])), cArgs[2] !== undefined ? Math.trunc(toNum(cArgs[2])) : undefined);
                return strGrow(typeof a0 === 'string' ? a0 : formatVal(a0));
            }
            if (b === 'priority_queue') {
                var pq = defaultVal(ty, []);
                pq.mode = ta[2] && ta[2].base === 'greater' ? 'min' : 'max';
                if (ta[2] && structs[ta[2].base]) pq.cmp = instantiateStruct(ta[2].base, []);
                if (a0 && (a0.__lambda || a0.__fn)) pq.cmp = a0;
                else if (a0 && a0.__cmp) pq.mode = a0.__cmp === 'desc' ? 'min' : 'max';
                return pq;
            }
            if (b === 'bitset') return makeBitset(Number(ta[0].val), a0);
            if (b === 'tuple') return cArgs.length ? cArgs.slice() : defaultVal(ty, []);
            if (b === 'pair') { var pr = defaultVal(ty, []); if (cArgs.length >= 2) { pr.first = a0; pr.second = cArgs[1]; } return pr; }
            if (b === 'stringstream' || b === 'istringstream' || b === 'ostringstream') { var ss = defaultVal(ty, []); if (a0 !== undefined) ss.buf = String(a0); return ss; }
            if (b === 'ifstream') { var is = defaultVal(ty, []); if (a0 !== undefined) { is.file = String(a0); is.open = true; is.buf = virtualFiles[is.file] !== undefined ? virtualFiles[is.file] : ''; if (virtualFiles[is.file] === undefined) is.bad = true; } return is; }
            if (b === 'ofstream') { var os = defaultVal(ty, []); if (a0 !== undefined) { os.file = String(a0); os.open = true; virtualFiles[os.file] = ''; } return os; }
            if (b === 'set' || b === 'unordered_set' || b === 'multiset' || b === 'unordered_multiset' || b === 'map' || b === 'unordered_map' || b === 'multimap') {
                var cobj = defaultVal(ty, []);
                if (a0 && a0.__stl === cobj.__stl) return cloneVal(a0);
                if (isIt(a0) && isIt(cArgs[1]) && a0.__iter) {
                    for (var rj = a0.idx; rj < cArgs[1].idx; rj++) { var rel = a0.__iter[rj]; if (cobj.__stl === 'set') setAdd(cobj, rel); else { var rp = pfOf(rel); if (rp) mapPut(cobj, rp[0], rp[1]); } }
                }
                return cobj;
            }
            return defaultVal(ty, []);
        }
        async function buildFromList(ty, list, env) {
            var b = ty.base, ta = ty.templateArgs || [];
            if (!Array.isArray(list)) return castVal(list, ty);
            if (b === 'vector' || b === 'list' || b === 'deque') { var o = defaultVal(ty, []); o.data = list.map(function (e) { return coerceElem(ta[0], e); }); memCharge(o, o.data.length * 8); return o; }
            if (b === 'set' || b === 'unordered_set' || b === 'multiset') { var st = defaultVal(ty, []); list.forEach(function (e) { setAdd(st, e); }); return st; }
            if (b === 'map' || b === 'unordered_map' || b === 'multimap') { var mp = defaultVal(ty, []); list.forEach(function (e) { var pe = pfOf(e); if (pe) mapPut(mp, pe[0], coerceElem(ta[1], pe[1])); }); return mp; }
            if (b === 'priority_queue') { var pq = await makeObj(ty, [], [], env); for (var i = 0; i < list.length; i++) await pqPush(pq, list[i], env); return pq; }
            if (b === 'pair') return coerceElem(ty, list);
            if (structs[b]) return coerceElem(ty, list);
            if (b === 'string' && list.length === 1) return String(list[0]);
            return list.length === 1 ? castVal(list[0], ty) : list;
        }
        function streamRead(st) {                   // đọc 1 token từ stringstream/ifstream; null nếu hết
            var buf = st.buf, p = st.pos;
            while (p < buf.length && /\s/.test(buf[p])) p++;
            if (p >= buf.length) { st.pos = p; st.fail = true; return null; }
            var a = p; while (p < buf.length && !/\s/.test(buf[p])) p++;
            st.pos = p; return buf.slice(a, p);
        }
        function streamWrite(st, text) {
            if (st.__stl === 'ofstream') { if (st.file) virtualFiles[st.file] = (virtualFiles[st.file] || '') + text; }
            else st.buf += text;
        }
        function assignParsed(target, cur, tok) {
            if (typeof cur === 'string') target.set(tok);
            else if (cur && cur.__cppType === 'char') target.set({ __cppType: 'char', val: tok.charCodeAt(0) || 0 });
            else if (target.ty && (target.ty.base === 'double' || target.ty.base === 'float')) target.set(parseFloat(tok) || 0);
            else target.set(parseTok(tok));
        }

        function defaultVal(ty, dims) {
            if (dims && dims.length > 0) return [];
            if (!ty) return 0;
            if (ty.ptr > 0) return 0;
            var b = ty.base;
            if (b === 'bool') return false;
            if (b === 'char') return { __cppType: 'char', val: 0 };
            if (b === 'string') return '';
            var ta = ty.templateArgs || [];
            if (b === 'vector' || b === 'list') return { __stl: 'vector', data: [], et: ta[0] };
            if (b === 'stack') return { __stl: 'stack', data: [], et: ta[0] };
            if (b === 'queue') return { __stl: 'queue', data: [], et: ta[0] };
            if (b === 'deque') return { __stl: 'deque', data: [], et: ta[0] };
            if (b === 'priority_queue') return { __stl: 'pq', data: [], cmp: ta[2] && structs[ta[2].base] ? instantiateStruct(ta[2].base, []) : null, mode: ta[2] && ta[2].base === 'greater' ? 'min' : 'max', cmpTy: ta[2], et: ta[0] };
            if (b === 'map' || b === 'unordered_map' || b === 'multimap') return { __stl: 'map', kt: ta[0], ordered: b !== 'unordered_map', multi: b === 'multimap', desc: !!(ta[2] && ta[2].base === 'greater'), data: new Map(), orig: new Map(), vt: ta[1], ver: 0, cache: null };
            if (b === 'set' || b === 'unordered_set' || b === 'multiset' || b === 'unordered_multiset') return { __stl: 'set', et: ta[0], ordered: b === 'set' || b === 'multiset', multi: b === 'multiset' || b === 'unordered_multiset', desc: !!(ta[1] && ta[1].base === 'greater'), data: new Map(), cnt: new Map(), ver: 0, cache: null };
            if (b === 'bitset') return makeBitset(ta[0] && ta[0].val ? Number(ta[0].val) : 0, 0);
            if (b === 'tuple') return ta.map(function (q) { return defaultVal(q, []); });
            if (b === 'pair') return { __stl: 'pair', first: ta[0] ? defaultVal(ta[0], []) : 0, second: ta[1] ? defaultVal(ta[1], []) : 0 };
            if (b === 'ifstream' || b === 'ofstream' || b === 'stringstream' || b === 'istringstream' || b === 'ostringstream') return { __stl: b, buf: '', pos: 0, file: '' };
            if (b === 'mutex') return { __stl: 'mutex' };
            if (b === 'thread') return { __stl: 'thread' };
            if (structs[b]) return instantiateStruct(b, []);
            return 0;
        }

        var structs = {};
        var funcs = {};
        var globalEnv = { parent: null, vars: {} };

        function sizeOfType(ty) {
            if (!ty) return 4;
            if (ty.ptr > 0) return 8;
            var b = ty.base;
            if (structs[b]) { var t = 0, mx = 1; structs[b].fields.forEach(function (f) { var q = sizeOfType(f.varType), n = 1; (f.dims || []).forEach(function (d) { n *= Math.max(1, Math.trunc(toNum(constSync(d) || 1))); }); if (q > mx && q <= 8) mx = q; t += q * n; }); return Math.ceil(t / mx) * mx; }
            if (b === 'char' || b === 'bool') return 1;
            if (b === 'short' || b === 'unsigned short') return 2;
            if (b === 'double' || b === 'long double') return 8;
            if (b === 'string') return 32;
            var ii = intInfo(b);
            if (ii) return ii.bits / 8;
            if (b === 'float') return 4;
            return 4;
        }
        function instantiateStruct(name, args) {
            var st = structs[name];
            var obj = { __struct: name, fields: {} };
            if (st && st.base && structs[st.base]) {
                var parent = instantiateStruct(st.base, []);
                Object.keys(parent.fields).forEach(function (k) { obj.fields[k] = cloneVal(parent.fields[k]); });
            }
            for (var i = 0; i < st.fields.length; i++) {
                var f = st.fields[i];
                if (f.dims && f.dims.length) {
                    if (f.varType.base === 'char' && f.dims.length === 1 && !f.varType.ptr) obj.fields[f.name] = '';
                    else obj.fields[f.name] = allocSync(f.dims, f.varType);
                } else {
                    obj.fields[f.name] = defaultVal(f.varType, []);
                    if (f.init && f.init.type !== 'init_list' && f.init.type !== 'ctor_args') { var cv = constSync(f.init); if (cv !== undefined) obj.fields[f.name] = castVal(cv, f.varType); }
                }
            }
            return obj;
        }
        function constSync(n) {
            if (!n) return undefined;
            if (n.type === 'lit') return n.kind === 'char' ? { __cppType: 'char', val: n.val } : n.val;
            if (n.type === 'id') { var b = resolveVar(globalEnv, n.val); return b ? b.val : undefined; }
            if (n.type === 'unary' && n.op === '-') { var u = constSync(n.expr); return u === undefined ? undefined : -toNum(u); }
            if (n.type === 'bin') { var l = constSync(n.left), r = constSync(n.right); if (l === undefined || r === undefined) return undefined; try { return binNum(n.op, l, r, n.left, n.right, n.line); } catch (e) { return undefined; } }
            if (n.type === 'cast') { var c = constSync(n.expr); return c === undefined ? undefined : castVal(c, n.target); }
            return undefined;
        }
        function allocSync(dims, ty) {
            var n = dims[0] ? Math.trunc(toNum(constSync(dims[0]) || 0)) : 0;
            memReserve(Math.max(0, n) * 8);
            var arr = new Array(Math.max(0, n));
            for (var i = 0; i < n; i++) arr[i] = dims.length > 1 ? allocSync(dims.slice(1), ty) : defaultVal(ty, []);
            return arr;
        }

        function resolveVar(env, name) {
            var cur = env;
            while (cur) {
                if (Object.prototype.hasOwnProperty.call(cur.vars, name)) return cur.vars[name];
                cur = cur.parent;
            }
            return null;
        }

        function makeLValue(getter, setter, ty) {
            return { __lval: true, get: getter, set: setter, ty: ty };
        }

        async function evalLValue(node, env) {
            if (node.type === 'id') {
                var box = resolveVar(env, node.val);
                if (!box) throw new Error('Dòng ' + node.line + ': Biến "' + node.val + '" chưa được khai báo.');
                if (box.isRef) return box.target;
                return makeLValue(function () { return box.val; }, function (v) { box.val = box.ty ? castVal(v, box.ty) : v; }, box.ty);
            }
            if (node.type === 'tuple_get') {
                var tgo = await evalExpr(node.expr, env), tgi = node.idx;
                if (tgo && tgo.__stl === 'pair') { var tk2 = tgi === 0 ? 'first' : 'second'; return makeLValue(function () { return tgo[tk2]; }, function (v) { tgo[tk2] = v; }); }
                return makeLValue(function () { return tgo[tgi]; }, function (v) { tgo[tgi] = v; });
            }
            if (node.type === 'unary' && node.op === '&') return evalLValue(node.expr, env);
            if (node.type === 'unary' && node.op === '*') {
                var dp = await evalExpr(node.expr, env);
                if (dp && dp.__ptr) return dp.lv;
                if (dp && dp.__iter) return makeLValue(function () { return dp.__iter[dp.idx]; }, function (v) { dp.__iter[dp.idx] = v; });
                if (dp && dp.__mit) return makeLValue(function () { return itDeref(dp); }, function () { });
                if (Array.isArray(dp)) return makeLValue(function () { return dp[0]; }, function (v) { dp[0] = v; });
                return makeLValue(function () { return dp; }, function () { });
            }
            if (node.type === 'call' && node.callee.type === 'member' && (node.callee.prop === 'at' || node.callee.prop === 'front' || node.callee.prop === 'back')) {
                var clObj = await evalExpr(node.callee.obj, env);          // v.at(i) = x;  v.back() = x;  v.front()++;
                if (clObj && (clObj.__stl === 'vector' || clObj.__stl === 'deque')) {
                    var clp = node.callee.prop, cli;
                    if (clp === 'at') {
                        cli = Math.trunc(toNum(await evalExpr(node.args[0], env)));
                        if (cli < 0 || cli >= clObj.data.length) cppThrow('out_of_range', 'vector::at: chỉ số ' + cli + ' ngoài phạm vi (size ' + clObj.data.length + ')');
                    } else {
                        if (!clObj.data.length) throw new Error('Dòng ' + node.line + ': ' + clp + '() trên vector rỗng.');
                        cli = clp === 'front' ? 0 : clObj.data.length - 1;
                    }
                    return makeLValue(function () { return clObj.data[cli]; }, function (v) { clObj.data[cli] = v; });
                }
            }
            if (node.type === 'index') {
                var obj = await evalExpr(node.obj, env);
                var idx = await evalExpr(node.idx, env);
                if (obj && (obj.__stl === 'vector' || obj.__stl === 'deque')) {
                    var i = Math.trunc(toNum(idx));
                    if (i < 0 || i >= obj.data.length) { if (i < 0 || i > obj.data.length + 5000000) throw new Error('Dòng ' + node.line + ': Truy cập ngoài phạm vi vector (chỉ số ' + i + ', size ' + obj.data.length + ').'); }
                    return makeLValue(function () { return obj.data[i] !== undefined ? obj.data[i] : 0; }, function (v) { obj.data[i] = v; });
                }
                if (obj && obj.__stl === 'bitset') {
                    var bi = BigInt(Math.trunc(toNum(idx)));
                    return makeLValue(function () { return ((obj.v >> bi) & 1n) === 1n; }, function (v) { if (toNum(v)) obj.v |= (1n << bi); else obj.v &= ~(1n << bi); });
                }
                if (obj && obj.__struct) {
                    var om2 = structs[obj.__struct].methods.filter(function (x) { return x.name === 'operator[]'; })[0];
                    if (om2) { var oRes = await invokeFunc(om2, [idx], [], env, obj); return makeLValue(function () { return oRes; }, function () { }); }
                }
                if (obj && obj.__stl === 'map') {
                    mapGet(obj, idx);
                    return makeLValue(function () { return obj.data.get(keyStr(idx)); }, function (v) { obj.data.set(keyStr(idx), v); });
                }
                if (Array.isArray(obj)) {
                    var ai = Math.trunc(toNum(idx));
                    return makeLValue(function () { return obj[ai] !== undefined ? obj[ai] : 0; }, function (v) { obj[ai] = v; });
                }
                if (typeof obj === 'string') {
                    var si = Math.trunc(toNum(idx));
                    var parentLv = null;
                    try { parentLv = await evalLValue(node.obj, env); } catch (e) { parentLv = null; }
                    return makeLValue(function () { return { __cppType: 'char', val: obj.charCodeAt(si) || 0 }; }, function (v) {
                        if (!parentLv) return;
                        var cur = parentLv.get(); if (typeof cur !== 'string') cur = obj;
                        var ch = v && v.__cppType === 'char' ? String.fromCharCode(v.val) : typeof v === 'number' ? String.fromCharCode(v) : String(v).charAt(0);
                        if (ch === '\0' && si <= cur.length) { parentLv.set(cur.slice(0, si)); return; }      // '\0' kết thúc chuỗi kiểu C
                        while (cur.length < si) cur += '\0';
                        parentLv.set(cur.slice(0, si) + ch + cur.slice(si + 1));
                    });
                }
                throw new Error('Dòng ' + node.line + ': Không thể truy cập chỉ số [] trên đối tượng này.');
            }
            if (node.type === 'member') {
                var mObj = await evalExpr(node.obj, env);
                var p = node.prop;
                if (mObj && mObj.__ptr) mObj = mObj.lv.get();
                if (isIt(mObj)) mObj = itDeref(mObj);
                if (Array.isArray(mObj) && (p === 'first' || p === 'second')) { var pIdx = p === 'first' ? 0 : 1; return makeLValue(function () { return mObj[pIdx]; }, function (v) { mObj[pIdx] = v; }); }
                if (mObj && mObj.__stl === 'pair' && (p === 'first' || p === 'second')) {
                    return makeLValue(function () { return mObj[p]; }, function (v) { mObj[p] = v; });
                }
                if (mObj && mObj.__struct && Object.prototype.hasOwnProperty.call(mObj.fields, p)) {
                    var mlv = makeLValue(function () { return mObj.fields[p]; }, function (v) { mObj.fields[p] = v; });
                    var fdef = ((structs[mObj.__struct] || {}).fields || []).filter(function (f) { return f.name === p; })[0];
                    if (fdef) mlv.fty = fdef.varType;            // chỉ dùng cho toán tử & (con trỏ cấp 2), không đổi cách gán
                    return mlv;
                }
                throw new Error('Dòng ' + node.line + ': Không có thuộc tính "' + p + '".');
            }
            throw new Error('Dòng ' + node.line + ': Biểu thức bên trái không thể gán giá trị.');
        }

        function toRaw(v) {
            if (v && v.__cppType === 'char') return v.val;
            return v;
        }

        async function evalExpr(node, env) {
            var yy = tickStep(); if (yy) await yy;
            if (!node) return 0;
            switch (node.type) {
                case 'lit':
                    if (node.kind === 'char') return { __cppType: 'char', val: node.val };
                    return node.val;
                case 'id': {
                    if (node.val === 'cin') return { __io: 'cin' };
                    if (node.val === 'stdin' || node.val === 'stdout' || node.val === 'stderr') return node.val;
                    if (node.val === 'cout') return { __io: 'cout' };
                    if (node.val === 'cerr' || node.val === 'clog') return { __io: 'cerr' };
                    if (node.val === 'endl') return { __manip: 'endl' };
                    if (node.val === 'fixed') return { __manip: 'fixed' };
                    if (node.val === 'left') return { __manip: 'left' };
                    if (node.val === 'right') return { __manip: 'right' };
                    if (node.val === 'flush' || node.val === 'ends') return { __manip: 'flush' };
                    if (node.val === 'boolalpha' || node.val === 'noboolalpha' || node.val === 'skipws' || node.val === 'dec') return { __manip: 'flush' };
                    if (node.val === 'UINT_MAX') return 4294967295;
                    if (node.val === 'ULLONG_MAX' || node.val === 'UINT64_MAX') return 18446744073709551615n;
                    if (node.val === 'INT64_MAX') return 9223372036854775807n;
                    if (node.val === 'INT64_MIN') return -9223372036854775808n;
                    if (node.val === 'LONG_MAX') return 9223372036854775807n;
                    if (node.val === 'LONG_MIN') return -9223372036854775808n;
                    if (node.val === 'INT32_MAX') return 2147483647;
                    if (node.val === 'INT32_MIN') return -2147483648;
                    if (node.val === 'UINT32_MAX') return 4294967295;
                    if (node.val === 'SHRT_MAX') return 32767;
                    if (node.val === 'SHRT_MIN') return -32768;
                    if (node.val === 'CHAR_BIT') return 8;
                    if (node.val === 'DBL_MAX') return Number.MAX_VALUE;
                    if (node.val === 'DBL_MIN') return 2.2250738585072014e-308;
                    if (node.val === 'DBL_EPSILON') return Number.EPSILON;
                    if (node.val === 'INFINITY') return Infinity;
                    if (node.val === 'EOF') return -1;
                    if (node.val === 'M_SQRT2') return Math.SQRT2;
                    if (node.val === 'npos') return -1;
                    if (node.val === 'INT_MAX') return 2147483647;
                    if (node.val === 'INT_MIN') return -2147483648;
                    if (node.val === 'LLONG_MAX') return 9223372036854775807n;
                    if (node.val === 'LLONG_MIN') return -9223372036854775808n;
                    if (node.val === 'RAND_MAX') return 32767;
                    if (node.val === 'M_PI') return Math.PI;
                    if (node.val === 'M_E') return Math.E;
                    if (node.val === 'greater') return { __cmp: 'desc' };
                    if (node.val === 'less') return { __cmp: 'asc' };
                    if (funcs[node.val]) return { __fn: node.val };
                    var box = resolveVar(env, node.val);
                    if (!box) throw new Error('Dòng ' + node.line + ': Biến hoặc hàm "' + node.val + '" chưa được khai báo.');
                    return box.isRef ? box.target.get() : box.val;
                }
                case 'comma':
                    await evalExpr(node.left, env);
                    return evalExpr(node.right, env);
                case 'ternary':
                    return toNum(await evalExpr(node.cond, env)) ? evalExpr(node.t, env) : evalExpr(node.f, env);
                case 'cast': {
                    var cv5 = await evalExpr(node.expr, env);
                    if (node.target.ptr > 0 && structs[node.target.base] && Array.isArray(cv5)) {
                        var cnt5 = Math.floor(cv5.length * 4 / Math.max(1, sizeOfType({ base: node.target.base, ptr: 0 })));
                        if (cnt5 <= 1) return instantiateStruct(node.target.base, []);
                        var arr5 = []; for (var q5 = 0; q5 < cnt5; q5++) arr5.push(instantiateStruct(node.target.base, []));
                        return arr5;
                    }
                    return castVal(cv5, node.target);
                }
                case 'sizeof': {
                    var sa = node.arg;
                    if (sa && sa.type === 'sizeof_type') return sizeOfType(sa.ty);
                    var sv = await evalExpr(sa, env);
                    if (Array.isArray(sv)) return sv.length * (sv.length && sv[0] && sv[0].__cppType === 'char' ? 1 : (sv.length && typeof sv[0] === 'number' && !Number.isInteger(sv[0]) ? 8 : 4));
                    if (typeof sv === 'string') return sv.length + 1;
                    if (sv && sv.__struct) return sizeOfType({ base: sv.__struct, ptr: 0 });
                    if (sv && sv.__cppType === 'char') return 1;
                    if (typeof sv === 'number' && !Number.isInteger(sv)) return 8;
                    if (typeof sv === 'bigint') return 8;
                    return 4;
                }
                case 'unary': {
                    if (node.op === '++' || node.op === '--') {
                        var lv = await evalLValue(node.expr, env);
                        var cv0 = lv.get();
                        if (cv0 && cv0.__struct) { var im = structs[cv0.__struct].methods.filter(function (x) { return x.name === 'operator' + node.op; })[0]; if (im) { await invokeFunc(im, [], [], env, cv0); return cv0; } }
                        if (isIt(cv0)) { lv.set(itStep(cv0, node.op === '++' ? 1 : -1)); return lv.get(); }
                        var nv = arith('+', typeof cv0 === 'bigint' ? cv0 : toNum(cv0), node.op === '++' ? 1 : -1, node.line);
                        lv.set(nv);
                        return lv.get();
                    }
                    if (node.op === '&') {
                        var tn = node.expr;
                        if (tn.type === 'id' || tn.type === 'index' || tn.type === 'member') {
                            var plv2 = await evalLValue(tn, env);
                            var cur2 = plv2.get();
                            var pty2 = plv2.ty || plv2.fty;
                            if (pty2 && pty2.ptr > 0) return { __ptr: true, lv: plv2 };      // &con_trỏ → con trỏ cấp 2 (N** pp = &head)
                            if (cur2 && typeof cur2 === 'object' && !cur2.__cppType) return cur2;
                            return { __ptr: true, lv: plv2 };
                        }
                        return evalExpr(node.expr, env);
                    }
                    if (node.op === '*') return derefVal(await evalExpr(node.expr, env));
                    var uv = await evalExpr(node.expr, env);
                    if (uv && uv.__struct) {
                        var um = structs[uv.__struct].methods.filter(function (x) { return x.name === 'operator' + node.op && x.params.length === 0; })[0];
                        if (um) return invokeFunc(um, [], [], env, uv);
                        var uf = pickFunc('operator' + node.op, [uv]);
                        if (uf && uf.params.length === 1) return invokeFunc(uf, [uv], [], env, null);
                    }
                    if (uv && uv.__stl === 'bitset') { if (node.op === '~') return { __stl: 'bitset', n: uv.n, v: (~uv.v) & bsMask(uv.n) }; }
                    if (node.op === '+') return typeof uv === 'bigint' ? uv : toNum(uv);
                    if (node.op === '-') return typeof uv === 'bigint' ? normBig(-uv) : -toNum(uv);
                    if (node.op === '!') return !(typeof uv === 'bigint' ? uv !== 0n : toNum(uv));
                    if (node.op === '~') return typeof uv === 'bigint' ? normBig(-uv - 1n) : -Math.trunc(toNum(uv)) - 1;
                    return uv;
                }
                case 'postfix': {
                    var plv = await evalLValue(node.expr, env);
                    var oldV = plv.get();
                    if (oldV && oldV.__struct) { var pm = structs[oldV.__struct].methods.filter(function (x) { return x.name === 'operator' + node.op; })[0]; if (pm) { var oc = cloneVal(oldV); await invokeFunc(pm, pm.params.length ? [0] : [], [], env, oldV); return oc; } }
                    if (isIt(oldV)) { plv.set(itStep(oldV, node.op === '++' ? 1 : -1)); return oldV; }
                    plv.set(arith('+', typeof oldV === 'bigint' ? oldV : toNum(oldV), node.op === '++' ? 1 : -1, node.line));
                    return oldV;
                }
                case 'assign': {
                    if (node.left.type === 'call' && node.left.callee.type === 'id' && node.left.callee.val === 'tie' && node.op === '=') {
                        var tieV = await evalExpr(node.right, env), tieP = pfOf(tieV) || [tieV];
                        for (var tii = 0; tii < node.left.args.length; tii++) {
                            var tn2 = node.left.args[tii];
                            if (tn2.type === 'id' && tn2.val === 'ignore') continue;
                            (await evalLValue(tn2, env)).set(tieP[tii]);
                        }
                        return tieV;
                    }
                    var alv = await evalLValue(node.left, env);
                    var rhs = await evalExpr(node.right, env);
                    if (node.op === '=') { alv.set(cloneIfValue(rhs, alv.ty)); return alv.get(); }
                    var cur = alv.get();
                    if (cur && cur.__struct) {
                        var cm2 = structs[cur.__struct].methods.filter(function (x) { return x.name === 'operator' + node.op && x.params.length === 1; })[0];
                        if (cm2) { await invokeFunc(cm2, [rhs], [], env, cur); return cur; }
                        var cres = await tryUserOp(node.op.slice(0, -1), cur, rhs, env);
                        if (cres !== NOT_HANDLED) { alv.set(cres); return alv.get(); }
                    }
                    if (cur && cur.__stl === 'bitset') { alv.set(bsBin(node.op.slice(0, -1), cur, rhs, node.line)); return alv.get(); }
                    if (node.op === '+=' && typeof cur === 'string') { alv.set(strGrow(cur + formatVal(rhs))); return alv.get(); }
                    var res = binNum(node.op.slice(0, -1), cur, rhs, null, node.right, node.line);
                    alv.set(res);
                    return alv.get();
                }
                case 'bin': {
                    // Hỗ trợ cout << ... và cin >> ...
                    if (node.op === '<<') {
                        var lstream = await evalExpr(node.left, env);
                        if (lstream && lstream.__stl && /stream$/.test(lstream.__stl)) {
                            var sval0 = await evalExpr(node.right, env);
                            if (sval0 && sval0.__struct && funcOv['operator<<']) { await invokeFunc(pickFunc('operator<<', [lstream, sval0]), [lstream, sval0], [], env, null); return lstream; }
                            if (sval0 && sval0.__manip === 'endl') streamWrite(lstream, '\n');
                            else if (sval0 && sval0.__manip) { if (sval0.__manip === 'fixed') fixedFmt = true; else if (sval0.__manip === 'setprecision') precisionFmt = sval0.n; else if (sval0.__manip === 'setw') nextWidth = sval0.n; }
                            else streamWrite(lstream, formatVal(sval0));
                            return lstream;
                        }
                        if (lstream && (lstream.__io === 'cout' || lstream.__io === 'cerr')) {
                            var rval = await evalExpr(node.right, env);
                            if (rval && rval.__struct && funcOv['operator<<']) { var fo = pickFunc('operator<<', [lstream, rval]); await invokeFunc(fo, [lstream, rval], [], env, null); return lstream; }
                            var kind = lstream.__io === 'cerr' ? 'err' : 'out';
                            if (rval && rval.__manip === 'endl') emitOut('\n', kind);
                            else if (rval && rval.__manip === 'fixed') fixedFmt = true;
                            else if (rval && rval.__manip === 'left') alignLeft = true;
                            else if (rval && rval.__manip === 'right') alignLeft = false;
                            else if (rval && rval.__manip === 'flush') { }
                            else if (rval && rval.__manip === 'setprecision') precisionFmt = rval.n;
                            else if (rval && rval.__manip === 'setw') nextWidth = rval.n;
                            else if (rval && rval.__manip === 'setfill') nextFill = rval.c;
                            else emitOut(formatVal(rval), kind);
                            return lstream;
                        }
                    }
                    if (node.op === '>>') {
                        var rstream = await evalExpr(node.left, env);
                        if (rstream && rstream.__stl && /stream$/.test(rstream.__stl)) {
                            var sTarget = await evalLValue(node.right, env);
                            var sTok = streamRead(rstream);
                            if (sTok === null) return 0;
                            assignParsed(sTarget, sTarget.get(), sTok);
                            return rstream;
                        }
                        if (!rstream) return 0;
                        if (rstream && rstream.__io === 'cin') {
                            var target = await evalLValue(node.right, env);
                            var tok = await readToken();
                            if (tok === null) return 0;
                            var curVal = target.get();
                            if (typeof curVal === 'string') target.set(tok);
                            else if (curVal && curVal.__cppType === 'char') target.set({ __cppType: 'char', val: tok.charCodeAt(0) || 0 });
                            else if (target.ty && (target.ty.base === 'double' || target.ty.base === 'float')) target.set(parseFloat(tok) || 0);
                            else target.set(parseTok(tok));
                            return rstream;
                        }
                    }
                    // Short-circuit && / ||
                    if (node.op === '&&') return toNum(await evalExpr(node.left, env)) ? !!toNum(await evalExpr(node.right, env)) : false;
                    if (node.op === '||') return toNum(await evalExpr(node.left, env)) ? true : !!toNum(await evalExpr(node.right, env));

                    var lv = await evalExpr(node.left, env);
                    var rv = await evalExpr(node.right, env);
                    if ((lv && lv.__struct) || (rv && rv.__struct)) {
                        var ovr = await tryUserOp(node.op, lv, rv, env);
                        if (ovr !== NOT_HANDLED) return ovr;
                    }
                    if ((lv && lv.__stl === 'bitset') || (rv && rv.__stl === 'bitset')) return bsBin(node.op, lv, rv, node.line);
                    if (Array.isArray(lv) && (node.op === '+' || node.op === '-') && typeof rv === 'number') return { __iter: lv, idx: node.op === '+' ? rv : -rv };
                    if (Array.isArray(rv) && node.op === '+' && typeof lv === 'number') return { __iter: rv, idx: lv };
                    if (isIt(lv) || isIt(rv)) {
                        if (isIt(lv) && isIt(rv)) {
                            var pl = itPos(lv), pr2 = itPos(rv);
                            switch (node.op) { case '-': return pl - pr2; case '==': return pl === pr2; case '!=': return pl !== pr2; case '<': return pl < pr2; case '<=': return pl <= pr2; case '>': return pl > pr2; case '>=': return pl >= pr2; }
                        }
                        if (isIt(lv) && (node.op === '+' || node.op === '-')) return itStep(lv, node.op === '+' ? toNum(rv) : -toNum(rv));
                        if (isIt(rv) && node.op === '+') return itStep(rv, toNum(lv));
                    }
                    if ((node.op === '==' || node.op === '!=' || node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') && lv && rv && typeof lv === 'object' && typeof rv === 'object' && pfOf(lv) && pfOf(rv)) {
                        var cc = cmpVals(lv, rv);
                        return node.op === '==' ? cc === 0 : node.op === '!=' ? cc !== 0 : node.op === '<' ? cc < 0 : node.op === '<=' ? cc <= 0 : node.op === '>' ? cc > 0 : cc >= 0;
                    }
                    if ((node.op === '==' || node.op === '!=') && ((lv && typeof lv === 'object' && !lv.__cppType) || (rv && typeof rv === 'object' && !rv.__cppType))) {
                        var same = lv === rv || (lv && rv && lv.__ptr && rv.__ptr && lv.lv === rv.lv);
                        return node.op === '==' ? !!same : !same;
                    }
                    if (node.op === '+' && (typeof lv === 'string' || typeof rv === 'string')) {
                        return strGrow((typeof lv === 'string' ? lv : formatVal(lv)) + (typeof rv === 'string' ? rv : formatVal(rv)));
                    }
                    if ((node.op === '==' || node.op === '!=' || node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') && typeof lv === 'string' && typeof rv === 'string') {
                        return node.op === '==' ? lv === rv : node.op === '!=' ? lv !== rv : node.op === '<' ? lv < rv : node.op === '<=' ? lv <= rv : node.op === '>' ? lv > rv : lv >= rv;
                    }
                    return binNum(node.op, lv, rv, node.left, node.right, node.line);
                }
                case 'index': {
                    var arr = await evalExpr(node.obj, env);
                    var idxRaw = await evalExpr(node.idx, env);
                    var idx = Math.trunc(toNum(idxRaw));
                    if (arr && (arr.__stl === 'vector' || arr.__stl === 'deque')) {
                        if (idx < 0) throw new Error('Dòng ' + node.line + ': Truy cập ngoài phạm vi vector (chỉ số ' + idx + ').');
                        return arr.data[idx] !== undefined ? arr.data[idx] : 0;
                    }
                    if (arr && arr.__stl === 'map') return mapGet(arr, idxRaw);
                    if (arr && arr.__stl === 'bitset') return ((arr.v >> BigInt(idx)) & 1n) === 1n;
                    if (arr && arr.__struct) {
                        var om = structs[arr.__struct].methods.filter(function (x) { return x.name === 'operator[]'; })[0];
                        if (om) return invokeFunc(om, [idxRaw], [], env, arr);
                    }
                    if (Array.isArray(arr)) return arr[idx] !== undefined ? arr[idx] : 0;
                    if (typeof arr === 'string') return { __cppType: 'char', val: arr.charCodeAt(idx) || 0 };
                    return 0;
                }
                case 'member': {
                    var targetObj = await evalExpr(node.obj, env);
                    if (targetObj && targetObj.__ptr) targetObj = targetObj.lv.get();
                    if (isIt(targetObj) && node.prop !== 'base') targetObj = itDeref(targetObj);
                    if (Array.isArray(targetObj) && (node.prop === 'first' || node.prop === 'second')) return targetObj[node.prop === 'first' ? 0 : 1];
                    if (targetObj && targetObj.__stl === 'pair' && (node.prop === 'first' || node.prop === 'second')) return targetObj[node.prop];
                    if (targetObj && targetObj.__struct && Object.prototype.hasOwnProperty.call(targetObj.fields, node.prop)) return targetObj.fields[node.prop];
                    return { __method: true, obj: targetObj, prop: node.prop, objNode: node.obj };
                }
                case 'lambda': return { __lambda: true, node: node, env: env };
                case 'tuple_get': { var tg = await evalExpr(node.expr, env), tgp = pfOf(tg); return tgp ? tgp[node.idx] : 0; }
                case 'numlim': return numLimit(node.ty, node.which);
                case 'construct': {
                    var ctArgs = [];
                    for (var cti = 0; cti < node.args.length; cti++) ctArgs.push(await evalExpr(node.args[cti], env));
                    if (ctArgs.length === 1 && Array.isArray(ctArgs[0]) && node.args[0].type === 'init_list') return buildFromList(node.ty, ctArgs[0], env);
                    return makeObj(node.ty, ctArgs, node.args, env);
                }
                case 'new_arr': {
                    var naN = Math.max(0, Math.trunc(toNum(await evalExpr(node.size, env))));
                    memReserve(naN * 8);
                    var naArr = new Array(naN);
                    var naDef = node.ty.ptr === 0 && (structs[node.ty.base] || node.ty.base === 'string' || node.ty.base === 'vector');
                    for (var nai = 0; nai < naN; nai++) { naArr[nai] = naDef ? defaultVal(node.ty, []) : defaultVal(node.ty, []); if ((nai & 8191) === 8191) checkStop(); }
                    memCharge(naArr, naN * 8);
                    return naArr;
                }
                case 'new_obj': {
                    var noArgs = [];
                    for (var noi = 0; noi < node.args.length; noi++) noArgs.push(await evalExpr(node.args[noi], env));
                    if (structs[node.ty.base] || node.ty.base === 'vector' || node.ty.base === 'map' || node.ty.base === 'set' || node.ty.base === 'string' || node.ty.base === 'stack' || node.ty.base === 'queue') return makeObj(node.ty, noArgs, node.args, env);
                    var noBox = { v: noArgs.length ? castVal(noArgs[0], node.ty) : defaultVal(node.ty, []) };
                    return { __ptr: true, lv: makeLValue(function () { return noBox.v; }, function (v) { noBox.v = castVal(v, node.ty); }, node.ty) };
                }
                case 'call':
                    return evalCall(node, env);
                case 'init_list': {
                    var list = [];
                    for (var ii = 0; ii < node.items.length; ii++) list.push(await evalExpr(node.items[ii], env));
                    return list;
                }
            }
            return 0;
        }

        async function evalCall(node, env) {
            // Gọi phương thức: obj.method(args)
            if (node.callee.type === 'member') {
                var mObj = await evalExpr(node.callee.obj, env);
                var mName = node.callee.prop;
                var mArgs = [];
                for (var i = 0; i < node.args.length; i++) mArgs.push(await evalExpr(node.args[i], env));

                if (mObj && mObj.__exc && mName === 'what') return mObj.msg;
                if (mObj && (mObj.__stl === 'thread' || mObj.__stl === 'mutex')) return mName === 'try_lock' ? true : 0;      // join/detach/lock/unlock... (chạy 1 luồng nên không cần chờ)
                if (mObj && mObj.__stl === 'vector' && mObj.et && mObj.et.base === 'thread' && mName === 'emplace_back') { mObj.data.push(await startThread(mArgs, node.args, env)); return 0; }
                if ((typeof mObj === 'number' || typeof mObj === 'bigint' || typeof mObj === 'boolean') && /^(load|store|fetch_add|fetch_sub|exchange)$/.test(mName)) {   // atomic<T>
                    var atl = await evalLValue(node.callee.obj, env), atOld = atl.get();
                    if (mName === 'load') return atOld;
                    if (mName === 'store') { atl.set(mArgs[0]); return 0; }
                    if (mName === 'exchange') { atl.set(mArgs[0]); return atOld; }
                    atl.set(arith('+', toNum(atOld), mName === 'fetch_add' ? toNum(mArgs[0]) : -toNum(mArgs[0]), node.line)); return atOld;
                }
                var cmRes = await containerMethod(mObj, mName, mArgs, node, env);
                if (cmRes !== NOT_HANDLED) return cmRes;

                if (mObj && mObj.__io === 'cin') {
                    if (mName === 'ignore') { await ensureInput(); if (stdinPos < stdinBuf.length) stdinPos++; return mObj; }
                    if (mName === 'eof') return stdinPos >= stdinBuf.length;
                    return mObj;
                }
                if (typeof mObj === 'string') {
                    if (mName === 'length' || mName === 'size') return mObj.length;
                    if (mName === 'empty') return mObj.length === 0;
                    if (mName === 'substr') return mObj.substr(toNum(mArgs[0]), mArgs[1] !== undefined ? toNum(mArgs[1]) : undefined);
                    if (mName === 'find') { var p = mObj.indexOf(String(mArgs[0]), mArgs[1] ? toNum(mArgs[1]) : 0); return p >= 0 ? p : -1; }
                    if (mName === 'push_back') {
                        var lvStr = await evalLValue(node.callee.obj, env);
                        lvStr.set(strGrow(mObj + formatVal(mArgs[0])));
                        return 0;
                    }
                    if (mName === 'pop_back') {
                        var lvStr2 = await evalLValue(node.callee.obj, env);
                        lvStr2.set(mObj.slice(0, -1));
                        return 0;
                    }
                    if (mName === 'clear') {
                        var lvStr3 = await evalLValue(node.callee.obj, env);
                        lvStr3.set('');
                        return 0;
                    }
                }
                if (mObj && mObj.__stl === 'vector') {
                    if (mName === 'push_back' || mName === 'emplace_back') { mObj.data.push(mName === 'emplace_back' && mArgs.length > 1 ? { __stl: 'pair', first: mArgs[0], second: mArgs[1] } : mArgs[0]); memCharge(mObj, 8); return 0; }
                    if (mName === 'pop_back') { mObj.data.pop(); memCharge(mObj, -8); return 0; }
                    if (mName === 'size') return mObj.data.length;
                    if (mName === 'empty') return mObj.data.length === 0;
                    if (mName === 'clear') { mObj.data.length = 0; memRelease(mObj); return 0; }
                    if (mName === 'back') return mObj.data[mObj.data.length - 1];
                    if (mName === 'front') return mObj.data[0];
                    if (mName === 'resize') {
                        var sz = Math.trunc(toNum(mArgs[0])), fillV = mArgs[1] !== undefined ? mArgs[1] : 0;
                        if (sz > mObj.data.length) memReserve((sz - mObj.data.length) * 8);
                        var oldLen = mObj.data.length;
                        while (mObj.data.length < sz) mObj.data.push(fillV);
                        mObj.data.length = sz;
                        memCharge(mObj, (sz - oldLen) * 8);
                        return 0;
                    }
                    if (mName === 'begin') return { __iter: mObj.data, idx: 0 };
                    if (mName === 'end') return { __iter: mObj.data, idx: mObj.data.length };
                }
                if (mObj && (mObj.__stl === 'stack' || mObj.__stl === 'queue')) {
                    if (mName === 'push' || mName === 'emplace') { mObj.data.push(mArgs[0]); memCharge(mObj, 8); return 0; }
                    if (mName === 'pop') { if (mObj.__stl === 'stack') mObj.data.pop(); else mObj.data.shift(); memCharge(mObj, -8); return 0; }
                    if (mName === 'top') return mObj.data[mObj.data.length - 1];
                    if (mName === 'front') return mObj.data[0];
                    if (mName === 'back') return mObj.data[mObj.data.length - 1];
                    if (mName === 'size') return mObj.data.length;
                    if (mName === 'empty') return mObj.data.length === 0;
                }
                if (mObj && mObj.__stl === 'set') {
                    var sv = toRaw(mArgs[0]);
                    if (mName === 'insert') { mObj.data.add(sv); return 0; }
                    if (mName === 'erase') { mObj.data.delete(sv); return 0; }
                    if (mName === 'count') return mObj.data.has(sv) ? 1 : 0;
                    if (mName === 'size') return mObj.data.size;
                    if (mName === 'empty') return mObj.data.size === 0;
                    if (mName === 'clear') { mObj.data.clear(); return 0; }
                }
                if (mObj && mObj.__stl === 'map') {
                    var mk = String(toRaw(mArgs[0]));
                    if (mName === 'count') return mObj.data.has(mk) ? 1 : 0;
                    if (mName === 'erase') { mObj.data.delete(mk); return 0; }
                    if (mName === 'size') return mObj.data.size;
                    if (mName === 'empty') return mObj.data.size === 0;
                    if (mName === 'clear') { mObj.data.clear(); return 0; }
                }
                if (mObj && mObj.__struct && structs[mObj.__struct]) {
                    var st = structs[mObj.__struct];
                    var mPick = null;
                    while (st && !mPick) {
                        for (var mi = 0; mi < st.methods.length; mi++) {
                            if (st.methods[mi].name === mName && !st.methods[mi].isCtor) {
                                if (st.methods[mi].params.length === mArgs.length) { mPick = st.methods[mi]; break; }
                                if (!mPick) mPick = st.methods[mi];
                            }
                        }
                        st = st.base ? structs[st.base] : null;
                    }
                    if (mPick) return invokeFunc(mPick, mArgs, node.args, env, mObj);
                    if (mName === 'what') {
                        var wRoot = null; for (var wn = mObj.__struct; wn; wn = structs[wn] ? structs[wn].base : null) if (!structs[wn] && Object.prototype.hasOwnProperty.call(EXC_PARENT, wn)) { wRoot = wn; break; }
                        if (wRoot) return mObj.fields.__what !== undefined ? mObj.fields.__what : 'std::' + wRoot;
                    }
                }
                throw new Error('Dòng ' + node.line + ': Không hỗ trợ phương thức "' + mName + '()".');
            }

            if (node.callee.type === 'lambda' || node.callee.type === 'call') {
                var lamV = await evalExpr(node.callee, env), lamArgs = [];
                for (var lai = 0; lai < node.args.length; lai++) lamArgs.push(await evalExpr(node.args[lai], env));
                if (lamV && (lamV.__lambda || lamV.__fn)) return callFnVal(lamV, lamArgs, node.args, env);
            }
            var fnName = node.callee.type === 'id' ? node.callee.val : null;
            if (!fnName) throw new Error('Dòng ' + node.line + ': Không thể gọi hàm này.');
            if (Object.prototype.hasOwnProperty.call(EXC_PARENT, fnName) && !structs[fnName] && !funcs[fnName]) {       // runtime_error("..."), exception(), out_of_range("...")
                var exA = node.args.length ? await evalExpr(node.args[0], env) : '';
                return { __exc: fnName, msg: node.args.length ? String(exA) : 'std::' + fnName };
            }
            if ((fnName === 'ref' || fnName === 'cref') && node.args.length === 1 && !funcs[fnName]) return evalExpr(node.args[0], env);
            if (fnName.indexOf('this_thread_') === 0 || /^chrono_(nanoseconds|microseconds|milliseconds|seconds|minutes|hours)$/.test(fnName)) {      // chạy 1 luồng: ngủ/nhường không cần chờ thật
                var chV = 0; for (var chi = 0; chi < node.args.length; chi++) chV = await evalExpr(node.args[chi], env);
                return fnName.indexOf('this_thread_') === 0 ? 0 : chV;
            }
            if ((fnName === 'thread' || fnName === 'jthread') && !structs[fnName] && !funcs[fnName]) {
                var thA = []; for (var thi = 0; thi < node.args.length; thi++) thA.push(await evalExpr(node.args[thi], env));
                return startThread(thA, node.args, env);
            }
            if (fnName === 'std' && node.callee.val) fnName = node.callee.val;

            var cvar0 = resolveVar(env, fnName);
            if (cvar0) {
                var cv0 = cvar0.isRef ? cvar0.target.get() : cvar0.val;
                if (cv0 && cv0.__struct && structs[cv0.__struct]) {
                    var fm0 = structs[cv0.__struct].methods.filter(function (x) { return x.name === 'operator()'; })[0];
                    if (fm0) { var fnA = []; for (var fni = 0; fni < node.args.length; fni++) fnA.push(await evalExpr(node.args[fni], env)); return invokeFunc(fm0, fnA, node.args, env, cv0); }
                }
                if (cv0 && (cv0.__lambda || cv0.__fn)) {
                    var cvArgs = [];
                    for (var cvi = 0; cvi < node.args.length; cvi++) cvArgs.push(await evalExpr(node.args[cvi], env));
                    return callFnVal(cv0, cvArgs, node.args, env);
                }
            }
            var th0 = resolveVar(env, 'this');
            if (th0 && th0.val && th0.val.__struct && structs[th0.val.__struct]) {
                var thM = structs[th0.val.__struct].methods.filter(function (m) { return m.name === fnName && !m.isCtor; });
                if (thM.length) {
                    var thArgs = [];
                    for (var thi = 0; thi < node.args.length; thi++) thArgs.push(await evalExpr(node.args[thi], env));
                    var thPick = thM.filter(function (m) { return m.params.length === thArgs.length; })[0] || thM[0];
                    return invokeFunc(thPick, thArgs, node.args, env, th0.val);
                }
            }
            if (structs[fnName] && !funcs[fnName]) {
                var stArgs = [];
                for (var sti = 0; sti < node.args.length; sti++) stArgs.push(await evalExpr(node.args[sti], env));
                return constructObj(fnName, stArgs, node.args, env);
            }

            // Hàm người dùng định nghĩa
            if (funcs[fnName]) {
                var fArgs = [];
                for (var ai = 0; ai < node.args.length; ai++) fArgs.push(await evalExpr(node.args[ai], env));
                return invokeFunc(pickFunc(fnName, fArgs) || funcs[fnName], fArgs, node.args, env, null);
            }

            // Hàm chuẩn <bits/stdc++.h>
            return callStdFunc(fnName, node, env);
        }


        function lowerPos(m, key, upper) {          // vị trí đầu tiên có khoá >= key (hoặc > key nếu upper) trong map/set có thứ tự
            var ks = mapKeys(m), og = m.__stl === 'map' ? m.orig : m.data, lo = 0, hi = ks.length;
            while (lo < hi) {
                var mid = (lo + hi) >> 1, c = cmpVals(og.get(ks[mid]), key); if (m.desc) c = -c;
                if (upper ? c <= 0 : c < 0) lo = mid + 1; else hi = mid;
            }
            return lo;
        }
        function findIt(m, key) {
            var ks = keyStr(key);
            if (!m.data.has(ks)) return mkMIt(m, mapKeys(m).length);
            var keys = mapKeys(m);
            return mkMIt(m, m.ordered && !m.keyStruct ? lowerPos(m, key, false) : keys.indexOf(ks));
        }
        function insResult(m, key, added) {
            var pr = { __stl: 'pair', second: added };
            Object.defineProperty(pr, 'first', { get: function () { return findIt(m, key); }, enumerable: true });
            return pr;
        }
        async function stringMethod(str, name, a, node, env) {
            var N = function (x) { return Math.trunc(toNum(x)); };
            var S = function (x) { return typeof x === 'string' ? x : (x && x.__cppType === 'char' ? String.fromCharCode(x.val) : formatVal(x)); };
            var setBack = async function (ns) { var lv = await evalLValue(node.callee.obj, env); lv.set(strGrow(ns)); };
            var chAt = function (i) { return { __cppType: 'char', val: str.charCodeAt(i) || 0 }; };
            switch (name) {
                case 'length': case 'size': return str.length;
                case 'empty': return str.length === 0;
                case 'c_str': case 'data': case 'str': return str;
                case 'capacity': return Math.max(str.length, 15);
                case 'substr': {
                    var st = a.length ? N(a[0]) : 0;
                    if (st > str.length) throw new Error('Dòng ' + node.line + ': substr: vị trí ' + st + ' vượt quá độ dài chuỗi (' + str.length + ').');
                    return a[1] !== undefined ? str.substr(st, N(a[1])) : str.substr(st);
                }
                case 'find': return str.indexOf(S(a[0]), a[1] !== undefined ? N(a[1]) : 0);
                case 'rfind': return a[1] !== undefined ? str.lastIndexOf(S(a[0]), N(a[1])) : str.lastIndexOf(S(a[0]));
                case 'find_first_of': { var f1 = S(a[0]); for (var i1 = a[1] !== undefined ? N(a[1]) : 0; i1 < str.length; i1++) if (f1.indexOf(str[i1]) >= 0) return i1; return -1; }
                case 'find_first_not_of': { var f2 = S(a[0]); for (var i2 = a[1] !== undefined ? N(a[1]) : 0; i2 < str.length; i2++) if (f2.indexOf(str[i2]) < 0) return i2; return -1; }
                case 'find_last_of': { var f3 = S(a[0]); for (var i3 = str.length - 1; i3 >= 0; i3--) if (f3.indexOf(str[i3]) >= 0) return i3; return -1; }
                case 'push_back': await setBack(str + S(a[0])); return 0;
                case 'pop_back': await setBack(str.slice(0, -1)); return 0;
                case 'clear': await setBack(''); return 0;
                case 'append': {
                    if (a.length >= 2 && typeof a[0] !== 'string') { var rc = Math.max(0, N(a[0])); memStr(rc); await setBack(str + S(a[1]).charAt(0).repeat(rc)); return 0; }
                    await setBack(str + S(a[0])); return 0;
                }
                case 'assign': await setBack(S(a[0])); return 0;
                case 'insert': { var ip = isIt(a[0]) ? a[0].idx : N(a[0]); await setBack(str.slice(0, ip) + S(a[1]) + str.slice(ip)); return 0; }
                case 'erase': {
                    var ep = a.length ? (isIt(a[0]) ? a[0].idx : N(a[0])) : 0, el = a.length ? (isIt(a[0]) ? (a[1] && isIt(a[1]) ? a[1].idx - ep : 1) : (a[1] !== undefined ? N(a[1]) : str.length - ep)) : str.length;
                    await setBack(str.slice(0, ep) + str.slice(ep + el)); return 0;
                }
                case 'replace': await setBack(str.slice(0, N(a[0])) + S(a[2]) + str.slice(N(a[0]) + N(a[1]))); return 0;
                case 'resize': { var rn = Math.max(0, N(a[0])); memStr(rn); await setBack(rn <= str.length ? str.slice(0, rn) : str + (a[1] !== undefined ? S(a[1]).charAt(0) : '\0').repeat(rn - str.length)); return 0; }
                case 'compare': { var co = S(a[0]); return str < co ? -1 : str > co ? 1 : 0; }
                case 'back': return chAt(str.length - 1);
                case 'front': return chAt(0);
                case 'at': { var ai = N(a[0]); if (ai < 0 || ai >= str.length) cppThrow('out_of_range', 'basic_string::at: chỉ số ' + ai + ' ngoài phạm vi (độ dài ' + str.length + ')'); return chAt(ai); }
                case 'begin': return { __sit: true, objNode: node.callee.obj, str: str, idx: 0 };
                case 'end': return { __sit: true, objNode: node.callee.obj, str: str, idx: str.length };
                case 'starts_with': return str.startsWith(S(a[0]));
                case 'ends_with': return str.endsWith(S(a[0]));
                case 'swap': { var l2 = await evalLValue(node.args[0], env), l1 = await evalLValue(node.callee.obj, env); var tmpS = l1.get(); l1.set(l2.get()); l2.set(tmpS); return 0; }
            }
            return NOT_HANDLED;
        }
        async function containerMethod(mObj, name, a, node, env) {
            var N = function (x) { return Math.trunc(toNum(x)); };
            if (typeof mObj === 'string') return stringMethod(mObj, name, a, node, env);
            if (!mObj || typeof mObj !== 'object') return NOT_HANDLED;
            // ---- cout / cin ----
            if (mObj.__io === 'cout' || mObj.__io === 'cerr') {
                switch (name) {
                    case 'precision': precisionFmt = N(a[0]); return mObj;
                    case 'width': nextWidth = N(a[0]); return 0;
                    case 'fill': nextFill = formatVal(a[0]).charAt(0) || ' '; return 0;
                    case 'flush': case 'tie': case 'sync_with_stdio': return mObj;
                    case 'put': emitOut(String.fromCharCode(toNum(a[0])), 'out'); return mObj;
                    case 'write': emitOut(String(a[0]).slice(0, N(a[1])), 'out'); return mObj;
                    case 'setf': if (a[0] && a[0].__manip === 'fixed') fixedFmt = true; return 0;
                    case 'unsetf': if (a[0] && a[0].__manip === 'fixed') fixedFmt = false; return 0;
                }
                return NOT_HANDLED;
            }
            if (mObj.__io === 'cin') {
                switch (name) {
                    case 'get': {
                        if (!a.length) { var gc = await readChar(); return { __cppType: 'char', val: gc === null ? -1 : gc.charCodeAt(0) }; }
                        var glv = await evalLValue(node.args[0], env), gc2 = await readChar(); if (gc2 === null) return 0; glv.set({ __cppType: 'char', val: gc2.charCodeAt(0) }); return mObj;
                    }
                    case 'peek': await ensureInput(); return { __cppType: 'char', val: stdinBuf.charCodeAt(stdinPos) };
                    case 'ignore': {
                        var ign = a.length ? N(a[0]) : 1, dl = a[1] !== undefined ? toNum(a[1]) : null, cnt = 0;
                        await ensureInput();
                        while (cnt < ign && stdinPos < stdinBuf.length) { var chc = stdinBuf.charCodeAt(stdinPos++); cnt++; if (dl !== null && chc === dl) break; }
                        return mObj;
                    }
                    case 'getline': { var glv2 = await evalLValue(node.args[0], env), gl2 = await readLine(); if (gl2 === null) return 0; glv2.set(gl2); return mObj; }
                    case 'fail': case 'bad': return false;
                    case 'good': return true;
                    case 'clear': case 'tie': case 'sync_with_stdio': return mObj;
                }
                return NOT_HANDLED;
            }
            // ---- stringstream / ifstream / ofstream ----
            if (mObj.__stl && /stream$/.test(mObj.__stl)) {
                switch (name) {
                    case 'open': {
                        var fname = String(a[0]); mObj.file = fname; mObj.open = true; mObj.fail = false;
                        if (mObj.__stl === 'ofstream') virtualFiles[fname] = '';
                        else { mObj.buf = virtualFiles[fname] !== undefined ? virtualFiles[fname] : ''; mObj.pos = 0; mObj.bad = virtualFiles[fname] === undefined; }
                        return 0;
                    }
                    case 'close': mObj.open = false; return 0;
                    case 'is_open': return !!mObj.open && !mObj.bad;
                    case 'str': if (a.length) { mObj.buf = String(a[0]); mObj.pos = 0; mObj.fail = false; return 0; } return mObj.buf;
                    case 'eof': return !!mObj.fail || mObj.pos >= mObj.buf.length;
                    case 'good': return !mObj.fail && !mObj.bad;
                    case 'fail': case 'bad': return !!mObj.fail || !!mObj.bad;
                    case 'clear': mObj.fail = false; return 0;
                    case 'ignore': mObj.pos += a.length ? N(a[0]) : 1; return mObj;
                    case 'get': {
                        if (mObj.pos >= mObj.buf.length) { mObj.fail = true; return { __cppType: 'char', val: -1 }; }
                        var gch = { __cppType: 'char', val: mObj.buf.charCodeAt(mObj.pos++) };
                        if (a.length) { (await evalLValue(node.args[0], env)).set(gch); return mObj; }
                        return gch;
                    }
                    case 'peek': return { __cppType: 'char', val: mObj.pos < mObj.buf.length ? mObj.buf.charCodeAt(mObj.pos) : -1 };
                    case 'getline': {
                        var slv = await evalLValue(node.args[0], env);
                        if (mObj.pos >= mObj.buf.length) { mObj.fail = true; return mObj; }
                        var mdel = node.args.length >= 2 ? String.fromCharCode(toNum(a[1])) : '\n';
                        var nl = mObj.buf.indexOf(mdel, mObj.pos), ln;
                        if (nl < 0) { ln = mObj.buf.slice(mObj.pos); mObj.pos = mObj.buf.length; } else { ln = mObj.buf.slice(mObj.pos, nl); mObj.pos = nl + mdel.length; }
                        slv.set(ln.replace(/\r$/, '')); return mObj;
                    }
                    case 'put': streamWrite(mObj, String.fromCharCode(toNum(a[0]))); return mObj;
                    case 'write': streamWrite(mObj, String(a[0]).slice(0, N(a[1]))); return mObj;
                    case 'flush': return mObj;
                    case 'seekg': mObj.pos = N(a[0]); mObj.fail = false; return 0;
                    case 'tellg': return mObj.pos;
                }
                return NOT_HANDLED;
            }
            if ((mObj.__stl === 'set' || mObj.__stl === 'map') && mObj.keyStruct) await ensureSorted(mObj, env);
            // ---- bitset ----
            if (mObj.__stl === 'bitset') {
                var bn = mObj.n, ONE = function (i) { return 1n << BigInt(i); };
                var chk = function (i) { if (i < 0 || i >= bn) throw new Error('Dòng ' + node.line + ': bitset: chỉ số ' + i + ' ngoài phạm vi (' + bn + ').'); return i; };
                switch (name) {
                    case 'set': if (!a.length) mObj.v = bsMask(bn); else mObj.v = (a[1] === undefined || toNum(a[1])) ? (mObj.v | ONE(chk(N(a[0])))) : (mObj.v & ~ONE(chk(N(a[0])))); return mObj;
                    case 'reset': if (!a.length) mObj.v = 0n; else mObj.v &= ~ONE(chk(N(a[0]))); return mObj;
                    case 'flip': if (!a.length) mObj.v = (~mObj.v) & bsMask(bn); else mObj.v ^= ONE(chk(N(a[0]))); return mObj;
                    case 'test': return ((mObj.v >> BigInt(chk(N(a[0])))) & 1n) === 1n;
                    case 'count': { var cnt2 = 0, tv = mObj.v; while (tv) { cnt2 += Number(tv & 1n); tv >>= 1n; } return cnt2; }
                    case 'size': return bn;
                    case 'any': return mObj.v !== 0n;
                    case 'none': return mObj.v === 0n;
                    case 'all': return mObj.v === bsMask(bn);
                    case 'to_string': return bsStr(mObj);
                    case 'to_ulong': case 'to_ullong': return normBig(mObj.v);
                }
                return NOT_HANDLED;
            }
            // ---- vector / deque ----
            if (mObj.__stl === 'vector' || mObj.__stl === 'deque') {
                var D = mObj.data, ptrEl = mObj.et && mObj.et.ptr > 0;
                var mk = function (x) { return ptrEl ? x : cloneVal(coerceElem(mObj.et, x)); };
                var dflt = function () { var f = mObj.et ? defaultVal(mObj.et, []) : 0; return f; };
                switch (name) {
                    case 'push_back': D.push(mk(a[0])); memCharge(mObj, 8); return 0;
                    case 'emplace_back': D.push(a.length > 1 ? { __stl: 'pair', first: a[0], second: a[1] } : mk(a[0])); memCharge(mObj, 8); return 0;
                    case 'push_front': D.unshift(mk(a[0])); memCharge(mObj, 8); return 0;
                    case 'pop_back': D.pop(); memCharge(mObj, -8); return 0;
                    case 'pop_front': D.shift(); memCharge(mObj, -8); return 0;
                    case 'size': return D.length;
                    case 'max_size': return 2147483647;
                    case 'capacity': return D.length;
                    case 'empty': return D.length === 0;
                    case 'clear': D.length = 0; memRelease(mObj); return 0;
                    case 'back': return D[D.length - 1];
                    case 'front': return D[0];
                    case 'data': return D;
                    case 'reserve': case 'shrink_to_fit': return 0;
                    case 'at': { var ai = N(a[0]); if (ai < 0 || ai >= D.length) cppThrow('out_of_range', 'vector::at: chỉ số ' + ai + ' ngoài phạm vi (size ' + D.length + ')'); return D[ai]; }
                    case 'begin': return { __iter: D, idx: 0 };
                    case 'end': return { __iter: D, idx: D.length };
                    case 'resize': {
                        var sz = Math.max(0, N(a[0])), old = D.length;
                        if (sz > old) memReserve((sz - old) * 8);
                        if (sz < old) D.length = sz;
                        else for (var q = old; q < sz; q++) { var fv = a[1] !== undefined ? a[1] : dflt(); D.push(fv && typeof fv === 'object' && !fv.__cppType ? cloneVal(fv) : fv); if ((q & 8191) === 8191) checkStop(); }
                        memCharge(mObj, (sz - old) * 8); return 0;
                    }
                    case 'assign': {
                        D.length = 0; memRelease(mObj);
                        if (isIt(a[0]) && a[0].__iter) { var src = a[0].__iter.slice(a[0].idx, a[1].idx); src.forEach(function (x) { D.push(cloneVal(x)); }); }
                        else { var an = Math.max(0, N(a[0])); memReserve(an * 8); for (var q2 = 0; q2 < an; q2++) D.push(mk(a[1] !== undefined ? a[1] : dflt())); }
                        memCharge(mObj, D.length * 8); return 0;
                    }
                    case 'insert': case 'emplace': {
                        var pos = isIt(a[0]) ? a[0].idx : N(a[0]), items;
                        if (a.length >= 3 && isIt(a[1]) && a[1].__iter) items = a[1].__iter.slice(a[1].idx, a[2].idx).map(cloneVal);
                        else if (a.length === 3) { items = []; for (var q3 = 0; q3 < N(a[1]); q3++) items.push(mk(a[2])); }
                        else items = [mk(a[1])];
                        memReserve(items.length * 8);
                        D.splice.apply(D, [pos, 0].concat(items)); memCharge(mObj, items.length * 8);
                        return { __iter: D, idx: pos };
                    }
                    case 'erase': {
                        var ep = isIt(a[0]) ? a[0].idx : N(a[0]), en = a[1] !== undefined && isIt(a[1]) ? a[1].idx - ep : 1;
                        if (en > 0) { D.splice(ep, en); memCharge(mObj, -8 * en); }
                        return { __iter: D, idx: ep };
                    }
                    case 'swap': { var o = a[0]; if (o && o.data) { var t = mObj.data; mObj.data = o.data; o.data = t; } return 0; }
                }
                return NOT_HANDLED;
            }
            // ---- stack / queue ----
            if (mObj.__stl === 'stack' || mObj.__stl === 'queue') {
                var SD = mObj.data;
                switch (name) {
                    case 'push': case 'emplace': SD.push(mObj.et && mObj.et.ptr > 0 ? a[0] : cloneVal(coerceElem(mObj.et, a[0]))); memCharge(mObj, 8); return 0;
                    case 'pop': if (!SD.length) throw new Error('Dòng ' + node.line + ': pop() trên ' + mObj.__stl + ' rỗng.'); if (mObj.__stl === 'stack') SD.pop(); else SD.shift(); memCharge(mObj, -8); return 0;
                    case 'top': case 'back': if (!SD.length) throw new Error('Dòng ' + node.line + ': ' + name + '() trên ' + mObj.__stl + ' rỗng.'); return SD[SD.length - 1];
                    case 'front': if (!SD.length) throw new Error('Dòng ' + node.line + ': front() trên queue rỗng.'); return SD[0];
                    case 'size': return SD.length;
                    case 'empty': return SD.length === 0;
                    case 'swap': { var so = a[0]; if (so && so.data) { var ts = mObj.data; mObj.data = so.data; so.data = ts; } return 0; }
                }
                return NOT_HANDLED;
            }
            // ---- priority_queue ----
            if (mObj.__stl === 'pq') {
                switch (name) {
                    case 'push': case 'emplace': await pqPush(mObj, mObj.et && mObj.et.ptr > 0 ? a[0] : cloneVal(coerceElem(mObj.et, a[0])), env); return 0;
                    case 'pop': if (!mObj.data.length) throw new Error('Dòng ' + node.line + ': pop() trên priority_queue rỗng.'); await pqPop(mObj, env); return 0;
                    case 'top': if (!mObj.data.length) throw new Error('Dòng ' + node.line + ': top() trên priority_queue rỗng.'); return mObj.data[0];
                    case 'size': return mObj.data.length;
                    case 'empty': return mObj.data.length === 0;
                }
                return NOT_HANDLED;
            }
            // ---- set / multiset ----
            if (mObj.__stl === 'set') {
                switch (name) {
                    case 'insert': case 'emplace': {
                        if (isIt(a[0]) && a.length === 2) { var rr = a[0].__iter; if (rr) for (var ri = a[0].idx; ri < a[1].idx; ri++) setAdd(mObj, rr[ri]); return 0; }
                        if (Array.isArray(a[0]) && node.args[0] && node.args[0].type === 'init_list' && !(mObj.et && (structs[mObj.et.base] || mObj.et.base === 'pair' || mObj.et.base === 'vector' || mObj.et.base === 'tuple'))) { a[0].forEach(function (x) { setAdd(mObj, x); }); return 0; }
                        return insResult(mObj, a[0], setAdd(mObj, a[0]));
                    }
                    case 'erase': {
                        var ks;
                        if (isIt(a[0])) ks = a[0].keys[a[0].pos]; else ks = keyStr(a[0]);
                        if (ks === undefined || !mObj.data.has(ks)) return 0;
                        var c = mObj.multi && !isIt(a[0]) ? (mObj.cnt.get(ks) || 1) : 1;
                        if (mObj.multi && isIt(a[0]) && (mObj.cnt.get(ks) || 1) > 1) mObj.cnt.set(ks, mObj.cnt.get(ks) - 1);
                        else { mObj.data.delete(ks); mObj.cnt.delete(ks); mObj.ver++; }
                        memCharge(mObj, -48 * c); return c;
                    }
                    case 'count': { var ck = keyStr(a[0]); return mObj.data.has(ck) ? (mObj.multi ? (mObj.cnt.get(ck) || 1) : 1) : 0; }
                    case 'contains': return mObj.data.has(keyStr(a[0]));
                    case 'find': return findIt(mObj, a[0]);
                    case 'lower_bound': return mkMIt(mObj, mObj.keyStruct ? await lowerPosA(mObj, a[0], false, env) : lowerPos(mObj, a[0], false));
                    case 'upper_bound': return mkMIt(mObj, mObj.keyStruct ? await lowerPosA(mObj, a[0], true, env) : lowerPos(mObj, a[0], true));
                    case 'begin': return mkMIt(mObj, 0);
                    case 'end': return mkMIt(mObj, mapKeys(mObj).length);
                    case 'rbegin': return mkMIt(mObj, mapKeys(mObj).length - 1);
                    case 'size': { if (!mObj.multi) return mObj.data.size; var tot = 0; mObj.cnt.forEach(function (v) { tot += v; }); return tot; }
                    case 'empty': return mObj.data.size === 0;
                    case 'clear': mObj.data.clear(); mObj.cnt.clear(); mObj.ver++; memRelease(mObj); return 0;
                }
                return NOT_HANDLED;
            }
            // ---- map / multimap ----
            if (mObj.__stl === 'map') {
                switch (name) {
                    case 'insert': case 'emplace': case 'insert_or_assign': case 'try_emplace': {
                        if (Array.isArray(a[0]) && node.args[0] && node.args[0].type === 'init_list' && Array.isArray(a[0][0])) { a[0].forEach(function (e) { var pe = pfOf(e); if (pe && !mObj.data.has(keyStr(pe[0]))) mapPut(mObj, pe[0], pe[1]); }); return 0; }
                        var kv = a.length >= 2 && name !== 'insert' ? [a[0], a[1]] : pfOf(a[0]);
                        if (!kv) return 0;
                        var had = mObj.data.has(keyStr(kv[0]));
                        if (!had || name === 'insert_or_assign') mapPut(mObj, kv[0], cloneVal(coerceElem(mObj.vt, kv[1])));
                        return insResult(mObj, kv[0], !had);
                    }
                    case 'at': { var ak = keyStr(a[0]); if (!mObj.data.has(ak)) cppThrow('out_of_range', 'map::at: không có khoá này'); return mObj.data.get(ak); }
                    case 'count': return mObj.data.has(keyStr(a[0])) ? 1 : 0;
                    case 'contains': return mObj.data.has(keyStr(a[0]));
                    case 'find': return findIt(mObj, a[0]);
                    case 'erase': {
                        var ek = isIt(a[0]) ? a[0].keys[a[0].pos] : keyStr(a[0]);
                        if (ek === undefined || !mObj.data.has(ek)) return 0;
                        mObj.data.delete(ek); mObj.orig.delete(ek); mObj.ver++; memCharge(mObj, -48); return 1;
                    }
                    case 'lower_bound': return mkMIt(mObj, mObj.keyStruct ? await lowerPosA(mObj, a[0], false, env) : lowerPos(mObj, a[0], false));
                    case 'upper_bound': return mkMIt(mObj, mObj.keyStruct ? await lowerPosA(mObj, a[0], true, env) : lowerPos(mObj, a[0], true));
                    case 'begin': return mkMIt(mObj, 0);
                    case 'end': return mkMIt(mObj, mapKeys(mObj).length);
                    case 'rbegin': return mkMIt(mObj, mapKeys(mObj).length - 1);
                    case 'size': return mObj.data.size;
                    case 'empty': return mObj.data.size === 0;
                    case 'clear': mObj.data.clear(); mObj.orig.clear(); mObj.ver++; memRelease(mObj); return 0;
                }
                return NOT_HANDLED;
            }
            return NOT_HANDLED;
        }

        async function callStdFunc(fn, node, env) {
            var args = [];
            for (var i = 0; i < node.args.length; i++) args.push(await evalExpr(node.args[i], env));

            switch (fn) {
                case 'greater': return { __cmp: 'desc' };
                case 'less': return { __cmp: 'asc' };
                case 'setprecision': return { __manip: 'setprecision', n: Math.trunc(toNum(args[0])) };
                case 'setw': return { __manip: 'setw', n: Math.trunc(toNum(args[0])) };
                case 'setfill': return { __manip: 'setfill', c: formatVal(args[0]).charAt(0) || ' ' };
                case 'getline': {
                    var target = await evalLValue(node.args[1], env);
                    var gs = args[0];
                    if (gs && gs.__stl && /stream$/.test(gs.__stl)) {
                        if (gs.pos >= gs.buf.length) { gs.fail = true; return 0; }
                        var gdel = node.args.length >= 3 ? String.fromCharCode(toNum(args[2])) : '\n';
                        var gnl = gs.buf.indexOf(gdel, gs.pos), gln;
                        if (gnl < 0) { gln = gs.buf.slice(gs.pos); gs.pos = gs.buf.length; } else { gln = gs.buf.slice(gs.pos, gnl); gs.pos = gnl + gdel.length; }
                        target.set(gln.replace(/\r$/, ''));
                        return gs;
                    }
                    var gl0 = await readLine();
                    if (gl0 === null) return 0;
                    target.set(gl0);
                    return args[0];
                }
                case 'isxdigit': return /[0-9A-Fa-f]/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'ispunct': return /[!-\/:-@\[-`{-~]/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'isprint': { var pc = toNum(args[0]); return pc >= 32 && pc < 127 ? 1 : 0; }
                case 'sqrtl': return Math.sqrt(toNum(args[0]));
                case 'powl': return Math.pow(toNum(args[0]), toNum(args[1]));
                case 'abs_': return 0;
                case 'strcpy': case 'strncpy': {
                    var scl = await evalLValue(node.args[0], env), ssrc = String(typeof args[1] === 'string' ? args[1] : formatVal(args[1]));
                    scl.set(fn === 'strncpy' ? ssrc.slice(0, Math.trunc(toNum(args[2]))) : ssrc); return args[0];
                }
                case 'strcat': { var sct = await evalLValue(node.args[0], env); sct.set(strGrow(String(sct.get()) + String(args[1]))); return args[0]; }
                case 'strcspn': { var cs1 = String(args[0]), cs2 = String(args[1]), ci0 = 0; while (ci0 < cs1.length && cs2.indexOf(cs1[ci0]) < 0) ci0++; return ci0; }
                case 'strspn': { var ss1 = String(args[0]), ss2 = String(args[1]), si0 = 0; while (si0 < ss1.length && ss2.indexOf(ss1[si0]) >= 0) si0++; return si0; }
                case 'strrchr': { var rci = String(args[0]).lastIndexOf(String.fromCharCode(toNum(args[1]))); return rci < 0 ? 0 : String(args[0]).slice(rci); }
                case 'strdup': return String(args[0]);
                case 'memcmp': { var m1 = String(args[0]), m2 = String(args[1]); return m1 < m2 ? -1 : m1 > m2 ? 1 : 0; }
                case 'strncmp': { var n1 = String(args[0]).slice(0, toNum(args[2])), n2 = String(args[1]).slice(0, toNum(args[2])); return n1 < n2 ? -1 : n1 > n2 ? 1 : 0; }
                case 'strchr': { var sci = String(args[0]).indexOf(String.fromCharCode(toNum(args[1]))); return sci < 0 ? 0 : String(args[0]).slice(sci); }
                case 'strstr': { var ssi = String(args[0]).indexOf(String(args[1])); return ssi < 0 ? 0 : String(args[0]).slice(ssi); }
                case 'getchar': { var gch0 = await readChar(); return gch0 === null ? -1 : { __cppType: 'char', val: gch0.charCodeAt(0) }; }
                case 'putchar': emitOut(String.fromCharCode(toNum(args[0])), 'out'); return args[0];
                case 'puts': emitOut(formatVal(args[0]) + '\n', 'out'); return 0;
                case 'printf': emitOut(cPrintf(String(args[0] || ''), args.slice(1)), 'out'); return 0;
                case 'sprintf': {
                    var sOut = cPrintf(String(args[1] || ''), args.slice(2));
                    var slv = await evalLValue(node.args[0], env);
                    slv.set(sOut);
                    return sOut.length;
                }
                case 'scanf': case 'fscanf': case 'sscanf': {
                    var isF = fn === 'fscanf', isS = fn === 'sscanf';
                    var fmtIdx = isF || isS ? 1 : 0, fmt = String(args[fmtIdx] || '');
                    var srcStr = isS ? String(args[0]) : null, srcPos = 0;
                    var rdTok = async function () {
                        if (isS) { var m0 = /^\s*(\S+)/.exec(srcStr.slice(srcPos)); if (!m0) return null; srcPos += m0[0].length; return m0[1]; }
                        return await readToken();
                    };
                    var rdChar = async function (skipWs) {
                        if (isS) { if (skipWs) while (srcPos < srcStr.length && /\s/.test(srcStr[srcPos])) srcPos++; return srcPos < srcStr.length ? srcStr[srcPos++] : null; }
                        if (skipWs) { await ensureInput(); while (stdinPos < stdinBuf.length && /\s/.test(stdinBuf[stdinPos])) stdinPos++; }
                        return await readChar();
                    };
                    var re = /(\s+)|%(\*?)(\d*)(hh|h|ll|l|z|L)?(\[\^?[^\]]*\]|[diouxXfFeEgGcsn%])|([^%\s])/g, mm, argi = fmtIdx + 1, done = 0, prevWs = false, failed = false;
                    while ((mm = re.exec(fmt)) && !failed) {
                        if (mm[1]) { prevWs = true; continue; }
                        if (mm[6]) { var lit = await rdChar(true); if (lit !== mm[6]) failed = true; prevWs = false; continue; }
                        var skip = mm[2] === '*', conv = mm[5];
                        if (conv === '%') { await rdChar(true); continue; }
                        if (conv === 'n') continue;
                        var dst = null;
                        if (!skip) { if (argi >= node.args.length) break; dst = await evalLValue(node.args[argi++], env); }
                        if (conv === 'c') {
                            var ch = await rdChar(prevWs); if (ch === null) { failed = true; break; }
                            if (dst) dst.set({ __cppType: 'char', val: ch.charCodeAt(0) });
                        } else if (conv[0] === '[') {
                            var neg = conv[1] === '^', setS = conv.slice(neg ? 2 : 1, -1), outS = '', c2;
                            if (!isS) await ensureInput();
                            while (true) {
                                if (isS) { c2 = srcPos < srcStr.length ? srcStr[srcPos] : null; } else c2 = stdinPos < stdinBuf.length ? stdinBuf[stdinPos] : null;
                                if (c2 === null || (setS.indexOf(c2) >= 0) === neg) break;
                                outS += c2; if (isS) srcPos++; else stdinPos++;
                            }
                            if (dst) dst.set(outS);
                        } else {
                            var tk = await rdTok(); if (tk === null) { failed = true; break; }
                            if (mm[3]) { var wN = parseInt(mm[3], 10); if (tk.length > wN) { if (!isS) stdinPos -= tk.length - wN; else srcPos -= tk.length - wN; tk = tk.slice(0, wN); } }
                            if (conv === 's') { if (dst) dst.set(tk); }
                            else if (/[fFeEgG]/.test(conv)) { var fv = parseFloat(tk); if (isNaN(fv)) { failed = true; break; } if (dst) dst.set(fv); }
                            else if (conv === 'x' || conv === 'X') { if (dst) dst.set(parseInt(tk, 16) || 0); }
                            else if (conv === 'o') { if (dst) dst.set(parseInt(tk, 8) || 0); }
                            else { if (!/^[+-]?\d/.test(tk)) { failed = true; break; } if (dst) dst.set(parseTok(tk.match(/^[+-]?\d+/)[0])); }
                        }
                        if (!skip) done++;
                        prevWs = false;
                    }
                    return done;
                }
                case 'fgets': {
                    var fgl = await evalLValue(node.args[0], env), fgN = Math.trunc(toNum(args[1])) || 1000;
                    var fgs = args[2];
                    if (fgs && fgs.__stl && /stream$/.test(fgs.__stl)) return 0;
                    await ensureInput();
                    if (stdinPos >= stdinBuf.length) return 0;
                    var fgLine = await readLineRaw();
                    fgl.set(fgLine.slice(0, fgN - 1));
                    return args[0];
                }
                case 'gets': { var gl = await evalLValue(node.args[0], env), gl1 = await readLine(); if (gl1 === null) return 0; gl.set(gl1); return args[0]; }
                case 'fputs': case 'puts_': { emitOut(formatVal(args[0]), 'out'); return 0; }
                case 'fputc': case 'putc': emitOut(String.fromCharCode(toNum(args[0])), 'out'); return args[0];
                case 'fprintf': { var tgt = args[0]; var ftxt = cPrintf(String(args[1] || ''), args.slice(2)); emitOut(ftxt, tgt === 'stderr' ? 'err' : 'out'); return ftxt.length; }
                case 'fflush': case 'setvbuf': case 'setbuf': case 'fclose': return 0;
                case 'malloc': case 'calloc': { var mn = Math.max(0, Math.trunc(toNum(fn === 'calloc' ? args[0] * args[1] : args[0]))); memReserve(mn * 8); var ma2 = new Array(Math.ceil(mn / 4)).fill(0); memCharge(ma2, mn * 2); return ma2; }
                case 'realloc': { var ra = Array.isArray(args[0]) ? args[0] : []; var rn = Math.ceil(Math.max(0, Math.trunc(toNum(args[1]))) / 4); while (ra.length < rn) ra.push(0); return ra; }
                case 'free': memRelease(args[0]); return 0;
                case 'strtol': case 'strtoll': case 'strtoul': case 'strtoull': { var stm = /^\s*[+-]?\d+/.exec(String(args[0])); var base = args[2] !== undefined ? Math.trunc(toNum(args[2])) : 10; return stm ? (base === 10 ? parseTok(stm[0].trim()) : (parseInt(String(args[0]).trim(), base) || 0)) : 0; }
                case 'strtod': return parseFloat(String(args[0])) || 0;
                case 'exit_': return 0;
                case 'freopen': {
                    var fName = String(args[0] || ''), mode = String(args[1] || '');
                    if (mode.indexOf('r') >= 0) {
                        stdinBuf = virtualFiles[fName] !== undefined ? virtualFiles[fName] : '';
                        stdinPos = 0;
                    } else if (mode.indexOf('w') >= 0) {
                        stdoutFile = fName;
                        virtualFiles[fName] = '';
                    }
                    return 1;
                }
                case 'system': {
                    var cmd = String(args[0] || '');
                    if (cmd.indexOf('pause') === 0) { emitOut('Press any key to continue . . . ', 'out'); await readChar(); }
                    else if (cmd === 'cls' || cmd === 'clear') { emitOut('\x1b[2J\x1b[H', 'out'); }
                    return 0;
                }
                // Toán học
                case 'abs': case 'fabs': case 'labs': case 'llabs': return typeof args[0] === 'bigint' ? normBig(args[0] < 0n ? -args[0] : args[0]) : Math.abs(toNum(args[0]));
                case 'sqrt': return Math.sqrt(toNum(args[0]));
                case 'cbrt': return Math.cbrt(toNum(args[0]));
                case 'pow': return Math.pow(toNum(args[0]), toNum(args[1]));
                case 'floor': return Math.floor(toNum(args[0]));
                case 'ceil': return Math.ceil(toNum(args[0]));
                case 'round': return Math.round(toNum(args[0]));
                case 'trunc': return Math.trunc(toNum(args[0]));
                case 'fmod': return toNum(args[0]) % toNum(args[1]);
                case 'hypot': return Math.hypot(toNum(args[0]), toNum(args[1]));
                case 'sin': return Math.sin(toNum(args[0]));
                case 'cos': return Math.cos(toNum(args[0]));
                case 'tan': return Math.tan(toNum(args[0]));
                case 'asin': return Math.asin(toNum(args[0]));
                case 'acos': return Math.acos(toNum(args[0]));
                case 'atan': return Math.atan(toNum(args[0]));
                case 'atan2': return Math.atan2(toNum(args[0]), toNum(args[1]));
                case 'log': return Math.log(toNum(args[0]));
                case 'log2': return Math.log2(toNum(args[0]));
                case 'log10': return Math.log10(toNum(args[0]));
                case 'exp': return Math.exp(toNum(args[0]));
                case 'min': case 'max': {
                    var mmv = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
                    var mmCmp = (args.length === 3 && args[2] && (args[2].__lambda || args[2].__fn)) ? args[2] : null;
                    if (mmCmp) mmv = args.slice(0, 2);
                    var mmLess = makeLess(mmCmp, env), mmBest = mmv[0];
                    for (var mmi = 1; mmi < mmv.length; mmi++) { if (fn === 'min' ? await mmLess(mmv[mmi], mmBest) : await mmLess(mmBest, mmv[mmi])) mmBest = mmv[mmi]; }
                    return mmBest;
                }
                case 'string': return makeObj({ base: 'string', templateArgs: null, ptr: 0 }, args, node.args, env);
                case '__gcd': case 'gcd': return gcd(Math.trunc(toNum(args[0])), Math.trunc(toNum(args[1])));
                case 'lcm': {
                    var g = gcd(Math.trunc(toNum(args[0])), Math.trunc(toNum(args[1])));
                    return g ? Math.abs(Math.trunc(toNum(args[0])) / g * Math.trunc(toNum(args[1]))) : 0;
                }
                case 'srand': rngState = Math.trunc(toNum(args[0])) || 1; return 0;
                case 'rand': rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState % 32768;
                case 'time': return Math.floor(Date.now() / 1000);
                case 'clock': return Date.now() - startedAt;
                case 'exit': throw { __halt: 'exit', code: Math.trunc(toNum(args[0] || 0)) };
                // Chuỗi & ký tự
                case 'stoi': case 'atoi': case 'stol': case 'stoll': case 'atol': case 'atoll': case 'stoul': case 'stoull': { var sm = /^\s*[+-]?\d+/.exec(String(args[0])); return sm ? parseTok(sm[0].trim()) : 0; }
                case 'stod': case 'stof': case 'atof': return parseFloat(String(args[0])) || 0;
                case 'to_string': return formatVal(args[0]);
                case 'strlen': return String(args[0] || '').length;
                case 'strcmp': { var sa = String(args[0]), sb = String(args[1]); return sa < sb ? -1 : sa > sb ? 1 : 0; }
                case 'isdigit': return /[0-9]/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'isalpha': return /[A-Za-z]/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'isalnum': return /[A-Za-z0-9]/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'islower': return /[a-z]/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'isupper': return /[A-Z]/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'isspace': return /\s/.test(String.fromCharCode(toNum(args[0]))) ? 1 : 0;
                case 'toupper': return { __cppType: 'char', val: String.fromCharCode(toNum(args[0])).toUpperCase().charCodeAt(0) };
                case 'tolower': return { __cppType: 'char', val: String.fromCharCode(toNum(args[0])).toLowerCase().charCodeAt(0) };
                // STL & Algorithm
                case 'make_pair': return { __stl: 'pair', first: args[0], second: args[1] };
                case 'swap': {
                    var la = await evalLValue(node.args[0], env), lb = await evalLValue(node.args[1], env);
                    var tmp = la.get(); la.set(lb.get()); lb.set(tmp);
                    return 0;
                }
                case 'sort': case 'stable_sort': case 'partial_sort': {
                    if (args[0] && args[0].__sit) {                      // sort(s.begin(), s.end()) trên std::string
                        var sslv = await evalLValue(args[0].objNode, env), sstr = String(sslv.get());
                        sslv.set(sstr.slice(0, args[0].idx) + sstr.slice(args[0].idx, args[1].idx).split('').sort(args[2] && args[2].__cmp === 'desc' ? function (x, y) { return x < y ? 1 : x > y ? -1 : 0; } : undefined).join('') + sstr.slice(args[1].idx));
                        return 0;
                    }
                    var sr = getRange(args[0], args[1]);
                    await sortArr(sr.arr, sr.l, sr.r, args[2], env);
                    return 0;
                }
                case 'reverse': {
                    if (args[0] && args[0].__sit) {
                        var rslv = await evalLValue(args[0].objNode, env), rstr = String(rslv.get());
                        rslv.set(rstr.slice(0, args[0].idx) + rstr.slice(args[0].idx, args[1].idx).split('').reverse().join('') + rstr.slice(args[1].idx));
                        return 0;
                    }
                    var rs = getRange(args[0], args[1]);
                    var rsub = rs.arr.slice(rs.l, rs.r).reverse();
                    for (var ri = 0; ri < rsub.length; ri++) rs.arr[rs.l + ri] = rsub[ri];
                    return 0;
                }
                case 'fill': case 'fill_n': {
                    if (fn === 'fill_n') { var fb = args[0].__iter ? args[0] : { __iter: args[0], idx: 0 }; for (var fni = 0; fni < toNum(args[1]); fni++) fb.__iter[fb.idx + fni] = args[2]; return 0; }
                    var fs = getRange(args[0], args[1]);
                    for (var fi = fs.l; fi < fs.r; fi++) fs.arr[fi] = cloneVal(args[2]);
                    return 0;
                }
                case 'accumulate': {
                    var acs = getRange(args[0], args[1]), acc = args[2] !== undefined ? args[2] : 0, aop = args[3];
                    for (var aci = acs.l; aci < acs.r; aci++) {
                        if (aop && (aop.__lambda || aop.__fn)) acc = await callFnVal(aop, [acc, acs.arr[aci]], [], env);
                        else if (typeof acc === 'string') acc += formatVal(acs.arr[aci]);
                        else acc = toNum(acc) + toNum(acs.arr[aci]);
                    }
                    return acc;
                }
                case 'memset': {
                    var mlv = await evalLValue(node.args[0], env);
                    var ma = mlv.get();
                    var byteV = Math.trunc(toNum(args[1])) & 255;
                    var memVal = byteV === 0 ? 0 : byteV === 255 ? -1 : byteV * 16843009;       // 0x3f → 0x3f3f3f3f (mẫu INF quen thuộc)
                    if (Array.isArray(ma)) fillNested(ma, memVal);
                    else if (typeof ma === 'string') mlv.set(String.fromCharCode(byteV).repeat(Math.max(0, Math.trunc(toNum(args[2])))));
                    return 0;
                }
                case 'memcpy': case 'copy': case 'copy_n': {
                    if (fn === 'memcpy') { var md = await evalLValue(node.args[0], env); if (Array.isArray(args[0]) && Array.isArray(args[1])) { for (var mci = 0; mci < Math.min(args[0].length, args[1].length); mci++) args[0][mci] = args[1][mci]; } else md.set(args[1]); return 0; }
                    var cs = getRange(args[0], args[1]), cd = args[2].__iter ? args[2] : { __iter: args[2], idx: 0 };
                    for (var cpi = cs.l; cpi < cs.r; cpi++) cd.__iter[cd.idx + cpi - cs.l] = cs.arr[cpi];
                    return { __iter: cd.__iter, idx: cd.idx + cs.r - cs.l };
                }
                case 'lower_bound': case 'upper_bound': case 'binary_search': {
                    var lb = getRange(args[0], args[1]), lbKey = args[2], lbLess = makeLess(args[3], env), lo = lb.l, hi = lb.r;
                    while (lo < hi) {
                        var mid = (lo + hi) >> 1;
                        var right = fn === 'upper_bound' ? !(await lbLess(lbKey, lb.arr[mid])) : await lbLess(lb.arr[mid], lbKey);
                        if (right) lo = mid + 1; else hi = mid;
                    }
                    if (fn === 'binary_search') return lo < lb.r && !(await lbLess(lbKey, lb.arr[lo]));
                    return { __iter: lb.arr, idx: lo };
                }
                case 'max_element': case 'min_element': {
                    var me = getRange(args[0], args[1]);
                    if (me.l >= me.r) return { __iter: me.arr, idx: me.r };
                    var meLess = makeLess(args[2], env), best = me.l;
                    for (var mei = me.l + 1; mei < me.r; mei++) { if (fn === 'max_element' ? await meLess(me.arr[best], me.arr[mei]) : await meLess(me.arr[mei], me.arr[best])) best = mei; }
                    return { __iter: me.arr, idx: best };
                }
                case 'next_permutation': case 'prev_permutation': {
                    if (args[0] && args[0].__sit) {
                        var npSlv = await evalLValue(args[0].objNode, env), npStr = String(npSlv.get());
                        var npL = args[0].idx, npR = args[1] && args[1].__sit ? args[1].idx : npStr.length;
                        var npA = npStr.slice(npL, npR).split(''), npSgn = fn === 'next_permutation' ? 1 : -1, ni = npA.length - 2;
                        while (ni >= 0 && npSgn * (npA[ni] < npA[ni + 1] ? -1 : npA[ni] > npA[ni + 1] ? 1 : 0) >= 0) ni--;
                        if (ni < 0) { npA.reverse(); npSlv.set(npStr.slice(0, npL) + npA.join('') + npStr.slice(npR)); return false; }
                        var nj = npA.length - 1;
                        while (npSgn * (npA[ni] < npA[nj] ? -1 : npA[ni] > npA[nj] ? 1 : 0) >= 0) nj--;
                        var nt = npA[ni]; npA[ni] = npA[nj]; npA[nj] = nt;
                        var ntail = npA.slice(ni + 1).reverse();
                        for (var nq = 0; nq < ntail.length; nq++) npA[ni + 1 + nq] = ntail[nq];
                        npSlv.set(npStr.slice(0, npL) + npA.join('') + npStr.slice(npR));
                        return true;
                    }
                    var np = getRange(args[0], args[1]), a = np.arr, L = np.l, R = np.r - 1, sgn = fn === 'next_permutation' ? 1 : -1;
                    var ii = R - 1;
                    while (ii >= L && sgn * cmpVals(a[ii], a[ii + 1]) >= 0) ii--;
                    if (ii < L) { var rv2 = a.slice(L, R + 1).reverse(); for (var q = 0; q < rv2.length; q++) a[L + q] = rv2[q]; return false; }
                    var jj = R;
                    while (sgn * cmpVals(a[ii], a[jj]) >= 0) jj--;
                    var tt = a[ii]; a[ii] = a[jj]; a[jj] = tt;
                    var tail = a.slice(ii + 1, R + 1).reverse();
                    for (var q2 = 0; q2 < tail.length; q2++) a[ii + 1 + q2] = tail[q2];
                    return true;
                }
                case 'iota': { var io = getRange(args[0], args[1]), iv = toNum(args[2]); for (var ioi = io.l; ioi < io.r; ioi++) io.arr[ioi] = iv++; return 0; }
                case 'unique': {
                    var un = getRange(args[0], args[1]), uo = [];
                    for (var ui = un.l; ui < un.r; ui++) if (!uo.length || cmpVals(uo[uo.length - 1], un.arr[ui]) !== 0) uo.push(un.arr[ui]);
                    for (var uj = 0; uj < uo.length; uj++) un.arr[un.l + uj] = uo[uj];
                    return { __iter: un.arr, idx: un.l + uo.length };
                }
                case 'count': case 'find': {
                    var cf = getRange(args[0], args[1]), cn = 0;
                    for (var cfi = cf.l; cfi < cf.r; cfi++) {
                        if (cmpVals(cf.arr[cfi], args[2]) === 0) { if (fn === 'find') return { __iter: cf.arr, idx: cfi }; cn++; }
                    }
                    return fn === 'find' ? { __iter: cf.arr, idx: cf.r } : cn;
                }
                case 'count_if': case 'find_if': case 'all_of': case 'any_of': case 'none_of': case 'for_each': case 'remove_if': {
                    var pf = getRange(args[0], args[1]), pred = args[2], pc2 = 0, kept = [];
                    for (var pfi = pf.l; pfi < pf.r; pfi++) {
                        var pr = await callFnVal(pred, [pf.arr[pfi]], [], env);
                        if (fn === 'for_each') continue;
                        if (toNum(pr)) {
                            if (fn === 'find_if') return { __iter: pf.arr, idx: pfi };
                            if (fn === 'any_of') return true;
                            if (fn === 'none_of') return false;
                            pc2++;
                        } else {
                            if (fn === 'all_of') return false;
                            if (fn === 'remove_if') kept.push(pf.arr[pfi]);
                        }
                    }
                    if (fn === 'for_each') return pred;
                    if (fn === 'find_if') return { __iter: pf.arr, idx: pf.r };
                    if (fn === 'all_of') return true;
                    if (fn === 'any_of') return false;
                    if (fn === 'none_of') return true;
                    if (fn === 'remove_if') { for (var rk = 0; rk < kept.length; rk++) pf.arr[pf.l + rk] = kept[rk]; return { __iter: pf.arr, idx: pf.l + kept.length }; }
                    return pc2;
                }
                case 'rotate': {
                    var rt = args[0], rm = args[1], rl = args[2];
                    var rarr = rt.__iter, seg = rarr.slice(rt.idx, rl.idx), k = rm.idx - rt.idx;
                    seg = seg.slice(k).concat(seg.slice(0, k));
                    for (var rti = 0; rti < seg.length; rti++) rarr[rt.idx + rti] = seg[rti];
                    return { __iter: rarr, idx: rt.idx + seg.length - k };
                }
                case 'partial_sum': {
                    var ps = getRange(args[0], args[1]), pd = args[2].__iter ? args[2] : { __iter: args[2], idx: 0 }, run = 0;
                    for (var psi = ps.l; psi < ps.r; psi++) { run += toNum(ps.arr[psi]); pd.__iter[pd.idx + psi - ps.l] = run; }
                    return { __iter: pd.__iter, idx: pd.idx + ps.r - ps.l };
                }
                case 'make_tuple': return args;
                case 'distance': return itPos(args[1]) - itPos(args[0]);
                case 'next': return itStep(args[0], args[1] !== undefined ? Math.trunc(toNum(args[1])) : 1);
                case 'prev': return itStep(args[0], -(args[1] !== undefined ? Math.trunc(toNum(args[1])) : 1));
                case 'advance': { var alv2 = await evalLValue(node.args[0], env); alv2.set(itStep(alv2.get(), Math.trunc(toNum(args[1])))); return 0; }
                case 'pair': return { __stl: 'pair', first: args[0], second: args[1] };
                case 'ref': case 'cref': case 'move': case 'forward': return args[0];
                case 'sqr': return toNum(args[0]) * toNum(args[0]);
                case 'fmin': return Math.min(toNum(args[0]), toNum(args[1]));
                case 'fmax': return Math.max(toNum(args[0]), toNum(args[1]));
                case 'sinh': return Math.sinh(toNum(args[0]));
                case 'cosh': return Math.cosh(toNum(args[0]));
                case 'tanh': return Math.tanh(toNum(args[0]));
                case 'expm1': return Math.expm1(toNum(args[0]));
                case 'log1p': return Math.log1p(toNum(args[0]));
                case 'isnan': return isNaN(toNum(args[0])) ? 1 : 0;
                case 'isinf': return !isFinite(toNum(args[0])) && !isNaN(toNum(args[0])) ? 1 : 0;
                case 'lround': case 'llround': return Math.round(toNum(args[0]));
                case 'popcount': case '__builtin_popcount': case '__builtin_popcountll': { var pcv = Math.trunc(toNum(args[0])), pcn = 0; while (pcv) { pcn += pcv & 1; pcv = Math.floor(pcv / 2); } return pcn; }
                case '__builtin_clz': return Math.clz32(Math.trunc(toNum(args[0])));
                case '__builtin_ctz': { var ctz = Math.trunc(toNum(args[0])); return ctz === 0 ? 32 : 31 - Math.clz32(ctz & -ctz); }
                case '__lg': return Math.floor(Math.log2(toNum(args[0])));
                case 'to_string_': return '';
            }
            throw new Error('Dòng ' + node.line + ': Hàm "' + fn + '()" chưa được hỗ trợ trong chế độ JS thuần.');
        }

        function fillNested(arr, val) {
            for (var i = 0; i < arr.length; i++) {
                if (Array.isArray(arr[i])) fillNested(arr[i], val);
                else arr[i] = val;
            }
        }

        function getRange(beginArg, endArg) {
            var b = Array.isArray(beginArg) ? { __iter: beginArg, idx: 0 } : beginArg;
            var e = Array.isArray(endArg) ? { __iter: endArg, idx: 0 } : endArg;
            if (b && b.__iter && e && e.__iter) return { arr: b.__iter, l: b.idx, r: e.idx };
            if (b && b.__iter && typeof e === 'number') return { arr: b.__iter, l: b.idx, r: e };
            return { arr: [], l: 0, r: 0 };
        }

        function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a; }

        function cPrintf(fmt, vals) {
            var idx = 0;
            return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d*|\*))?(hh|h|ll|l|z|j|t|L)?([diuoxXfFeEgGcsp%])/g, function (m, flags, width, prec, len, type) {
                if (type === '%') return '%';
                if (width === '*') width = String(Math.trunc(toNum(vals[idx++])));
                if (prec === '*') prec = String(Math.trunc(toNum(vals[idx++])));
                var v = vals[idx++];
                var left = flags.indexOf('-') >= 0, zero = flags.indexOf('0') >= 0 && !left, plus = flags.indexOf('+') >= 0, space = flags.indexOf(' ') >= 0, alt = flags.indexOf('#') >= 0;
                var w = width ? parseInt(width, 10) : 0;
                var pr = prec !== undefined ? (prec === '' ? 0 : parseInt(prec, 10)) : null;
                function pad(sign, body, numeric) {
                    var t = sign + body;
                    if (t.length >= w) return t;
                    if (left) return t + ' '.repeat(w - t.length);
                    if (zero && numeric) return sign + '0'.repeat(w - t.length) + body;
                    return ' '.repeat(w - t.length) + t;
                }
                function sgn(neg) { return neg ? '-' : plus ? '+' : space ? ' ' : ''; }
                var n, body;
                switch (type) {
                    case 'd': case 'i': { var big = typeof v === 'bigint' ? v : BigInt(Math.trunc(toNum(v)) || 0); body = String(big < 0n ? -big : big); if (pr !== null) body = body.padStart(pr, '0'); return pad(sgn(big < 0n), body, pr === null); }
                    case 'u': { var bu = typeof v === 'bigint' ? v : BigInt(Math.trunc(toNum(v)) || 0); if (bu < 0n) bu = BigInt.asUintN(len === 'l' || len === 'll' || len === 'z' || len === 'j' ? 64 : 32, bu); body = String(bu); if (pr !== null) body = body.padStart(pr, '0'); return pad('', body, pr === null); }
                    case 'o': n = Math.trunc(toNum(v)); if (n < 0) n += 4294967296; return pad('', (alt ? '0' : '') + n.toString(8), true);
                    case 'x': case 'X': { var bx = typeof v === 'bigint' ? v : BigInt(Math.trunc(toNum(v)) || 0); if (bx < 0n) bx = BigInt.asUintN(len === 'l' || len === 'll' || len === 'z' || len === 'j' || typeof v === 'bigint' ? 64 : 32, bx); n = bx; body = bx.toString(16); if (type === 'X') body = body.toUpperCase(); return pad(alt && bx ? (type === 'X' ? '0X' : '0x') : '', body, true); }
                    case 'xx_unused': body = n.toString(16); if (type === 'X') body = body.toUpperCase(); return pad(alt && n ? (type === 'X' ? '0X' : '0x') : '', body, true);
                    case 'f': case 'F': n = toNum(v); if (!isFinite(n)) return pad(sgn(n < 0), isNaN(n) ? 'nan' : 'inf', false); return pad(sgn(n < 0 || Object.is(n, -0)), Math.abs(n).toFixed(pr === null ? 6 : pr), true);
                    case 'e': case 'E': n = toNum(v); if (!isFinite(n)) return pad(sgn(n < 0), isNaN(n) ? 'nan' : 'inf', false); body = Math.abs(n).toExponential(pr === null ? 6 : pr).replace(/e([+-])(\d)$/, 'e$10$2'); return pad(sgn(n < 0), type === 'E' ? body.toUpperCase() : body, true);
                    case 'g': case 'G': {
                        n = toNum(v); if (!isFinite(n)) return pad(sgn(n < 0), isNaN(n) ? 'nan' : 'inf', false);
                        var P = pr === null ? 6 : (pr === 0 ? 1 : pr), an = Math.abs(n), ex = an === 0 ? 0 : Math.floor(Math.log10(an));
                        if (ex < -4 || ex >= P) body = an.toExponential(P - 1).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2');
                        else { body = an.toFixed(Math.max(0, P - 1 - ex)); if (body.indexOf('.') >= 0 && !alt) body = body.replace(/\.?0+$/, ''); }
                        return pad(sgn(n < 0), type === 'G' ? body.toUpperCase() : body, true);
                    }
                    case 'c': return pad('', v && v.__cppType === 'char' ? String.fromCharCode(v.val) : String.fromCharCode(toNum(v)), false);
                    case 's': { body = typeof v === 'string' ? v : (v && v.__cppType === 'char' ? String.fromCharCode(v.val) : (v === undefined ? '' : formatVal(v))); if (pr !== null) body = body.slice(0, pr); return pad('', body, false); }
                    case 'p': return pad('', '0x' + (Math.abs(Math.trunc(toNum(v))) * 8 + 0x7ffc0000).toString(16), false);
                }
                return m;
            });
        }

        async function invokeFunc(fn, argVals, argNodes, callerEnv, thisObj, parentEnv) {
            if (++callDepth > MAX_CALL_DEPTH) { callDepth = 0; throw { __halt: 'stack' }; }
            memTotal += FRAME_BYTES;
            try { return await invokeFunc2(fn, argVals, argNodes, callerEnv, thisObj, parentEnv); }
            finally { callDepth--; memTotal -= FRAME_BYTES; if (memTotal < 0) memTotal = 0; }
        }
        async function invokeFunc2(fn, argVals, argNodes, callerEnv, thisObj, parentEnv) {
            var fnEnv = { parent: parentEnv || globalEnv, vars: {} };
            if (thisObj) {
                fnEnv.vars['this'] = { val: thisObj, ty: null };
                Object.keys(thisObj.fields).forEach(function (k) {       // trường của đối tượng: hộp "sống" (đọc/ghi thẳng vào đối tượng)
                    var box = { ty: null };
                    Object.defineProperty(box, 'val', { get: function () { return thisObj.fields[k]; }, set: function (v) { thisObj.fields[k] = v; } });
                    fnEnv.vars[k] = box;
                });
            }
            for (var i = 0; i < fn.params.length; i++) {
                var p = fn.params[i];
                if (p.type.isRef && argNodes[i]) {
                    var lv = await evalLValue(argNodes[i], callerEnv);
                    fnEnv.vars[p.name] = { isRef: true, target: lv };
                } else {
                    var v = i < argVals.length ? argVals[i] : (p.defVal ? await evalExpr(p.defVal, callerEnv) : defaultVal(p.type, []));
                    fnEnv.vars[p.name] = { val: p.isArr ? v : castVal(v, p.type), ty: p.isArr ? null : p.type };
                }
            }
            if (fn.inits && thisObj) {         // danh sách khởi tạo: A(int a) : x(a), y(0) { ... }
                for (var ii2 = 0; ii2 < fn.inits.length; ii2++) {
                    var iv = fn.inits[ii2].args.length ? await evalExpr(fn.inits[ii2].args[0], fnEnv) : 0;
                    var iniN = fn.inits[ii2].name;
                    if (Object.prototype.hasOwnProperty.call(thisObj.fields, iniN)) thisObj.fields[iniN] = iv;
                    else if (structs[iniN]) {          // gọi constructor lớp cha: B() : A(3) {}
                        var bVals = []; for (var bai = 0; bai < fn.inits[ii2].args.length; bai++) bVals.push(await evalExpr(fn.inits[ii2].args[bai], fnEnv));
                        var bCtors = structs[iniN].methods.filter(function (m) { return m.isCtor; });
                        var bPick = bCtors.filter(function (m) { return m.params.length === bVals.length; })[0] || bCtors.filter(function (m) { return m.params.length >= bVals.length && m.params.slice(bVals.length).every(function (q) { return q.defVal; }); })[0];
                        if (bPick) await invokeFunc(bPick, bVals, fn.inits[ii2].args, fnEnv, thisObj);
                    }
                    else if (Object.prototype.hasOwnProperty.call(EXC_PARENT, iniN)) thisObj.fields.__what = String(iv);      // runtime_error("msg") của lớp cha chuẩn
                }
            }
            var res = await execBlock(fn.body, fnEnv);
            if (res && res.__signal === 'return') return (fn.retType && !fn.retType.ptr && !fn.retType.isRef) ? castVal(res.val, fn.retType) : res.val;
            return 0;
        }

        async function allocArray(dims, env, ty) {
            if (!dims.length) return defaultVal(ty, []);
            var n = dims[0] ? Math.trunc(toNum(await evalExpr(dims[0], env))) : 0;
            memReserve(Math.max(0, n) * 8);
            var arr = new Array(Math.max(0, n));
            memCharge(arr, Math.max(0, n) * 8);
            for (var i = 0; i < n; i++) { arr[i] = await allocArray(dims.slice(1), env, ty); if ((i & 4095) === 4095) checkStop(); }
            return arr;
        }

        async function execEnum(node, env) {
            var cur = 0;
            for (var i = 0; i < node.items.length; i++) {
                if (node.items[i].expr) cur = toNum(await evalExpr(node.items[i].expr, env));
                env.vars[node.items[i].name] = { val: cur, ty: null };
                cur++;
            }
            if (node.trailing && node.trailing.length) await execVarDecls(node.trailing, env);
        }
        async function execVarDecls(decls, env) {
            for (var i = 0; i < decls.length; i++) {
                var d = decls[i];
                var val;
                if (d.dims && d.dims.length) {
                    if (d.varType.base === 'char' && d.dims.length === 1 && !d.varType.ptr && (!d.init || (d.init.type === 'lit' && d.init.kind === 'str'))) {
                        val = d.init ? String(d.init.val) : '';          // char s[N] → chuỗi kiểu C
                    } else {
                        val = await allocArray(d.dims, env, d.varType);
                        if (d.init && d.init.type === 'init_list') {
                            var list = await evalExpr(d.init, env);
                            for (var li = 0; li < list.length; li++) val[li] = list[li];
                        }
                    }
                } else if (d.init && d.init.type === 'ctor_args') {
                    var cArgs = [];
                    for (var ci = 0; ci < d.init.args.length; ci++) cArgs.push(await evalExpr(d.init.args[ci], env));
                    val = await makeObj(d.varType, cArgs, d.init.args, env);
                } else if (d.init && d.init.type === 'init_list' && d.varType.base !== 'auto') {
                    var iLst = await evalExpr(d.init, env);
                    if (d.varType.ptr > 0) val = iLst.length ? iLst[0] : defaultVal(d.varType, []);                 // N* p{nullptr};
                    else if (structs[d.varType.base] && structs[d.varType.base].methods.some(function (m) { return m.isCtor; })) val = await makeObj(d.varType, iLst, d.init.items, env);   // Lớp có constructor: P p{1,2};
                    else val = await buildFromList(d.varType, iLst, env);
                } else if (d.init && d.varType.isRef && (d.init.type === 'id' || d.init.type === 'index' || d.init.type === 'member')) {
                    env.vars[d.name] = { isRef: true, target: await evalLValue(d.init, env) };
                    continue;
                } else if (d.init) {
                    val = cloneIfValue(castVal(await evalExpr(d.init, env), d.varType), d.varType);
                } else if (structs[d.varType.base] && !d.varType.ptr && structs[d.varType.base].methods.some(function (m) { return m.isCtor; })) {
                    val = await constructObj(d.varType.base, [], [], env);
                } else {
                    val = defaultVal(d.varType, []);
                }
                env.vars[d.name] = { val: val, ty: (d.dims && d.dims.length) || d.varType.base === 'auto' ? null : d.varType };
            }
        }

        // ---------- ngoại lệ C++ (try / catch / throw) ----------
        var excStack = [];
        function excMatches(h, v, loose) {
            if (h.all) return true;
            var b = h.ty.base, isPtr = h.ty.ptr > 0;
            if (v && v.__exc) { for (var k = v.__exc; k; k = EXC_PARENT[k]) if (k === b) return true; return false; }
            if (v && v.__struct) { for (var sn = v.__struct; sn; sn = structs[sn] ? structs[sn].base : EXC_PARENT[sn]) if (sn === b) return true; return false; }
            if (typeof v === 'string') return b === 'string' || (b === 'char' && isPtr);
            if (v && v.__cppType === 'char') return b === 'char' && !isPtr;
            if (typeof v === 'boolean') return b === 'bool';
            if (typeof v === 'bigint') return /long/.test(b);
            if (typeof v === 'number') {
                if (isPtr) return false;
                if (/^(int|short|long|long long|unsigned|unsigned int|unsigned long|unsigned long long|size_t)$/.test(b) && Number.isInteger(v)) return true;
                return !!loose && /^(int|short|long|long long|unsigned|unsigned int|double|float|long double)$/.test(b);   // vòng 2: chấp nhận mọi kiểu số
            }
            return false;
        }
        function cppThrow(kind, msg) { throw { __cppThrow: true, val: { __exc: kind, msg: msg }, line: 0 }; }

        async function execBlock(block, env) {
            var bEnv = { parent: env, vars: {} };
            for (var i = 0; i < block.stmts.length; i++) {
                var sig = await execStmt(block.stmts[i], bEnv);
                if (sig) return sig;
            }
            return null;
        }

        async function execStmt(stmt, env) {
            var yy = tickStep(); if (yy) await yy;
            if (!stmt || stmt.type === 'empty') return null;
            switch (stmt.type) {
                case 'throw': {
                    var thVal;
                    if (stmt.expr) thVal = await evalExpr(stmt.expr, env);
                    else if (excStack.length) thVal = excStack[excStack.length - 1].val;
                    else throw new Error('Dòng ' + stmt.line + ': "throw;" chỉ dùng được bên trong khối catch.');
                    throw { __cppThrow: true, val: thVal, line: stmt.line };
                }
                case 'try': {
                    try { return await execStmt(stmt.body, env); }
                    catch (ex) {
                        if (!ex || !ex.__cppThrow) throw ex;                 // dừng/timeout/lỗi cú pháp... không phải ngoại lệ C++
                        var hit = null;
                        for (var hp = 0; hp < 2 && !hit; hp++) for (var hi = 0; hi < stmt.handlers.length && !hit; hi++) if (excMatches(stmt.handlers[hi], ex.val, hp === 1)) hit = stmt.handlers[hi];
                        if (!hit) throw ex;
                        var cEnv = { parent: env, vars: {} };
                        if (hit.name) cEnv.vars[hit.name] = { val: ex.val, ty: hit.ty && hit.ty.isRef ? null : hit.ty };
                        excStack.push(ex);
                        try { return await execStmt(hit.body, cEnv); } finally { excStack.pop(); }
                    }
                }
                case 'delete': { var dv = await evalExpr(stmt.expr, env); if (dv && typeof dv === 'object') memRelease(dv); return null; }
                case 'block': return execBlock(stmt, env);
                case 'enum_decl': { await execEnum(stmt, env); return null; }
                case 'bind_decl': {
                    var bv = await evalExpr(stmt.init, env);
                    var bparts = pfOf(bv) || (bv && bv.__struct ? Object.keys(bv.fields).map(function (f) { return bv.fields[f]; }) : [bv]);
                    for (var bdi = 0; bdi < stmt.names.length; bdi++) env.vars[stmt.names[bdi]] = { val: bparts[bdi], ty: null };
                    return null;
                }
                case 'vardecl': await execVarDecls(stmt.decls, env); return null;
                case 'expr_stmt': await evalExpr(stmt.expr, env); return null;
                case 'return': return { __signal: 'return', val: stmt.val ? await evalExpr(stmt.val, env) : 0 };
                case 'break': return { __signal: 'break' };
                case 'continue': return { __signal: 'continue' };
                case 'if':
                    if (toNum(await evalExpr(stmt.cond, env))) return execStmt(stmt.thenB, env);
                    if (stmt.elseB) return execStmt(stmt.elseB, env);
                    return null;
                case 'while':
                    while (toNum(await evalExpr(stmt.cond, env))) {
                        var ws = await execStmt(stmt.body, env);
                        if (ws) {
                            if (ws.__signal === 'break') break;
                            if (ws.__signal === 'return') return ws;
                        }
                    }
                    return null;
                case 'dowhile':
                    do {
                        var ds = await execStmt(stmt.body, env);
                        if (ds) {
                            if (ds.__signal === 'break') break;
                            if (ds.__signal === 'return') return ds;
                        }
                    } while (toNum(await evalExpr(stmt.cond, env)));
                    return null;
                case 'for': {
                    var fEnv = { parent: env, vars: {} };
                    if (stmt.init) {
                        if (stmt.init.type === 'vardecl') await execVarDecls(stmt.init.decls, fEnv);
                        else await evalExpr(stmt.init, fEnv);
                    }
                    while (!stmt.cond || toNum(await evalExpr(stmt.cond, fEnv))) {
                        var fs = await execStmt(stmt.body, fEnv);
                        if (fs) {
                            if (fs.__signal === 'break') break;
                            if (fs.__signal === 'return') return fs;
                        }
                        if (stmt.step) await evalExpr(stmt.step, fEnv);
                    }
                    return null;
                }
                case 'for_range': {
                    var rVal = await evalExpr(stmt.range, env);
                    var srcArr = null, items;
                    if (rVal && (rVal.__stl === 'vector' || rVal.__stl === 'deque')) { srcArr = rVal.data; items = srcArr; }
                    else if (rVal && rVal.__stl === 'set') {
                        await ensureSorted(rVal, env);
                        items = [];
                        mapKeys(rVal).forEach(function (k) { var c = rVal.multi ? (rVal.cnt.get(k) || 1) : 1; for (var q = 0; q < c; q++) items.push(rVal.data.get(k)); });
                    }
                    else if (rVal && rVal.__stl === 'map') items = (await ensureSorted(rVal, env), mapKeys(rVal)).map(function (k) { return mapPairAt(rVal, k); });
                    else if (typeof rVal === 'string') items = rVal.split('').map(function (c) { return { __cppType: 'char', val: c.charCodeAt(0) }; });
                    else if (Array.isArray(rVal)) { srcArr = rVal; items = rVal; }
                    else items = [];
                    for (var ri = 0; ri < items.length; ri++) {
                        var rEnv = { parent: env, vars: {} };
                        var elem = items[ri];
                        if (stmt.bind) {
                            var parts = pfOf(elem) || (elem && elem.__struct ? Object.keys(elem.fields).map(function (f) { return elem.fields[f]; }) : [elem]);
                            for (var bi = 0; bi < stmt.bind.length; bi++) rEnv.vars[stmt.bind[bi]] = { val: parts[bi], ty: null };
                        } else if (stmt.varType.isRef && srcArr) {
                            (function (arrRef, idxRef, box) {
                                Object.defineProperty(box, 'val', { get: function () { return arrRef[idxRef]; }, set: function (v) { arrRef[idxRef] = v; } });
                            })(srcArr, ri, rEnv.vars[stmt.varName] = { ty: null });
                        } else rEnv.vars[stmt.varName] = { val: elem, ty: stmt.varType };
                        var rs = await execStmt(stmt.body, rEnv);
                        if (rs) {
                            if (rs.__signal === 'break') break;
                            if (rs.__signal === 'return') return rs;
                        }
                    }
                    return null;
                }
                case 'switch': {
                    var swVal = toNum(await evalExpr(stmt.expr, env));
                    var matched = false;
                    for (var ci = 0; ci < stmt.cases.length; ci++) {
                        var c = stmt.cases[ci];
                        if (!matched) {
                            if (c.val === null || toNum(await evalExpr(c.val, env)) === swVal) matched = true;
                            else continue;
                        }
                        for (var si = 0; si < c.stmts.length; si++) {
                            var ss = await execStmt(c.stmts[si], env);
                            if (ss) {
                                if (ss.__signal === 'break') return null;
                                if (ss.__signal === 'return' || ss.__signal === 'continue') return ss;       // continue trong switch phải đi ra vòng lặp ngoài
                            }
                        }
                    }
                    return null;
                }
            }
            return null;
        }

        async function runProgram(ast) {
            for (var i = 0; i < ast.items.length; i++) {
                var item = ast.items[i];
                if (item.type === 'struct') {
                    structs[item.name] = item;
                    if (item.trailingVars.length) await execVarDecls(item.trailingVars, globalEnv);
                } else if (item.type === 'enum_decl') {
                    await execEnum(item, globalEnv);
                } else if (item.type === 'func') {
                    funcs[item.name] = item;
                    (funcOv[item.name] = funcOv[item.name] || []).push(item);
                } else if (item.type === 'vardecl') {
                    await execVarDecls(item.decls, globalEnv);
                }
            }
            if (!funcs.main) throw new Error('Không tìm thấy hàm int main().');
            var ret = await invokeFunc(funcs.main, [], [], globalEnv, null);
            return Math.trunc(toNum(ret));
        }

        function collectOutFiles() {
            var out = {};
            Object.keys(virtualFiles).forEach(function (name) {
                if (!/\.txt$/i.test(name)) return;
                var content = virtualFiles[name];
                var isNew = !(name in userFiles);
                var changed = !isNew && userFiles[name] !== content;
                if (isNew || changed) out[name] = { content: content, isNew: isNew, changed: changed };
            });
            return out;
        }

        return {
            run: runProgram,
            feed: feedStdin,
            stop: function () {
                stopped = true;
                while (stdinWaiters.length) stdinWaiters.shift()();
            },
            endInput: function () { inputClosed = true; while (stdinWaiters.length) stdinWaiters.shift()(); },
            collectOutFiles: collectOutFiles,
            startedAt: function () { return startedAt; }
        };
    }

    // =========================================================================
    // 5. GIAO DIỆN PUBLIC (TƯƠNG THÍCH CppWasm.start)
    // =========================================================================
    // Bỏ các từ khoá không ảnh hưởng kết quả chạy: noexcept / noexcept(...), override, final (sau tên lớp hoặc sau khai báo hàm)
    function stripSpecifiers(tokens) {
        var out = [];
        for (var i = 0; i < tokens.length; i++) {
            var t = tokens[i];
            if (t.type === 'id' && t.val === 'override') continue;
            if (t.type === 'id' && t.val === 'noexcept') {
                if (tokens[i + 1] && tokens[i + 1].val === '(') { var d = 0; do { if (tokens[i + 1].val === '(') d++; else if (tokens[i + 1].val === ')') d--; i++; } while (d > 0 && i + 1 < tokens.length); }
                continue;
            }
            if (t.type === 'id' && t.val === 'final' && tokens[i + 1] && (tokens[i + 1].val === '{' || tokens[i + 1].val === ':')) continue;
            out.push(t);
        }
        return out;
    }

    function start(opts) {
        var rt = createRuntime(opts);
        var doneResolve;
        var promise = new Promise(function (r) { doneResolve = r; });
        var finished = false;
        function finish(res) { if (finished) return; finished = true; doneResolve(res); }

        (async function () {
            await Promise.resolve();
            try {
                if (opts.onStatus) opts.onStatus('Đang phân tích code C++ (JS thuần)...');
                var fileMap = {};
                (opts.files || []).forEach(function (f) { fileMap[f.name] = f.content; });
                var prep = preprocess(opts.code, fileMap);
                var tokens = stripSpecifiers(tokenize(prep.code));
                var ast = parse(tokens);
                if (opts.onStatus) opts.onStatus('Đang chạy...');
                if (opts.onCompiled) opts.onCompiled();
                var exitCode = await rt.run(ast);
                finish({ status: 'finished', exitCode: exitCode, files: rt.collectOutFiles(), error: null });
            } catch (e) {
                if (e && e.__halt === 'stopped') {
                    finish({ status: 'stopped', exitCode: null, files: rt.collectOutFiles(), error: 'Đã dừng bởi người dùng.' });
                } else if (e && e.__halt === 'timeout') {
                    opts.onOut('\n[Hết ' + (RUN_LIMIT_MS / 1000) + ' giây — đã dừng]', 'err');
                    finish({ status: 'timeout', exitCode: null, files: rt.collectOutFiles(), error: 'Chạy quá thời gian' });
                } else if (e && e.__halt === 'memory') {
                    opts.onOut('\n[⚠ CẢNH BÁO TRÀN BỘ NHỚ: bộ nhớ tạm tăng bất thường' + (e.mb ? ' (~' + e.mb + ' MB)' : '') + (e.why === 'hard' || e.why === 'heap' ? ' — vượt giới hạn an toàn' : ' — vẫn tăng đến giây thứ ' + Math.round((Date.now() - rt.startedAt()) / 1000)) + '. Thường do vòng lặp vô hạn cấp phát (push_back / += / new) hoặc đệ quy không dừng. Đã dừng chạy code.]', 'err');
                    finish({ status: 'memory', exitCode: null, files: rt.collectOutFiles(), error: 'Tràn bộ nhớ' });
                } else if (e && e.__halt === 'stack') {
                    opts.onOut('\n[⚠ TRÀN NGĂN XẾP: đệ quy quá sâu (> ' + MAX_CALL_DEPTH + ' lần gọi) — thường do đệ quy không có điều kiện dừng. Đã dừng chạy code.]', 'err');
                    finish({ status: 'memory', exitCode: null, files: rt.collectOutFiles(), error: 'Tràn ngăn xếp' });
                } else if (e && e.__cppThrow) {
                    var tv = e.val, tn = tv && tv.__exc ? 'std::' + tv.__exc : tv && tv.__struct ? tv.__struct : typeof tv === 'string' ? 'char const*' : typeof tv === 'number' ? (Number.isInteger(tv) ? 'int' : 'double') : 'unknown';
                    opts.onOut("terminate called after throwing an instance of '" + tn + "'\n" + (tv && tv.__exc ? '  what():  ' + tv.msg + '\n' : ''), 'err');
                    finish({ status: 'finished', exitCode: 134, files: rt.collectOutFiles(), error: 'Chương trình bị hủy do ngoại lệ không được bắt (mã thoát 134)' });
                } else if (e && e.__halt === 'exit') {
                    finish({ status: 'finished', exitCode: e.code, files: rt.collectOutFiles(), error: e.code ? 'Mã thoát ' + e.code : null });
                } else if (e instanceof RangeError && /Invalid (array|string|typed array) length|Array buffer allocation|Invalid count value/i.test(String(e.message))) {
                    opts.onOut('\n[⚠ CẢNH BÁO TRÀN BỘ NHỚ: chương trình yêu cầu mảng/chuỗi quá lớn (' + String(e.message) + '). Đã dừng chạy code.]', 'err');
                    finish({ status: 'memory', exitCode: null, files: rt.collectOutFiles(), error: 'Tràn bộ nhớ' });
                } else {
                    var msg = String(e && e.message || e);
                    opts.onOut('Lỗi: ' + msg + '\n', 'err');
                    finish({ status: 'compile-error', exitCode: null, files: {}, error: msg });
                }
            }
        })();

        return {
            done: promise,
            send: function (text) { rt.feed(text); },
            endInput: function () { rt.endInput(); },
            stop: function () { rt.stop(); }
        };
    }

    root.CppJs = { start: start };
    if (typeof module !== 'undefined') module.exports = root.CppJs;
})(typeof window !== 'undefined' ? window : globalThis);
