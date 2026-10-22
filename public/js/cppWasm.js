// public/js/cppWasm.js — biên dịch + chạy C++ NGAY TRONG TRÌNH DUYỆT (clang chạy bằng WebAssembly, qua Wasmer JS SDK).
// Dùng khi máy chủ không có g++ (Vercel). Cần: trang gửi header COOP/COEP (controller đã làm), và tải được
// SDK + gói "clang/clang" từ mạng (~vài chục MB, trình duyệt cache lại sau lần đầu).
(function (root) {
    var SDK_URL = root.WASMER_SDK_URL || 'https://unpkg.com/@wasmer/sdk@0.8.0-beta.1/dist/index.mjs';
    var CLANG_PKG = root.WASMER_CLANG_PKG || 'clang/clang';
    // ⚠ Nếu clang báo thiếu thư viện C++ khi link, chỉnh các cờ ở đây (xem thông báo lỗi hiện ra khi dịch).
    var CLANG_ARGS = ['-x', 'c++', '-std=c++17', '-O0', '-w', '-I/project', '-include', '/project/mnha_prelude.h'];
    var LINK_ARGS = ['-lc++', '-lc++abi'];
    var RUN_LIMIT_MS = 60000, COMPILE_LIMIT_MS = 240000;

    var sdkP = null, clangP = null;
    function loadSdk(onStatus) {
        if (!sdkP) sdkP = import(SDK_URL).then(function (m) { return m.init().then(function () { return m; }); });
        return sdkP.then(function (m) {
            if (!clangP) { onStatus('Đang tải trình biên dịch clang (lần đầu hơi lâu, các lần sau nhanh hơn)...'); clangP = m.Wasmer.fromRegistry(CLANG_PKG); }
            return clangP.then(function (clang) { return { sdk: m, clang: clang }; });
        }).catch(function (e) { sdkP = clangP = null; throw e; });
    }
    var dec = new TextDecoder();
    function td(x) { return typeof x === 'string' ? x : dec.decode(x); }

    // opts: {code, files:[{name,content}], onStatus(msg), onOut(text, kind:'out'|'err'), onCompiled()}
    function start(opts) {
        var st = { stopped: false, finished: false, writer: null, pendingStdin: [] };
        var done, project, userFiles = {};
        var promise = new Promise(function (r) { done = r; });
        function finish(res) { if (st.finished) return; st.finished = true; done(res); }

        (async function () {
            try {
                var env = await loadSdk(opts.onStatus);
                if (st.stopped) return finish({ status: 'stopped', exitCode: null, files: {}, error: 'Đã dừng bởi người dùng.' });
                project = new env.sdk.Directory();
                try { await project.createDir('bits'); } catch (_) { /* đã có */ }
                var srcFiles = (opts.files || []).filter(function (f) { return f.src; });     // header / .cpp được #include cùng thư mục
                var allCode = opts.code + '\n' + srcFiles.map(function (f) { return f.content; }).join('\n');
                var unitPaths = srcFiles.filter(function (f) { return f.unit; }).map(function (f) { return '/project/' + f.name; });
                var shim = root.CppShims.files;
                for (var n in shim) if (n !== 'bits/stdc++.h') await project.writeFile(n, shim[n]);
                await project.writeFile('bits/stdc++.h', root.CppShims.leanStdcpp(allCode));   // chỉ include header code thực sự dùng → dịch nhanh hơn nhiều
                if (!root.crossOriginIsolated) opts.onOut('[Cảnh báo] Trang chưa ở chế độ cô lập (crossOriginIsolated=false) nên clang WASM có thể treo. Tải lại bằng Ctrl+F5; nếu vẫn vậy, máy chủ chưa gửi header COOP/COEP.\n', 'err');
                await project.writeFile('main.cpp', opts.code);
                (opts.files || []).forEach(function (f) { if (!f.src) userFiles[f.name] = f.content; });
                for (var si = 0; si < srcFiles.length; si++) {
                    var parts = srcFiles[si].name.split('/'); parts.pop();
                    for (var pi = 1; pi <= parts.length; pi++) { try { await project.createDir(parts.slice(0, pi).join('/')); } catch (_) { /* đã có */ } }
                    await project.writeFile(srcFiles[si].name, srcFiles[si].content);
                }
                for (var fn in userFiles) await project.writeFile(fn, userFiles[fn]);

                opts.onStatus('Đang biên dịch...');
                var tryCompile = async function (link) {
                    var ci = await env.clang.entrypoint.run({ args: CLANG_ARGS.concat(['/project/main.cpp'], unitPaths, link, ['-o', '/project/main.wasm']), mount: { '/project': project } });
                    return ci.wait();
                };
                var t0 = Date.now(), tick = setInterval(function () { opts.onStatus('Đang biên dịch... ' + Math.round((Date.now() - t0) / 1000) + ' giây (lần đầu có thể mất 1–3 phút vì phải nạp clang)'); }, 1000);
                var limit = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Biên dịch quá ' + COMPILE_LIMIT_MS / 1000 + ' giây — clang WASM không phản hồi. Thử Ctrl+F5, dùng Chrome/Edge bản mới, và kiểm tra tab Console (F12) xem có lỗi SharedArrayBuffer/COEP.')); }, COMPILE_LIMIT_MS); });
                var co;
                try { co = await Promise.race([tryCompile(LINK_ARGS), limit]); } finally { clearInterval(tick); }
                // gói clang đã tự gắn libc++ thì cờ -lc++ có thể báo "không tìm thấy" → thử lại không có LINK_ARGS
                if (!co.ok && /(-lc\+\+|unable to find library|cannot find -l)/.test(td(co.stderr || ''))) co = await Promise.race([tryCompile([]), limit]);
                var cerr = td(co.stderr || '').split('/project/').join('');
                if (!co.ok) { opts.onOut('Lỗi biên dịch:\n' + cerr + (co.stdout ? td(co.stdout) : ''), 'err'); return finish({ status: 'compile-error', exitCode: co.code, files: {}, error: 'Lỗi biên dịch' }); }
                if (cerr.trim()) opts.onOut(cerr, 'err');
                if (st.stopped) return finish({ status: 'stopped', exitCode: null, files: {}, error: 'Đã dừng bởi người dùng.' });

                var bytes = await project.readFile('main.wasm');
                var prog = await env.sdk.Wasmer.fromFile(bytes);
                opts.onStatus('Đang chạy...'); if (opts.onCompiled) opts.onCompiled();
                var inst = await prog.entrypoint.run({ mount: { '/project': project }, cwd: '/project' });
                if (inst.stdin && inst.stdin.getWriter) {
                    st.writer = inst.stdin.getWriter();
                    st.pendingStdin.forEach(function (t) { st.writer.write(new TextEncoder().encode(t)); });
                }
                var pump = function (stream, kind) {
                    if (!stream || !stream.getReader) return Promise.resolve();
                    var rd = stream.getReader();
                    return (function loop() { return rd.read().then(function (r) { if (r.done) return; if (!st.stopped) opts.onOut(td(r.value), kind); return loop(); }); })();
                };
                var streamed = !!(inst.stdout && inst.stdout.getReader);
                var pumps = Promise.all([pump(inst.stdout, 'out'), pump(inst.stderr, 'err')]).catch(function () { });
                var timer = setTimeout(function () { if (!st.finished) { st.stopped = true; opts.onOut('\n[Hết ' + RUN_LIMIT_MS / 1000 + ' giây — đã dừng]', 'err'); finish({ status: 'timeout', exitCode: null, files: {}, error: 'Chạy quá thời gian' }); } }, RUN_LIMIT_MS);
                var out = await inst.wait(); await pumps; clearTimeout(timer);
                if (st.finished) return;
                if (!streamed) { if (out.stdout) opts.onOut(td(out.stdout), 'out'); if (out.stderr) opts.onOut(td(out.stderr), 'err'); }

                // file .txt chương trình ghi ra (output.txt...) hoặc đã sửa
                var files = {};
                try {
                    var names = await project.readDir('/');
                    for (var i = 0; i < names.length; i++) {
                        var name = typeof names[i] === 'string' ? names[i] : names[i].name;
                        if (!/\.txt$/i.test(name)) continue;
                        var content = td(await project.readFile(name));
                        var isNew = !(name in userFiles), changed = !isNew && userFiles[name] !== content;
                        if (isNew || changed) files[name] = { content: content, isNew: isNew, changed: changed };
                    }
                } catch (_) { /* không đọc được thì bỏ qua */ }
                finish({ status: 'finished', exitCode: out.code, files: files, error: out.ok ? null : 'Chương trình kết thúc với mã ' + out.code });
            } catch (e) {
                var msg = /import|fetch|Failed|network|load/i.test(String(e && e.message)) ? 'Không tải được trình biên dịch WebAssembly (' + e.message + '). Kiểm tra mạng / trình duyệt (cần Chrome/Edge/Firefox mới).' : String(e && e.message || e);
                opts.onOut(msg, 'err'); finish({ status: 'error', exitCode: null, files: {}, error: msg });
            }
        })();

        return {
            done: promise,
            send: function (text) { if (st.writer) st.writer.write(new TextEncoder().encode(text)); else st.pendingStdin.push(text); },
            stop: function () { st.stopped = true; finish({ status: 'stopped', exitCode: null, files: {}, error: 'Đã dừng bởi người dùng.' }); }
        };
    }
    root.CppWasm = { start: start };
})(window);
