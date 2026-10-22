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
