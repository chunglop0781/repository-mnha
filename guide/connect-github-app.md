# GitHub App — trình duyệt tải file THẲNG lên GitHub (không qua Vercel)

Trang **Lưu trữ file** (`/code/files`): trình duyệt mã hoá từng phần rồi gửi **thẳng** lên `api.github.com` (như khi chạy localhost),
bản mã không đi qua Vercel nên không tốn băng thông. Server chỉ nhận một request JSON nhỏ để **gom các phần vào 1 commit**.

## Vì sao dùng GitHub App
Muốn trình duyệt ghi lên GitHub thì phải đưa cho nó một token. Đưa PAT thật là lộ. Vì vậy:

- Máy chủ giữ **private key của GitHub App**, mỗi lần tải lên chỉ cấp cho trình duyệt **installation token**:
  **hết hạn sau 1 giờ, chỉ 1 repo (repo đang nhận file, kể cả `<repo>-1`, `-2`…), chỉ quyền Contents:write**.
- PAT thật (`GITHUB_TOKEN`) và private key **không bao giờ** xuống trình duyệt (giống cách khoá giải mã được cấp tạm cho từng file).

## Cấu hình 1 lần (không cần .env)
1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App** (tắt Webhook). Repository permissions: **Contents = Read and write**.
2. Ghi lại **App ID**, bấm **Generate a private key** để tải file `.pem`.
3. **Install App** lên tài khoản chứa repo dữ liệu, chọn **All repositories** (để repo `-1`, `-2`… tự tạo sau này cũng được cấp token).
4. Mở `/connect` (admin mặc định) → mục **GitHub App** → dán App ID + nội dung `.pem` → **Lưu** → **Thử cấp token**.

Private key được **mã hoá AES-256-GCM** (`CONNECT_ENC_KEY`) rồi lưu ở repo chính `v-s/github-app.json`; web kết nối đọc cấu hình này từ repo chính.
Không muốn dùng trang `/connect` thì đặt `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (nội dung `.pem`, cho phép 1 dòng với `\n` hoặc base64), `GITHUB_APP_INSTALLATION_ID` (tuỳ chọn) trong `.env`.

## Luồng
`POST /code/files/upload/init` → trả `ghDirect` {owner, repo, branch, **token tạm**} → trình duyệt `POST /git/blobs` từng phần (bản mã `MNHAENC1`)
→ cứ 8 phần `POST …/files/commit` {parts:[{i,sha}]} (server gom vào 1 commit, kiểm quyền + đường dẫn + mã tải lên) → `POST …/files/finish`.
Đứt giữa chừng thì tải lại đúng file để **làm tiếp** từ phần còn thiếu.

## Tự quay về đường cũ
Chưa cấu hình App, token hết hạn/hết hạn mức, mạng/CORS lỗi → trình duyệt **báo rõ lý do** rồi gửi qua web kết nối như trước (tốn băng thông Vercel).
Có R2 thì R2 vẫn được ưu tiên. Tắt hẳn đường GitHub trực tiếp: `FILES_GH_DIRECT=off`.

## Test
`node test/github-app.js` (cấu hình mã hoá, token tối thiểu, commitBlobs) · `node test/files-client-gh.js` (trình duyệt → GitHub, làm tiếp, dự phòng).
