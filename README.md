# ChiTieuHangNgay

Trang web (PWA) để nhập và tổng hợp chi tiêu hằng ngày của gia đình, dùng tốt trên iPhone.
Dữ liệu **không nằm trên GitHub**. Trang ghi vào sheet `ChiTieuApp` trong file Google Sheet
"Tính tiền hàng tháng" thông qua Google Apps Script. Các sheet tháng cũ không bị đụng tới.

## Cấu trúc

| File | Vai trò |
|---|---|
| `index.html`, `styles.css`, `app.js` | Giao diện: Nhập, Danh sách, Tổng hợp, Cài đặt |
| `classifier.js` | Tự gợi ý hạng mục theo quy tắc đã thống nhất (ăn sáng, cháo của Putin/Út…) |
| `sw.js`, `manifest.json`, `icons/` | Cài lên màn hình chính, mở được khi mất mạng |
| `apps-script/Code.gs` | Backend dán vào Apps Script của file Google Sheet |

File `seed-2026.json` (dữ liệu tháng 1–11/2026) **không đưa lên GitHub** vì repo GitHub Pages là công khai.

## Cài đặt

### 1. Backend Google Apps Script
1. Mở file Google Sheet "Tính tiền hàng tháng", chọn **Tiện ích mở rộng → Apps Script**.
2. Xóa nội dung mặc định, dán toàn bộ `apps-script/Code.gs`, bấm Lưu.
3. **Cài đặt dự án (biểu tượng bánh răng) → Thuộc tính tập lệnh → Thêm**: khóa `SECRET`, giá trị là một chuỗi bí mật tự đặt (dài, khó đoán).
4. Chọn hàm `setup` rồi bấm **Chạy** một lần và cấp quyền. Hàm này tạo 2 sheet `ChiTieuApp` và `PhanLoaiApp`.
5. **Triển khai → Tùy chọn triển khai mới → Ứng dụng web**:
   - Thực thi với tư cách: **Tôi**
   - Người có quyền truy cập: **Bất kỳ ai** (mã `SECRET` sẽ bảo vệ dữ liệu)
6. Sao chép **URL ứng dụng web** (dạng `https://script.google.com/macros/s/…/exec`).

> Khi sửa `Code.gs` sau này: **Triển khai → Quản lý triển khai → Chỉnh sửa → Phiên bản mới**, để giữ nguyên URL.

### 2. GitHub Pages
1. Tạo repo `ChiTieuHangNgay` trên tài khoản GitHub.
2. Đưa toàn bộ thư mục này lên nhánh `main`.
3. **Settings → Pages → Deploy from a branch → main / (root)**.
4. Trang sẽ ở `https://<tài-khoản>.github.io/ChiTieuHangNgay/`.

### 3. Lần đầu mở trang
1. Mở trang, vào tab **Cài đặt**, dán URL Web App và mã `SECRET`, bấm **Lưu & kiểm tra**.
2. Ở mục **Nạp dữ liệu ban đầu**, chọn file `seed-2026.json`. Nên làm trên máy tính. Nạp lại nhiều lần cũng không bị trùng.
3. Trên iPhone: mở bằng Safari, bấm **Chia sẻ → Thêm vào MH chính**.
   Sau đó trên iPhone chỉ cần nhập URL + SECRET, không phải nạp lại file.

## Cách dùng

- **Nhập**: chọn ngày, người, loại (Sinh hoạt / Phát sinh / Chung), gõ khoản chi và số tiền.
  - Gõ `30` sẽ hiểu là 30.000 đ.
  - Có nút tiền nhanh, và gợi ý các khoản hay dùng của từng người (bấm vào sẽ điền luôn số tiền lần trước).
  - Hạng mục được gợi ý tự động. Nếu bạn chọn hạng mục khác, trang **ghi nhớ** cho tên đó vào sheet `PhanLoaiApp`.
  - Bấm vào một khoản trong danh sách để sửa hoặc xóa.
- **Danh sách**: lọc theo tháng, người, hạng mục, hoặc tìm theo tên. Có tổng theo ngày.
- **Tổng hợp**: theo năm hoặc tháng, cả nhà hoặc từng người. Có tổng chi, bình quân, theo hạng mục, theo người, theo tháng/ngày và các khoản lớn nhất. Bấm vào một thanh để xem chi tiết.
- **Mất mạng**: khoản chi vẫn lưu trên máy (hiện chữ "chờ gửi") và tự gửi lên Sheet khi có mạng.
- **Xuất CSV** ở tab Cài đặt.

## Quy tắc phân loại

Hạng mục được tính theo nội dung khoản chi, không theo cột. Thứ tự ưu tiên:
1. Khoản bắt đầu bằng "cháo" của **Putin** hoặc **Út** → *Ăn uống – Putin & Út*.
2. Bảng `PhanLoaiApp` (411 tên từ sổ 2026 và những tên bạn chỉnh tay sau này).
3. Từ điển trong `classifier.js`.
4. Món ăn sáng: các họ món ở cột Sinh hoạt của Chồng (cháo, phở, bún, miến, riêu, lươn, súp lươn, bánh mỳ, bánh bèo, cơm tấm, áp chảo, sốt vang, lòng cá, mỳ tôm) → *Ăn sáng*.
5. Quy tắc theo từ khóa (khám/thuốc → Y tế, học/sách → Giáo dục, nhậu/bia → Nhậu…). Không khớp quy tắc nào thì là *Chưa rõ*.

Cấu trúc sheet `ChiTieuApp`: `id, ngay, thang, nguoi, loai, ten, tien, hangmuc, ghichu, nguon, capnhat`.
Dữ liệu sổ cũ có `ngay` để trống, `nguon = sheet-2026`, và `ghichu` ghi vị trí ô gốc.
