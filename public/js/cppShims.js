// public/js/cppShims.js — các "header giả" để code kiểu Dev-C++ chạy được trên clang/WASI trong trình duyệt.
// Ghi vào thư mục ảo /project; dùng với  -I/project -include /project/mnha_prelude.h  → KHÔNG đổi số dòng code người dùng.
(function (root) {
    var STD = ['cassert', 'cctype', 'cerrno', 'cfloat', 'climits', 'cmath', 'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime',
        'algorithm', 'array', 'bitset', 'chrono', 'complex', 'deque', 'fstream', 'functional', 'iomanip', 'iostream', 'iterator',
        'limits', 'list', 'map', 'memory', 'numeric', 'queue', 'random', 'set', 'sstream', 'stack', 'string', 'tuple',
        'unordered_map', 'unordered_set', 'utility', 'vector'];
    var F = {};
    // #include <bits/stdc++.h> (chỉ có ở GCC)
    F["bits/stdc++.h"] = STD.map(function (h) { return '#include <' + h + '>'; }).join('\n') + '\n';

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

    // Bản "gọn" của bits/stdc++.h: clang chạy bằng WASM parse rất chậm → chỉ include header mà code thực sự dùng.
    var USE = {
        iostream: /\b(cin|cout|cerr|clog|endl|ios_base|ios|istream|ostream)\b/, string: /\b(string|getline|to_string|stoi|stol|stoll|stod|stof|stoul|stoull|char_traits)\b/,
        vector: /\bvector\b/, map: /\b(map|multimap)\b/, set: /\b(set|multiset)\b/, unordered_map: /\bunordered_(multi)?map\b/, unordered_set: /\bunordered_(multi)?set\b/,
        queue: /\b(queue|priority_queue)\b/, stack: /\bstack\b/, deque: /\bdeque\b/, list: /\blist\b/, array: /\bstd::array\b|\barray\s*</, bitset: /\bbitset\b/,
        tuple: /\b(tuple|tie|make_tuple|get)\b/, utility: /\b(pair|make_pair|swap|move|forward)\b/,
        algorithm: /\b(sort|stable_sort|reverse|min|max|swap|find|find_if|count|count_if|fill|unique|lower_bound|upper_bound|binary_search|max_element|min_element|next_permutation|prev_permutation|__gcd|nth_element|rotate|remove|replace|copy|for_each|transform|any_of|all_of|none_of|equal_range|merge|partial_sort|minmax|clamp|shuffle|random_shuffle|is_sorted|includes|set_union|set_intersection)\b/,
        numeric: /\b(accumulate|iota|gcd|lcm|partial_sum|inner_product|adjacent_difference)\b/,
        cmath: /\b(sqrt|pow|fabs|floor|ceil|sin|cos|tan|asin|acos|atan|atan2|log|log2|log10|exp|round|hypot|fmod|cbrt|trunc|M_PI|M_E|INFINITY|NAN|isnan|isinf|abs)\b/,
        iomanip: /\b(setw|setprecision|setfill|setbase|put_time|get_money)\b/, sstream: /\b(stringstream|ostringstream|istringstream)\b/, fstream: /\b(fstream|ifstream|ofstream)\b/,
        cstring: /\b(strlen|strcpy|strncpy|strcmp|strncmp|strcat|strncat|strchr|strrchr|strstr|strtok|memset|memcpy|memmove|memcmp)\b/,
        cstdlib: /\b(rand|srand|atoi|atol|atoll|atof|exit|malloc|calloc|realloc|free|qsort|abs|labs|llabs|system|RAND_MAX|EXIT_SUCCESS|EXIT_FAILURE)\b/,
        ctime: /\b(time|clock|clock_t|time_t|CLOCKS_PER_SEC|difftime|localtime|strftime)\b/, cctype: /\b(isalpha|isdigit|isalnum|isupper|islower|isspace|ispunct|toupper|tolower|isxdigit)\b/,
        climits: /\b(INT_MAX|INT_MIN|UINT_MAX|LONG_MAX|LONG_MIN|LLONG_MAX|LLONG_MIN|ULLONG_MAX|CHAR_BIT|SHRT_MAX|SHRT_MIN)\b/, cfloat: /\b(DBL_MAX|DBL_MIN|FLT_MAX|FLT_MIN|DBL_EPSILON|FLT_EPSILON)\b/,
        cstdint: /\b(u?int(8|16|32|64)_t|size_t|intptr_t)\b/, functional: /\b(function|greater|less|bind|hash|plus|minus|multiplies)\b/,
        random: /\b(mt19937|mt19937_64|random_device|uniform_int_distribution|uniform_real_distribution|default_random_engine)\b/, chrono: /\bchrono\b/,
        limits: /\bnumeric_limits\b/, cassert: /\bassert\b/, iterator: /\b(back_inserter|inserter|distance|advance|next|prev|istream_iterator|ostream_iterator)\b/,
        memory: /\b(unique_ptr|shared_ptr|weak_ptr|make_unique|make_shared)\b/, complex: /\bcomplex\b/
    };
    function leanStdcpp(code) {
        var src = String(code).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/"(\\.|[^"\\])*"/g, '""');
        var out = ['#include <cstdio>', '#include <cstdlib>'];
        Object.keys(USE).forEach(function (h) { if (USE[h].test(src) && h !== 'cstdlib') out.push('#include <' + h + '>'); });
        if (out.indexOf('#include <iostream>') < 0 && /\b(cin|cout)\b/.test(src)) out.push('#include <iostream>');
        return out.join('\n') + '\n';
    }
    root.CppShims = { files: F, names: Object.keys(F), leanStdcpp: leanStdcpp };
    if (typeof module !== 'undefined') module.exports = root.CppShims;
})(typeof window !== 'undefined' ? window : globalThis);
