// config/codeConfig.js — ứng dụng "Lập trình": ngôn ngữ được hỗ trợ + giới hạn
'use strict';
const LANGS = {
    emu8086: {
        key: 'emu8086', name: 'Emu8086 (Assembly 8086)', icon: 'cpu',
        description: 'Viết và chạy hợp ngữ 8086 như phần mềm emu8086, ngay trên web.',
        runExt: 'asm', exts: ['asm'], editorMode: 'asm',
        template: ['; Emu8086 - Hello', '.model small', '.stack 100h', '.data', "msg db 'Hello, MNHA!$'", '.code', 'main proc', '    mov ax, @data', '    mov ds, ax', '    lea dx, msg', '    mov ah, 9', '    int 21h', '    mov ah, 4ch', '    int 21h', 'main endp', 'end main', ''].join('\n')
    },
    cpp: {
        key: 'cpp', name: 'C++ (Dev-C++)', icon: 'terminal',
        description: 'Viết và chạy C++ như Dev-C++; tạo được file .txt để freopen stdin/stdout.',
        runExt: 'cpp', exts: ['cpp', 'txt'], editorMode: 'cpp',
        template: ['#include <bits/stdc++.h>', 'using namespace std;', '', 'int main() {', '    // freopen("input.txt", "r", stdin);', '    // freopen("output.txt", "w", stdout);', '    int a, b;', '    cout << "Nhap a, b: ";', '    cin >> a >> b;', '    cout << "Tong = " << a + b << endl;', '    return 0;', '}', ''].join('\n')
    }
};

const LIMITS = {
    MAX_FILE_BYTES: 200 * 1024,
    MAX_DEPTH: 4,
    MAX_FILES_PER_DIR_SYNC: 30,       // số file .txt cùng thư mục được nạp vào thư mục chạy
    MAX_OUT_FILE_BYTES: 512 * 1024,   // file .txt do chương trình ghi ra (output.txt...)
    RUN_WALL_MS: 60 * 1000,           // tổng thời gian chạy (không tính lúc chờ nhập)
    IDLE_INPUT_MS: 5 * 60 * 1000,     // chờ nhập quá lâu → dừng
    COMPILE_MS: 25 * 1000,
    MAX_CONSOLE_BYTES: 1024 * 1024,
    MAX_SESSIONS_PER_USER: 3
};
// Chạy C++ ở đâu: 'server' (g++ trên máy chủ) | 'browser' (clang WebAssembly ngay trong trình duyệt).
// Mặc định: trên Vercel (không có g++) → 'browser'; chỗ khác → 'server'. Ép bằng biến môi trường CPP_RUN_MODE.
// CPP_RUNNER_URL (+ CPP_RUNNER_KEY): trỏ tới dịch vụ runner/ (Docker có g++) → web chính chỉ chuyển yêu cầu sang đó (giống OnlineGDB).
const CPP_RUNNER_URL = process.env.CPP_RUNNER_URL || '';
const CPP_RUNNER_KEY = process.env.CPP_RUNNER_KEY || '';
const CPP_RUN_MODE = process.env.CPP_RUN_MODE || (CPP_RUNNER_URL ? 'server' : (process.env.VERCEL ? 'browser' : 'server'));
const NAME_RE = /^[A-Za-z0-9_\-]{1,60}$/;
module.exports = { LANGS, LIMITS, NAME_RE, CPP_RUN_MODE, CPP_RUNNER_URL, CPP_RUNNER_KEY };
