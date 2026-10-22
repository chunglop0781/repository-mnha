# repository-mnha

Web riêng để viết & chạy code **Emu8086 (Assembly 8086)** và **C++** (có freopen với file .txt).
KHÔNG phải một phần của "Luyện thi của MNHA" — chỉ **dùng chung database người dùng** (MongoDB) với dự án đó.

## Dùng chung tài khoản
- Đặt `MONGODB_URI` giống hệt dự án Luyện thi → cùng collection `users` và `otps`.
- Đăng ký ở web nào, tài khoản (role `client`, status `pending`, userKey `null`, bcrypt 12 — đúng dạng dự án cũ) cũng dùng được ở web kia.
- repository-mnha không kiểm tra duyệt: đăng nhập được là dùng được (chỉ chặn tài khoản `disabled`/đã xoá hẳn).
- Session riêng: cookie `mnha.sid`, lưu ở GitHub `cookies/index.json` (mã hoá) — KHÔNG ghi vào MongoDB.
- ⚠ Schema `models/User.js`, `models/OTP.js` phải GIỮ KHỚP dự án cũ; nếu dự án cũ đổi schema thì sửa theo.

## Chạy
```
cp .env.example .env   # điền MONGODB_URI, GITHUB_*, MAIL_*
npm install
npm start
```
Xem `CODE.md` cho chi tiết emu8086/C++, lưu GitHub và lưu ý triển khai.

## Lịch sử chạy code & xem code trên mạng
- Trang danh sách file (`/code/emu8086`, `/code/cpp`) có 2 nút:
  - **Lịch sử chạy code** (`/code/:lang/history`): xem lại từng lần chạy — chỉ XEM code (đúng như lúc chạy) và màn hình kết quả.
  - **Xem code trên mạng** (`/code/:lang/online`): dán link file trên **github.com** hoặc **gitlab.com** (có hướng dẫn lấy link ngay trên trang) → xem code (không sửa được) và bấm chạy để xem màn hình. Mỗi lần chạy được lưu vào lịch sử cùng link nguồn (`origin`).
- Máy chủ tự tải code từ link nên chỉ nhận đúng 2 host trên, tự dựng lại địa chỉ raw, kiểm tra từng lần redirect, giới hạn 200KB, từ chối file nhị phân/trang đăng nhập (xem `services/code/remoteSource.js`). Repo chứa code phải công khai.
- Test: `node test/online-source.js`.
- C++ đọc được file **cùng thư mục** khi chạy (cả code của tôi lẫn code xem trên mạng): `#include "x.hpp"` (kể cả thư mục con, đệ quy), `x.cpp` đi kèm `x.hpp` tự biên dịch cùng (trừ khi có `main`), và file `.txt` cho freopen. Header cũng bị lọc an toàn như `main.cpp`. Test: `node test/cpp-includes.js`.
