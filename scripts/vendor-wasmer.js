// scripts/vendor-wasmer.js — tải Wasmer JS SDK về public/vendor/wasmer/ để TỰ HOST (khỏi phụ thuộc unpkg, và cùng origin
// nên COEP require-corp của Safari/iOS không bị CDN ngoài chặn). Cần mạng + npm + tar (Windows 10+ có sẵn tar).
//   node scripts/vendor-wasmer.js              # bản 0.8.0-beta.1 (đúng bản đang dùng)
//   node scripts/vendor-wasmer.js 0.8.0-beta.2 # bản khác
// Xong chỉ cần redeploy: utils/isolation.js tự thấy public/vendor/wasmer/index.mjs và trỏ trang C++ vào đó
// (đặt WASMER_SDK_URL để ép nguồn khác). Gói clang/clang vẫn tải từ registry của Wasmer (có cache trình duyệt).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = process.argv[2] || '0.8.0-beta.1';
const DEST = path.join(__dirname, '..', 'public', 'vendor', 'wasmer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasmer-sdk-'));
try {
    console.log(`Tải @wasmer/sdk@${VERSION} ...`);
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', `@wasmer/sdk@${VERSION}`, '--pack-destination', tmp], { stdio: 'inherit', shell: process.platform === 'win32' });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack không tạo ra file .tgz');
    execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp], { stdio: 'inherit' });
    const dist = path.join(tmp, 'package', 'dist');
    if (!fs.existsSync(path.join(dist, 'index.mjs'))) throw new Error('Gói không có dist/index.mjs — đổi phiên bản hoặc sửa VENDOR_SDK_REL trong utils/isolation.js');
    fs.rmSync(DEST, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
    fs.cpSync(dist, DEST, { recursive: true });
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    walk(DEST).forEach((f) => console.log('  ' + path.relative(DEST, f) + '  ' + (fs.statSync(f).size / 1024).toFixed(0) + ' KB'));
    console.log(`\nĐã chép vào ${path.relative(process.cwd(), DEST)}. Commit thư mục này (hoặc chạy script trong bước build) rồi redeploy.`);
    console.log('Kiểm tra: mở /code/cpp/iso-check trên Chrome và Safari, "Nguồn SDK" phải là /vendor/wasmer/index.mjs.');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
