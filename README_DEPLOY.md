# NTS Logo Studio Pro Web V2 Batch

Frontend HTML/CSS/JavaScript responsive theo giao diện Bordeaux của bản desktop V7, tích hợp Supabase Auth thật và batch export cục bộ an toàn.

## Có sẵn

- Đăng nhập email + mật khẩu
- Đăng ký tài khoản + tên hiển thị
- Xác minh email theo cấu hình Supabase
- Giữ phiên đăng nhập / tự refresh token
- Quên mật khẩu + trang đặt mật khẩu mới
- Google OAuth (sau khi bật provider trong Supabase)
- Đăng xuất
- Toast notification
- Dashboard responsive desktop/tablet/mobile
- Thêm nhiều ảnh vào thư viện local
- Chọn logo
- 9 vị trí watermark
- Opacity / Size / Padding / X / Y / Rotation
- Before/After split slider
- Preview tối ưu: chỉ decode ảnh đang xem, debounce slider, giới hạn DPR preview
- Xuất ảnh hiện tại ngay trong browser
- Chọn nhiều ảnh / Chọn tất cả / Bỏ chọn
- Batch export ảnh đã chọn hoặc toàn bộ thư viện
- Chrome/Edge ghi tuần tự trực tiếp vào thư mục để giảm RAM
- Trình duyệt khác tự đóng ZIP với giới hạn an toàn
- Trạng thái từng ảnh + tiến trình + dừng batch an toàn
- Không tự upload ảnh lên server

> V2 đã có batch export cục bộ an toàn cho lô vừa/nhỏ. Với hàng trăm ảnh full-resolution hoặc workflow nhiều người dùng, backend FastAPI vẫn là bước production tiếp theo.

---

## 1. Tạo Supabase project

1. Vào Supabase Dashboard và tạo project mới.
2. Mở **Project Settings > API**.
3. Sao chép:
   - Project URL
   - Publishable key (hoặc anon key nếu dashboard của bạn vẫn hiển thị tên cũ)
4. Mở `js/config.js` và thay:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_ID.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR_SUPABASE_PUBLISHABLE_KEY",
  APP_NAME: "NTS Logo Studio Pro Web"
};
```

### Quan trọng về bảo mật

Publishable/anon key được thiết kế để dùng trong frontend. **Không bao giờ** đưa `service_role` key vào HTML, JavaScript, GitHub public repo hoặc Cloudflare Pages.

---

## 2. Cấu hình Auth

Trong Supabase Dashboard:

### Email / Password

- Authentication > Providers > Email
- Bật Email provider.
- Có thể giữ "Confirm email" để tài khoản phải xác minh email trước khi đăng nhập.

### URL Configuration

Khi chưa deploy, bạn có thể test bằng local server, ví dụ:

- Site URL: `http://localhost:5500`
- Redirect URL: `http://localhost:5500/**`

Sau khi deploy Cloudflare Pages, đổi/add:

- Site URL: `https://TEN-DU-AN.pages.dev`
- Redirect URLs:
  - `https://TEN-DU-AN.pages.dev/`
  - `https://TEN-DU-AN.pages.dev/reset-password.html`

### Google Login (tùy chọn)

- Authentication > Providers > Google
- Tạo OAuth Client trong Google Cloud
- Điền Client ID và Client Secret vào Supabase
- Cấu hình Authorized Redirect URI theo URI Supabase hiển thị trong phần Google provider.

Nếu chưa bật Google provider, email/password vẫn hoạt động bình thường.

---

## 3. Test local

Không mở `index.html` trực tiếp bằng `file://` vì OAuth/reset URL sẽ không hoạt động đúng.

Nếu có Python:

```bash
cd NTS_Logo_Studio_Web_V2_Batch
python -m http.server 5500
```

Mở:

```text
http://localhost:5500
```

---

## 4. Deploy miễn phí lên Cloudflare Pages

### Cách A — GitHub (khuyên dùng)

1. Tạo GitHub repository.
2. Upload toàn bộ thư mục này lên repo.
3. Cloudflare Dashboard > Workers & Pages > Create > Pages > Connect to Git.
4. Chọn repository.
5. Vì app là HTML/CSS/JS thuần:
   - Framework preset: None
   - Build command: để trống
   - Build output directory: `/` hoặc thư mục chứa `index.html` tùy cấu trúc repo
6. Deploy.

Cloudflare sẽ cấp URL dạng:

```text
https://nts-logo-studio.pages.dev
```

### Cách B — Direct Upload

Cloudflare Pages cũng hỗ trợ upload trực tiếp static assets. Chọn Direct Upload và upload toàn bộ nội dung thư mục web.

---

## 5. Tên miền

`*.pages.dev` là subdomain miễn phí do Cloudflare cấp và có HTTPS.

Nếu bạn đã sở hữu domain riêng như `ntslogo.com`, Cloudflare Pages cho phép gắn custom domain. Một tên miền cấp cao `.com/.net/.vn` thực sự thường không miễn phí lâu dài; đừng dựa vào các dịch vụ "free domain" không ổn định cho phần mềm dùng lâu dài.

---

## 6. Kiến trúc khuyến nghị khi nối toàn bộ app desktop sang web

```text
Browser
├── HTML/CSS/JS responsive
├── Supabase Auth
├── Preview nhẹ bằng Canvas
└── Upload job khi cần batch nặng
        ↓
Python API (FastAPI)
├── Pillow/image pipeline từ V7
├── Worker queue
├── giới hạn RAM/CPU
└── trả ZIP / file kết quả
        ↓
Object Storage
└── file tạm có TTL
```

Lý do: ảnh full-resolution hàng loạt có thể làm trình duyệt hết RAM. Preview nên ở client, batch nặng nên sang worker/backend.

---

## 7. Cấu trúc file

```text
NTS_Logo_Studio_Web_V2_Batch/
├── index.html
├── reset-password.html
├── _headers
├── README_DEPLOY.md
├── assets/
│   ├── styles.css
│   ├── reset.css
│   └── favicon.svg
└── js/
    ├── config.js
    ├── auth.js
    ├── app.js
    └── reset-password.js
```

## 8. Bước tiếp theo

Nên port phần xử lý ảnh Python V7 thành **FastAPI image engine** thay vì cố chạy Tkinter trên server. Frontend hiện tại đã chừa kiến trúc để nối API batch, cloud project, preset theo user và lịch sử export.
