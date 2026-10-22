// public/js/cppShims.js — các "header giả" để code kiểu Dev-C++ chạy được trên clang/WASI trong trình duyệt.
// Ghi vào thư mục ảo /project; dùng với  -I/project -include /project/mnha_prelude.h  → KHÔNG đổi số dòng code người dùng.
(function (root) {
    var STD = ['cassert', 'cctype', 'cerrno', 'cfloat', 'climits', 'cmath', 'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime',
        'algorithm', 'array', 'bitset', 'chrono', 'complex', 'deque', 'fstream', 'functional', 'iomanip', 'iostream', 'iterator',
        'limits', 'list', 'map', 'memory', 'numeric', 'queue', 'random', 'set', 'sstream', 'stack', 'string', 'tuple',
        'unordered_map', 'unordered_set', 'utility', 'vector'];
    var F = {};
    // #include <bits/stdc++.h> (chỉ có ở GCC)
    F['bits/stdc++.h'] = STD.map(function (h) { return '#include <' + h + '>'; }).join('\n') + '\n';

    // Tiền xử lý nạp trước mọi file: system("pause"/"cls"...), getch...
    F['mnha_prelude.h'] = [
        '#pragma once',
        '#include <cstdio>', '#include <cstdlib>', '#include <cstring>', '#include <string>',
        'static inline int mnha_system(const char* c) {',
        '    std::string s = c ? c : "";',
        '    if (s.find("pause") == 0) { std::fputs("Press any key to continue . . . ", stdout); std::fflush(stdout); std::getchar(); return 0; }',
        '    if (s == "cls" || s == "clear") { std::fputs("\\x1b[2J\\x1b[H", stdout); return 0; }',
        '    if (s.find("color") == 0 || s.find("title") == 0 || s.find("mode") == 0) return 0;',
        '    std::fputs("[system(\\"", stderr); std::fputs(c ? c : "", stderr); std::fputs("\\") không hỗ trợ trên web]\\n", stderr); return -1;',
        '}',
        'namespace std { using ::mnha_system; }',
        '#define system mnha_system',
        ''
    ].join('\n');

    // <conio.h> của Dev-C++/Turbo C
    F['conio.h'] = [
        '#pragma once', '#include <cstdio>',
        'static inline int getch() { return std::getchar(); }',
        'static inline int getche() { int c = std::getchar(); if (c != EOF) std::putchar(c); return c; }',
        'static inline int _getch() { return getch(); }',
        'static inline int _getche() { return getche(); }',
        'static inline int kbhit() { return 0; }',
        'static inline int _kbhit() { return 0; }',
        'static inline void clrscr() { std::fputs("\\x1b[2J\\x1b[H", stdout); }',
        'static inline void gotoxy(int x, int y) { std::printf("\\x1b[%d;%dH", y, x); }',
        'static inline void textcolor(int) {}', 'static inline void textbackground(int) {}',
        ''
    ].join('\n');

    // <windows.h> (chỉ vài hàm hay dùng)
    F['windows.h'] = [
        '#pragma once', '#include <cstdio>',
        'typedef void* HANDLE; typedef unsigned long DWORD; typedef unsigned short WORD;',
        'struct COORD { short X; short Y; };',
        '#define STD_OUTPUT_HANDLE ((DWORD)-11)',
        'static inline void Sleep(DWORD) {}',
        'static inline HANDLE GetStdHandle(DWORD) { return 0; }',
        'static inline int SetConsoleTextAttribute(HANDLE, WORD) { return 1; }',
        'static inline int SetConsoleCursorPosition(HANDLE, COORD c) { std::printf("\\x1b[%d;%dH", c.Y + 1, c.X + 1); return 1; }',
        ''
    ].join('\n');

    root.CppShims = { files: F, names: Object.keys(F) };
    if (typeof module !== 'undefined') module.exports = root.CppShims;
})(typeof window !== 'undefined' ? window : globalThis);
