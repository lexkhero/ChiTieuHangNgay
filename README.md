> **Bản 3.11** (xem số phiên bản ở cuối tab Cài đặt): giao diện viết lại đạt chuẩn tương phản, ô chọn có nút × bỏ chọn,
> so sánh cùng kỳ trong Tổng hợp, thêm thành viên / hạng mục trong Cài đặt, đồng bộ nhẹ hơn (không tải lại toàn bộ sau mỗi lần lưu).
> Cập nhật: chỉ cần đẩy code lên GitHub; không phải làm lại Apps Script.

> **Cập nhật bản 3 (giao diện mới):** chỉ cần upload lại các file trong thư mục này lên GitHub (Commit changes), chờ 2 phút rồi mở trang bấm Ctrl + F5.
> **Không cần** làm lại Apps Script, URL /exec, SECRET hay nạp lại dữ liệu. Dữ liệu và cấu hình khoản vay giữ nguyên.
> Trên điện thoại: đóng hẳn app rồi mở lại 1-2 lần để nhận bản mới.

# ChiTieuHangNgay – Hướng dẫn cài đặt chi tiết

Trang web (PWA) để nhập và tổng hợp chi tiêu hằng ngày, theo dõi khoản vay ô tô và nhà, cảnh báo đến hạn trả nợ.
Dữ liệu **không nằm trên GitHub**. Trang ghi vào các sheet mới trong file Google Sheet "Tính tiền hàng tháng"
thông qua Google Apps Script. Các sheet tháng cũ không bị sửa.

---

## Thư mục gồm những gì

```
E:\ChiTieuHangNgay\
  apps-script\
    Code.gs          -> dán vào Apps Script (backend)
    LoanEngine.gs    -> dán vào Apps Script (bộ tính lãi vay)
  icons\             -> biểu tượng trang
  app.js, classifier.js, loan-engine.js, index.html, styles.css, sw.js, manifest.json, README.md
```

Có thêm một file **seed-2024-2026.json** (dữ liệu tháng 6/2024 → 11/2026 và cấu hình 2 khoản vay).
**Không để file này trong thư mục E:\ChiTieuHangNgay và không upload lên GitHub**, ví dụ hãy để ở `E:\seed-2024-2026.json`.
File `seed-2026.json` của bản trước không dùng nữa, có thể xóa.

---

## PHẦN 1. Backend Google Apps Script

### 1.1. Mở Apps Script
1. Mở Google Sheet **Tính tiền hàng tháng** trên máy tính.
2. Menu **Tiện ích mở rộng** (Extensions), chọn **Apps Script**. Một tab mới sẽ mở ra.

### 1.2. Dán file Code.gs
1. Ở cột bên trái, mục **Tệp**, có sẵn file **Mã.gs** (hoặc Code.gs). Bấm vào file đó.
2. Dùng Notepad mở `E:\ChiTieuHangNgay\apps-script\Code.gs`, bấm Ctrl + A rồi Ctrl + C.
3. Quay lại Apps Script, bấm vào vùng code, Ctrl + A rồi Delete để xóa hết, sau đó Ctrl + V để dán.
4. Bấm Ctrl + S để lưu.

### 1.3. Thêm file LoanEngine.gs
1. Cạnh chữ **Tệp**, bấm dấu **＋** và chọn **Tập lệnh** (Script).
2. Gõ tên `LoanEngine` rồi Enter. Apps Script tự thêm đuôi .gs.
3. Xóa nội dung mặc định trong file mới tạo.
4. Mở `E:\ChiTieuHangNgay\apps-script\LoanEngine.gs` bằng Notepad, chép toàn bộ và dán vào. Bấm Ctrl + S.

### 1.4. Đặt mã bí mật
1. Ở cột trái, bấm **⚙ Cài đặt dự án**.
2. Kéo xuống mục **Thuộc tính tập lệnh**, bấm **Thêm thuộc tính tập lệnh**:
   - Thuộc tính: `SECRET`
   - Giá trị: một chuỗi khó đoán do bạn tự đặt, ví dụ `ChiTieu@NhaLe#2026xyz`. Hãy ghi lại.
3. Bấm **Lưu thuộc tính tập lệnh**.

### 1.5. Chạy hàm setup
1. Bấm **< > Trình chỉnh sửa**, mở file **Code.gs**.
2. Trên thanh công cụ, ở ô chọn hàm (cạnh nút "Gỡ lỗi"), chọn **setup**, rồi bấm **▷ Chạy**.
3. Lần đầu sẽ phải cấp quyền: bấm **Xem xét quyền**, chọn tài khoản, bấm **Nâng cao**, bấm **Đi tới … (không an toàn)**, rồi bấm **Cho phép**.
   Đây là code của chính bạn, chạy trong tài khoản Google của bạn.
4. Khi thấy "Đã hoàn tất thực thi", quay lại Google Sheet. Sẽ có 3 sheet mới: **ChiTieuApp**, **PhanLoaiApp**, **CaiDatApp**.

### 1.6. Triển khai thành Ứng dụng web
1. Bấm nút xanh **Triển khai**, chọn **Tùy chọn triển khai mới**.
2. Bấm ⚙ cạnh "Chọn loại", chọn **Ứng dụng web**.
3. Điền:
   - Nội dung mô tả: `Bản 2`
   - Thực thi dưới dạng: **Tôi**
   - Người có quyền truy cập: **Bất kỳ ai**. Mã SECRET sẽ bảo vệ dữ liệu.
4. Bấm **Triển khai**, rồi **Sao chép** URL dạng `https://script.google.com/macros/s/……/exec`. Lưu URL này lại.

> **Khi sửa code Apps Script sau này**: chọn **Triển khai → Quản lý triển khai**, bấm ✏ Chỉnh sửa, ở ô Phiên bản chọn **Phiên bản mới**, rồi bấm **Triển khai**.
> Làm như vậy thì URL giữ nguyên. Nếu bấm "Tùy chọn triển khai mới" thì sẽ ra một URL khác.

---

## PHẦN 2. Nhắc nợ qua Telegram (không bắt buộc)

Phần này giúp mỗi sáng 7 giờ nhận tin nhắn khi khoản vay sắp đến hạn, khi chi tiêu sắp vượt ngân sách, và nhận bản tổng kết vào ngày 1 hằng tháng.

1. **Lấy token bot**: dùng bot Telegram bạn đang có (như bot của tool Vietlott), hoặc tạo bot mới bằng cách nhắn `/newbot` cho **@BotFather**. Token có dạng `123456789:ABC…`.
2. **Lấy chat id**:
   1. Mở Telegram, nhắn cho bot của bạn một tin bất kỳ, ví dụ "hi".
   2. Mở trình duyệt, vào `https://api.telegram.org/bot<TOKEN>/getUpdates` (thay `<TOKEN>` bằng token thật).
   3. Tìm đoạn `"chat":{"id":123456789` trong kết quả. Số đó là chat id.
3. Trong Apps Script, vào **⚙ Cài đặt dự án → Thuộc tính tập lệnh** và thêm 2 thuộc tính:
   - `TELEGRAM_TOKEN` = token bot
   - `TELEGRAM_CHAT_ID` = chat id
4. Mở lại **Code.gs**. Chọn hàm **thuTelegram** rồi bấm **Chạy**. Telegram phải nhận được tin "✅ ChiTieuHangNgay đã kết nối Telegram".
5. Chọn hàm **caiNhacHangNgay** rồi bấm **Chạy** (cấp quyền nếu được hỏi). Hàm này cài lịch chạy tự động mỗi ngày lúc 7 giờ sáng.
   Muốn kiểm tra thì vào biểu tượng ⏰ **Trình kích hoạt** ở cột trái, sẽ thấy dòng `nhacHangNgay`.

---

## PHẦN 3. Đưa trang lên GitHub Pages

1. Đăng nhập https://github.com (tài khoản **lexkhero**).
2. Bấm **＋ → New repository**:
   - Repository name: `ChiTieuHangNgay`
   - Chọn **Public** (GitHub Pages miễn phí yêu cầu repo công khai. Repo chỉ chứa code, không có dữ liệu.)
   - **Không** tích "Add a README file".
   - Bấm **Create repository**.
3. Trong repo trống, bấm link **uploading an existing file**.
4. Mở `E:\ChiTieuHangNgay`, bấm Ctrl + A để chọn tất cả (kể cả thư mục `apps-script` và `icons`), rồi kéo thả vào trang GitHub.
5. Kiểm tra danh sách file: có `index.html`, `loan-engine.js`, `icons/…`, `apps-script/…` và **không có file seed nào**.
6. Bấm **Commit changes**.
7. Vào **Settings → Pages**. Mục Source chọn **Deploy from a branch**, Branch chọn **main** và **/(root)**, rồi bấm **Save**.
8. Chờ 1–2 phút. Trang sẽ ở **https://lexkhero.github.io/ChiTieuHangNgay/**

**Cập nhật code sau này**: vào repo, bấm **Add file → Upload files**, kéo các file mới vào (file trùng tên sẽ được thay), rồi bấm Commit.
Trên điện thoại, mở lại trang 1–2 lần để nhận bản mới.

---

## PHẦN 4. Lần đầu mở trang trên máy tính

1. Mở **https://lexkhero.github.io/ChiTieuHangNgay/** bằng Chrome. Trang sẽ tự vào tab **Cài đặt**.
2. Dán **URL /exec** (bước 1.6) và **SECRET** (bước 1.4), rồi bấm **Lưu & kiểm tra**. Phải hiện "Kết nối thành công."
3. Ở mục **Nạp dữ liệu ban đầu**, bấm **Chọn tệp** và chọn `E:\seed-2024-2026.json`.
   Chờ thanh tiến trình chạy hết (khoảng 1–2 phút). Đừng đóng trang.
   Khi xong sẽ hiện "Đã nạp 3.037 khoản và 1.000 tên phân loại".
4. Kiểm tra lại:
   - Tab **Tổng hợp**: Năm 2024 = 163.407.481, năm 2025 = 258.410.877, năm 2026 = 286.283.259.
   - Tab **Khoản vay**: có "Vay mua ô tô" và "Vay nhà".
   - Sheet **ChiTieuApp** trên Google Sheet có 3.037 dòng.

Chỉ cần nạp file seed **một lần**. Nạp lại cũng không bị trùng, vì mỗi khoản có mã riêng.

---

## PHẦN 5. Cài lên iPhone

1. Mở **Safari** (không dùng Chrome) và vào https://lexkhero.github.io/ChiTieuHangNgay/
2. Bấm nút **Chia sẻ** (ô vuông có mũi tên lên), chọn **Thêm vào MH chính**, rồi bấm **Thêm**.
3. Mở biểu tượng **Chi tiêu** vừa thêm. Vào tab **Cài đặt**, nhập URL và SECRET, bấm **Lưu & kiểm tra**.

---

## Cách dùng

### Nhập
- Chọn ngày, người, loại (Sinh hoạt / Phát sinh / Chung), gõ tên khoản chi và số tiền. Gõ `30` sẽ hiểu là 30.000 đ.
- Hạng mục được gợi ý tự động. Nếu bạn chọn hạng mục khác, trang **ghi nhớ** cho tên đó.
- Phía trên form có **cảnh báo**: khoản vay sắp đến hạn và hạng mục sắp vượt hoặc đã vượt ngân sách.
- Bấm vào một khoản trong danh sách để sửa hoặc xóa.
- Mất mạng vẫn nhập được. Khoản chi hiện chữ "chờ gửi" và tự gửi lên Sheet khi có mạng.

### Tổng hợp
- Chọn năm hoặc tháng, cả nhà hoặc từng người.
- Xem theo hạng mục (có so với ngân sách khi xem một tháng), theo người, theo tháng hoặc ngày, và các khoản lớn nhất.
- Có **Trả nợ gốc, Trả nợ lãi, Chi tiêu + trả nợ** tính theo lịch các khoản vay.
- **So sánh các năm**: bảng tháng × năm, có % tăng/giảm so với cùng kỳ năm trước. Lọc được theo hạng mục và theo người.

### Khoản vay
- Mỗi khoản vay hiện: kỳ tới (ngày, gốc, lãi, tổng), dư nợ, lãi suất hiện tại, **lãi tạm tính đến hôm nay** (để đối chiếu với app ngân hàng), đáo hạn, số đã trả, lãi còn phải trả.
- Có dòng **Cách tính lãi kỳ tới**, ghi rõ từng đoạn ngày × dư nợ × lãi suất.
- **Xem lịch trả nợ**: toàn bộ các kỳ từ đầu đến đáo hạn.
- **Sửa** khoản vay:
  - **Lãi suất**: mỗi lần ngân hàng đổi lãi, thêm một dòng "Từ ngày – %/năm".
  - **Trả trước gốc**: ngày và số tiền.
  - **Tạm dừng trả gốc**: các tháng chỉ trả lãi (ví dụ sau khi trả trước gốc).
  - **Đổi ngày trả**: tháng nào ngân hàng thu vào ngày khác (lễ, Tết).
  - **Nhắc trước (ngày)**: bao nhiêu ngày trước hạn thì bắt đầu cảnh báo.
- Cách tính: lãi = dư nợ × lãi suất năm / 365 × số ngày. Kỳ nào có đổi lãi giữa chừng thì tách thành nhiều đoạn.
  Ngày trả rơi vào thứ 7 hoặc chủ nhật thì dời sang thứ 2.

### Cài đặt
- Kết nối Google Sheet, nạp dữ liệu ban đầu, **ngân sách tháng theo hạng mục**, gửi thử Telegram, xuất CSV.

---

## Nếu gặp lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| "Sai mã bí mật" | Mã nhập trên trang khác mã ở bước 1.4. Kiểm tra chữ hoa/thường và dấu cách thừa. |
| "Failed to fetch" / không kết nối được | Kiểm tra URL có kết thúc bằng `/exec` không, và bước 1.6 đã chọn **Bất kỳ ai** chưa. |
| "LoanEngine is not defined" trong Apps Script | Chưa làm bước 1.3 (thêm file LoanEngine.gs). |
| Trang GitHub báo 404 | Chờ thêm vài phút. Kiểm tra `index.html` có nằm ngay ở thư mục gốc của repo không. |
| Sửa Code.gs mà không có tác dụng | Phải triển khai **Phiên bản mới** (xem ghi chú ở bước 1.6). |
| Không nhận được Telegram | Chạy hàm `thuTelegram` và xem nhật ký thực thi. Kiểm tra lại token, chat id, và đã nhắn cho bot ít nhất một lần chưa. |
