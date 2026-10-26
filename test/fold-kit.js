// Test: public/js/foldKit.js — dò khối C++/HTML/CSS/JS, thu gọn / mở (lồng nhau), bảo vệ dòng thu gọn khi sửa
const assert = require('assert');
const K = require('../public/js/foldKit');

const byStart = (rs) => { const m = {}; rs.forEach((r) => { m[r.s] = r; }); return m; };
const R = (s, e, h) => ({ s, e, h });

// --- cấu hình theo đuôi file
assert.ok(K.cfgFor('cpp', 'a.cpp') && K.cfgFor('cpp', 'a.h'));
assert.strictEqual(K.cfgFor('cpp', 'input.txt'), null);          // file dữ liệu: không gấp
assert.strictEqual(K.cfgFor('emu8086', 'a.asm'), null);
assert.ok(K.cfgFor('html', 'index.html').html && K.cfgFor('html', 'a.css') && K.cfgFor('html', 'a.js') && K.cfgFor('html', 'a.json'));
assert.strictEqual(K.cfgFor('html', 'a.txt'), null);

// --- C++: ngoặc, chuỗi/ký tự chứa ngoặc, else, chú thích nhiều dòng
const cpp = [
    '#include <iostream>',          // 0
    'using namespace std;',         // 1
    'struct A {',                   // 2
    '    int x;',                   // 3
    '};',                           // 4
    'int main() {',                 // 5
    '    string s = "{ not a brace";', // 6
    "    char c = '}';",            // 7
    '    if (x) {',                 // 8
    '        foo();',               // 9
    '    } else {',                 // 10
    '        bar();',               // 11
    '    }',                        // 12
    '    /* multi',                 // 13
    '       line */',               // 14
    '    int n = 1\'000;',          // 15  (dấu phân cách hàng nghìn không phải ký tự)
    '    // } đây là chú thích {',   // 16
    '    return 0;',                // 17
    '}',                            // 18
].join('\n');
const cr = byStart(K.computeRanges(cpp, K.cfgFor('cpp', 'a.cpp')));
assert.deepStrictEqual(cr[2], R(2, 4, true));
assert.deepStrictEqual(cr[5], R(5, 18, true));
assert.deepStrictEqual(cr[8], R(8, 9, false));       // "} else {" ở dòng 10 vẫn hiện
assert.deepStrictEqual(cr[10], R(10, 12, true));
assert.deepStrictEqual(cr[13], R(13, 14, true));
assert.strictEqual(Object.keys(cr).length, 5);

// raw string C++ không làm hỏng việc dò
const raw = ['auto s = R"x(', '{ {', ')x";', 'void f() {', '  a();', '}'].join('\n');
assert.deepStrictEqual(K.computeRanges(raw, K.cfgFor('cpp', 'a.cpp')), [R(3, 5, true)]);

// --- HTML: thẻ, chú thích, <style>/<script>
const html = [
    '<!DOCTYPE html>',              // 0
    '<html>',                       // 1
    '<head>',                       // 2
    '  <style>',                    // 3
    '    body {',                   // 4
    '      color: red;',            // 5
    '    }',                        // 6
    '  </style>',                   // 7
    '</head>',                      // 8
    '<body>',                       // 9
    '  <!-- a',                     // 10
    '       b -->',                 // 11
    '  <div class="x">',            // 12
    '    <br>',                     // 13
    '    <p>hi</p>',                // 14
    '  </div>',                     // 15
    '  <script>',                   // 16
    '    function f() {',           // 17
    '      return "</div>";',       // 18
    '    }',                        // 19
    '  </script>',                  // 20
    '</body>',                      // 21
    '</html>',                      // 22
].join('\n');
const hr = byStart(K.computeRanges(html, K.cfgFor('html', 'index.html')));
assert.deepStrictEqual(hr[1], R(1, 22, true));
assert.deepStrictEqual(hr[2], R(2, 8, true));
assert.deepStrictEqual(hr[3], R(3, 7, true));
assert.deepStrictEqual(hr[4], R(4, 6, true));           // CSS trong <style>
assert.deepStrictEqual(hr[9], R(9, 21, true));
assert.deepStrictEqual(hr[10], R(10, 11, true));        // chú thích nhiều dòng
assert.deepStrictEqual(hr[12], R(12, 15, true));
assert.deepStrictEqual(hr[16], R(16, 20, true));
assert.deepStrictEqual(hr[17], R(17, 19, true));        // JS trong <script>
assert.strictEqual(Object.keys(hr).length, 9);

// thẻ không đóng / thẻ đóng thừa không làm hỏng; thẻ đóng không đứng đầu dòng thì giữ lại dòng đó
const odd = ['<div>', '  <p>một', '  <p>hai', '  text</div>', '</span>'].join('\n');
const or_ = byStart(K.computeRanges(odd, K.cfgFor('html', 'a.html')));
assert.deepStrictEqual(or_[0], R(0, 2, false));

// --- CSS / JS / JSON
assert.deepStrictEqual(K.computeRanges('a {\n  b: c;\n}\n/* x\ny */', K.cfgFor('html', 'a.css')), [R(0, 2, true), R(3, 4, true)]);
assert.deepStrictEqual(K.computeRanges('foo(function () {\n  x();\n});', K.cfgFor('html', 'a.js')), [R(0, 2, true)]);
assert.deepStrictEqual(K.computeRanges('{\n "a": [\n  1,\n  2\n ]\n}', K.cfgFor('html', 'a.json')), [R(0, 5, true), R(1, 4, true)]);

// --- Doc: thu gọn / mở / bung lại đúng như cũ
function mk(text) { const d = new K.Doc(); return { d, lines: text.split('\n') }; }
const full = (x) => x.d.expand(x.lines.join('\n'));

let x = mk(cpp);
assert.ok(x.d.fold(x.lines, 5, 18, true));
assert.strictEqual(x.lines.length, 6);
assert.ok(/^int main\(\) \{ \u2026 \}/.test(x.lines[5]), x.lines[5]);
assert.strictEqual(full(x), cpp);
assert.strictEqual(x.d.layout(x.lines).total, 19);
assert.strictEqual(x.d.fold(x.lines, 5, 18, true), false);       // đã thu gọn rồi
assert.strictEqual(x.d.fold(x.lines, 8, 9, false), false);       // dòng bắt đầu đang bị ẩn
assert.strictEqual(x.d.unfold(x.lines, 5), 14);
assert.strictEqual(x.lines.join('\n'), cpp);
assert.strictEqual(x.d.count, 0);

// khối cắt ngang khối đã thu gọn → từ chối, không đổi gì
x = mk(cpp); x.d.fold(x.lines, 2, 4, true);
assert.strictEqual(x.d.fold(x.lines, 3, 6, true), false);        // dòng 3 đang bị ẩn
assert.strictEqual(x.d.fold(x.lines, 1, 3, false), false);       // kết thúc giữa khối đã gấp
assert.strictEqual(full(x), cpp);

// lồng nhau: gấp khối trong rồi khối ngoài; mở khối ngoài thì khối trong vẫn gấp
x = mk(cpp);
assert.ok(x.d.fold(x.lines, 8, 9, false));
assert.ok(x.d.fold(x.lines, 5, 18, true));
assert.strictEqual(x.lines.length, 6);
assert.strictEqual(full(x), cpp);
x.d.unfold(x.lines, 5);
assert.ok(x.d.idOf(x.lines[8]) > 0, 'khối trong vẫn thu gọn');
assert.strictEqual(x.d.layout(x.lines).total, 19);
assert.strictEqual(x.d.layout(x.lines).ol[9], 10);               // số dòng thật nhảy qua phần ẩn
assert.strictEqual(full(x), cpp);

// gấp tất cả / mở tất cả
x = mk(html);
const rs = K.computeRanges(html, K.cfgFor('html', 'a.html'));
assert.ok(x.d.foldAll(x.lines, rs));
assert.strictEqual(x.lines.length, 2);                           // <!DOCTYPE> + <html> … </html>
assert.strictEqual(full(x), html);
assert.ok(x.d.unfoldAll(x.lines));
assert.strictEqual(x.lines.join('\n'), html);

// --- bảo vệ dòng thu gọn khi sửa
x = mk(cpp); x.d.fold(x.lines, 5, 18, true);
const txt = x.lines.join('\n'), ls = txt.indexOf('int main'), le = txt.length;       // dòng thu gọn là dòng cuối = [ls, le]
assert.deepStrictEqual(x.d.touched(x.lines, ls, ls, 'insert'), [5]);       // gõ đầu dòng
assert.deepStrictEqual(x.d.touched(x.lines, le, le, 'insert'), [5]);       // gõ cuối dòng
assert.deepStrictEqual(x.d.touched(x.lines, ls, ls, 'newline'), []);       // Enter ở đầu dòng: đẩy cả dòng xuống, an toàn
assert.deepStrictEqual(x.d.touched(x.lines, le, le, 'newline'), []);       // Enter ở cuối dòng: an toàn
assert.deepStrictEqual(x.d.touched(x.lines, ls + 3, ls + 3, 'newline'), [5]);
assert.deepStrictEqual(x.d.touched(x.lines, le, le + 1, 'range'), [5]);    // Delete ở cuối dòng (nuốt xuống dòng)
assert.deepStrictEqual(x.d.touched(x.lines, ls - 1, ls, 'range'), [5]);    // Backspace ở đầu dòng (nối lên dòng trước)
assert.deepStrictEqual(x.d.touched(x.lines, 0, 5, 'range'), []);           // sửa dòng đầu file
assert.deepStrictEqual(x.d.touched(x.lines, 0, txt.length, 'range'), [5]); // chọn tất cả rồi gõ

// mở dòng bị chạm + dời con trỏ
x = mk(cpp); x.d.fold(x.lines, 5, 18, true); x.d.fold(x.lines, 2, 4, true);
const pts = [{ line: 3, col: 2 }, { line: 3, col: 999 }];        // dòng 3 = "int main() { … }"
x.d.unfoldMany(x.lines, [2, 3], pts);                                                  // mở cả struct (dòng 2) lẫn main (dòng 3)
assert.strictEqual(x.lines.join('\n'), cpp);
assert.deepStrictEqual(pts[0], { line: 5, col: 2 });          // con trỏ ở phần chữ → về dòng đầu của khối
assert.deepStrictEqual(pts[1], { line: 18, col: 1 });         // con trỏ ở phần "… }" → cuối dòng đóng

// chỉ mở struct (dòng 2) → dòng "main" thu gọn bị đẩy xuống đúng 2 dòng (struct chiếm 3 dòng thật), con trỏ đi theo
x = mk(cpp); x.d.fold(x.lines, 5, 18, true); x.d.fold(x.lines, 2, 4, true);
const p2 = [{ line: 3, col: 5 }];
x.d.unfoldMany(x.lines, [2], p2);
assert.deepStrictEqual(p2[0], { line: 5, col: 5 });
assert.ok(x.d.idOf(x.lines[5]) > 0);
assert.strictEqual(full(x), cpp);

console.log('fold-kit: OK');
