# Ứng dụng "Lập trình" (emu8086 + C++)

Menu chính ở `/`, các trang code ở `/code/...` · chỉ cần đăng nhập, không có bước duyệt.

## Lưu trữ GitHub (repo cấu hình bằng GITHUB_*, riêng hoặc dùng chung với dự án khác đều được)
- Code:    `{user_id}/codes/{emu8086|cpp}/[thư-mục/...]/file`   (thư mục chỉ tạo được ở đây; thư mục rỗng giữ bằng `.keep`)
- Word:    `{user_id}/file-word/[thư-mục/...]/ten.docx` (HTML đã **mã hoá**; tài liệu lớn: chỉ mục trang `MNHAPAGE1` + `.../<tên-tài-liệu>/trang-<hash>.mnha` mã hoá từng trang) + `mnha-word.json` (chỉ metadata)
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

### Trình duyệt TỰ giải mã (đỡ Fast Origin Transfer của Vercel) — `MEDIA_DIRECT`, `MEDIA_RAW_BASE`
Trước đây mọi byte media đi GitHub → hàm Vercel (giải mã bằng Node) → trình duyệt, kể cả tải về. Giờ: file mã hoá nằm công khai trong repo (repo PHẢI public), trình duyệt tải **thẳng từ `raw.githubusercontent.com`** và giải mã bằng WebCrypto; máy chủ chỉ trả **khoá nhỏ của từng file** sau khi kiểm quyền.
- **Ba lớp khoá** (`services/code/keyService.js` là cửa duy nhất): *khoá chủ* (`MEDIA_ENC_KEY`) không bao giờ ra khỏi máy chủ · *khoá file* riêng từng file (ảnh/âm thanh/video ≤ 23MB: HKDF(khoá chủ, salt trong header `MNHAENC1`) — file cũ dùng được ngay, không phải chuyển; m3u8: khoá AES-128 riêng của lần tải lên, bọc 2 chiều trong `mnha-media.json`) · dữ liệu mã hoá công khai. Lộ 1 khoá file ⇒ không suy ra khoá chủ, không mở được file khác.
- **Xem**: `GET /preview/<token>/…/__key/<tên>` → `{mode:'direct', key, raw}` (file ≤ 23MB; trình duyệt tải `raw`, giải mã AES-256-GCM từng khối → blob) · `{mode:'plain', raw}` (ảnh thường) · `{mode:'hls'}` (m3u8). Playlist m3u8 có đoạn trỏ thẳng GitHub raw, `key.bin` do máy chủ trả → hls.js tự giải mã AES-128; `backBufferLength` 20s nên xem đến đâu xả bộ đệm cũ đến đó. Trang HTML: `src` tương đối tới ảnh/âm thanh/video được đổi thành `data-mnha-src`, `previewShim` giải mã rồi mới gắn `src` (cả `el.src = …` do JS của trang gán).
- **Tải về** (`MnhaMedia.download`): tải/giải mã từng đoạn (tối đa 3 đoạn cùng lúc), ghi xuống bộ nhớ tạm của trình duyệt (OPFS, đuôi `.mnhapart`) và bỏ khỏi RAM ngay; đủ thì đổi tên về **đuôi gốc** rồi lưu (m3u8 = MPEG-TS ghép / mp4 phân mảnh như trước). Không có OPFS thì gom trong RAM tới 400MB, quá thì quay về tải qua máy chủ. Nút Tải trong iframe sandbox (origin `null`, không ghi đĩa được) gửi `postMessage` cho trang cha (`htmlEditor.js`, chỉ khi người dùng vừa bấm) để trang cha tải.
- **Kiểm quyền** (`authorize`): token `own` → chỉ file của chính người đó · token `web` → chỉ trong repo của app và đúng thư mục của chủ link (`token.uid`), file chủ đã **tắt công khai** thì người khác bị 403 (cả ở `__key`, `key.bin` lẫn đường giải mã dự phòng ở Node — tắt công khai giờ là riêng tư thật, kể cả khi nhúng vào HTML) · repo lạ/uid khác/ngoài `{uid}/codes/html` → 403. Xin khoá giới hạn 600 lần/10 phút/token, phản hồi `no-store`, trong trình duyệt khoá import `extractable:false` và chỉ nằm trong RAM.
- **Phiếu xem**: khi xem file công khai của người khác, máy chủ ghi vào `{uid_người_xem}/keys/index.json` (+ file đánh dấu `.mnha-keys`) chủ link + thư mục + thời điểm. Chỉ ghi định danh, KHÔNG ghi khoá; ghi lỗi thì bỏ qua.
- **Đường dự phòng** (CSS `url()`, `fetch()` của trang, `MEDIA_DIRECT=off`, repo private, âm thanh m3u8 tải lên trước đây dùng `MNHAENC1` từng đoạn): vẫn giải mã ở Node, nhưng luôn qua `keyService.allowDecrypt`. Trình duyệt gặp lỗi raw (vd 404 vì repo private) cũng tự quay về đường này.
- **Safari / iPhone**: trình phát kiểm codec TRƯỚC (`__key` trả `codecs`; `MediaSource`/`ManagedMediaSource`/`canPlayType`) — thiết bị không giải mã được (vd **AV1** trên iPhone trước 15 Pro / Mac trước M3) thì báo rõ lý do + gợi ý tải về / nén lại H.264·H.265, không quay mãi. Codec được hỗ trợ: hls.js trước (đoạn tải thẳng GitHub bằng XHR), lỗi nặng/không có MSE → phát native bằng playlist master `?master=1` (có `CODECS`, cần cho fMP4 H.265/AV1), chờ tối đa 9s. Không có đường nào tự động đi qua máy chủ (`?proxy=1` vẫn còn ở máy chủ nhưng trình phát không dùng).
- **Giới hạn thật**: người đã đăng nhập và được quyền xem một file vẫn lấy được khoá/bản giải mã của chính file đó bằng DevTools (trình duyệt phải phát được). Thiệt hại chỉ nằm trong file họ được xem. Repo public ⇒ mọi file khác trong repo (code, kết quả chạy, `cookies/index.json` đã mã hoá) cũng công khai; GitHub khuyến nghị repo < 1GB và `raw` có giới hạn tần suất.
- Test: `node -r ./test/_stubs.js test/html-keys.js` (khoá, kiểm quyền, phiếu xem, playlist, giải mã WebCrypto, ghi đè HTML).

### Cloudflare R2 cho video / âm thanh — thay GitHub media đang khoá

Ảnh vẫn đi GitHub (`mediaRepo.facade()`); **video/âm thanh mới** đi Cloudflare R2. Khi R2 lỗi, đoạn/file + `m3u8` được ghi sang **repo GitHub dự phòng** (tài khoản khác, token riêng). Media cũ không có `storage` vẫn đọc GitHub như trước.

- **Cấu hình** (`services/connect/cloudflare.js`): `v-s/cloudflare.json` (đổi bằng `CLOUDFLARE_INDEX_PATH`), lưu qua `/connect` (admin mặc định). Access Key, Secret và token dự phòng mã hoá AES-256-GCM bằng `services/connect/crypto.js` với AAD `cloudflare|accessKeyId`, `cloudflare|secretAccessKey`, `cloudflare|fallbackToken`; khoá lấy từ `CONNECT_ENC_KEY` (fallback `SESSION_ENC_KEY`). `runtime()` trả `{ storage, fallback, direct, error }`; storage ghi vào manifest **không chứa khoá**.
- **Chọn kho** (`mediaService.targetFor`): ảnh → `github`; video/âm thanh → `cloudflare` nếu đủ cấu hình, ngược lại `github-fallback`, cuối cùng mới về đường GitHub cũ. `CLOUDFLARE_REQUIRED=on` → 503 thay vì ghi GitHub khi chưa cấu hình.
- **Direct (≤ 23MB)**: mã hoá `MNHAENC1` (salt trong entry `enc.salt`), ghi 1 object R2 tại đúng đường dẫn gốc; lỗi ghi → file trong repo dự phòng. Đọc/giải mã theo `storage`; `keyService` trả URL trực tiếp qua `cloudflare.urlFor` (public/presign) hoặc để trình duyệt đi qua `/preview`.
- **HLS (> 23MB)**: đoạn `.ts`/`.m4s` mã hoá AES-128-CBC, `index.m3u8` + tiến độ + khoá bọc trong `mnha-media.json` ở repo chính. Entry có `storage`; khi lẫn kho, `segStorage[i]` ghi kho của từng đoạn. R2 lỗi từng đoạn → đoạn đó sang dự phòng (client nhận `notice`); không đoạn nào lên R2 → chuyển `storage` sang `github-fallback`; R2 lỗi ghi `m3u8` → ghi `m3u8` dự phòng. Đoạn/m3u8 dự phòng được commit theo từng lô nên đứt mạng vẫn làm tiếp được.
- **Đọc/phát** (`previewServer`): `ownSource` đọc object R2/repo dự phòng theo `storage`/`segStorage`; playlist do máy chủ dựng lại mỗi lần xem, mỗi đoạn trỏ `cloudflare.urlFor` (public, presign 6 giờ, hoặc `null` → `/preview`). `MEDIA_DIRECT=off` buộc mọi thứ qua máy chủ. `key.bin` luôn qua máy chủ sau kiểm quyền.
- **Xoá/ghi đè**: `purgeEntry` xoá object/prefix trên R2 (`deletePrefix`) hoặc repo dự phòng (`fallbackRemovePrefix`) trước khi ghi bản mới/xoá media.
- **Biến môi trường**: `CLOUDFLARE_INDEX_PATH` (mặc định `v-s/cloudflare.json`), `CLOUDFLARE_REQUIRED` (`off`; `on` = bắt buộc R2/dự phòng cho video/âm thanh), `GITHUB_FALLBACK_TOKEN` (tuỳ chọn, dự phòng khi token chưa lưu trong json), `MEDIA_DIRECT`, `MEDIA_RAW_BASE`.
- **Bảo mật**: object trên R2/repo dự phòng là bản mã hoá; manifest/summary không chứa khoá thật. Đổi `MEDIA_ENC_KEY`/`CONNECT_ENC_KEY` = mất khả năng đọc media/khoá đã lưu.
- Hướng dẫn người dùng + xử lý lỗi: `guide/connect-cloudflare.md`. Test: `node -r ./test/_stubs.js test/cloudflare.js` (ảnh→GitHub, direct/HLS→R2, R2 lỗi→dự phòng, đọc media cũ, purge, không lộ khoá).

## Trình soạn code — tính năng DÙNG CHUNG cho MỌI ngôn ngữ (`public/js/editorKit.js`)
Áp dụng cho emu8086, C++, HTML/CSS/JS và mọi dạng code thêm sau này (trang nào có `<textarea>` soạn code đều gọi `EditorKit.attach(textarea, { lang, file, readOnly })`;
dạng mới chỉ cần thêm 1 nhánh trong `cfgFor()`: dấu chú thích, độ thụt, có tự đóng ngoặc hay không).
- **Ctrl + /** (hoặc nút *Chú thích (Ctrl+/)* trên thanh trên): chú thích / bỏ chú thích các dòng đang chọn — `//` (C++, JS), `;` (emu8086), `<!-- -->` (HTML, SVG), `/* */` (CSS). Có dòng chưa chú thích → chú thích hết; tất cả đã chú thích → bỏ. `.txt` không có chú thích.
- **Tự đóng ngoặc**: gõ `(` `[` `{` `"` `'` (và `` ` `` ở .js) → tự thêm ký tự đóng; gõ ký tự đóng thì nhảy qua; Backspace giữa cặp xoá cả cặp; bôi đen rồi gõ `(` → bọc lại; không đóng khi đứng trước chữ khác hoặc dấu nháy sau chữ (don't). Gõ `}` ở dòng chỉ có khoảng trắng → tự lùi 1 cấp.
- **Enter**: giữ độ thụt của dòng trên (đã Tab rồi xuống dòng thì tự căn như cũ). Enter giữa `{|}` (cũng `( )`, `[ ]`, và `<div>|</div>` ở HTML) → `}` nằm ở dòng dưới, con trỏ ở dòng giữa đã thụt vào 1 cấp. Dòng kết thúc bằng `{` mà chưa có `}` → dòng sau thụt thêm 1 cấp.
- **Tab / Shift+Tab**: thụt / lùi 1 cấp (4 dấu cách; HTML/CSS/JS 2 dấu cách); chọn nhiều dòng thì áp cho tất cả các dòng.
- Không can thiệp khi đang gõ tiếng Việt bằng bộ gõ (IME), khi trang chỉ-xem (code trên mạng), hay phím có Ctrl/Alt (trừ Ctrl+/). File dữ liệu `.txt` của C++ không tự đóng ngoặc.
- Logic là hàm thuần có test: `node test/run.js editor`.

## Gấp / mở khối code (`public/js/foldKit.js`) — C++ và HTML
- Rê chuột vào lề số dòng → hiện mũi tên ▾ cạnh các dòng mở khối (`{ }`, thẻ HTML, `<script>`/`<style>`, chú thích nhiều dòng); bấm để thu gọn, dòng đã thu gọn hiện ▸ và dạng `int main() { … }`. Bấm vào phần … cũng mở lại được.
- Phím: Ctrl+Shift+[ thu gọn khối tại con trỏ, Ctrl+Shift+] mở khối tại con trỏ. Nút "Thu gọn tất cả" / "Mở rộng tất cả" trên thanh trên.
- Số dòng luôn là số dòng thật. Lưu / chạy / so sánh "chưa lưu" đều dùng `fold.getText()` (code đầy đủ), KHÔNG đọc thẳng `ed.value`. Gõ/xoá đụng vào dòng thu gọn thì khối tự mở trước, không mất code ẩn.
- Chỉ bật cho C++ (trừ `.txt`) và html/css/js/json/svg; emu8086 và file `.txt` không có. `FoldKit.attach` phải gắn TRƯỚC `EditorKit.attach`.
- Test: `node test/run.js fold` (test/fold-kit.js, test/fold-kit-dom.js).

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

### Bật / tắt công khai ảnh · âm thanh · video (HTML)
- Ở **trình phát của tôi** (`/code/html/player?dir=...&file=...`) mỗi file có nút **Đang công khai / Đang riêng tư** (`POST /code/html/media/visibility {dir, name, public}`).
- Tắt công khai: tên file được ghi vào `private: [...]` trong `mnha-media.json` (cùng thư mục); ảnh chưa mã hoá **bị mã hoá ngay** (repo công khai nên bản rõ vẫn tải thẳng được; âm thanh/video vốn luôn mã hoá). Ghi đè ảnh cùng tên lúc đang riêng tư cũng luôn mã hoá. Bật lại công khai: giữ bản đã mã hoá (máy chủ tự giải mã khi phát).
- Trang **Xem thư mục trên mạng** + trình phát trên mạng không liệt kê file riêng tư (các file còn lại hiện bình thường). Tắt công khai CHỈ ẩn khỏi danh sách/trình phát: nhúng vào html (`<img src>`, `<video src>`...) vẫn chạy bình thường, cả khi xem trang qua link trên mạng.
- Thư mục chỉ có media đã cắt m3u8 (danh sách file rỗng vì `mnha-media.json`/`_media` bị ẩn) vẫn đọc manifest để hiện video và nút trình phát.
- **Giới hạn file**: dạng HTML gần như không giới hạn (trần **50MB**, vì GitHub 100MB/file và Vercel 60s). Vercel chặn request/response > 4.5MB nên file lớn được **lưu theo phần** (`PUT /code/html/save/part` ≤ 3.5MB mỗi phần + `POST /code/html/save/finish`, biên nhận HMAC) và **tải riêng** (`GET /code/html/raw`, `/code/html/online/raw`, ghi từng khúc) thay vì nhúng vào trang; preview file lớn cũng ghi từng khúc. Code HTML KHÔNG mã hoá — chỉ ảnh/âm thanh/video. Các dạng code khác (C++, emu8086) vẫn 200KB.

## Word (DOCX) (`/code/word`) — soạn như Word, tự chuyển DOCX ⇄ HTML, mã hoá từng trang
Lưu ở `{user_id}/file-word/[thư-mục/...]/ten.docx`. File `.docx` trong repo **không phải** DOCX thật: nó là **HTML đã mã hoá** `MNHAENC1` (AES-256-GCM, khoá chủ `MEDIA_ENC_KEY`/`SESSION_ENC_KEY`), nên repo công khai cũng không đọc được nội dung. Tài liệu **lớn hơn `WORD_PAGE_STORE_BYTES`** (mặc định 80MB HTML) được lưu **mã hoá từng trang**: `ten.docx` chỉ còn là **chỉ mục trang** đã mã hoá (`MNHAPAGE1` + JSON `{v,total,pages:[{n,s}]}`), còn từng khúc HTML là một file mã hoá riêng `{user_id}/file-word/[thư-mục/...]/<tên-tài-liệu>/trang-<sha256>.mnha` (mặc định 4MB/trang, đổi bằng `WORD_PAGE_CHUNK_BYTES`). Tên trang là hash nội dung nên lưu lại không đổi sẽ **dùng lại blob cũ**; trang không còn dùng bị xoá. `mnha-word.json` cùng thư mục chỉ chứa `title`, `page` (khổ giấy, lề, **màu nền, số cột, hình chìm**), `size`, `pageCount`, `updatedAt`, `public`, `images` — **không chứa nội dung**.
- **Tải lên**: chỉ nhận `.docx` (Word 2007+). File `.doc` bị từ chối kèm hướng dẫn mở Word → “Save As” → `.docx`. File được gửi **từng phần ≤ 3.2MB** (`PUT /code/word/upload/part`), mỗi phần được mã hoá ngay trên máy chủ trước khi tạo blob GitHub; `POST /code/word/upload/finish` ghép + giải mã trong RAM → tự chuyển DOCX → HTML sạch → lưu lại (một file hoặc nhiều trang). Vượt được giới hạn 4.5MB/request của Vercel; trần **200MB/file, 96 phần**; ZIP giải nén tối đa 512MB.
- **Soạn**: `GET /code/word/edit?dir=&file=` (`views/code/word-editor.pug`, `public/js/wordEditor.js`, `public/css/word.css` + `word-doc.css`): ribbon đầy đủ 8 thẻ như Word — **Tệp, Trang đầu, Chèn, Bố trí, Tham khảo, Xem lại, Xem, Trợ giúp** — gồm bảng tạm, phông chữ, đoạn văn, kiểu, tìm/thay thế, bảng–ảnh–hình–liên kết–đầu/chân trang, thiết lập trang A4/Letter (dọc/ngang, lề), mục lục–chú thích–trích dẫn, nhận xét–theo dõi thay đổi–bảo vệ, chế độ đọc/bố cục web/đường lưới/thước/khung dẫn hướng/chế độ tối, thu phóng, trợ giúp. Màu nền trang, số cột và hình chìm được lưu cùng tài liệu. Nút **Tải về máy** (thanh trên và nhóm *Tệp*) tự lưu nếu có thay đổi rồi tải `.docx` thật về máy.
- **Ảnh**: khi lưu, mọi ảnh `data:` URI trong HTML được tách thành file `anh-NNN-<mô-tả>.<ext>` (mô tả lấy từ `alt`), lưu **mã hoá** trong thư mục cùng tên tài liệu; HTML chỉ còn tên file. Ảnh cùng nội dung được dùng lại (hash trong `mnha-word.json`), ảnh không còn dùng bị xoá, tối đa 200 ảnh/lần lưu (vượt thì giữ inline). Đổi tên tài liệu di chuyển cả thư mục ảnh **và trang**; xoá tài liệu xoá ảnh/trang do hệ thống tạo. Chủ tài liệu xem qua `GET /code/word/media?dir=&file=&n=`, bản công khai qua `GET /w/media?...`; tải `.docx` nhúng lại ảnh thành `data:` URI. Thư mục ảnh/trang không hiện như thư mục thường trong danh sách.
- **Lưu**: `PUT /code/word/save/part` (mỗi phần 700.000 ký tự, mã hoá trước khi lên GitHub) + `POST /code/word/save/finish`; biên nhận HMAC gắn `uid|uploadId|đường-dẫn|scope|sha|size` nên không ghép được blob của người khác. Trần HTML **256MB**; tài liệu lớn tự chuyển sang lưu từng trang.
- **Tải về**: `GET /code/word/download?dir=&file=` giải mã HTML (hoặc ghép các trang) → tạo **DOCX thật** (`services/word/htmlToDocx.js`: ZIP + OOXML + styles/numbering/ảnh/khổ giấy). Nếu một file `.docx` vượt `WORD_DOCX_PART_BYTES` (mặc định 48MB) thì **không giảm chất lượng/không nén ảnh**: tài liệu được cắt theo trang/khối thành `ten-1.docx`, `ten-2.docx`… và đóng gói trong `ten.zip`. Tài liệu nhỏ vẫn tải `.docx` trực tiếp. Khi một khối lớn (bảng/khung bọc cả tài liệu) bị cắt giữa chừng, `balanceParts` tự đóng các thẻ đang mở ở cuối mỗi phần và mở lại ở đầu phần sau, nên không phần `.docx` nào bị mất dòng/bảng (chỉ áp dụng khi xuất `.docx`; dữ liệu lưu vẫn ghép đúng nguyên văn). Upload cũng dùng `services/word/docxToHtml.js` (đọc ZIP/XML, ảnh, bảng, danh sách, heading, màu/phông/lề).
- **Công khai / riêng tư**: nút trên trình soạn hoặc danh sách → `POST /code/word/visibility`; bật thì người khác xem được bằng `GET /w?u=<uid>&p=<thư-mục/ten.docx>` (khung đọc + `GET /w/raw` + `GET /w/media` + `GET /w/download`), tắt thì các đường này trả 404. `/w/download` cũng trả ZIP nhiều phần nếu tài liệu quá lớn. `/w` gắn **trước** cookie/session trong `server.js`; `/w/raw` chỉ trả HTML đã làm sạch với CSP chặt (`default-src 'none'; img-src 'self' data: https:`) và ảnh `/<uid>/file-word/.../anh-NNN-*` được kiểm tra công khai trong `mnha-word.json` trước khi giải mã.
- **Khác**: tạo/xoá/đổi tên tài liệu (`/code/word/file|delete|rename-file`), thư mục dùng route chung `/code/:lang/folder|rename-folder` (vẫn nằm dưới `file-word`). Xoá/đổi tên cũng dọn/đi chuyển các file hệ thống `anh-*` và `trang-*.mnha`. Tên file do trình duyệt đổi về ASCII để hợp luật `FILE_STEM_RE`; tên gốc có dấu vẫn hiện trong tiêu đề tài liệu. Test: `node test/run.js word`.
- **Biến môi trường Word** (không bắt buộc, xem `.env.example`): `WORD_PAGE_STORE_BYTES` (ngưỡng HTML để chuyển sang lưu từng trang, mặc định 80MB), `WORD_PAGE_CHUNK_BYTES` (kích thước mỗi trang, mặc định 4MB, tối thiểu 64KB), `WORD_DOCX_PART_BYTES` (kích thước tối đa mỗi `.docx` khi tải về, mặc định 48MB, tối thiểu 192KB).

## Web kết nối (nhiều Vercel + tải media dự phòng)
Web chính (`https://repository-mnha.vercel.app`) có thể dùng **nhiều Vercel project cùng codebase** làm "web dữ liệu"
để nhận ảnh / âm thanh / video. Mỗi web dữ liệu tự đăng ký vào `v-s/index.json` của repo GitHub chính; web chính chọn
web còn sống, ký phiếu để trình duyệt gửi **thẳng** file lên web đó, và tự chuyển web khi lỗi.

### 1. Dựng một web dữ liệu
- Tạo Vercel project mới từ **cùng repo/mã nguồn**, ví dụ domain `https://repository-mnha-data-1.vercel.app`.
- `.env` phải **GIỐNG HỆT** web chính ở mọi biến bí mật; chỉ đổi 4 biến:
```
DATA_NODE=on
NODE_ID=repository-mnha-data-1
NODE_URL=https://repository-mnha-data-1.vercel.app
NODE_NAME=Web dữ liệu 1
```
- Web chính để `DATA_NODE=off` (hoặc bỏ trống). Mẫu đầy đủ ở `.env.example` và ngay trên trang `/connect`.
- Các biến phải giống: `MONGODB_URI`, `SESSION_SECRET`, `SESSION_ENC_KEY`, `MEDIA_ENC_KEY`, `CONNECT_ENC_KEY`,
  `CONNECT_HMAC_KEY`, `GITHUB_TOKEN`, `GITHUB_MEDIA_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`.
  Khác khoá → không giải mã được khoá kết nối / không xác thực được phiếu tải / không đọc được media đã mã hoá.
- Deploy lại sau khi sửa env. Kiểm tra nhanh: `GET https://<web-dữ-liệu>/api/node/health` → `{"ok":true,"id":"..."}`.
- File `connect/vercel/index.js` chỉ hoạt động khi `DATA_NODE=on`; `server.js` mount `/api/node/*` và trang `/connect`
  riêng cho web dữ liệu. Web chính dùng các module trong `services/connect/`.

### 2. Đăng nhập và khoá kết nối (connection key)
- Web dữ liệu **chỉ cho admin mặc định** đăng nhập: `role === 'admin' && userKey == null`. Admin tổ chức, student,
  client đều bị chặn; đăng ký / OTP cũng bị tắt trên web dữ liệu (`controllers/auth.controller.js`).
- **Lần đầu** admin mặc định đăng nhập, `connect/vercel.onAdminLogin` gọi `ensureRegistered()`:
  - Nếu web chưa có trong `v-s/index.json`: sinh khoá ngẫu nhiên 32 byte (64 ký tự hex), **mã hoá 2 chiều**
    AES-256-GCM (AAD gắn với id web) rồi ghi `keyEnc`; bản rõ chỉ giữ trong session để hiện **đúng một lần**.
  - Nếu đã có: giữ nguyên khoá cũ, chỉ cập nhật tên/URL.
- Trang `/connect` của web dữ liệu hiện khoá đầy đủ **một lần** sau khi tạo (đọc xong xoá khỏi session); các lần sau chỉ
  hiện `keyHint` (4 ký tự cuối). Nút **Đổi khoá** (`POST /connect/rotate-key`) tạo khoá mới — web chính tự dùng khoá mới
  ở lần kiểm tra kế tiếp. Mất khoá thì đổi khoá mới, không xem lại được.
- Khoá **không bao giờ** gửi cho client/trình duyệt thường và không đi qua URL/log. Nó chỉ dùng server-server để ký
  yêu cầu `POST /api/node/status`; request chỉ mang HMAC + timestamp, không mang khoá.

### 3. Sổ đăng ký `v-s/index.json`
```json
{
  "v": 1,
  "nodes": [{
    "id": "repository-mnha-data-1",
    "url": "https://repository-mnha-data-1.vercel.app",
    "name": "Web dữ liệu 1",
    "enabled": true,
    "keyEnc": "v1.<iv>.<tag>.<ciphertext>",
    "keyHint": "a1b2",
    "createdAt": "2026-...",
    "health": { "ok": true, "ms": 123, "error": null, "statusOk": true, "version": "..." },
    "vercel": { "fastDataTransfer": 0, "fastOriginTransfer": 0, "updatedAt": "2026-..." }
  }],
  "updatedAt": "2026-..."
}
```
- `id` lấy từ host đã chuẩn hoá (`registry.idForUrl`): `https://repository-mnha-data-1.vercel.app` →
  `repository-mnha-data-1`, khớp `NODE_ID` và `usage.nodeId()`.
- Mọi thao tác ghi đều qua `registry.mutate()`: đọc kèm SHA → sửa → ghi kèm SHA, tự đọc lại và thử lại khi xung đột,
  nên nhiều web dữ liệu đăng ký cùng lúc vẫn an toàn.
- Đây là **nguồn duy nhất** cho: danh sách web, thứ tự tải lên (cũ → mới), khoá ký kiểm tra trạng thái, số liệu Vercel
  nhập tay. File nằm trong repo chính; lộ file cũng không lấy được khoá nếu không có `CONNECT_ENC_KEY`.

### 4. Trang `/connect` của web chính
Chỉ admin mặc định dùng được (`routes/connect.js` gắn `requireDefaultAdmin`).
- Thêm web bằng URL gốc (không kèm đường dẫn); **Kiểm tra** duyệt lần lượt **cũ → mới**, lưu `health` và trạng thái.
- Đổi tên / bật-tắt / xoá web; dán khoá kết nối thủ công (nếu web đã tạo khoá mà chưa tự đăng ký); nhập số liệu Vercel.
- **Fast Data Transfer** ≈ dữ liệu trình duyệt ⇄ web (bytes vào + ra). **Fast Origin Transfer** ≈ dữ liệu web ⇄ GitHub
  (đọc + ghi qua `githubService`). Vercel không có API công khai cho 2 chỉ số này, nên app **tự đo xấp xỉ** theo request
  và ghi vào `v-s/usage.json`; số chính thức của Vercel do admin nhập tay và cộng thêm. Trang ghi rõ đây là số ước lượng.
- Mỗi web có một ô `.env` mẫu **giống hệt nhau**, chỉ khác 4 dòng `DATA_NODE` / `NODE_ID` / `NODE_URL` / `NODE_NAME`.

### 5. Luồng tải media và chuyển web dự phòng
1. Người dùng bấm Tải lên → `POST /code/html/upload/init` (đã qua `requireMediaUploader`).
2. Web chính gọi `nodes.pickForUpload()`: đọc các web đang bật trong `v-s/index.json`, duyệt **tuần tự cũ → mới**,
   kiểm tra `GET /api/node/health` (timeout 4 giây, cache 60 giây). Web đầu tiên OK là **primary**, các web còn lại là
   **candidates**. Web lỗi bị tạm nghỉ 90 giây (`nodes.markFailed` qua `POST /code/html/upload/node-fail`).
3. Web chính trả `mode:'node'` kèm `node`, `candidates`, `uploadId`, `token`, `ttl` và `checks`. `token` là phiếu HMAC
   (`services/connect/uploadToken.js`), hạn 2 giờ (`UPLOAD_TOKEN_TTL_MS`), gắn chặt `uid + uploadId + tên file + thư mục`.
4. Trình duyệt (`public/js/mediaUpload.js`) gửi file **trực tiếp** tới web dữ liệu, hiện "Web: &lt;tên&gt; — tiến trình";
   không quay lại web chính nên không tốn thêm một lần Fast Origin Transfer.
5. Endpoint trên web dữ liệu: `POST /api/node/media/init`, `PUT /part`, `POST /finish`, `PUT /seg`,
   `POST /commit`, `POST /visibility`, `POST /delete`. Xác thực bằng header `X-MNHA-Upload: Bearer <token>`
   (hoặc `Authorization`, body/query `token`) — **không dùng cookie**; phiếu phải khớp đúng `dir`/`name`/`uploadId`.
6. Web đang dùng lỗi giữa chừng → trình duyệt báo web chính cho web đó nghỉ, rồi thử candidate kế tiếp với cùng
   `uploadId` (web mới ký lại phiếu nếu cần, đọc `mnha-media.json` để làm tiếp đoạn đã có). Hết candidate → lỗi rõ ràng.
7. Không có web nào hoạt động:
   - `CONNECT_FALLBACK_LOCAL=on` (mặc định) và `CONNECT_REQUIRED` khác `on`: tải lên máy chủ chính, kèm thông báo
     "… Tạm thời tải lên máy chủ chính."
   - `CONNECT_FALLBACK_LOCAL=off` hoặc `CONNECT_REQUIRED=on`: HTTP 503 `NO_NODE` với câu
     "Chưa có web kết nối nào. Hãy vào /connect thêm web dữ liệu trước khi tải ảnh / âm thanh / video lên."

### 6. Chặn tài khoản chưa duyệt tải media
- Chỉ chặn **tải ảnh / âm thanh / video** (`middleware/uploadAuth.js` → `requireMediaUploader` gắn vào các route
  `/code/html/upload/*`). Sửa code, tạo thư mục, chạy code, xem file… vẫn dùng bình thường.
- Được tải: admin mặc định, admin tổ chức, student, client có `status='approved'`. Bị chặn: `pending`, `rejected`,
  `disabled`, hoặc client chưa được duyệt.
- Thông báo đúng dạng: **"Tài khoản bị … vì vậy hãy nhắn quản trị viên để mở tính năng này."**
  (`chưa được duyệt` / `bị từ chối` / `bị vô hiệu hoá` / `chưa được cấp quyền tải lên`).
- Trang HTML ẩn khu vực tải lên với tài khoản bị chặn; API trả 403 kèm `code: 'UPLOAD_NOT_ALLOWED'`.

### 7. Tự xoay vòng repo media (~500MB)
- Bật mặc định bằng `MEDIA_REPO_POOL=on`; `services/connect/mediaRepo.js` bọc `githubService` và định tuyến:
  - `mnha-media.json`, `v-s/`, `cookies/`, `*/keys/*` → **luôn ở repo chính** (một nguồn duy nhất).
  - File/đoạn media → repo **đang dùng** trong `v-s/media-repos.json`.
- Khi repo đang dùng đạt `MEDIA_REPO_LIMIT_BYTES` (mặc định 500MB), app tạo repo mới
  `<GITHUB_MEDIA_REPO_PREFIX>-N` (mặc định `repository-mnha-media-1`, `-2`…) bằng `GITHUB_MEDIA_TOKEN`
  (cần quyền tạo repo; có thể dùng chính `GITHUB_TOKEN`), ghi vào `v-s/media-repos.json` rồi ghi tiếp.
  `MEDIA_REPO_PRIVATE=on` nếu muốn repo mới ở chế độ riêng tư.
- Khi **đọc**, app gộp cây thư mục + blob của repo chính và **tất cả** repo media, nên media cũ vẫn phát/tải bình thường.
  Xoá file thì tìm đúng repo đang chứa file đó.
- Chỉ đường dẫn hệ thống thay đổi thì **không** tạo repo mới / không xoay vòng.
- `MEDIA_REPO_POOL=off` → quay lại hành vi cũ (mọi thứ trong repo chính), hữu ích khi chạy test hoặc repo nhỏ.

### 8. Biến môi trường liên quan
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATA_NODE` | `off` | `on` = web dữ liệu (khóa đăng nhập thường, mở `/api/node/*`). |
| `NODE_ID` / `NODE_URL` / `NODE_NAME` | — | Danh tính web dữ liệu; `NODE_ID` nên trùng id trong `v-s/index.json`. |
| `CONNECT_INDEX_PATH` | `v-s/index.json` | Sổ đăng ký web. |
| `CONNECT_USAGE_PATH` | `v-s/usage.json` | Bộ đếm lưu lượng theo ngày (giữ 62 ngày). |
| `CONNECT_ENC_KEY` | — | Khoá mã hoá khoá kết nối (≥ 32 ký tự); fallback `SESSION_ENC_KEY`. |
| `CONNECT_HMAC_KEY` | — | Khoá ký phiếu tải lên; fallback `CONNECT_ENC_KEY` → `MEDIA_ENC_KEY` → `SESSION_ENC_KEY`. |
| `CONNECT_PROBE_TIMEOUT_MS` | `4000` | Thời gian chờ kiểm tra một web. |
| `UPLOAD_TOKEN_TTL_MS` | `7200000` | Hạn phiếu tải lên (2 giờ). |
| `CONNECT_FALLBACK_LOCAL` | `on` | Không có web → tải lên máy chủ chính. |
| `CONNECT_REQUIRED` | `off` | `on` = bắt buộc có web, không fallback. |
| `MAIN_URL` | `https://repository-mnha.vercel.app` | Địa chỉ web chính, hiện trong `.env` mẫu. |
| `MEDIA_REPO_POOL` | (bật khi `on`) | Bật xoay vòng repo media. |
| `MEDIA_REPO_LIMIT_BYTES` | `524288000` | Ngưỡng xoay vòng (~500MB). |
| `MEDIA_REPO_INDEX_PATH` | `v-s/media-repos.json` | Danh sách repo media + repo đang dùng. |
| `GITHUB_MEDIA_TOKEN` | — | Token tạo repo mới; mặc định dùng `GITHUB_TOKEN`. |
| `GITHUB_MEDIA_OWNER` | `GITHUB_OWNER` | Chủ repo media. |
| `GITHUB_MEDIA_REPO_PREFIX` | `<GITHUB_REPO>-media` | Tiền tố tên repo mới. |
| `MEDIA_REPO_PRIVATE` | `off` | Repo media mới là private. |

### 9. Kiểm thử
```
node test/run.js                 # toàn bộ test (tự tìm test/*.js)
node test/html-upload-client.js  # riêng phần chọn web / phiếu tải ở trình duyệt
```
Test dùng `githubService` giả qua `require.cache`, không gọi GitHub thật. Các test cũ vẫn chạy với
`MEDIA_REPO_POOL` tắt để giữ nguyên hành vi mặc định.

### 10. Dữ liệu chỉ đi qua web kết nối (web chính chỉ lo giao diện + backend)
- Web chính trên mạng (vd `https://repository-mnha.vercel.app`) **không nhận và không phát dữ liệu** ảnh / âm thanh / video: tải lên đi thẳng tới web kết nối (mục 5); **xem và tải xuống** cũng dùng địa chỉ `<web-kết-nối>/preview/<token>/…` (cùng khoá `.env`, nên token của web chính dùng được).
- Không có web kết nối nào hoạt động → lỗi `NO_NODE` rõ ràng (trang trình phát báo lỗi, tab View báo lỗi). **Không còn tự lùi về web chính**; `CONNECT_FALLBACK_LOCAL` không còn tác dụng với web chính.
- Các route ghi dữ liệu trực tiếp lên máy chủ (`/code/html/upload/local/init|part|finish|seg|commit`) chỉ mở ở **localhost** và **web dữ liệu**; ở web chính trả 403 `DATA_ON_NODE` (`services/connect/locality.js`).
- **localhost** (không phải Vercel) tự nối dữ liệu với chính localhost, không cần web kết nối.
- Mọi trang có nhãn `Web kết nối: <tên> (<id>)` trên thanh đầu (`GET /api/connect-info`, `public/js/connectBadge.js`); trình phát và nút Tải ghi rõ đang xem / tải qua web nào.
- Chưa đổi: xoá media đã cắt và bật/tắt công khai (`/code/html/media/delete|visibility`) vẫn gọi web chính (chỉ sửa danh sách mnha-media.json, không chuyển file).



## Hình khối đặt tự do (Word)
- Nút **Hình khối** (thẻ Chèn) mở thư viện: bấm để chèn, hoặc **kéo thả** vào bất kỳ chỗ nào của trang (kể cả vùng lề). Hình là `div.word-shape[data-shape]` với `position:absolute; left; top` tính từ góc trên-trái vùng nội dung.
- Chọn hình → kéo để di chuyển, 8 chấm vuông để đổi cỡ (Shift giữ tỉ lệ), chấm tròn để xoay (Shift = bước 15°), phím mũi tên để nhích (Shift = 10px), nháy đúp/Enter để gõ chữ, Delete để xoá. Thẻ ngữ cảnh **Định dạng hình**: kiểu hình, tô/viền/đổ bóng, chữ, vị trí, ngắt dòng (trước/sau văn bản/cùng dòng), xếp lớp, căn lề, xoay 90°, kích thước (cm), nhân bản, văn bản thay thế.
- Mã: `public/js/wordShapes.js` (nạp trước `wordEditor.js`, nhận `window.__wd`). Lưu: `beforeSave()` ghi `data-oy` (lệch so với đoạn neo).
- `htmlSanitize.js`: chỉ cho `position:absolute/left/top/z-index/align-items/justify-content` và `data-shape/data-oy` trên đúng `div.word-shape` (chặn `position:fixed`).
- Xuất `.docx`: `htmlToDocx.js` ghi DrawingML (`wps:wsp`) — hình tự do là `wp:anchor` (ngang tính từ lề, dọc tính từ đoạn neo), hình cùng dòng là `wp:inline`. Nhập `.docx` → HTML chưa đọc lại hình `wps`.

## Nhiều repo GitHub dữ liệu (services/githubPool.js)

- `GITHUB_REPO=repository-mnha-database` là repo chính. Khi đạt `GITHUB_REPO_LIMIT_MB` (mặc định 200MB), server tự tạo `repository-mnha-database-1`, rồi `-2`, `-3`… và ghi tiếp vào repo mới nhất.
- **File `.json` luôn ở repo chính.** Chỉ file khác (docx, pdf, ảnh, âm thanh, video, html…) mới sang repo `-1`, `-2`…; file đã có thì ghi đè đúng repo đang chứa nó. Đọc thì gộp mọi repo.
- Sổ các repo đã tạo: `github/repos/index.json` (repo chính): `id`, tên repo, ngày tạo. **Không lưu dung lượng.**
- Dung lượng lấy từ webhook `push` của GitHub (`repository.size`), giữ trong RAM; instance chưa nhận webhook thì hỏi API GitHub một lần. Hiện từng repo ở trang **Web kết nối**.
- Webhook push (`<MAIN_URL>/api/github/webhook`) được **tự gắn** cho repo chính và mọi repo `-1`, `-2`… khi web khởi động (chỉ web chính, 1 lần/tiến trình); secret **tự sinh** (HMAC từ `SESSION_ENC_KEY`/`GITHUB_TOKEN`…, mọi instance ra cùng giá trị) — không cần đặt `GITHUB_WEBHOOK_SECRET` (đặt thì dùng giá trị đó). Cần token có quyền `admin:repo_hook`. Tắt: `GITHUB_WEBHOOK_AUTO=off`.
- Tắt: `GITHUB_REPO_POOL=off`. Test: `node test/github-pool.js`.
