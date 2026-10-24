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
- Khi chạy code xem trên mạng mà chương trình ghi file (vd `freopen("output.txt","w",stdout)`), các file **mới/đã đổi** tự được tạo trong `{user_id}/codes/cpp/tren-mang/` (thư mục tự có, trùng tên thì ghi đè; tối đa 10 file, mỗi file ≤ 200KB) và hiện ở trang `/code/cpp` như thư mục của bạn. Đường dẫn cũng nằm trong JSON kết quả (`autoSaved`). Code của tôi thì vẫn dùng nút "Lưu vào thư mục". Test: `node test/online-outputs.js`.
- Test: `node test/online-source.js`.
- C++ đọc được file **cùng thư mục** khi chạy (cả code của tôi lẫn code xem trên mạng): `#include "x.hpp"` (kể cả thư mục con, đệ quy), `x.cpp` đi kèm `x.hpp` tự biên dịch cùng (trừ khi có `main`), và file `.txt` cho freopen. Header cũng bị lọc an toàn như `main.cpp`. Test: `node test/cpp-includes.js`.

## HTML + CSS (`/code/html`)
Viết html/css/js, **xem trang ngay** (tab Code ⇄ View), tải **ảnh / âm thanh / video** lên (mã hoá; file > 23MB tự cắt m3u8 ngay trong trình duyệt — video H.264, H.265/HEVC, AV1, VP9 — mã hoá DRM AES-128), nhúng vào html bằng tên gốc. Trang `/code/html/online` xem code + trang html từ GitHub/GitLab (kèm css/ảnh/media cùng thư mục) và **xem thư mục**. Trình phát ảnh/âm thanh/video cho cả thư mục của tôi lẫn trên mạng, mọi media đều có nút Tải. Media được **trình duyệt tự giải mã** (tải thẳng từ GitHub raw, máy chủ chỉ trả khoá nhỏ từng file sau khi kiểm quyền) để không tốn Fast Origin Transfer của Vercel — repo cần công khai, hoặc đặt `MEDIA_DIRECT=off` để quay về giải mã ở máy chủ. Chi tiết, giới hạn và bảo mật: xem `CODE.md` (mục HTML + CSS → "Trình duyệt TỰ giải mã"). Chạy toàn bộ test: `npm test` (cần ffmpeg để chạy test cắt/phát m3u8; thiếu thì bỏ qua phần đó).
