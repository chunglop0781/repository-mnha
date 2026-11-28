// node test/cpp-errors.js — thông báo lỗi C++ phải đúng khuôn g++ (file:dòng:cột: error: ... + dòng code + ^~~) và lỗi chạy phải như terminal Linux.
// Thêm ca mới: thêm 1 phần tử vào mảng `cases` ([tên, code, {files}, kết quả mong đợi, status, exitCode]).
const assert = require('assert');
const C = require('../public/js/cppJs.js');

async function run(code, files) {
    let out = '';
    const h = C.start({ code, files: files || [], fileName: 'bai1.cpp', onOut: (s) => { out += s; }, onStatus() { }, onCompiled() { } });
    const r = await Promise.race([h.done, new Promise((res) => setTimeout(() => res({ status: 'HANG' }), 6000))]);
    return { out, r };
}
const H = '#include <bits/stdc++.h>\nusing namespace std;\n';
const cases = [
    // ---- lỗi cú pháp (phát hiện lúc phân tích, chưa chạy dòng nào)
    ['thiếu ;', H + 'int main() {\n    int x = 5\n    cout << x;\n}\n', 0,
        'bai1.cpp:4:14: error: expected ‘;’ before ‘cout’\n    4 |     int x = 5\n      |              ^\n      |              ;\n', 'compile-error', null],
    ['thiếu )', H + 'int main() {\n    cout << (1 + 2;\n}\n', 0,
        'bai1.cpp:4:19: error: expected ‘)’ before ‘;’ token\n    4 |     cout << (1 + 2;\n      |                   ^\n', 'compile-error', null],
    ['thiếu } cuối file', H + 'int main() {\n    cout << 1;\n', 0,
        'bai1.cpp:4:15: error: expected ‘}’ at end of input\n    4 |     cout << 1;\n      |               ^\n', 'compile-error', null],
    ['nháy cong dán từ Word', '#include <iostream>\nint main() { std::cout << “hi”; }\n', 0,
        'bai1.cpp:2:27: error: stray ‘\\342’ in program\n    2 | int main() { std::cout << “hi”; }\n      |                           ^\n' +
        'bai1.cpp:2:28: error: stray ‘\\200’ in program\n    2 | int main() { std::cout << “hi”; }\n      |                            ^\n' +
        'bai1.cpp:2:29: error: stray ‘\\234’ in program\n    2 | int main() { std::cout << “hi”; }\n      |                             ^\n', 'compile-error', null],
    ['chuỗi chưa đóng', '#include <iostream>\nint main() {\n  std::cout << "hi;\n}\n', 0,
        'bai1.cpp:3:16: error: missing terminating " character\n    3 |   std::cout << "hi;\n      |                ^\n', 'compile-error', null],
    ['thiếu main → lỗi liên kết', '#include <iostream>\nint f(){ return 1; }\n', 0,
        '/usr/bin/ld: /usr/lib/gcc/x86_64-linux-gnu/12/../../../x86_64-linux-gnu/Scrt1.o: in function `_start\':\n(.text+0x1b): undefined reference to `main\'\ncollect2: error: ld returned 1 exit status\n', 'compile-error', null],
    // ---- lỗi ngữ nghĩa
    ['biến chưa khai báo (không gợi ý)', H + 'int main() {\n    int count = 3;\n    cout << zzz;\n}\n', 0,
        'bai1.cpp: In function ‘int main()’:\nbai1.cpp:5:13: error: ‘zzz’ was not declared in this scope\n    5 |     cout << zzz;\n      |             ^~~\n', 'compile-error', null],
    ['gõ sai tên → did you mean (tab được nới như g++)', '#include <iostream>\nusing namespace std;\nint f(int a, double b){\n\tcoutt << a;\n return 0;}\nint main() { f(1,2); }\n', 0,
        'bai1.cpp: In function ‘int f(int, double)’:\nbai1.cpp:4:2: error: ‘coutt’ was not declared in this scope; did you mean ‘cout’?\n    4 |         coutt << a;\n      |         ^~~~~\n      |         cout\n', 'compile-error', null],
    ['có output trước lỗi → thêm note', H + 'int main() {\n    cout << "a\\n";\n    cout << cnt;\n}\n', 0,
        'a\nbai1.cpp: In function ‘int main()’:\nbai1.cpp:5:13: error: ‘cnt’ was not declared in this scope\n    5 |     cout << cnt;\n      |             ^~~\nnote: g++ sẽ chặn lỗi này ngay lúc biên dịch và không chạy chương trình; trình thông dịch chỉ phát hiện khi chạy tới dòng này, nên phần kết quả phía trên là của các dòng đã chạy trước đó.\n', 'compile-error', null],
    ['struct không có thành viên', '#include <iostream>\nstruct P{int x;};\nint main() {\n  P p; p.x=1;\n  std::cout << p.getY();\n}\n', 0,
        'bai1.cpp: In function ‘int main()’:\nbai1.cpp:5:18: error: ‘struct P’ has no member named ‘getY’\n    5 |   std::cout << p.getY();\n      |                  ^~~~\n', 'compile-error', null],
    ['gán vào giá trị không phải lvalue', '#include <iostream>\nint main(){ int a=1; 5 = a; }\n', 0,
        'bai1.cpp: In function ‘int main()’:\nbai1.cpp:2:24: error: lvalue required as left operand of assignment\n    2 | int main(){ int a=1; 5 = a; }\n      |                        ^\n', 'compile-error', null],
    ['lỗi nằm trong header → In file included from', '#include "a.h"\nint main(){ f(); }\n', [{ name: 'a.h', content: '#include <iostream>\n// c\nvoid f(){\n  std::cout << zz;\n}\n' }],
        'In file included from bai1.cpp:1:\na.h: In function ‘void f()’:\na.h:4:16: error: ‘zz’ was not declared in this scope\n    4 |   std::cout << zz;\n      |                ^~\n', 'compile-error', null],
    ['dòng có macro vẫn chỉ đúng chữ', '#define N 10\n#include <iostream>\nint main(){ int a[N]; std::cout << N << bb; }\n', 0,
        '10\nbai1.cpp: In function ‘int main()’:\nbai1.cpp:3:41: error: ‘bb’ was not declared in this scope\n    3 | int main(){ int a[N]; std::cout << N << bb; }\n      |                                         ^~\nnote: g++ sẽ chặn lỗi này ngay lúc biên dịch và không chạy chương trình; trình thông dịch chỉ phát hiện khi chạy tới dòng này, nên phần kết quả phía trên là của các dòng đã chạy trước đó.\n', 'compile-error', null],
    // ---- lỗi lúc chạy (như terminal Linux)
    ['chia số nguyên cho 0 → SIGFPE', H + 'int main() { int a=5,b=0; cout << "truoc\\n"; cout << a / b; }\n', 0,
        'truoc\nFloating point exception (core dumped)\n  ↳ bai1.cpp:3: chia số nguyên cho 0 (toán tử /)\n    3 | int main() { int a=5,b=0; cout << "truoc\\n"; cout << a / b; }\n', 'finished', 136],
    ['chia số thực cho 0 → inf, KHÔNG lỗi; double 5/2 = 2.5', H + 'int main() { double a=5, b=0; cout << a/2 << " " << a/b << " " << -1.0/0 << endl; }\n', 0, '2.5 inf -inf\n', 'finished', 0],
    ['v.at() ngoài phạm vi chưa bắt', H + 'int main() { vector<int> v={1,2,3}; cout << v.at(5); }\n', 0,
        "terminate called after throwing an instance of 'std::out_of_range'\n  what():  vector::_M_range_check: __n (which is 5) >= this->size() (which is 3)\nAborted (core dumped)\n", 'finished', 134],
    ['substr ngoài phạm vi bắt được bằng catch', H + 'int main() { string s="abc"; try { cout << s.substr(10); } catch (out_of_range& e) { cout << e.what() << endl; } }\n', 0,
        'basic_string::substr: __pos (which is 10) > this->size() (which is 3)\n', 'finished', 0],
    ['pop() trên stack rỗng → SIGSEGV', H + 'int main() { stack<int> st; cout << "x\\n"; st.pop(); }\n', 0,
        'x\nSegmentation fault (core dumped)\n  ↳ bai1.cpp:3: pop() gọi trên stack rỗng (hành vi không xác định trong C++)\n    3 | int main() { stack<int> st; cout << "x\\n"; st.pop(); }\n', 'finished', 139],
    ['throw; ngoài catch', '#include <iostream>\nint main(){ throw; }\n', 0,
        'terminate called without an active exception\nAborted (core dumped)\n  ↳ bai1.cpp:2: throw; được gọi khi không có ngoại lệ nào đang xử lý\n    2 | int main(){ throw; }\n', 'finished', 134]
];

(async () => {
    for (const [name, code, files, expect, status, exit] of cases) {
        const { out, r } = await run(code, files || undefined);
        assert.strictEqual(out, expect, name + ': nội dung báo lỗi sai\n--- thực tế ---\n' + out + '--- mong đợi ---\n' + expect);
        assert.strictEqual(r.status, status, name + ': status ' + r.status);
        assert.strictEqual(r.exitCode, exit, name + ': exitCode ' + r.exitCode);
        if (status === 'compile-error') assert.ok(/(error): /.test(r.error), name + ': result.error phải có dòng "error:" (' + r.error + ')');
    }
    console.log('cpp-errors: ' + cases.length + ' ca báo lỗi kiểu g++ / terminal — đạt');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
