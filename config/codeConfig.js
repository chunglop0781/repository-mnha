// config/codeConfig.js — ứng dụng "Lập trình": ngôn ngữ được hỗ trợ + giới hạn
'use strict';
// Đuôi file tải lên (ảnh / âm thanh / video) cho dạng 'web' (html). File văn bản sửa được nằm ở `exts`.
const ASSET_EXTS = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'],
    audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'],
    video: ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv']
};
const LANGS = {
    emu8086: {
        key: 'emu8086', name: 'Emu8086 (Assembly 8086)', icon: 'cpu',
        description: 'Viết và chạy hợp ngữ 8086 như phần mềm emu8086, ngay trên web.',
        runExt: 'asm', exts: ['asm'], editorMode: 'asm',
        template: ['; Emu8086 - Hello', '.model small', '.stack 100h', '.data', "msg db 'Hello, MNHA!$'", '.code', 'main proc', '    mov ax, @data', '    mov ds, ax', '    lea dx, msg', '    mov ah, 9', '    int 21h', '    mov ah, 4ch', '    int 21h', 'main endp', 'end main', ''].join('\n')
    },
    cpp: {
        key: 'cpp', name: 'C++ (Dev-C++)', icon: 'terminal',
        description: 'Viết và chạy C++ như Dev-C++; tạo được file .txt (freopen) và header .h/.hpp (#include "..." cùng thư mục).',
        runExt: 'cpp', exts: ['cpp', 'txt', 'h', 'hpp', 'hh', 'hxx', 'inl', 'ipp', 'tpp'], editorMode: 'cpp',
        template: ['#include <bits/stdc++.h>', 'using namespace std;', '', 'int main() {', '    // freopen("input.txt", "r", stdin);', '    // freopen("output.txt", "w", stdout);', '    int a, b;', '    cout << "Nhap a, b: ";', '    cin >> a >> b;', '    cout << "Tong = " << a + b << endl;', '    return 0;', '}', ''].join('\n')
    },
    html: {
        key: 'html', name: 'HTML + CSS', icon: 'layout-template', kind: 'web',
        description: 'Viết HTML/CSS/JS và xem trang ngay (Code ⇄ View); tải ảnh, âm thanh, video lên (có mã hoá) để nhúng vào trang. Xem được cả trang HTML trên GitHub/GitLab kèm CSS, JS, ảnh cùng thư mục.',
        runExt: 'html', runExts: ['html', 'htm'],
        exts: ['html', 'htm', 'css', 'js', 'json', 'svg', 'txt'], editorMode: 'html',
        assetExts: ASSET_EXTS,
        template: ['<!DOCTYPE html>', '<html lang="vi">', '<head>', '  <meta charset="UTF-8">', '  <meta name="viewport" content="width=device-width, initial-scale=1">', '  <title>Trang của tôi</title>', '  <!-- CSS riêng: tạo file style.css cùng thư mục rồi bỏ comment dòng dưới -->', '  <!-- <link rel="stylesheet" href="style.css"> -->', '  <style>', '    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; }', '    h1 { color: #4f46e5; }', '  </style>', '</head>', '<body>', '  <h1>Xin chào, MNHA!</h1>', '  <p>Sửa code ở tab Code, bấm View để xem trang.</p>', '  <!-- Ảnh/âm thanh/video đã tải lên (cùng thư mục) nhúng như bình thường: -->', '  <!-- <img src="anh.png" alt="" width="300"> -->', '  <!-- <audio controls src="nhac.mp3"></audio> -->', '  <!-- <video controls src="phim.mp4" width="480"></video> -->', '</body>', '</html>', ''].join('\n')
    }
};

// File .txt TRẮNG (tạo mới hoặc lưu khi chưa nhập gì) được ghi tạm dòng này (xuống dòng + gợi ý) thay vì file rỗng.
// Khi chạy code, file chỉ chứa đúng dòng này được nạp như file RỖNG (siblingTextFiles).
const EMPTY_TXT_PLACEHOLDER = '\nhap-du-lieu-input-vao-day';
const LIMITS = {
    MAX_FILE_BYTES: 200 * 1024,
    MAX_DEPTH: 4,
    MAX_FILES_PER_DIR_SYNC: 30,       // số file .txt cùng thư mục được nạp vào thư mục chạy
    MAX_OUT_FILE_BYTES: 512 * 1024,   // file .txt do chương trình ghi ra (output.txt...)
    RUN_WALL_MS: 60 * 1000,           // tổng thời gian chạy (không tính lúc chờ nhập)
    IDLE_INPUT_MS: 5 * 60 * 1000,     // chờ nhập quá lâu → dừng
    COMPILE_MS: 25 * 1000,
    MAX_CONSOLE_BYTES: 1024 * 1024,
    MAX_SESSIONS_PER_USER: 3,
    ONLINE_OUT_DIR: 'tren-mang',      // file .txt chương trình ghi ra khi chạy code "xem trên mạng" → tự lưu vào codes/cpp/tren-mang/
    ONLINE_OUT_MAX_FILES: 10
};
// Chạy C++ ở đâu: 'server' (g++ trên máy chủ) | 'browser' (clang WebAssembly ngay trong trình duyệt).
// Mặc định: trên Vercel (không có g++) → 'browser'; chỗ khác → 'server'. Ép bằng biến môi trường CPP_RUN_MODE.
// CPP_RUNNER_URL (+ CPP_RUNNER_KEY): trỏ tới dịch vụ runner/ (Docker có g++) → web chính chỉ chuyển yêu cầu sang đó (giống OnlineGDB).
const CPP_RUNNER_URL = process.env.CPP_RUNNER_URL || '';
const CPP_RUNNER_KEY = process.env.CPP_RUNNER_KEY || '';
const CPP_RUN_MODE = process.env.CPP_RUN_MODE || (CPP_RUNNER_URL ? 'server' : (process.env.VERCEL ? 'browser' : 'server'));
const NAME_RE = /^[A-Za-z0-9_\-]{1,60}$/;                                   // tên thư mục
const FILE_STEM_RE = /^(?=.{1,60}$)[A-Za-z0-9_\-]+(?: [A-Za-z0-9_\-]+)*$/;      // tên file (không đuôi): cho phép dấu cách giữa các từ, vd "Chu thuong thanh hoa"

// ---- Tải lên ảnh / âm thanh / video cho dạng 'web' (html) — xem services/code/mediaService.js
// Vercel chỉ nhận body ≤ 4.5MB/request nên file được gửi theo từng PHẦN ≤ PART_BYTES; mọi phần đều được mã hoá ở server trước khi lên GitHub.
//   • file ≤ DIRECT_MAX  : mã hoá trực tiếp thành 1 file cùng tên (ghép các phần ở request cuối).
//   • âm thanh/video > DIRECT_MAX : trình duyệt CẮT thành các đoạn MPEG-TS ≤ SEG_MAX_BYTES (m3u8 + .ts, xem public/js/tsMux.js),
//     server mã hoá từng đoạn .ts, tên gốc (vd song.mp3) khai báo là m3u8 trong mnha-media.json.
const MEDIA = {
    DIRECT_MAX: 23 * 1024 * 1024,
    PART_BYTES: 3.5 * 1024 * 1024,
    SEG_MAX_BYTES: 3.5 * 1024 * 1024,
    SEG_AUDIO_SEC: 10,
    SEG_VIDEO_SEC: 6,
    MAX_FILE_BYTES: (Number(process.env.MEDIA_MAX_BYTES) > 0 ? Number(process.env.MEDIA_MAX_BYTES) : 2 * 1024 * 1024 * 1024),
    MANIFEST: 'mnha-media.json',   // cùng thư mục với file gốc: { files: { "song.mp3": {...playlist, khoá DRM đã mã hoá...} } }
    HIDDEN_DIR: '_media',          // nơi chứa m3u8 + đoạn đã mã hoá (ẩn khỏi danh sách file)
    PREVIEW_TTL_MS: 12 * 60 * 60 * 1000,
    HLSJS_URL: process.env.HLSJS_URL || 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js',
    HLS_AUDIO_EXTS: ['mp3', 'aac', 'm4a'],     // âm thanh > DIRECT_MAX cắt được
    HLS_VIDEO_EXTS: ['mp4', 'm4v', 'mov']      // video > DIRECT_MAX cắt được (H.264 → TS; H.265/AV1/VP9 → fMP4; âm thanh AAC/MP3/Opus/FLAC; mp4 thường — không phân mảnh sẵn)
};
const mediaKind = (name) => {
    const e = String(name || '').split('.').pop().toLowerCase();
    for (const k of Object.keys(ASSET_EXTS)) if (ASSET_EXTS[k].includes(e)) return k;
    return null;
};
module.exports = { EMPTY_TXT_PLACEHOLDER, LANGS, LIMITS, NAME_RE, FILE_STEM_RE, CPP_RUN_MODE, CPP_RUNNER_URL, CPP_RUNNER_KEY, ASSET_EXTS, MEDIA, mediaKind };
