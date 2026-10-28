// node -r ./test/_stubs.js test/emu-browser.js — emu8086 chạy ở trình duyệt: bộ máy gửi cho trình duyệt + 5 máy ảo độc lập chạy xen kẽ
const assert = require('assert'), vm = require('vm');
const ctrl = require('../controllers/code.controller.js');
let body = '';
ctrl.emuEngine({}, { set() { return this; }, send(b) { body = b; } });
const win = {}; vm.runInNewContext(body, { window: win, Date, Math });
const { Machine, AsmError } = win.Emu8086;
const code = ['.model small', '.stack 100h', '.data', "msg db 'Nhap so: $'", '.code', 'main proc', '  mov ax,@data', '  mov ds,ax', '  lea dx,msg', '  mov ah,9', '  int 21h',
    '  mov ah,1', '  int 21h', '  mov dl,al', '  mov ah,2', '  int 21h', '  mov ah,4ch', '  int 21h', 'main endp', 'end main', ''].join('\n');
const N = 5, ms = Array.from({ length: N }, () => new Machine(code));
ms.forEach((m) => assert.strictEqual(m.run(1000), 'waiting'));                       // cả 5 cùng chờ phím
for (let i = N - 1; i >= 0; i--) { ms[i].feed(String(i + 1)); }                          // nhập xen kẽ, thứ tự ngược
ms.forEach((m) => assert.strictEqual(m.run(1000), 'halted'));
ms.forEach((m, i) => assert.strictEqual(m.screen.raw, 'Nhap so: ' + (i + 1) + (i + 1), 'máy ' + (i + 1) + ' không lẫn dữ liệu máy khác'));
try { new Machine('mov zz,1'); assert.fail('phải lỗi dịch'); } catch (e) { assert(e instanceof AsmError && e.errors.length); }
console.log('emu-browser: 5 máy ảo độc lập xen kẽ — đạt');
