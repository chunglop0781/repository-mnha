// Test: public/js/editorKit.js — tự đóng ngoặc, Enter giữ độ thụt, Tab, Ctrl+/ (mô phỏng gõ phím trên văn bản thuần)
const assert = require('assert');
const K = require('../public/js/editorKit');
const E = K.edits;

// mô phỏng 1 phím: text có dấu | là con trỏ (hoặc [..] là vùng chọn); trả về văn bản sau khi gõ, cũng có |
function parse(src) {
    const a = src.indexOf('[');
    if (a >= 0) { const b = src.indexOf(']', a); return { t: src.slice(0, a) + src.slice(a + 1, b) + src.slice(b + 1), s: a, e: b - 1 }; }
    const i = src.indexOf('|'); return { t: src.slice(0, i) + src.slice(i + 1), s: i, e: i };
}
function show(t, s, e) { return s === e ? t.slice(0, s) + '|' + t.slice(s) : t.slice(0, s) + '[' + t.slice(s, e) + ']' + t.slice(e); }
function run(fn, src, ...args) {
    const { t, s, e } = parse(src), r = fn(t, s, e, ...args);
    if (!r) return null;
    return show(t.slice(0, r.start) + r.text + t.slice(r.end), r.selStart, r.selEnd);
}
const cpp = K.cfgFor('cpp', 'a.cpp'), txt = K.cfgFor('cpp', 'input.txt'), asm = K.cfgFor('emu8086', 'a.asm');
const htm = K.cfgFor('html', 'a.html'), css = K.cfgFor('html', 'a.css'), js = K.cfgFor('html', 'a.js');
const typed = (src, ch, cfg) => run(E.type, src, ch, cfg);

// --- tự đóng ngoặc
assert.strictEqual(typed('int main|', '(', cpp), 'int main(|)');
assert.strictEqual(typed('if (x) |', '{', cpp), 'if (x) {|}');
assert.strictEqual(typed('f(|)', ')', cpp), 'f()|');                       // gõ ) nhảy qua )
assert.strictEqual(typed('x = |', '"', cpp), 'x = "|"');
assert.strictEqual(typed('x = "ab|"', '"', cpp), 'x = "ab"|');            // nhảy qua " đóng
assert.strictEqual(typed("don|", "'", cpp), null);                         // dấu nháy sau chữ: không đóng
assert.strictEqual(typed('|abc', '(', cpp), null);                         // đứng trước chữ: không đóng
assert.strictEqual(typed('x = [a]', '(', cpp), 'x = ([a])');                 // bôi đen → bọc
assert.strictEqual(typed('1 2|', '(', txt), null);                         // input.txt không tự đóng
assert.strictEqual(typed("msg db |", "'", asm), "msg db '|'");
assert.strictEqual(typed('x|', '`', cpp), null);                            // backtick chỉ cho .js
assert.strictEqual(typed('x = |', '`', js), 'x = `|`');
// dấu nháy đôi đang trong chuỗi mở (không có tự đóng) → là ký tự đóng
assert.strictEqual(typed('printf("abc|', '"', cpp), null);
// gõ } ở dòng chỉ có khoảng trắng → lùi 1 cấp
assert.strictEqual(typed('{\n    |', '}', cpp), '{\n}|');
assert.strictEqual(typed('  {\n    foo|', '}', cpp), null);

// --- Backspace giữa cặp
assert.strictEqual(run(E.backspace, 'f(|)', cpp), 'f|');
assert.strictEqual(run(E.backspace, '{|}', cpp), '|');
assert.strictEqual(run(E.backspace, 'f(a|)', cpp), null);
assert.strictEqual(run(E.backspace, '"|"', txt), null);

// --- Enter
assert.strictEqual(run(E.enter, 'int main() {|}', cpp), 'int main() {\n    |\n}');
assert.strictEqual(run(E.enter, '    for (;;) {|}', cpp), '    for (;;) {\n        |\n    }');     // giữ độ thụt gốc
assert.strictEqual(run(E.enter, '    x = 1;|', cpp), '    x = 1;\n    |');                      // căn như cũ sau khi đã tab
assert.strictEqual(run(E.enter, '    if (a) {|', cpp), '    if (a) {\n        |');               // chưa có } → thụt thêm 1 cấp
assert.strictEqual(run(E.enter, '    f(|)', cpp), '    f(\n        |\n    )');
assert.strictEqual(run(E.enter, '  <div>|</div>', htm), '  <div>\n    |\n  </div>');
assert.strictEqual(run(E.enter, '  <p>|', htm), '  <p>\n  |');
assert.strictEqual(run(E.enter, '  a {|}', css), '  a {\n    |\n  }');
assert.strictEqual(run(E.enter, '  12 34|', txt), '  12 34\n  |');
assert.strictEqual(run(E.enter, '    mov ax, 1|', asm), '    mov ax, 1\n    |');

// --- Tab / Shift+Tab
assert.strictEqual(run(E.tab, 'a|', false, cpp), 'a    |');
assert.strictEqual(run(E.tab, '[a\nb]', false, cpp), '[    a\n    b]');
assert.strictEqual(run(E.tab, '[    a\n  b]', true, cpp), '[a\nb]');
assert.strictEqual(run(E.tab, '    a|', true, cpp), 'a|');
assert.strictEqual(run(E.tab, '[a\n\nb]', false, cpp), '[    a\n\n    b]');                        // dòng trống không thụt

// --- Ctrl + /
const tc = (src, cfg) => run(E.toggleComment, src, cfg);
assert.strictEqual(tc('int a;|', cpp), '// int a;|');
assert.strictEqual(tc('[a;\n    b;]', cpp), '[// a;\n//     b;]');                                  // chú thích ở cột nhỏ nhất
assert.strictEqual(tc('[    a;\n    b;]', cpp), '[    // a;\n    // b;]');
assert.strictEqual(tc('[// a;\n// b;]', cpp), '[a;\nb;]');                                        // tất cả đã chú thích → bỏ
assert.strictEqual(tc('[// a;\nb;]', cpp), '[// // a;\n// b;]');                                  // lẫn lộn → chú thích hết
assert.strictEqual(tc('    mov ax, 1|', asm), '    ; mov ax, 1|');
assert.strictEqual(tc('; mov ax, 1|', asm), 'mov ax, 1|');
assert.strictEqual(tc('<p>hi</p>|', htm), '<!-- <p>hi</p> -->|');
assert.strictEqual(tc('<!-- <p>hi</p> -->|', htm), '<p>hi</p>|');
assert.strictEqual(tc('a {color:red}|', css), '/* a {color:red} */|');
assert.strictEqual(tc('/* a {color:red} */|', css), 'a {color:red}|');
assert.strictEqual(tc('1 2|', txt), null);                                                       // .txt: không chú thích
assert.strictEqual(tc('|', cpp), null);                                                          // dòng trống: bỏ qua
// dòng đầu tệp (s = 0) không bị lỗi lastIndexOf
assert.strictEqual(tc('|x\ny', cpp), '// |x\ny');
assert.strictEqual(E.lineRange('\nab', 0, 0).ls, 0);
assert.strictEqual(E.lineRange('a\nb\n', 0, 4).le, 3);                                           // vùng chọn kết thúc ở đầu dòng thì không tính dòng đó

console.log('editor-kit OK');
