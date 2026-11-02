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

## Tải file text lên / tải về (`/code/cpp`, `/code/emu8086`, `/code/html`)
- Nút **Tải file text lên**: chọn nhiều file từ máy (cpp: `.cpp .txt .h .hpp ...`; emu8086: `.asm`; html: `.html .css .js .json .svg .txt`) → lưu vào thư mục đang mở ở **repo chính**. **Trùng tên thì ghi đè** file cũ (có hỏi xác nhận trước). Cả lô nằm trong 1 commit; file sai đuôi / tên không hợp lệ / nhị phân / không phải UTF-8 / quá lớn (cpp 200KB, html 3MB) được bỏ qua và báo lý do. API: `POST /code/:lang/upload-text` `{dir, files:[{name, content}]}` (tối đa 40 file/lần; trình duyệt tự chia đợt ≤15 file / 2.5MB).
- Nút **Tải tất cả file text về**: gom mọi file text của thư mục đang mở thành 1 file `.zip` (zip tạo ngay trong trình duyệt, không tốn CPU máy chủ); thư mục chỉ có 1 file thì tải thẳng file đó. Mỗi dòng file có link **Tải** riêng: `GET /code/:lang/download?dir=&file=`.
- Trang **Đọc thư mục trên mạng** (`/code/<cpp|emu8086>/online/folder?url=...`, `views/code/online-folder.pug`): nút **Tải tất cả file về** (zip dựng ở trình duyệt) + nút **Tải** từng file. Máy chủ tải hộ qua `GET /code/:lang/online/download?url=<link file>` (`onlineDownload`, chỉ github.com/gitlab.com, chỉ đuôi của dạng code đó, ≤200KB/file); script `public/js/onlineDownload.js`, phần zip dùng chung `public/js/zipKit.js`.
- Code: `services/code/codeStore.js` (`saveUploads`), `controllers/code.controller.js` (`uploadText`, `download`), `public/js/textTransfer.js`. Test: `node -r ./test/_stubs.js test/text-upload.js`.

## HTML + CSS (`/code/html`)
Viết html/css/js, **xem trang ngay** (tab Code ⇄ View), tải **ảnh / âm thanh / video** lên (mã hoá; file > 23MB tự cắt m3u8 ngay trong trình duyệt — video H.264, H.265/HEVC, AV1, VP9 — mã hoá DRM AES-128), nhúng vào html bằng tên gốc. Trang `/code/html/online` xem code + trang html từ GitHub/GitLab (kèm css/ảnh/media cùng thư mục) và **xem thư mục**. Trình phát ảnh/âm thanh/video cho cả thư mục của tôi lẫn trên mạng, mọi media đều có nút Tải. Media được **trình duyệt tự giải mã** (tải thẳng từ GitHub raw, máy chủ chỉ trả khoá nhỏ từng file sau khi kiểm quyền) để không tốn Fast Origin Transfer của Vercel — repo cần công khai, hoặc đặt `MEDIA_DIRECT=off` để quay về giải mã ở máy chủ. Chi tiết, giới hạn và bảo mật: xem `CODE.md` (mục HTML + CSS → "Trình duyệt TỰ giải mã"). Chạy toàn bộ test: `npm test` (cần ffmpeg để chạy test cắt/phát m3u8; thiếu thì bỏ qua phần đó).

## Lưu trữ file (`/code/files`) — Word, Excel, PowerPoint, PDF, ảnh
Mục **Lưu trữ file** ở menu chính để cất tài liệu (có thư mục, tải về, đổi tên, xoá).
- **Chỉ nhận**: Word (`doc docx dot dotx docm rtf odt`), Excel (`xls xlsx xlsm xlsb xlt xltx ods`), PowerPoint (`ppt pptx pps ppsx pptm pot potx odp`), PDF, văn bản (`txt` — xem và **sửa ngay trên web**), ảnh (`png jpg jpeg gif webp avif bmp ico tif tiff heic`) và vài file Office khác (`vsd vsdx pub mpp one`). Đuôi khác bị từ chối cả ở trình duyệt lẫn máy chủ. Tên file được phép có tiếng Việt / dấu cách.
- **File nặng tự chia nhỏ**: trình duyệt cắt file thành các phần 3.5MB (Vercel chặn request > 4.5MB), mỗi phần được mã hoá riêng (AES-256-GCM, cùng khoá chủ `MEDIA_ENC_KEY`/`SESSION_ENC_KEY` như media) rồi ghi thành `{user_id}/codes/files/[thư mục]/_data/<mã>/0001.bin`, `0002.bin`…
- **Lưu repo theo trình tự repo được tạo**: phần là file `.bin` (không phải file chữ) nên `services/githubPool.js` ghi vào **repo đang dùng**; repo đầy (`GITHUB_REPO_LIMIT_MB`, mặc định 200MB) thì tự tạo repo kế (`…-1`, `-2`…) và các phần sau ghi sang đó. Danh sách phần (kèm repo chứa từng phần), **khoá file đã mã hoá** và **cờ công khai/riêng tư** nằm chung trong `mnha-files.json` cùng thư mục với các phần mã hoá (repo chính). Trang danh sách hiện "N phần · M repo".
- **Làm tiếp khi đứt**: mã tải lên dẫn xuất từ (người dùng, thư mục, tên, kích thước, ngày sửa) → chọn lại đúng file thì chỉ gửi các phần còn thiếu. Cùng tên thì hỏi ghi đè; bản cũ được dọn.
- **Tải lên đi qua web kết nối** như ảnh/âm thanh/video: web chính chỉ ký phiếu, các phần đi thẳng tới web kết nối (`/api/node/files/init|part|finish`); localhost / web dữ liệu tự nhận (`/code/files/upload/...`).
- **Tải về: TRÌNH DUYỆT tự giải mã, không qua máy chủ** (như ảnh/media — `services/code/keyService.js`). Trình duyệt hỏi `POST /code/files/open` (chỉ vài KB: khoá RIÊNG của file + địa chỉ GitHub raw của từng phần, đúng repo chứa phần đó), tải các phần mã hoá **thẳng từ `raw.githubusercontent.com`** (3 phần cùng lúc, hiện % tiến độ) rồi giải mã bằng WebCrypto (`public/js/mnhaFiles.js`) và lưu file. Khoá chủ (`MEDIA_ENC_KEY`) không bao giờ rời máy chủ; mỗi file có **1 khoá riêng** (dẫn xuất từ khoá chủ + người dùng + mã tải lên) và bản lưu trong `mnha-files.json` là bản **mã hoá** (`key`, định dạng MNHAENC1) — json không chứa khoá thô, đổi/mất khoá chủ thì khoá trong json cũng không mở được; máy chủ chỉ mở khoá ra khi đã kiểm quyền (chủ, hoặc file đang công khai); mỗi phần là 1 khối AES-256-GCM có **AAD = số thứ tự phần** nên đổi chỗ / sửa / cắt phần đều bị phát hiện (không ra file sai).
  - **Yêu cầu**: repo chứa file phải **công khai** (để trình duyệt tải thẳng từ raw). Dữ liệu trên GitHub vẫn là bản mã hoá, người ngoài không đọc được nếu không có khoá.
  - **Dự phòng tự động** (repo riêng tư, `MEDIA_DIRECT=off`, trình duyệt thiếu WebCrypto, file lưu bằng bản cũ): quay về đường qua máy chủ — `POST /code/files/download-token` cấp phiếu ký 30 phút, web kết nối giải mã từng phần và gửi nối tiếp (`/api/node/files/download?t=`).
  - File tải về được giữ trong bộ nhớ trình duyệt trước khi lưu (tối đa 200MB/file).
- **Công khai / riêng tư**: mặc định mọi file **riêng tư**. Bấm nhãn trạng thái của từng file để bật/tắt công khai (hoặc nút "Công khai tất cả / Riêng tư tất cả" cho cả thư mục); cờ `public` nằm trong `mnha-files.json`, ghi đè file cùng tên thì giữ nguyên chế độ. File công khai có link `/f?u=<user>&d=<thư mục>&n=<tên>` (nút "Sao chép link"): **không cần đăng nhập**; trang xem chỉ là HTML nhỏ + `public/js/filePublic.js`, script xin khoá ở `/f/key` rồi **tải thẳng từ GitHub raw và giải mã trong trình duyệt của người xem** — ảnh, PDF hiện ngay; Word-Excel-PowerPoint có nút Tải về; không giải mã được thì có nút "Tải qua máy chủ" (`/f/raw` → web kết nối). Riêng tư hoặc không tồn tại đều trả cùng một lỗi 404. Tắt công khai là máy chủ **ngừng cấp khoá** ngay (link hết hiệu lực). Lưu ý: ai đã xin khoá lúc file còn công khai thì vẫn giữ khoá đó (khoá theo file, không đổi khi tắt) — file cần thu hồi hẳn thì xoá và tải lên lại.
- **Chia sẻ thư mục (xem trên mạng, duyệt cả cây như "xem code trên mạng" của HTML)**: nút **Chia sẻ thư mục** bật cờ `shared` trong `mnha-files.json`. Link `/f/d?u=<user>&d=<thư mục>` (nút "Mở trang thư mục" / "Sao chép link thư mục") không cần đăng nhập và cho **duyệt cả thư mục con lẫn file** (gộp file của mọi repo trong nhóm repo): thư mục con (mọi độ sâu) hiện kèm số file công khai, có breadcrumb và nút "⬆ .." đi lên — nhưng **không lên quá thư mục chia sẻ cao nhất**. Thư mục con của thư mục đã chia sẻ tự xem được; thư mục cha thì không. Chỉ file **đang công khai** mới hiện (file riêng tư và thư mục con không có file công khai thì ẩn). Chưa chia sẻ hoặc không có → 404. Bấm 1 file → trang xem `/f`. Bật chia sẻ **ở thư mục gốc** = xem cả kho. Danh sách được nhớ 15 giây ở mỗi máy chủ (mọi thay đổi ở máy chủ đó xoá ngay; máy chủ khác tối đa 15 giây) — còn trang xem và khoá của từng file thì không nhớ nên tắt công khai là có hiệu lực ngay.
- **Link GitHub đủ mọi repo (cho chủ)**: trang quản lý hiện khung "Link GitHub của thư mục này — đủ N repo" liệt kê **từng repo** đang chứa dữ liệu của thư mục (repo chính trước, rồi `-1`, `-2`… theo thứ tự repo được tạo; kèm số file và nút Sao chép), và mỗi file nặng có dòng "GitHub:" dẫn tới thư mục `_data/<mã>` chứa các phần mã hoá trong từng repo. (Khác mục HTML chỉ hiện 1 repo vì file HTML không bị chia qua nhiều repo.)
- **Văn bản `.txt` — xem và sửa được**: file `.txt` có nút "Xem / Sửa" (tối đa 2MB, UTF-8). Trình duyệt tải và giải mã nội dung vào khung soạn thảo; **Lưu** = mã hoá lại và ghi đè file cùng tên qua đúng đường tải lên (không hỏi ghi đè, giữ nguyên chế độ công khai; tài khoản không có quyền tải lên chỉ xem được). Trang xem công khai hiển thị `.txt` ở dạng chỉ-đọc.
- **Tìm kiếm**: ô tìm lọc ngay các dòng của thư mục đang mở; nút "Tìm trong mọi thư mục" (hoặc Enter) tìm theo tên file/thư mục trong toàn bộ kho của bạn, không phân biệt hoa-thường và dấu tiếng Việt (`GET /code/files/search?q=`).
- Giới hạn: tối đa 200MB/file (đổi bằng `FILES_MAX_BYTES`). **Ai được tải lên**: chỉ **admin** và **student đã được duyệt** (`canUploadFiles` trong `middleware/uploadAuth.js`). Tài khoản **client** / chưa duyệt (pending) / bị từ chối / vô hiệu hoá không tải lên được — trang chỉ hiện thông báo nhắn quản trị viên, và cả 4 bước tải lên đều bị chặn ở máy chủ; vẫn xem danh sách và tải file đã có. Quy tắc này chỉ áp cho Lưu trữ file (ảnh/âm thanh/video của dạng code HTML vẫn theo `canUploadMedia`).
- Code: `services/code/fileStore.js`, `controllers/files.controller.js`, `views/code/storage.pug`, `public/js/fileStorage.js`, cấu hình `FILES` trong `config/codeConfig.js`. Test: `node -r ./test/_stubs.js test/files-store.js`, `test/files-controller.js`, `test/files-client.js`.

## Cloudflare R2 cho video / âm thanh + dự phòng GitHub
- **Ảnh** vẫn tải lên GitHub như cũ. **Video / âm thanh mới** lưu trên **Cloudflare R2** (S3-compatible), không ghi vào tài khoản GitHub media đang bị khoá.
- Cấu hình ở trang `/connect` (chỉ admin mặc định): Account ID, bucket, Access Key/Secret, prefix, cách trả link (`public` / `presign` / `proxy`) và **repo GitHub dự phòng** (owner/repo/branch/token riêng). Khoá R2 + token dự phòng được **mã hoá 2 chiều** trong `v-s/cloudflare.json` bằng `CONNECT_ENC_KEY`; trang chỉ hiện 4 ký tự cuối của Access Key ID; Secret và token dự phòng không hiện (không lưu cả 4 ký tự cuối).
- R2 lỗi khi ghi object/đoạn hoặc khi ghi `m3u8` → tự ghi sang repo dự phòng; nếu toàn bộ đoạn phải dùng dự phòng thì entry chuyển hẳn sang `github-fallback`. Media cũ trên GitHub vẫn xem/phát/tải bình thường (entry cũ không có `storage`).
- Tải lên vẫn mã hoá đầu-cuối: file nhỏ AES-256-GCM, HLS AES-128 (khoá bọc trong `mnha-media.json`); object trên R2/repo dự phòng đều là bản mã hoá. `CLOUDFLARE_REQUIRED=on` chặn hẳn việc ghi video/âm thanh mới vào GitHub khi chưa cấu hình R2/dự phòng.
- Hướng dẫn đầy đủ (tạo bucket/token, cấu hình, luồng tải, link xem/tải, xử lý lỗi): `guide/connect-cloudflare.md`. Test: `node -r ./test/_stubs.js test/cloudflare.js` và `test/cloudflare-usage.js` (mã hoá cấu hình + đếm GB).
- **Dung lượng đã up lên Cloudflare (GB)**: `/connect#cloudflare` hiện hôm nay / tuần / 30 ngày / tổng đã ghi lên R2 (đo thực tế, lưu theo tuần `usage/week-N/index.json` như Vercel, cộng mọi web) + nút **Đo dung lượng bucket** (liệt kê object, lưu `stored` vào `v-s/cloudflare.json`).

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
- Không dùng `api/` hay `vercel.json`: `server.js` xuất `app` (MongoDB nối lười ở request đầu; `/api/node/health` không cần MongoDB) nên Vercel tự chạy như Express.
- Settings → Build and Deployment: **Framework Preset = Express**, để trống Build/Output/Install command (tắt Override Output Directory).
- Nếu đẩy cả thư mục `repository-mnha/` lên GitHub thì Settings → General → **Root Directory** = `repository-mnha`.
- Settings → Deployment Protection: tắt **Vercel Authentication** để web chính gọi được `/api/node/health`.

## Trang khoá kết nối + kiểm tra khoá khi tải lên
- Web dữ liệu có trang **`/connect/key`** (chỉ admin mặc định): xem khoá sau khi nhập lại mật khẩu (sai 5 lần khoá 10 phút), nút sao chép, và mục **Tự kiểm tra khoá** (giải mã được khoá trong `v-s/index.json`, ký/xác minh phiếu tải lên đúng cơ chế thật).
- Mỗi lần tải lên, web chính kiểm tra lần lượt cũ → mới: web sống **và đúng khoá** (`POST /api/node/ping`, ký bằng khoá riêng) mới được chọn. Sai khoá → bỏ qua, ghi vào danh sách kiểm tra và chuyển web kế tiếp.
- Mỗi web nhận một **phiếu tải lên riêng**, ký bằng khoá kết nối của web đó; web dữ liệu từ chối (401) mọi phần/đoạn file có phiếu sai khoá, trình duyệt tự chuyển sang web kế.
