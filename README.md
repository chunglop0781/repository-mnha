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

## Nhiều web dữ liệu + tải lên dự phòng (`/connect`)
Web chính có thể dùng **nhiều Vercel deployment** làm "web dữ liệu" để nhận ảnh / âm thanh / video.
- Mỗi web dữ liệu chạy **cùng codebase**, chỉ khác `.env`: `DATA_NODE=on`, `NODE_ID`, `NODE_URL`, `NODE_NAME`; các biến bí mật (`MONGODB_URI`, `SESSION_*`, `CONNECT_*`, `GITHUB_*`) phải **giống hệt** web chính.
- Web dữ liệu **chỉ cho admin mặc định** (`role=admin`, `userKey=null`) đăng nhập; admin tổ chức / student / client bị từ chối.
- Lần đầu admin mặc định đăng nhập ở web dữ liệu: web tự tạo **khoá kết nối**, mã hoá 2 chiều rồi ghi vào `v-s/index.json` của repo GitHub chính. Khoá gốc chỉ hiện **một lần** ở `/connect` của web dữ liệu.
- Trang `/connect` của web chính (chỉ admin mặc định): thêm / đổi tên / bật-tắt / xoá web, kiểm tra **lần lượt cũ → mới**, xem **Fast Data Transfer** và **Fast Origin Transfer** (số đo thực tế của app + số chính thức của Vercel nhập tay), và `.env` mẫu giống hệt cho từng web.
- Khi tải media: web chính chọn web đầu tiên hoạt động và ký **phiếu tải lên** (HMAC, 2 giờ) để trình duyệt gửi **thẳng** lên web dữ liệu; web đang dùng lỗi → tự chuyển web kế tiếp (web lỗi tạm nghỉ 90 giây). Không có web nào → báo lỗi, hoặc tải lên máy chủ chính nếu `CONNECT_FALLBACK_LOCAL=on`.
- Repo media tự xoay vòng: khi repo đang dùng đạt ~500MB (`MEDIA_REPO_LIMIT_BYTES`), hệ thống tự tạo `GITHUB_MEDIA_REPO_PREFIX-N` bằng `GITHUB_MEDIA_TOKEN` và ghi tiếp; `mnha-media.json` vẫn ở repo chính, đọc gộp mọi repo.
- Tài khoản **chưa được duyệt** (`pending`/`rejected`/`disabled` hoặc client chưa approved) bị chặn tải ảnh/âm thanh/video với thông báo: *"Tài khoản bị … vì vậy hãy nhắn quản trị viên để mở tính năng này."* Sửa code/file vẫn dùng bình thường.
- Cấu hình mẫu: xem `.env.example`; chi tiết luồng & bảo mật: `CODE.md` mục "Web kết nối".

## Tài khoản GitHub riêng cho media + bảo mật mã hoá (cập nhật)
- **GitHub mới chỉ để chứa media**: đặt `GITHUB_MEDIA_TOKEN` (token của tài khoản mới, quyền tạo repo) và `GITHUB_MEDIA_OWNER` (tên tài khoản đó). Khi `GITHUB_MEDIA_OWNER` khác `GITHUB_OWNER`, pool tự bật: repo đầu tiên `<prefix>-1` được tạo ở tài khoản mới (không ghi media vào repo chính), đầy ~500MB thì tạo `-2`, `-3`… `mnha-media.json` và `v-s/*` vẫn ở repo chính.
- **Khoá kết nối thật sự có tác dụng**: web chính ký yêu cầu tới từng web dữ liệu bằng khoá RIÊNG của web đó (`hmacWithKey`), nên chỉ biết `CONNECT_ENC_KEY` dùng chung vẫn không giả được chữ ký.
- **Mã hoá v2** (`v2.<iv>.<tag>.<ct>`): AES-256-GCM, AAD = `connect|<id web>`, kiểu dữ liệu nằm trong phần mã hoá; vẫn đọc được bản `v1` cũ. `CONNECT_ENC_KEY` quá yếu bị từ chối.
- Đặt `MAIN_URL=https://repository-mnha.vercel.app` ở web dữ liệu để chỉ web chính được gọi `/api/node/*` từ trình duyệt (CORS).
- Test: `node test/connect-crypto.js`.
- **Tên repo media theo thời gian**: đặt `GITHUB_MEDIA_REPO_PREFIX=mnha-media-{ts}` → repo tạo ra dạng `mnha-media-20261025-091530`. Không có `{ts}` thì vẫn đánh số `-1`, `-2`.

## Deploy lên Vercel
- `vercel.json` + `api/index.js`: mọi đường dẫn chạy qua một serverless function (Express xuất từ `server.js`, MongoDB nối lười ở request đầu; `/api/node/health` không cần MongoDB).
- Nếu đẩy cả thư mục `repository-mnha/` lên GitHub (không phải nội dung bên trong) thì ở Vercel → Settings → General → **Root Directory** đặt `repository-mnha`.
- Settings → Build and Deployment: Framework Preset = **Other**, để trống Build/Output/Install command.
