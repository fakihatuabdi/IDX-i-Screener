# Watchlist IHSG

Dashboard watchlist IHSG yang update otomatis tiap hari bursa (Senin-Jumat) jam 19:00 WIB, setelah bursa tutup. Tanpa Netlify, tanpa server, tanpa biaya bulanan — semuanya jalan di GitHub (Actions + Pages).

## Arsitektur

- **GitHub Actions** (`.github/workflows/daily-update.yml`) — jalan otomatis tiap hari bursa jam 19:00 WIB (cron `0 12 * * 1-5`, UTC). Ambil data dari Zapi (TradingView + IDX resmi, termasuk broker summary, fundamentals, berita, corporate action), hitung semua indikator teknikal secara deterministik, panggil Claude API hanya untuk menulis narasi teks, lalu **commit hasilnya langsung ke repo** sebagai file JSON (`docs/data/latest.json`).
- **GitHub Pages** — meng-host `docs/index.html` (dashboard statis) yang fetch `docs/data/latest.json` langsung sebagai file, tanpa API/server sama sekali.
- **`lib/`** — logic inti (pipeline, indikator, klien Zapi, klien Claude), dipakai oleh `scripts/run-pipeline.mjs`.

Prinsip yang tetap dipertahankan: data fundamental tidak pernah dipakai untuk screening/ranking Scalping & Swing (hanya latar belakang di kartu saham); Investment strategy secara eksplisit mempertimbangkan fundamental (PER/PBV/Dividend Yield/DER/ROE) untuk ranking & narasinya. Semua angka (harga, verdict, indikator) dihitung dari data asli — Claude API cuma menulis kalimat, tidak pernah mengarang angka. Kalau satu sumber data gagal/kena limit, kode skip sumber itu saja dan lanjut pakai data lain (tidak membatalkan seluruh update).

## Setup — langkah demi langkah

### 1. Tambahkan secrets di GitHub

Di repo GitHub Anda: **Settings -> Secrets and variables -> Actions -> New repository secret**. Tambahkan 2 ini:

| Name | Value |
|---|---|
| `ZAPI_KEY` | key Zapi Anda (`zpi_...`) |
| `ANTHROPIC_API_KEY` | key Anthropic Anda dari https://console.anthropic.com (`sk-ant-...`) — **JANGAN** pernah ditulis di file/kode, hanya lewat secret ini |

### 2. Aktifkan GitHub Pages

**Settings -> Pages**:
- Source: **Deploy from a branch**
- Branch: **main**, folder **/docs**
- Save

Setelah beberapa menit, situs Anda akan tersedia di `https://<username>.github.io/<nama-repo>/`.

### 3. Jalankan update pertama kali (manual)

Jangan tunggu jadwal otomatis untuk verifikasi pertama kali:
1. Buka tab **Actions** di repo GitHub Anda.
2. Klik workflow **"Daily IHSG Update"** di sidebar kiri.
3. Klik tombol **"Run workflow"** (dropdown di kanan) -> **Run workflow**.
4. Tunggu 1-3 menit, refresh halaman - akan ada centang hijau kalau berhasil.
5. Cek log-nya (klik run yang baru selesai) kalau ada error - error asli akan terlihat jelas di sini (beda dengan Netlify Functions yang sering menyembunyikan error).
6. Buka situs GitHub Pages Anda - dashboard akan tampil dengan data asli.

### 4. Jadwal otomatis

Sudah otomatis aktif dari `cron: "0 12 * * 1-5"` di workflow file — tidak perlu setting tambahan. GitHub Actions akan menjalankannya sendiri tiap hari bursa jam 19:00 WIB, commit hasilnya ke `docs/data/latest.json`, dan GitHub Pages otomatis menyajikan versi terbaru itu.

Anda bisa lihat riwayat semua run (otomatis maupun manual) di tab **Actions** kapan saja.

## Kuota API (Zapi Pro)

Sekali jalan (baik otomatis maupun manual), pipeline memakai:
- Screener 300 saham + foreign-flow 4 halaman (800 baris) + chart intraday IHSG.
- Shortlist 20 saham (10 Buy + 5 Hold + 5 Sell), masing-masing: chart harian 210 hari, chart intraday per jam, rating teknikal TradingView, dan data fundamental.
- Broker summary top 10 aktif untuk 1 saham unggulan, berita bursa, dan corporate action untuk 10 saham Buy.
- Total sekitar 300 + 4 + 1 + 1 + (20 x 3) + 1 + 1 + 10 = ~378 call/hari kalau dijalankan sekali sehari — jauh di bawah kuota bulanan Pro (~11.000+ call/bulan kalau jalan tiap hari bursa).

## Catatan: kenapa pindah dari Netlify

Sempat dicoba pakai Netlify Functions (Scheduled Function + Background Function untuk trigger manual), tapi Background Function ternyata tidak benar-benar berjalan di akun yang dipakai (terbukti lewat pengujian langsung: bahkan operasi paling sederhana pun tidak pernah selesai dieksekusi meski selalu membalas "202 Accepted"), sementara pipeline penuh butuh waktu lebih dari 40 detik sehingga tidak muat di batas waktu function biasa. GitHub Actions tidak punya batasan seperti ini (limitnya jam, bukan detik) dan gratis untuk kebutuhan ini, jadi datanya sekarang disimpan sebagai file statis di repo, bukan lewat database/serverless function.
