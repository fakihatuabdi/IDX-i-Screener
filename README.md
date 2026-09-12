# Watchlist IHSG - Netlify

Dashboard watchlist IHSG yang update otomatis setiap hari jam 08:00 WIB, tanpa perlu trigger manual. Backend berjalan sebagai Netlify Scheduled Function, data disimpan di Netlify Blobs, dan frontend (`public/index.html`) membacanya lewat endpoint `/api/dashboard`.

## Arsitektur singkat

- `netlify/functions/daily-update.mjs` - Scheduled Function, jalan otomatis tiap `01:00 UTC` (= `08:00 WIB`). Ambil data dari Zapi (TradingView + IDX resmi) dan arjum.com (broker summary), hitung semua indikator teknikal secara deterministik, lalu panggil Claude API hanya untuk menulis narasi teks. Hasilnya disimpan ke Netlify Blobs.
- `netlify/functions/get-dashboard.mjs` - Function biasa yang dibaca frontend, isinya cuma membaca data terakhir dari Blobs.
- `public/index.html` - dashboard statis, fetch `/api/dashboard` saat dibuka dan setiap 60 detik.

Prinsip yang dipertahankan dari versi Artifact sebelumnya: data fundamental tidak pernah dipakai untuk screening/ranking (hanya latar belakang), semua angka (harga, verdict, indikator) dihitung dari data asli - Claude API cuma menulis kalimat, tidak pernah mengarang angka. Kalau satu sumber data gagal/kena limit, kode akan skip sumber itu saja dan lanjut pakai data lain (tidak membatalkan seluruh update).

## Setup - langkah demi langkah

### 1. Dapatkan Anthropic API key (berbayar, terpisah dari Claude Code)

1. Buka https://console.anthropic.com dan login/daftar.
2. Menu **API Keys** -> **Create Key**. Simpan key ini (`sk-ant-...`) di tempat aman (password manager) - JANGAN ditulis di file ini atau file apa pun di folder project. Key hanya boleh dimasukkan lewat env var Netlify di langkah 4.
3. Isi saldo/billing secukupnya (dashboard ini murah - sekali panggil per hari, model default `claude-haiku-4-5-20251001`).

### 2. Push folder ini ke GitHub

Dari folder `C:\Users\LENOVO\ihsg-dashboard-netlify`:

```powershell
git init
git add .
git commit -m "Initial commit: IHSG dashboard Netlify pipeline"
```

Lalu buat repo baru (kosong) di https://github.com/new, misalnya `ihsg-dashboard`. Setelah itu:

```powershell
git remote add origin https://github.com/<username>/ihsg-dashboard.git
git branch -M main
git push -u origin main
```

Ganti `<username>` dan nama repo sesuai punya Anda. Repo boleh **private**, tidak masalah untuk Netlify.

### 3. Hubungkan repo ke Netlify

1. Login ke https://app.netlify.com (bisa pakai akun GitHub yang sama).
2. **Add new site -> Import an existing project -> Deploy with GitHub**.
3. Pilih repo `ihsg-dashboard` yang baru dibuat. Netlify otomatis mendeteksi `netlify.toml` (build settings sudah diatur di situ, tidak perlu diubah).
4. Klik **Deploy site**.

### 4. Set environment variables di Netlify

Di dashboard site Netlify: **Site configuration -> Environment variables -> Add a variable**. Tambahkan 4 ini:

| Key | Value |
|---|---|
| `ZAPI_KEY` | key Zapi Anda (`zpi_...`) |
| `ARJUM_KEY` | key arjum.com Anda |
| `ANTHROPIC_API_KEY` | key dari langkah 1 (`sk-ant-...`) |
| `ANTHROPIC_MODEL` | (opsional) default `claude-haiku-4-5-20251001`, bisa ganti `claude-sonnet-5` kalau mau narasi lebih kaya |

Setelah menambahkan env var, trigger **Deploy -> Trigger deploy -> Clear cache and deploy site** sekali supaya function membaca env var barunya.

### 5. Pastikan Scheduled Functions aktif

Netlify mendeteksi `daily-update.mjs` sebagai Scheduled Function otomatis dari kode `export default schedule("0 1 * * *", handler)` - tidak perlu setting tambahan. Anda bisa cek di tab **Functions** di dashboard Netlify, akan ada function `daily-update` dengan label "Scheduled".

### 6. Test manual sebelum menunggu jam 08:00

Jangan tunggu jadwal otomatis untuk verifikasi pertama kali. Buka:

```
https://<nama-site-anda>.netlify.app/api/run-update
```

di browser (atau `curl`). Ini menjalankan `run-update.mjs` - pipeline yang sama persis dengan update terjadwal, hanya saja bisa dipanggil langsung lewat HTTP (Netlify tidak mengizinkan Scheduled Function seperti `daily-update.mjs` dipanggil langsung dari luar). Kalau sukses akan balas JSON `{"ok":true,"trading_date":"..."}`. Cek juga tab **Logs -> Function logs** di Netlify kalau ada error (biasanya env var yang belum ke-set, atau salah satu API key expired/limit).

Setelah itu buka `https://<nama-site-anda>.netlify.app/` - dashboard akan tampil dengan data asli.

### 7. (Opsional) Custom domain / hosting InfinityFree lama

Hosting InfinityFree yang lama tidak dipakai lagi untuk jalur ini karena tidak punya cron/serverless function (PHP/MySQL murni). Kalau suatu saat mau memakai domain sendiri yang sudah dibeli, itu tetap bisa - tinggal arahkan domain tersebut ke Netlify lewat **Site configuration -> Domain management -> Add a domain**, hosting file/function-nya tetap di Netlify.

## Kuota API (Zapi Pro)

Dengan Zapi sudah di-upgrade ke Pro, pipeline sekarang menggunakan kuota lebih besar per hari:
- Screener 300 saham + foreign-flow 4 halaman (800 baris) sekali jalan - untuk sektor & ranking yang lebih representatif.
- Shortlist penuh 20 saham/hari (10 Buy + 5 Hold + 5 Sell, sesuai spesifikasi dashboard), masing-masing diambil chart 210 hari + rating teknikal TradingView asli (dipakai khusus untuk verdict strategi Investment).
- Total sekitar 300 + 4 + 1 + 1 + (20 x 2) = ~347 call/hari kalau dijalankan sekali sehari - jauh di bawah kuota bulanan Pro. Kalau suatu saat mau menambah shortlist atau menjalankan lebih dari sekali sehari, sesuaikan angka `SHORTLIST_BUY/HOLD/SELL` dan jumlah halaman foreign-flow di `daily-update.mjs`.
