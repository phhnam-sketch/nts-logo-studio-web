/*
  NTS Logo Studio Web V3.3 - CẤU HÌNH DỄ THAY ĐỔI

  1) SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY:
     Supabase Dashboard > Project Settings > API / Connect.
     Publishable/anon key được phép dùng ở frontend.
     TUYỆT ĐỐI KHÔNG đặt service_role / sb_secret / database password ở đây.

  2) ĐỔI LOGO / QR / ẢNH MẶC ĐỊNH / ẢNH LOGIN:
     - Ảnh login trái:  assets/login/login-hero.png
     - Logo:            assets/brand/logo.png
     - Avatar mặc định: assets/brand/avatar-default.png
     - Cover mặc định:  assets/brand/cover-default.png
     - QR thanh toán:   assets/payment/payment-qr.png
     Chỉ cần thay file cùng tên là website dùng ảnh mới.

  3) MÀU SẮC:
     Đổi BRAND.primary / BRAND.accent rồi đồng bộ CSS variables ở đầu assets/styles.css.
     V3 mặc định dùng Bordeaux đỏ đô.

  4) GIÁ/QUOTA THỰC TẾ:
     Dữ liệu chính thức nằm trong Supabase table public.site_settings.
     Các giá trị MEMBERSHIP dưới đây chỉ là fallback hiển thị khi database chưa tải xong.
*/
window.APP_CONFIG = {
  SUPABASE_URL: "https://jzmiqadildvtzdpldquw.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable___QvvAoa-1g7xxiPYXvFaw_r5vTMQ8Q",

  APP_NAME: "NTS Logo Studio Pro Web",
  APP_VERSION: "3.16.1",

  BRAND: {
    shortName: "NTS",
    studioName: "NAM TIÊN SINH STUDIO",
    primary: "#711A37",
    accent: "#A63255",
    logoUrl: "assets/brand/logo.png",
    defaultAvatarUrl: "assets/brand/avatar-default.png",
    defaultCoverUrl: "assets/brand/cover-default.png"
  },

  // LOGIN LEFT PANEL — chỉ cần thay assets/login/login-hero.png để dùng ảnh của bạn.
  // Có thể tinh chỉnh vị trí/cường độ mà không sửa HTML/CSS.
  LOGIN: {
    heroImageUrl: "assets/login/login-hero.png",
    heroPosition: "center center",
    heroSize: "contain",
    heroOpacity: 1,
    overlayOpacity: 0.70,
    eyebrow: "NTS UI",
    title: "NHÌN SANG PHẢI",
    subtitle: "Đăng nhập để quản lý phiên làm việc, sử dụng giao diện tối ưu cho desktop, tablet và mobile."
  },

  MEMBERSHIP: {
    freeMonthlyImages: 10,
    vipMonthlyPriceVnd: 200000,
    paymentQrUrl: "assets/payment/payment-qr.png",
    bankName: "THAY TÊN NGÂN HÀNG",
    accountName: "THAY TÊN CHỦ TÀI KHOẢN",
    accountNumber: "THAY SỐ TÀI KHOẢN",
    transferPrefix: "NTSVIP",
    supportText: "Liên hệ quản trị viên nếu thanh toán chưa được duyệt sau 24 giờ."
  }
};
