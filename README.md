# QU-N-L-ALL-GIAN-H-NG-TIKTOK

186 HOME - TikTok MultiShop (Quản lý nhiều gian hàng TikTok Shop bằng Chrome thật với profile riêng).

## Cài đặt & Chạy trên MacBook (macOS)

1. Cài đặt [Node.js LTS](https://nodejs.org/) và **Google Chrome**.
2. Mở **Terminal**, tải code về và cài đặt:
   ```bash
   git clone https://github.com/nguyentiendung38/QU-N-L-ALL-GIAN-H-NG-TIKTOK.git
   cd QU-N-L-ALL-GIAN-H-NG-TIKTOK
   npm install
   ```
3. Chạy trực tiếp:
   ```bash
   npm start
   ```
4. Đóng gói ra file cài đặt `.dmg` / `.zip` cho MacBook:
   ```bash
   npm run build:mac
   ```
   File `.dmg` sẽ nằm trong thư mục `dist/`.

## Cài đặt & Chạy trên Windows

```bash
npm install
npm start
```
Đóng gói bộ cài Windows:
```bash
npm run build:installer
npm run build:portable
```
