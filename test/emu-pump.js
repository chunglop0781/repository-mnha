// node -r ./test/_stubs.js test/emu-pump.js — vòng chạy emu8086 kiểu mới (lát thích ứng ≈12ms + nhường bằng MessageChannel):
// cùng kết quả như chạy một mạch, mỗi lát đủ ngắn để UI mượt, và không chậm hơn cách cũ (100000 lệnh + setTimeout(0)).
const assert = require('assert'), vm = require('vm');
const ctrl = require('../controllers/code.controller.js'), PK = require('../public/js/perfKit.js');
let body = ''; ctrl.emuEngine({}, { set() { return this; }, send(b) { body = b; } });
const win = {}; vm.runInNewContext(body, { window: win, Date, Math }); const { Machine } = win.Emu8086;
const code = ['.model small', '.stack 100h', '.code', 'main proc', '  mov bx, 60', 'outer:', '  mov cx, 0FFFFh', 'inner:', '  loop inner', '  dec bx', '  jnz outer', '  mov ah, 4ch', '  int 21h', 'main endp', 'end main', ''].join('\n');

const ref = new Machine(code); const t0 = performance.now(); assert.strictEqual(ref.run(1e9), 'halted'); const direct = performance.now() - t0;

function pump(newStyle) {
    return new Promise((resolve) => {
        const m = new Machine(code), slices = []; let batch = 20000, yields = 0; const start = performance.now();
        (function tick() {
            const s = performance.now(); const st = m.run(newStyle ? batch : 100000); const dt = performance.now() - s; slices.push(dt);
            if (newStyle) batch = PK.nextBatch(batch, dt);
            if (st === 'running') { yields++; return newStyle ? PK.yieldNow(tick) : setTimeout(tick, 4); }   // 4ms = khoá tối thiểu của setTimeout lồng nhau ở Chrome/Safari
            resolve({ m, st, total: performance.now() - start, slices, yields });
        })();
    });
}
(async () => {
    const keep = setInterval(() => { }, 1000);
    const oldS = await pump(false), newS = await pump(true);
    for (const r of [oldS, newS]) { assert.strictEqual(r.st, 'halted'); assert.strictEqual(r.m.steps, ref.steps, 'cùng số lệnh như chạy một mạch'); assert.strictEqual(r.m.regs ? r.m.regs.bx : 0, ref.regs ? ref.regs.bx : 0); }
    const sorted = newS.slices.slice(3).sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || 0, max = sorted[sorted.length - 1] || 0;
    assert(p95 < 40, 'lát chạy (p95) phải ngắn để UI mượt, thực tế ' + p95.toFixed(1) + 'ms');
    assert(newS.total <= oldS.total * 1.15, 'kiểu mới không được chậm hơn kiểu cũ (mới ' + newS.total.toFixed(0) + 'ms, cũ ' + oldS.total.toFixed(0) + 'ms)');
    console.log(`emu-pump: ${ref.steps.toLocaleString('en-US')} lệnh · một mạch ${direct.toFixed(0)}ms · kiểu cũ (100000 lệnh + setTimeout 4ms) ${oldS.total.toFixed(0)}ms/${oldS.yields} lần nhường · kiểu mới ${newS.total.toFixed(0)}ms/${newS.yields} lần nhường, lát p95 ${p95.toFixed(1)}ms, max ${max.toFixed(1)}ms — đạt`);
    clearInterval(keep); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
