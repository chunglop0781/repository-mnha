# Kết nối Cloudflare R2 — lưu video / âm thanh, dự phòng GitHub

Tài liệu này hướng dẫn cấu hình kho media mới cho trang **HTML + CSS** (`/code/html`):

- **Ảnh** vẫn tải lên GitHub như trước (không đổi).
- **Video / âm thanh mới** được lưu trên **Cloudflare R2**.
- R2 lỗi khi ghi hoặc không tạo được link xem → tự ghi sang **repo GitHub dự phòng** (tài khoản/repo KHÁC), kèm `index.m3u8` khi file bị cắt đoạn.
- **Media cũ** trên GitHub vẫn xem, phát, tải bình thường.
- Không bao giờ ghi media mới vào **tài khoản GitHub media đang bị khoá**.

Cấu hình nằm trong repo chính tại `v-s/cloudflare.json`; khoá R2 và token GitHub dự phòng được **mã hoá 2 chiều** bằng `CONNECT_ENC_KEY` (AES-256-GCM, AAD riêng từng trường). Trang `/connect` chỉ hiện 4 ký tự cuối của Access Key ID; Secret Access Key và token dự phòng **không** hiện gì (chỉ ghi “đã lưu (mã hoá)”).

---

## 1. Chuẩn bị Cloudflare R2

1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com/) → **R2**.
2. Tạo bucket, ví dụ `mnha-media`.
   - Bucket **private** là đủ: chọn cách trả link *Ký URL tạm thời* hoặc *Qua máy chủ*.
   - Muốn link công khai: bật **Public access** (r2.dev) hoặc gắn **custom domain**, rồi dán địa chỉ đó vào ô *Địa chỉ công khai*.
3. Vào **R2 → Manage R2 API Tokens → Create API token**:
   - Quyền: **Object Read & Write** cho đúng bucket trên (hoặc toàn bộ R2 nếu chấp nhận).
   - Lưu lại **Access Key ID** và **Secret Access Key** — secret chỉ hiện một lần.
4. Lấy **Account ID**: góc phải Dashboard Cloudflare (32 ký tự hex), hoặc trong trang tổng quan R2.
5. (Tuỳ chọn) Đặt **tiền tố** nếu muốn media nằm trong một thư mục con của bucket, ví dụ `media`. Để trống nếu dùng gốc bucket.

> Endpoint mặc định là `https://<account-id>.r2.cloudflarestorage.com`. Chỉ cần nhập ô *Endpoint* khi dùng endpoint riêng/giả lập S3.

## 2. Chuẩn bị repo GitHub dự phòng

Repo dự phòng là nơi ghi thay khi R2 lỗi — phải là **tài khoản/repo khác** với tài khoản GitHub media đang khoá.

1. Tạo repo mới, ví dụ `repository-mnha-fallback` (repo riêng tư vẫn dùng được, nhưng khi đó trình duyệt không tải đoạn trực tiếp được → xem mục 6).
2. Tạo **fine-grained token** chỉ cho repo đó, quyền **Contents: Read and write**.
3. Ghi lại `owner`, `repo`, `branch` (thường `main`) và token.

## 3. Cấu hình trên trang `/connect`

Mở `/connect` của **web chính** bằng tài khoản admin mặc định (`role=admin`, `userKey=null`) → mục **Cloudflare R2 — video / âm thanh**.

Điền:

| Ô | Ý nghĩa |
|---|---|
| Bật Cloudflare R2 | Bỏ tick = tạm ngừng dùng R2 (chỉ còn đường dự phòng/legacy). |
| Account ID | Account ID Cloudflare. |
| Tên bucket R2 | Ví dụ `mnha-media`. |
| Access Key ID / Secret Access Key | Khoá của R2 API token. Để trống khi lưu = giữ khoá cũ. |
| Endpoint (tuỳ chọn) | Mặc định `https://<account-id>.r2.cloudflarestorage.com`. |
| Region (tuỳ chọn) | Mặc định `auto`. |
| Tiền tố (prefix) | Thư mục con trong bucket, có thể để trống. |
| Địa chỉ công khai | `https://pub-....r2.dev` hoặc custom domain; chỉ dùng cho chế độ *Công khai*. |
| Cách trả link xem | `Công khai` / `Ký URL tạm thời` / `Qua máy chủ /preview`. |
| GitHub dự phòng | Owner, repo, branch, token; tick *Repo công khai* nếu trình duyệt được tải đoạn thẳng từ `raw.githubusercontent.com`. |

Bấm **Lưu cấu hình Cloudflare**, sau đó **Kiểm tra R2 + repo dự phòng** để xác nhận ghi/đọc/xoá thử và quyền token dự phòng.

### Biến môi trường (tuỳ chọn)

Cấu hình thật nằm trong `v-s/cloudflare.json`. Hai biến dưới chỉ đổi đường dẫn / chế độ bắt buộc:

```env
# Đường dẫn file cấu hình trong repo chính
CLOUDFLARE_INDEX_PATH=v-s/cloudflare.json

# on = KHÔNG cho ghi video/âm thanh mới vào GitHub khi chưa cấu hình R2/dự phòng.
# Khuyến nghị bật khi tài khoản GitHub media đã bị khoá.
CLOUDFLARE_REQUIRED=off
```

Khi `CLOUDFLARE_REQUIRED=on` mà chưa có R2 lẫn repo dự phòng, lần tải video/âm thanh sẽ báo lỗi 503 kèm hướng dẫn vào `/connect`, thay vì âm thầm ghi vào GitHub.

## 4. Luồng tải lên

1. Trình duyệt gọi `POST /code/html/upload/init`. Máy chủ chọn kho:
   - ảnh → GitHub (`github`);
   - video/âm thanh → `cloudflare` nếu R2 đã cấu hình, ngược lại `github-fallback` nếu có repo dự phòng; không có gì thì giữ đường GitHub cũ (trừ khi `CLOUDFLARE_REQUIRED=on`).
2. **File ≤ 23MB** (`MEDIA_DIRECT_MAX`): mã hoá AES-256-GCM (`MNHAENC1`) rồi ghi **một object** vào R2 (hoặc file trong repo dự phòng). Tên object giữ nguyên đường dẫn gốc: `{user_id}/codes/html/{thư mục}/{tên-file}`.
3. **File > 23MB**: trình duyệt cắt thành đoạn HLS (`public/js/tsMux.js`), mỗi đoạn được mã hoá AES-128-CBC rồi gửi lên. Mỗi lô 8 đoạn ghi một lần:
   - đoạn `.ts` / `.m4s` → R2 (hoặc repo dự phòng);
   - `index.m3u8` → cùng kho với đoạn;
   - tiến độ + khoá HLS đã bọc mã hoá → `mnha-media.json` **trong repo chính**.
4. Nếu một đoạn ghi R2 lỗi, đoạn đó được ghi sang repo dự phòng và trình duyệt nhận thông báo *"Cloudflare R2 lỗi khi ghi đoạn … — dùng repo GitHub dự phòng."* Các đoạn còn lại vẫn thử R2 trước; nếu **toàn bộ** đoạn nằm ở dự phòng, cả entry được đánh dấu `github-fallback`.
5. File trùng tên: bản cũ (trên R2 và/hoặc repo dự phòng) được dọn trước khi ghi bản mới. Tải dở mà đứt mạng: chọn lại đúng file để làm tiếp từ đoạn đã có.

Trong `mnha-media.json`, mỗi entry mới có thêm `storage` (không chứa khoá):

```json
{
  "phim.mp4": {
    "kind": "video",
    "mode": "hls-video",
    "state": "ready",
    "done": 120,
    "storage": { "provider": "cloudflare", "accountId": "…", "bucket": "mnha-media", "prefix": "", "publicBase": "https://cdn.example.com", "mode": "public" },
    "segStorage": {
      "37": { "provider": "github-fallback", "owner": "fb-owner", "repo": "fb-media", "branch": "main", "public": true }
    },
    "drm": { "method": "AES-128", "key": "v2.…" }
  }
}
```

- `storage`: kho mặc định của media đó.
- `segStorage`: chỉ xuất hiện khi **lẫn kho** — vài đoạn nằm ở dự phòng trong khi phần còn lại ở R2 (khoá là số thứ tự đoạn).
- Entry cũ **không có** `storage` vẫn được đọc từ GitHub như trước.

## 5. Xem, phát và tải về

Người dùng không phải đổi thao tác: vẫn mở trang HTML, trình phát `/code/html/player`, hoặc bấm nút **Tải** như cũ.

- **Xem qua máy chủ** (`/preview/<token>/...`): máy chủ đọc object từ R2/repo dự phòng theo `storage`/`segStorage`, giải mã rồi trả. Luôn hoạt động kể cả bucket private.
- **Trình duyệt tự giải mã** (mặc định khi có link trực tiếp): máy chủ trả playlist mà mỗi đoạn trỏ thẳng tới:
  - R2: `https://<public-base>/<key>?v=<uploadId>` (chế độ *Công khai*) hoặc URL đã ký hạn **6 giờ** (chế độ *Ký URL tạm thời*);
  - GitHub dự phòng: `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<key>?v=<uploadId>`;
  - `key.bin` luôn đi qua máy chủ sau khi kiểm tra quyền, không lộ khoá chủ.
- **Chế độ *Qua máy chủ***: không trả link trực tiếp; mọi đoạn đi qua `/preview`. Dùng khi bucket private và không muốn presign, hoặc khi đặt `MEDIA_DIRECT=off`.
- **Tải về** (`?dl=1` / nút Tải): media nhỏ trả file gốc đã giải mã; media cắt đoạn được ghép lại thành luồng phát được (giữ đuôi lúc tải lên).

### Lấy link xem / tải nhanh

- **Trong web**: mở trình phát của thư mục (`/code/html/player?dir=…&file=…`) → nút **Tải về**; hoặc mở trang HTML và rê chuột vào media → nút ⬇.
- **Link trực tiếp tới object** (chỉ để kiểm tra/kỹ thuật):
  - R2 công khai: `https://<public-base>/<user_id>/codes/html/<thư-mục>/<tên-file>`;
  - R2 private: dùng chế độ *Ký URL tạm thời* (link hết hạn sau 6 giờ) hoặc *Qua máy chủ*;
  - GitHub dự phòng: `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<user_id>/codes/html/<thư-mục>/<tên-file>` (repo phải công khai).
  - Với file đã cắt HLS: `…/_media/<id>/index.m3u8` và các đoạn `seg00000.ts`, …; object trên R2 **đã mã hoá**, không phát trực tiếp nếu không có `key.bin`.

## 6. Tự chuyển sang GitHub dự phòng

Thứ tự quyết định kho cho video/âm thanh:

1. R2 đã cấu hình và đang bật → ghi R2.
2. R2 lỗi khi `PUT` object/đoạn → ghi object/đoạn đó sang repo dự phòng (kèm thông báo trên giao diện).
3. R2 lỗi khi ghi `index.m3u8` → vẫn ghi `m3u8` sang repo dự phòng.
4. Không có đoạn nào lên được R2 → toàn bộ entry chuyển sang `github-fallback`.
5. Chưa cấu hình R2 nhưng có repo dự phòng → dùng repo dự phòng ngay từ đầu.
6. Không cấu hình gì → giữ đường GitHub cũ (trừ khi `CLOUDFLARE_REQUIRED=on`).

Repo dự phòng **riêng tư**: máy chủ vẫn đọc/phát được, nhưng trình duyệt không tải thẳng `raw` được nên media sẽ đi qua `/preview` (chậm hơn, tốn băng thông máy chủ). Nên để repo dự phòng **công khai** nếu chấp nhận được, hoặc dùng R2 làm kho chính.

## 7. Bảo mật

- `v-s/cloudflare.json` chỉ chứa bản mã hoá của Access Key, Secret và token dự phòng:
  - AES-256-GCM, AAD lần lượt `cloudflare|accessKeyId`, `cloudflare|secretAccessKey`, `cloudflare|fallbackToken`;
  - khoá mã hoá lấy từ `CONNECT_ENC_KEY` (fallback `SESSION_ENC_KEY`).
- Cấu hình cũ có `secretHint`/`tokenHint` (4 ký tự cuối) sẽ tự bị xoá ở lần lưu cấu hình kế tiếp.
- Sai/đổi `CONNECT_ENC_KEY`, sửa ciphertext hoặc tráo khối mã hoá giữa các trường → giải mã thất bại (AES-GCM + AAD), `/connect` báo lỗi và không dùng R2, không ném lỗi làm sập trang.
- `mnha-media.json` **không** chứa khoá R2/token; chỉ chứa thông tin công khai của kho (provider, owner/repo/bucket, chế độ).
- Media luôn được mã hoá trước khi rời máy chủ/trình duyệt:
  - file nhỏ: AES-256-GCM `MNHAENC1`, khoá suy ra từ `MEDIA_ENC_KEY` + salt;
  - HLS: AES-128-CBC từng đoạn, khoá bọc 2 chiều trong `mnha-media.json`.
- Lộ object trên R2/repo dự phòng không đủ để xem nội dung nếu không có khoá chủ.
- **Đổi `MEDIA_ENC_KEY` hoặc `CONNECT_ENC_KEY` = mất khả năng đọc media/khoá đã lưu.** Hãy sao lưu 2 biến này an toàn.
- Xoá cấu hình Cloudflare trên `/connect` chỉ xoá `v-s/cloudflare.json`; object trên R2 vẫn còn nhưng sẽ không đọc lại được nếu mất khoá.

## 8. Giới hạn & lưu ý

- Ảnh vẫn chịu giới hạn GitHub/Vercel như cũ; video/âm thanh không còn làm phình repo GitHub media.
- R2 có phí lưu trữ + băng thông; theo dõi dung lượng bucket và số lần presign.
- Mỗi đoạn HLS vẫn ≤ 3.5MB để hợp giới hạn request của Vercel.
- Phát được hay không còn tuỳ codec/trình duyệt (H.264/H.265/AV1/VP9 — xem `CODE.md`).
- Presign có hạn 6 giờ: playlist được tạo lại mỗi lần xem nên không bị "chết link" giữa chừng; link dán ra ngoài sẽ hết hạn.

## 9. Kiểm thử & khắc phục sự cố

Chạy test end-to-end (dùng R2/GitHub giả, không cần tài khoản thật):

```bash
node -r ./test/_stubs.js test/cloudflare.js
node -r ./test/_stubs.js test/cloudflare-usage.js   # mã hoá cấu hình + đếm GB + đo bucket
```

Test bao gồm: ảnh vẫn lên GitHub; âm thanh nhỏ lên R2; HLS + playlist + key trên R2; R2 lỗi → file/đoạn/m3u8 sang repo dự phòng; đọc lại media cũ trên GitHub; xoá dọn object trên R2; json không lộ khoá.

| Hiện tượng | Kiểm tra |
|---|---|
| "Chưa cấu hình Cloudflare R2 …" (503) | Đã lưu đủ Account ID, bucket, Access Key, Secret ở `/connect` chưa; hoặc tắt `CLOUDFLARE_REQUIRED`. |
| R2 báo lỗi 403/`SignatureDoesNotMatch` | Sai Access Key/Secret, sai Account ID, hoặc token không có quyền bucket. |
| Không phát được, chỉ tải được | Chế độ link/bucket private; thử *Ký URL tạm thời* hoặc *Qua máy chủ*. |
| Rơi vào dự phòng liên tục | Xem thông báo lỗi R2 trong log máy chủ (`[mediaService]`); kiểm tra endpoint/bucket/quyền ghi. |
| Bật *Qua máy chủ* nhưng vẫn thấy link CDN | Đặt `MEDIA_DIRECT=off` hoặc kiểm tra lại `mode` đã lưu trong `v-s/cloudflare.json`. |
| Media cũ không phát | Entry cũ không có `storage` → vẫn phải đọc GitHub; kiểm tra repo media cũ còn truy cập được. |

## 10. Xem đã up lên Cloudflare bao nhiêu GB

Mục **Dung lượng đã up lên Cloudflare R2** nằm ngay trong khung Cloudflare ở `/connect#cloudflare` (chỉ admin mặc định):

| Số liệu | Ý nghĩa |
|---|---|
| Hôm nay / Tuần / 30 ngày / Tổng | Số byte máy chủ **ghi lên R2** (đã mã hoá; tính cả phần tạm khi ghép file lớn), đổi ra MB/GB. Tuần chọn bằng `?w=0`, `?w=-1`… như bảng lưu lượng Vercel. |
| Request R2 | Số request S3 gửi tới R2 (PUT/GET/LIST/DELETE). |
| Đọc từ R2 (máy chủ) | Byte máy chủ đọc về (xem qua `/preview`, ghép file để tải). Xem trực tiếp bằng link công khai/presign **không** đi qua máy chủ nên không tính ở đây. |
| Ghi GitHub dự phòng | Byte ghi sang repo dự phòng khi R2 lỗi. |
| Đang chứa trong bucket | Bấm **Đo dung lượng bucket**: liệt kê object (theo prefix đã cấu hình), cộng dung lượng thật và lưu `stored` vào `v-s/cloudflare.json`. |

- Số “ghi lên R2” lưu **mỗi tuần một file** `usage/week-N/index.json` (cùng nơi lưu lượng Vercel, **không xoá**), cộng gộp mọi web (web chính + web dữ liệu). Mỗi instance giữ bộ đếm rồi ghi lên GitHub định kỳ (~45 giây) — số đo là xấp xỉ, tính từ lúc bật tính năng này.
- Số chính thức của Cloudflare: Dashboard → R2 → bucket → **Metrics**. R2 miễn phí 10 GB lưu trữ/tháng; thu phí theo dung lượng lưu và số request, không thu phí băng thông ra (egress).
