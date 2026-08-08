# NTS Logo Studio Web V2 Batch — Fix Report

## Lỗi gốc đã xác định
- V1 chỉ có `selectedId`: một ảnh dùng cho preview, không có tập ảnh được chọn để batch.
- Nút `Xuất ảnh hiện tại` chỉ render/download một file.
- `Áp dụng tất cả` ở V1 chỉ đổi UI/toast, chưa ghi snapshot cấu hình vào từng ảnh.

## Đã sửa
- Checkbox chọn từng ảnh.
- Ảnh mới thêm được chọn để xuất mặc định.
- Chọn tất cả / Bỏ chọn.
- Bộ đếm số ảnh đã chọn.
- Mỗi ảnh có `settings`, `selected`, `status`, `error`.
- Chỉnh slider lưu thật vào ảnh đang preview.
- Áp dụng ảnh đã chọn: copy snapshot cấu hình thật.
- Áp dụng tất cả: copy snapshot cấu hình thật cho toàn thư viện.
- Xuất ảnh đã chọn / Xuất tất cả / Xuất ảnh hiện tại.
- Chrome/Edge: File System Access API, xử lý tuần tự và ghi từng file vào thư mục.
- Trình duyệt khác: ZIP fallback bằng JSZip, có giới hạn dung lượng an toàn.
- Batch chạy tuần tự, `ImageBitmap` được close sau mỗi ảnh để hạn chế RAM.
- Giới hạn megapixel dựa trên `navigator.deviceMemory`.
- Trạng thái từng ảnh: ready / processing / done / error / cancelled.
- Progress bar + HUD + nút dừng sau ảnh hiện tại.
- Tên file trùng được tự đổi `_2`, `_3`, ...
- JPEG/WebP giữ định dạng tương ứng; loại khác xuất PNG.

## Kiểm tra tĩnh
- `node --check js/app.js`: PASS
- `node --check js/auth.js`: PASS
- `node --check js/reset-password.js`: PASS
- Kiểm tra toàn bộ DOM id mà app.js tham chiếu: không thiếu ID.

## Lưu ý kiến trúc
Batch cục bộ này phù hợp lô vừa/nhỏ. Với hàng trăm ảnh full-resolution, nhiều người dùng đồng thời, lưu lịch sử cloud hoặc ZIP rất lớn, nên chuyển batch engine sang FastAPI/backend worker.
