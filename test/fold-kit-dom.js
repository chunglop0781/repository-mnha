// Test: public/js/foldKit.js — phần gắn vào <textarea> (mô phỏng ô soạn + lề số dòng, không cần trình duyệt)
const assert = require('assert');
const K = require('../public/js/foldKit');

function target(html) {      // đủ dùng cho ed / gutter
    const h = {};
    return {
        value: '', innerHTML: html || '', selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0, readOnly: false,
        addEventListener(t, f) { (h[t] = h[t] || []).push(f); },
        setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
        focus() { },
        fire(t, e) { e = Object.assign({ type: t, prevented: false }, e); e.preventDefault = () => { e.prevented = true; }; (h[t] || []).forEach((f) => f(e)); return e; },
    };
}
function setup(text, file) {
    const ed = target(), gutter = target();
    ed.value = text;
    const fold = K.attach(ed, gutter, { lang: file.endsWith('.cpp') ? 'cpp' : 'html', file });
    return { ed, gutter, fold };
}
const arrows = (g, cls) => (g.innerHTML.match(new RegExp('class="fg-a ' + cls + '"', 'g')) || []).length;
const nums = (g) => (g.innerHTML.match(/<div class="fg-r">(\d+)</g) || []).map((x) => +x.replace(/\D/g, ''));
function clickArrow(g, cls, nth) {
    const ms = [...g.innerHTML.matchAll(new RegExp('class="fg-a ' + cls + '" data-i="(\\d+)"', 'g'))];
    const i = ms[nth || 0][1];
    g.fire('click', { target: { closest: () => ({ getAttribute: () => i, classList: { contains: (c) => c === cls } }) } });
}

const cpp = ['#include <iostream>', 'int main() {', '    if (x) {', '        foo();', '    }', '    return 0;', '}'].join('\n');

// --- không hỗ trợ: file .txt, ngôn ngữ khác
assert.strictEqual(K.attach(target(), target(), { lang: 'cpp', file: 'input.txt' }), null);
assert.strictEqual(K.attach(target(), target(), { lang: 'emu8086', file: 'a.asm' }), null);

// --- hiện mũi tên đúng chỗ, số dòng đúng
let { ed, gutter, fold } = setup(cpp, 'a.cpp');
assert.strictEqual(arrows(gutter, 'o'), 2);                        // main + if
assert.deepStrictEqual(nums(gutter), [1, 2, 3, 4, 5, 6, 7]);

// --- bấm ▾ ở main → thu gọn; số dòng thật vẫn đúng; getText() trả về đủ code
clickArrow(gutter, 'o', 0);
assert.strictEqual(ed.value.split('\n').length, 2);
assert.ok(/^int main\(\) \{ \u2026 \}/.test(ed.value.split('\n')[1]));
assert.strictEqual(fold.getText(), cpp);
assert.strictEqual(arrows(gutter, 'c'), 1);
assert.deepStrictEqual(nums(gutter), [1, 2]);
// --- bấm ▸ → mở lại
clickArrow(gutter, 'c', 0);
assert.strictEqual(ed.value, cpp);
assert.strictEqual(fold.count(), 0);

// --- thu gọn tất cả / mở tất cả
fold.foldAll();
assert.strictEqual(ed.value.split('\n').length, 2);
assert.strictEqual(fold.getText(), cpp);
fold.unfoldAll();
assert.strictEqual(ed.value, cpp);
assert.strictEqual(fold.count(), 0);

// --- Ctrl+Shift+[ / ] theo con trỏ: con trỏ trong khối if → gấp khối if (khối trong cùng)
ed.setSelectionRange(cpp.indexOf('foo'), cpp.indexOf('foo'));
let ev = ed.fire('keydown', { key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true });
assert.ok(ev.prevented);
assert.strictEqual(ed.value.split('\n').length, 5);                // if gấp: 7 - (3-1) = 5? (dòng if + 2 dòng ẩn) → 7-2 = 5
assert.strictEqual(fold.getText(), cpp);
ed.setSelectionRange(0, 0);
ed.fire('keydown', { key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true });
assert.strictEqual(ed.value.split('\n').length, 5);                // con trỏ không ở dòng thu gọn → không mở gì
ed.setSelectionRange(ed.value.indexOf('if (x)') + 2, ed.value.indexOf('if (x)') + 2);
ed.fire('keydown', { key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true });
assert.strictEqual(ed.value, cpp);                                  // con trỏ trên dòng thu gọn → mở

// --- sửa ở dòng đang hiển thị bình thường: code ẩn không mất
fold.foldAll();                                                   // chỉ còn: "#include..." và "int main() { … }"
ed.setSelectionRange(0, 0);
ed.fire('keydown', { key: 'X' });                                 // gõ đầu file (không đụng dòng thu gọn)
ed.value = 'X' + ed.value; ed.setSelectionRange(1, 1); ed.fire('input'); // trình duyệt chèn chữ X
assert.strictEqual(fold.getText(), 'X' + cpp);
assert.ok(fold.count() > 0, 'vẫn đang thu gọn');

// --- gõ vào dòng thu gọn → khối đó tự mở trước, chữ gõ vào KHÔNG làm hỏng dòng thu gọn
const L1 = ed.value.split('\n');
const mainOff = L1[0].length + 1;                                   // đầu dòng "int main() { … }"
ed.setSelectionRange(mainOff + 3, mainOff + 3);
ev = ed.fire('keydown', { key: 'Z' });
assert.ok(!ev.prevented);
const afterOpen = fold.getText();
assert.strictEqual(afterOpen, 'X' + cpp);                           // mở ra không đổi nội dung thật
assert.ok(ed.value.split('\n').length > 2, 'main đã mở');

// --- Ctrl+A rồi gõ: mở hết các khối bị chạm, không mất code
fold.foldAll();
ed.setSelectionRange(0, ed.value.length);
ed.fire('keydown', { key: 'a' });
assert.strictEqual(fold.getText(), 'X' + cpp);
assert.ok(ed.selectionEnd > ed.selectionStart);                   // vẫn đang chọn (đã dời theo phần vừa mở)

// --- Enter ở cuối dòng thu gọn: dòng thu gọn được giữ nguyên (không mở)
fold.unfoldAll(); fold.foldAll();
const before = ed.value;
ed.setSelectionRange(ed.value.length, ed.value.length);
ed.fire('keydown', { key: 'Enter' });
assert.strictEqual(ed.value, before);                              // chưa đụng gì (trình duyệt mới chèn \n)
assert.strictEqual(fold.getText(), 'X' + cpp);

// --- đọc-chỉ (code trên mạng): vẫn gấp được, không tự mở khi bấm phím
fold.unfoldAll();
ed.readOnly = true;
fold.foldAll();
ed.fire('keydown', { key: 'a' });
assert.ok(fold.count() > 0);
assert.strictEqual(fold.getText(), 'X' + cpp);

// --- HTML
const html = ['<div>', '  <p>a</p>', '  <ul>', '    <li>1</li>', '  </ul>', '</div>'].join('\n');
({ ed, gutter, fold } = setup(html, 'index.html'));
assert.strictEqual(arrows(gutter, 'o'), 2);                        // div + ul
fold.foldAll();
assert.strictEqual(ed.value.split('\n').length, 1);
assert.ok(/^<div> \u2026 <\/div>/.test(ed.value), ed.value);
assert.strictEqual(fold.getText(), html);
ed.value = html + '\n<p>mới</p>'; fold.reset();          // file lớn tải xong: code ngoài gán lại ed.value
assert.strictEqual(fold.count(), 0);
assert.strictEqual(fold.getText(), html + '\n<p>mới</p>');

console.log('fold-kit-dom: OK');
