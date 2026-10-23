# Ứng dụng "Lập trình" (emu8086 + C++)

Menu chính ở `/`, các trang code ở `/code/...` · chỉ cần đăng nhập, không có bước duyệt.

## Lưu trữ GitHub (repo cấu hình bằng GITHUB_*, riêng hoặc dùng chung với dự án khác đều được)
- Code:    `{user_id}/codes/{emu8086|cpp}/[thư-mục/...]/file`   (thư mục chỉ tạo được ở đây; thư mục rỗng giữ bằng `.keep`)
- Kết quả: `{user_id}/result/{emu8086|cpp}/{timestamp}.json`   (mỗi lần chạy, kể cả lỗi dịch/lỗi chạy)

## Emu8086 (services/emu8086/)
Viết lại từ đặc tả 8086 bằng Node.js (không dùng mã của emu8086): assembler.js (cú pháp emu8086: .MODEL/.DATA/.CODE,
ORG, DB/DW/DD/DUP, EQU, PROC, SEGMENT...) + machine.js (CPU, cờ, MUL/DIV, dịch/xoay, chuỗi, INT 21h/10h/16h/1Ah/20h).
Khi chương trình cần nhập (INT 21h AH=01/07/08/0A, INT 16h AH=00) máy dừng ở trạng thái `waiting` → giao diện hiện ô nhập ngang.

## C++ (services/code/cppRunner.js)
g++ (đổi bằng biến `CPP_COMPILER`, vd MinGW của Dev-C++ trên Windows). Thư mục chạy tạm chứa main.cpp + các file .txt
cùng thư mục → `freopen("input.txt","r",stdin)` / `freopen("output.txt","w",stdout)` chạy như Dev-C++.
File .txt chương trình ghi ra được hiện dưới khung kết quả (nút "Lưu vào thư mục"), và nằm trong JSON kết quả.

## Triển khai
- Cần máy chủ chạy liên tục có g++ (VPS/Render/Railway/Docker). KHÔNG chạy được trên Vercel serverless.
- Chạy code lạ là rủi ro: cppRunner chỉ có lớp bảo vệ nông (ulimit, bỏ biến môi trường, chặn vài hàm, unshare -rn nếu có).
  Nên chạy cả app trong container không có secret, hoặc đưa cppRunner vào nsjail/firejail/Docker riêng.

## C++ chạy trong trình duyệt (Vercel) — CPP_RUN_MODE=browser
Mặc định tự bật khi có biến `VERCEL` (đặt `CPP_RUN_MODE=server|browser` để ép). Trình duyệt tải Wasmer JS SDK (unpkg) + gói `clang/clang`
(vài chục MB, cache lại), dịch `main.cpp` → wasm rồi chạy; `cin` nhập qua ô nhập, `freopen` dùng các .txt cùng thư mục (nạp qua `/code/cpp/siblings`).
- `public/js/cppShims.js`: header giả `bits/stdc++.h`, `conio.h`, `windows.h` và `system("pause"/"cls")` (không đổi số dòng code người dùng).
- `public/js/cppWasm.js`: tải SDK, dịch, chạy. Cờ clang ở đầu file (`CLANG_ARGS`, `LINK_ARGS`) — chỉnh nếu clang báo thiếu libc++.
- Trang sửa code C++ gửi COOP `same-origin` + COEP `credentialless` (cần cho SDK). Kết quả lưu qua `POST /code/cpp/client-result`.
- Giới hạn: không `std::thread`, không exception (wasi-libc++), nút Dừng chỉ ngừng hiển thị, hết 60 giây tự dừng.

## C++ kiểu OnlineGDB: runner riêng + web ở Vercel (khuyên dùng) — `runner/`
Web chính chỉ **chuyển yêu cầu** sang dịch vụ `runner/server.js` (Docker có g++, dùng lại `cppRunner.js`) → vẫn nhập `cin` tương tác từng dòng, `freopen` với .txt.
1. Deploy runner (Render: New → Blueprint, chọn repo, dùng `render.yaml`; hoặc `docker build -f runner/Dockerfile .` ở Railway/Fly/VPS). Đặt `CPP_RUNNER_KEY` (≥ 16 ký tự).
2. Trên Vercel đặt `CPP_RUNNER_URL=https://<runner>` và `CPP_RUNNER_KEY=<cùng khoá>` rồi redeploy.
- Khi có `CPP_RUNNER_URL` thì không dùng g++ cục bộ/WASM. Runner kiểm khoá + `x-uid` (người dùng chỉ đọc/nhập/dừng phiên của mình); kết quả vẫn lưu GitHub từ web chính (runner không cần secret GitHub).
- Gói free của Render ngủ sau ~15 phút không dùng → lần chạy đầu có thể chờ ~30–60 giây. Runner chạy code lạ: chỉ có ulimit + chặn vài hàm (xem cppRunner.js), nên để container không chứa secret nào khác.
- Runner đang ngủ (Render free): mở trang C++ → web gửi vài yêu cầu `/code/cpp/warmup` thưa dần để đánh thức; bấm Chạy mà runner chưa thức → trình duyệt tự thử lại (mỗi lúc 1 yêu cầu, giãn 4–8 giây, tối đa ~3 phút, nút Dừng hủy ngay). Máy chủ thăm dò `/health` trước khi gửi lệnh chạy thật nên không sinh phiên chạy thừa.

## HTML + CSS (`/code/html`) — viết, xem trang, tải ảnh/âm thanh/video (mã hoá, cắt m3u8)
Lưu ở `<user_id>/codes/html/...` trên GitHub. Tạo được `.html .htm .css .js .json .svg .txt`; html nhúng css/js/ảnh/âm thanh/video **cùng thư mục** bằng đường dẫn tương đối.
- **Soạn code ⇄ View** (`controllers/html.controller.js`, `views/code/html-editor.pug`, `public/js/htmlEditor.js`): tab *Code* vừa khít màn hình (thanh trên + code + thanh link GitHub ở dưới); tab *View* hiện trang trong iframe tự cao theo nội dung → cuộn hết trang mới tới thanh link GitHub/GitLab. Bấm View tự lưu (nếu có sửa). Lỗi tải tài nguyên (vd ảnh không giải mã được) hiện ở khung đỏ phía trên.
- **Xem trang** = `GET /preview/<token>/<đường-dẫn>` (`services/code/previewServer.js`): iframe `sandbox` (không cookie, origin "null"), quyền đọc nằm trong token HMAC (`previewToken.js`, 12 giờ) → gắn TRƯỚC session trong `server.js`. Tự chèn `previewShim.js` (đo chiều cao, bắt lỗi, gắn hls.js khi cần, **nút ⬇ Tải** khi rê chuột vào ảnh/âm thanh/video, link ngoài mở tab mới).
- **Ảnh**: tải lên có mã hoá (mặc định) hoặc không (≤ 3.5MB). Khi xem: file bắt đầu bằng `MNHAENC1` mới giải mã (ở Node), còn lại trả nguyên; mã hoá mà giải mã lỗi → HTTP 422 + "Không giải mã được …" (hiện ở khung lỗi).
- **Âm thanh/video ≤ 23MB**: mã hoá trực tiếp, giữ đuôi; Node giải mã khi phát, hỗ trợ Range (tua).
- **Âm thanh/video > 23MB** (`public/js/tsMux.js` + `mediaUpload.js` + `mediaService.js`): trình duyệt **đọc từng lát** file gốc, cắt đoạn **MPEG-TS** (video H.264) hoặc **fMP4** (video codec thế hệ mới) ≤ 3.5MB (video cắt ở keyframe), gửi từng đoạn lên để mã hoá, cứ 8 đoạn ghi 1 lô + `index.m3u8` + đánh dấu tiến độ vào `mnha-media.json` (cùng thư mục). Đứt thì chọn lại đúng file để làm tiếp.
  - Âm thanh (`.mp3 .aac .m4a`): từng đoạn `.ts` mã hoá 2 chiều trực tiếp (`MNHAENC1`); Node giải mã từng đoạn khi phát.
  - Video (`.mp4 .m4v .mov`, mp4 thường — không phải mp4 phân mảnh sẵn): đoạn mã hoá **AES-128 chuẩn HLS (DRM)**; khoá lưu trong json đã bọc mã hoá 2 chiều, Node trả `key.bin` đã mở khoá.
    - **H.264 + AAC/MP3** → đoạn `.ts` (MPEG-TS), như trước.
    - **Codec thế hệ mới: H.265/HEVC (`hvc1`/`hev1`), AV1 (`av01`), VP9 (`vp09`)** (+ AAC/MP3/Opus/FLAC; H.264 + Opus cũng đi đường này) → đoạn **fMP4** `.m4s` (moof+mdat) + `init.mp4`. **Không chuyển mã**: chép nguyên mẫu nén, chỉ bọc lại, nên file lớn vẫn cắt được ngay trong trình duyệt. Lý do dùng fMP4: HLS chỉ cho AV1 trong fMP4, MPEG-TS không có AV1. `init.mp4` (chỉ cấu hình codec, không có hình) lưu base64 trong `mnha-media.json` (`init`, `codecs`) và Node trả ở `…/_media/<id>/init.mp4`; playlist có `#EXT-X-MAP` đặt **trước** `#EXT-X-KEY` nên init không bị mã hoá còn các đoạn `.m4s` vẫn AES-128. Tải về (`?dl=1`) = init + các đoạn = **mp4 phân mảnh** phát được.
    - **GOP quá nặng** (keyframe thưa / bitrate cao, nặng hơn 1 đoạn 3.5MB): tự chia tiếp ở ranh giới khung hình, không bắt nén lại. Phát liên tục bình thường; chỉ khi tua vào giữa một GOP bị chia thì hình có thể khựng/vỡ tới keyframe kế. Chỉ báo lỗi khi **một khung hình đơn lẻ** đã vượt giới hạn.
    - Phát được hay không còn tuỳ **trình duyệt/thiết bị** (AV1/HEVC cần decoder; Chrome/Edge/Firefox mới phát AV1, Safari cần chip có AV1, HEVC cần phần cứng hỗ trợ). Không hỗ trợ: ProRes, AC-3/E-AC-3 và codec khác — báo lỗi ngay lúc chọn file, trước khi tải lên.
  - Tên gốc (vd `phim.mp4`) được **khai báo là m3u8** trong json. Khi html gọi tên gốc: (1) có file trực tiếp → đọc thẳng; (2) không có → tra json, trả playlist m3u8 → hls.js (Safari phát thẳng).
  - Tải về (`?dl=1`): giữ **đuôi lúc tải lên**; media nhỏ → file gốc đã giải mã; media đã cắt → giải mã các đoạn rồi ghép thành luồng **mpegts** mang đuôi gốc (VLC/ffmpeg mở được).
  - Giới hạn: H.265/VP9/AV1, mp4 phân mảnh, mkv/webm > 23MB chưa cắt được (báo lỗi nói rõ cách xử lý); một GOP quá lớn (bitrate rất cao) cũng báo lỗi trước khi tải lên.
- **Trình phát** (`/code/html/player?dir=&file=`, `views/code/html-player.pug`, `public/js/mediaPlayer.js`): danh sách + trình phát ảnh/âm thanh/video của thư mục, nút Tải về, tự phát tiếp.
- **Xem code trên mạng** (`/code/html/online`): *Xem code* — dán link file GitHub/GitLab (repo công khai) → tab Code (chỉ đọc) và tab View (kèm css/js/ảnh/media cùng repo); *Xem thư mục* — dán link thư mục/repo → liệt kê file & thư mục con (API công khai của GitHub/GitLab, **không gửi token**; có thể bị giới hạn số lần/giờ), mở trang, xem code, hoặc trình phát. Ảnh mã hoá bởi trang này giải mã được nhờ cùng `MEDIA_ENC_KEY`; nếu không → báo lỗi.
- **Biến môi trường**: `MEDIA_ENC_KEY` (khoá chủ mã hoá media; mặc định suy từ `SESSION_ENC_KEY` — ĐỔI KHOÁ = ảnh/video đã mã hoá không giải mã được nữa), `MEDIA_MAX_BYTES` (mặc định 2GB/file), `HLSJS_URL` (nguồn hls.js, mặc định jsDelivr).
- **Lưu ý**: GitHub khuyến nghị repo < 1GB (hard limit mỗi file 100MB; mỗi đoạn chỉ ~3.5MB nên không chạm) — video rất nặng làm repo phình nhanh. Muốn kiểm tra: `npm test` (có test cắt TS bằng ffmpeg thật, mã hoá/giải mã, tải lên làm tiếp, xem từ GitHub giả).

## Trình soạn code — tính năng DÙNG CHUNG cho MỌI ngôn ngữ (`public/js/editorKit.js`)
Áp dụng cho emu8086, C++, HTML/CSS/JS và mọi dạng code thêm sau này (trang nào có `<textarea>` soạn code đều gọi `EditorKit.attach(textarea, { lang, file, readOnly })`;
dạng mới chỉ cần thêm 1 nhánh trong `cfgFor()`: dấu chú thích, độ thụt, có tự đóng ngoặc hay không).
- **Ctrl + /** (hoặc nút *Chú thích (Ctrl+/)* trên thanh trên): chú thích / bỏ chú thích các dòng đang chọn — `//` (C++, JS), `;` (emu8086), `<!-- -->` (HTML, SVG), `/* */` (CSS). Có dòng chưa chú thích → chú thích hết; tất cả đã chú thích → bỏ. `.txt` không có chú thích.
- **Tự đóng ngoặc**: gõ `(` `[` `{` `"` `'` (và `` ` `` ở .js) → tự thêm ký tự đóng; gõ ký tự đóng thì nhảy qua; Backspace giữa cặp xoá cả cặp; bôi đen rồi gõ `(` → bọc lại; không đóng khi đứng trước chữ khác hoặc dấu nháy sau chữ (don't). Gõ `}` ở dòng chỉ có khoảng trắng → tự lùi 1 cấp.
- **Enter**: giữ độ thụt của dòng trên (đã Tab rồi xuống dòng thì tự căn như cũ). Enter giữa `{|}` (cũng `( )`, `[ ]`, và `<div>|</div>` ở HTML) → `}` nằm ở dòng dưới, con trỏ ở dòng giữa đã thụt vào 1 cấp. Dòng kết thúc bằng `{` mà chưa có `}` → dòng sau thụt thêm 1 cấp.
- **Tab / Shift+Tab**: thụt / lùi 1 cấp (4 dấu cách; HTML/CSS/JS 2 dấu cách); chọn nhiều dòng thì áp cho tất cả các dòng.
- Không can thiệp khi đang gõ tiếng Việt bằng bộ gõ (IME), khi trang chỉ-xem (code trên mạng), hay phím có Ctrl/Alt (trừ Ctrl+/). File dữ liệu `.txt` của C++ không tự đóng ngoặc.
- Logic là hàm thuần có test: `node test/run.js editor`.

## File .txt trắng
GitHub lưu được file rỗng nhưng Contents API trả `content` rỗng → trước đây `readBinaryFile` coi là "quá lớn" → **lỗi 500** khi mở/chạy (vd `/code/cpp/edit?...&file=input2.txt`). Đã sửa 2 lớp:
1. `readBinaryFile` / `readBinaryFileLarge`: `size === 0` → trả Buffer rỗng.
2. `.txt` trắng được ghi tạm `EMPTY_TXT_PLACEHOLDER` = xuống dòng + `hap-du-lieu-input-vao-day` (config/codeConfig.js) khi tạo/lưu; mở file `.txt` đang trắng (kể cả file rỗng cũ) cũng hiện dòng này. Khi **chạy**, file chỉ chứa đúng dòng gợi ý được nạp như file RỖNG (`siblingTextFiles`). File chương trình ghi ra (output.txt…) giữ nguyên, không thêm dòng gợi ý.

## Thư mục: Đổi tên, link chia sẻ (mọi dạng code, kể cả html)
- Nút **Đổi tên** (thư mục đang xem, và từng thư mục con trong danh sách) → `POST /code/:lang/rename-folder {dir, name}`; chỉ đổi đoạn cuối của đường dẫn, tên theo luật thư mục (chữ, số, `-`, `_`); báo lỗi nếu trùng tên. Làm bằng **1 commit** (chuyển sha blob sang đường dẫn mới + xoá đường dẫn cũ, `codeStore.renameFolder`) nên ảnh/media mã hoá (`_media`, `mnha-media.json`) đi theo nguyên vẹn. Lịch sử kết quả cũ vẫn ghi tên thư mục cũ.
- Thanh **Link GitHub của thư mục này** (kiểu `…/tree/<nhánh>/<user_id>/codes/<lang>/<thư mục>`) + nút Sao chép, giống thanh chia sẻ file code. Repo riêng tư thì chỉ chủ repo mở được link.
- JS dùng chung: `public/js/folderTools.js`.

## Đọc thư mục trên mạng (emu8086, C++) — `/code/:lang/online/folder?url=`
Trang *Xem code trên mạng* có 2 ô: **Xem tệp code** (dán link file, như cũ) và **Đọc thư mục** (dán link thư mục/repo GitHub·GitLab công khai). Danh sách chỉ hiện file **liên quan tới dạng code** (`LANGS[lang].exts`: C++ = `.cpp .txt .h .hpp …`, emu8086 = `.asm`; file khác chỉ được đếm "đã ẩn N file"), thư mục con vẫn hiện để đi sâu. Bấm tên file → mở như *Xem tệp code* (chỉ xem, chạy được). Trang xem code trên mạng có nút **Đọc thư mục** dẫn tới thư mục chứa file đó. Dùng API công khai, không gửi token (có thể bị giới hạn số lần/giờ). HTML vẫn dùng *Xem thư mục* riêng (`/code/html/online/folder`).
- **Đổi tên file** (nút "Đổi tên" cạnh từng file code/.txt): `POST /code/:lang/rename-file {dir, file, name}`; không gõ đuôi thì giữ đuôi cũ; trùng tên thì báo lỗi; 1 commit giữ nguyên nội dung (`codeStore.renameFile`). Ảnh/âm thanh/video của HTML chưa có nút đổi tên.
