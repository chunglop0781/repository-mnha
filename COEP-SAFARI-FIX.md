# COEP / Safari / Wasmer — kiểm tra lại (27/11/2026)

## Đã xác nhận bằng nguồn
- **Safari và Safari iOS chưa hỗ trợ `COEP: credentialless`** (caniuse/MDN BCD, đến Safari 27.x) → dùng `require-corp`.
- **Firefox cho Android chưa hỗ trợ `credentialless`**; Firefox desktop có từ 119; Chrome/Edge từ 96. Code cũ chỉ loại WebKit nên gửi `credentialless` cho Firefox Android (không cô lập được, phải chờ client tự tải lại với `?coep=rc`).
- Tài liệu Wasmer chỉ nêu `require-corp` (+ COOP `same-origin`) cho SDK.

## Chưa xác nhận được (đừng coi là đã chắc)
- **`init({ registry })`**: tài liệu và API reference của Wasmer SDK không nêu tuỳ chọn này (chỉ thấy `module`, `token`). Nếu SDK bỏ qua nó thì proxy `/api/wasmer/registry` không được dùng. `/code/cpp/iso-check` giờ đo thực tế và báo "✔/✘ Truy vấn registry đi qua proxy".
- **CORS của registry/CDN gói clang dưới `require-corp`**: không có tài liệu; chỉ biết SDK dùng `fetch()`. Cách xác nhận duy nhất: chạy iso-check trên Safari/iPhone.
- **iPhone đời cũ thiếu RAM khi nạp clang**: có báo lỗi WebKit về Wasm bị jetsam, chưa có số liệu cho clang. Tối thiểu là không tải trước (xem dưới).

## Đã sửa trong code
- `utils/isolation.js`: `supportsCredentialless(ua)` — require-corp cho WebKit, Firefox Android, Firefox < 119, Chrome < 96.
- `public/js/perfKit.js`: không tự tải trước clang trên iPhone/iPad (kể cả iPad chế độ desktop) và máy ≤ 2 GB RAM; bấm Chạy mới nạp.
- `utils/vendorProxy.js`: gộp request đồng thời, timeout, dùng bản cũ khi CDN lỗi; có thể ghim Lucide bằng `VENDOR_LUCIDE_URL`.
- `views/layout.pug`: nếu `/vendor/*.js` lỗi thì lùi về CDN (gắn `crossorigin` chỉ khi trang đã cô lập).
- `services/wasmerProxy.js`: kiểm tra body, giới hạn 16 KB, timeout 15 giây, 120 truy vấn/phút/IP.
- `/code/cpp/iso-check`: thêm header COOP/COEP máy chủ thực gửi, số lần dùng proxy registry, danh sách host ngoài đã tải.
- Test mới: `test/vendor-proxy.js`; mở rộng `test/isolation.js`, `test/perf-kit.js`, `test/code-isolation.js`.

## Giới hạn còn lại
- Không dùng được `std::thread` và exception (giới hạn cũ).
- Tailwind CDN/Lucide: đã proxy cùng origin nên câu hỏi "CDN có gửi CORS không" không còn ảnh hưởng, trừ khi rơi vào đường lùi về CDN.
- Bản beta SDK `0.8.0-beta.1` chưa được mở thử trong môi trường này (không có mạng cho shell).

## Cách kiểm tra
1. `node test/run.js` — 5 test lỗi (`cloudflare`, `cloudflare-usage`, `html-media`, `html-upload-client`, `word`) cũng lỗi y hệt trên bản zip gốc khi chạy ở sandbox không có `node_modules`.
2. Deploy rồi mở `/code/cpp/iso-check` trên Chrome, Safari/iPhone, Firefox Android; gửi lại báo cáo cuối trang.
