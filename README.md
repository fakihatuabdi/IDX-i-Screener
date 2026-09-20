# Watchlist IHSG

Dashboard watchlist IHSG yang update otomatis jam 19:00 WIB tiap hari kecuali Sabtu, setelah bursa tutup. Minggu malam sengaja tetap jalan sebagai laporan persiapan Senin, memakai data closing Jumat (bursa memang tidak buka Sabtu/Minggu, jadi tidak ada data baru di hari itu - `trading_date` di dashboard selalu jujur menunjukkan tanggal sesi bursa yang sebenarnya, bukan tanggal script-nya dijalankan). Tanpa Netlify, tanpa server, tanpa biaya bulanan — semuanya jalan di GitHub (Actions + Pages).

## Arsitektur

- **GitHub Actions** (`.github/workflows/daily-update.yml`) — jalan otomatis jam 19:00 WIB tiap hari kecuali Sabtu (cron `0 12 * * 0-5`, UTC). Ambil data dari Zapi (TradingView + IDX resmi, termasuk broker summary, fundamentals, berita, corporate action), hitung semua indikator teknikal secara deterministik, panggil Claude API hanya untuk menulis narasi teks, lalu **commit hasilnya langsung ke repo** sebagai file JSON (`docs/data/latest.json` + `docs/data/track-record.json` untuk win rate).
- **GitHub Pages** — meng-host `docs/index.html` (dashboard statis) yang fetch `docs/data/latest.json` langsung sebagai file, tanpa API/server sama sekali.
- **`lib/`** — logic inti (pipeline, indikator, klien Zapi, klien Claude), dipakai oleh `scripts/run-pipeline.mjs`.

Prinsip yang tetap dipertahankan: data fundamental tidak pernah dipakai untuk screening/ranking Scalping & Swing (hanya latar belakang di kartu saham); Investment strategy secara eksplisit mempertimbangkan fundamental (PER/PBV/Dividend Yield/DER/ROE) untuk ranking & narasinya. Semua angka (harga, verdict, indikator) dihitung dari data asli — Claude API cuma menulis kalimat, tidak pernah mengarang angka. Kalau satu sumber data gagal/kena limit, kode skip sumber itu saja dan lanjut pakai data lain (tidak membatalkan seluruh update).

## Ketahanan terhadap gangguan provider data (primary/secondary/watchdog)

Endpoint IDX resmi (`finance:idx/index-summary`, `foreign-flow`, `broker-summary`) pernah down berjam-jam (real, bukan simulasi - terverifikasi lewat pengujian langsung). Desainnya berlapis:

1. **Primary (IDX)** dicoba dulu, tiap call retry singkat maks 3x (`lib/pipeline.mjs` `withRetry`, jeda hitungan detik - bukan menit).
2. Kalau primary gagal setelah itu, **fallback ke secondary (Pluang)** di run yang sama - tapi formulanya disesuaikan, bukan sekadar tempel data:
   - Level IHSG: dari chart harian TradingView (Pluang sendiri tidak punya data index/composite - sudah dicek langsung ke 31 endpoint mereka, tidak ada).
   - Ranking net asing: estimasi dari broker yang diklasifikasikan asing (`brokers?type=FOREIGN`) dikombinasikan dengan broker-summary per saham dari Pluang - bukan angka resmi yang identik, tapi real, bukan karangan.
   - Broker paling aktif: agregat dari scan broker-summary Pluang yang sama.
3. Kalau secondary **juga** gagal untuk suatu data, dashboard menampilkan banner jujur **"Data gagal dimuat"** (bukan diam-diam pakai data lama/kosong).
4. **Recovery Watchdog** (`.github/workflows/recovery-watchdog.yml`) jalan tiap jam, closed-loop: cek status data terakhir (`data_health` di `latest.json`) → kalau sudah sehat, skip (hemat kuota); kalau tidak, probe murah (1 call) ke IDX → baru jalankan pipeline penuh kalau primary kelihatan sudah pulih ATAU status masih "gagal total". Begitu primary pulih, run berikutnya otomatis kembali pakai data resmi tanpa menunggu jadwal harian berikutnya.

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

Sudah otomatis aktif dari `cron: "0 12 * * 0-5"` di workflow file — tidak perlu setting tambahan. GitHub Actions akan menjalankannya sendiri jam 19:00 WIB tiap hari kecuali Sabtu (termasuk Minggu malam, sebagai laporan persiapan Senin dari data closing Jumat), commit hasilnya ke `docs/data/`, dan GitHub Pages otomatis menyajikan versi terbaru itu.

Anda bisa lihat riwayat semua run (otomatis maupun manual) di tab **Actions** kapan saja.

## Kuota API (Zapi Pro)

Kuota akun (dicek langsung dari header response API): **2.000 call/menit**, **25.000 call/bulan**.

Sekali jalan (baik otomatis maupun manual), pipeline memakai sekitar:
- Screener 500 saham (1 call) + foreign-flow 4 halaman (4 call) + chart harian IHSG 6 bulan (1 call) + index summary (1 call).
- Shortlist 20 saham (10 Buy + 5 Hold + 5 Sell), masing-masing: chart harian 300 hari, rating teknikal TradingView, data fundamental, dan broker summary per-saham dari Pluang untuk konsentrasi top-3 buyer (20 x 4 = 80 call).
- Broker summary top 10 aktif market-wide (1 call, endpoint IDX ini tidak punya dimensi per-saham) + top buy pick asli per broker dari Pluang, discan dari 250 saham paling aktif hari itu (250 call) - murni info pasar, tidak terkait rekomendasi Buy/Sell kita. Berita bursa (1 call), corporate action untuk 10 saham Buy (10 call), dan Fear & Greed Index saham AS + crypto (2 call).
- Total sekitar 1 + 4 + 1 + 1 + 80 + 1 + 250 + 1 + 10 + 2 = ~351 call/run. Dijalankan ~26x/bulan (tiap hari kecuali Sabtu) = ~9.130 call/bulan — masih menyisakan ruang besar dari kuota 25.000/bulan untuk manual re-run atau retry.

## Metodologi analisis per strategi

Verdict Swing/Investment mengikuti kerangka referensi "Kerangka Analisis Saham: Scalping, Swing, dan Investasi" (13 Sep 2026) - skor konfluensi (hitung berapa sinyal riil independen yang searah, bukan 1 indikator saja), sisi bullish & bearish dihitung terpisah supaya sinyal yang benar-benar bertentangan jatuh ke Hold, dan fundamental 100% dikeluarkan dari skor Swing tapi jadi faktor terbesar di Investment. Yang sudah diimplementasikan dengan data real: SMA20/50 (Swing) cross, RSI(14), RVOL&ge;2x sebagai syarat validitas breakout, MACD(12,26,9), ADX/+DI/-DI (Wilder, dihitung sendiri dari OHLC), OBV untuk konfirmasi volume, konsentrasi top-3 broker pembeli dari Pluang (>=60% = akumulasi kuat), RSI & ADX mingguan khusus Investment, dan rating TradingView + rasio fundamental (ROE/PBV/DER/dividend yield/PEG). "Success Rate %" di tiap kartu dihitung langsung dari skor konfluensi yang sama (bukan angka terpisah), diskalakan ke 50-90%.

**Scalping** sejak 2026-09-20 tidak lagi bagian dari update harian jam 19:00 WIB - diganti scan **real-time tiap 5 menit selama jam bursa** (09:00-15:50 WIB, Senin-Jumat) memakai data intraday Pluang (`lib/scalping.mjs`, `scripts/scalping-scan.mjs`, `.github/workflows/scalping-scan.yml`): VWAP sesi dari candle 5 menit riil, Micro EMA3/5/9, RSI(7), Order Book Dynamics (rasio bid/ask riil dari order book), Tape Reading/HAKA (dari running-trades riil, tag BUY/SELL asli), dan volume breakout terarah. Verdict-nya pakai matriks hitung sinyal generik persis dokumen referensi "Buku Putih Logika Aplikasi Trading" (Bullish&ge;4 & Bearish=0 &rarr; Strong Buy, dst) - deliberately BEDA dari skor berbobot Swing/Investment di atas, karena ini modul baru tanpa perilaku live lama yang perlu dijaga kompatibel (lihat `ROADMAP.md` §1.4/§3.3 untuk keputusan verdict matrix Swing/Investment yang masih menunggu approval terpisah). Universe: 250 saham teraktif (di-screening murah tiap siklus lewat Multi Quote batch), 30 saham paling bergerak di-deep-scan penuh (order book + tape reading) - desain dua tingkat ini dijelaskan lengkap di `ROADMAP.md` §3.4 termasuk perhitungan kuota API-nya.

**Entry/Target/Stop Loss** tidak lagi persentase flat dari harga close. Setiap saham Buy/Strong Buy sekarang punya **Target 1** (reward:risk pertama) dan **Target 2** (objektif lanjutan setelah Target 1 tercapai - dipakai level struktural riil lebih jauh seperti resistance/support 52 minggu kalau memang ada di antara Target 1 dan proyeksi reward:risk yang diperluas, kalau tidak ada baru pakai proyeksi reward:risk yang lebih lebar), berlaku juga untuk Sell/Strong Sell dan Hold (arah kebalikan/simetris).

Entry Scalping & Swing berupa **rentang harga (zona akumulasi)**, dan TIDAK dibatasi maksimal harga close hari ini lagi - dipilih dari 4 skenario teknikal klasik sesuai kondisi riil saham itu (urutan prioritas): (1) **breakout confirmed** - harga sudah tutup di atas resistance 20D/50D hari ini, entry di sekitar harga close saat ini; (2) **anticipatory breakout** - harga mendekati resistance tapi belum tembus, entry berupa **buy-stop zone DI ATAS harga close** (persis di level resistance sampai buffer konfirmasi kecil) - baru dieksekusi kalau levelnya benar-benar tembus; (3) **pullback** - ada support riil (EMA9/SMA20) di bawah harga, entry dari support itu sampai harga close (beli saat koreksi); (4) fallback: zona sempit tepat di bawah close kalau tidak ada struktur relevan. Stop loss di-set di bawah **seluruh zona** (melindungi entry manapun di dalam rentang), sejauh ATR(14) saham itu sendiri, digeser sedikit melewati support/resistance riil terdekat kalau levelnya lebih ketat dari stop berbasis ATR.

Entry Investment diganti total jadi **Max Buy** - satu harga batas atas yang dipimpin oleh **valuasi fundamental riil**, bukan level teknikal: dihitung dari **Graham Number** (`sqrt(22.5 x EPS x BVPS)`, formula klasik Benjamin Graham; EPS & BVPS diturunkan dari PER/PBV riil saham itu, bukan dikarang, dan hanya dihitung kalau perusahaan benar-benar profitable dengan ekuitas positif), lalu diberi **margin of safety** dasar 15% yang disesuaikan naik/turun oleh faktor riil lain: DER tinggi & ROE lemah memperlebar margin (butuh diskon lebih besar), sementara tren mingguan (ADX/DI) yang kuat, volume (RVOL) tinggi, konsentrasi broker pembeli >=60%, dan corporate action riil yang akan datang (dividen dsb) mempersempit margin (sinyal sudah saling mendukung). Kalau data PER/PBV tidak tersedia (mis. perusahaan rugi), tidak ada angka fundamental yang dikarang - Max Buy jatuh ke harga close hari ini sebagai batas teknikal murni.

Untuk verdict **Sell/Strong Sell dan Hold** (semua strategi), tidak ada Entry/Max Buy sama sekali - hanya Target 1, Target 2, dan Stop Loss (Sell = aksi sekarang di harga close riil, Hold = bukan taruhan arah), semuanya tetap dihitung dari ATR riil saham itu, bukan persentase tetap. Setiap kartu saham juga menampilkan **Harga Terakhir (Close)** terpisah, supaya selalu jelas bedanya harga pasar riil sekarang vs zona entry/Max Buy yang direkomendasikan.

**Catalyst** (narasi per saham) ditulis Claude dalam bahasa manusia yang natural - dilarang menyalin nama field mentah (`lastClose`, `prior20High`, dst) langsung ke kalimat, harus diterjemahkan ke istilah awam (mis. "resistance 20 hari terakhir"). Kondisi **volume transaksi (RVOL)** wajib disebutkan sebagai salah satu faktor analisis di tiap catalyst - volume di atas rata-rata memperkuat keyakinan sinyal, volume tipis jadi catatan bahwa sinyalnya masih perlu konfirmasi lebih lanjut.

## Data fundamental historis (scraper terpisah)

`scrapers/idx-fundamentals/` (Python, milik sendiri) menarik laporan keuangan kuartalan riil per saham - EPS, BVPS, ROE, ROA, Net Profit Margin, current ratio, debt-to-equity riil, free cash flow, dan pertumbuhan revenue/laba/EPS YoY (semua dihitung per kuartal dari angka laporan asli), plus PER/PBV/dividend yield/**PEG Ratio** sebagai snapshot valuasi saat ini (bukan historis per kuartal, karena butuh harga saham hari ini) - dipakai `lib/pipeline.mjs` untuk Max Buy Investment yang lebih akurat. PEG (`PER ÷ EPS Growth YoY riil`) sengaja dipilih ketimbang DCF sebagai pelengkap valuasi - murni dari data historis yang sudah teramati, tanpa asumsi pertumbuhan/discount rate masa depan (lihat `ROADMAP.md` §2.2 untuk alasan lengkapnya). PEG hanya dihitung kalau EPS Growth YoY-nya positif (konvensi standar rasio ini). Awalnya didesain menarik langsung dari arsip XBRL resmi idx.co.id, tapi situs itu berada di balik proteksi Cloudflare yang memblokir semua request otomatis (terverifikasi langsung: bahkan `cloudscraper` dari jaringan rumah biasa tetap kena halaman "Just a moment..."). Sumbernya diganti ke **Yahoo Finance** (`yfinance`, dengan suffix `.JK`) - datanya tetap angka laporan keuangan resmi emiten yang sama, hanya saluran pengambilannya berbeda - dengan konsekuensi cakupan histori lebih pendek (~5-6 kuartal terakhir, bukan multi-tahun). Dijalankan lewat `.github/workflows/fundamental-scraper.yml`, terpisah total dari update harian jam 19:00 WIB - otomatis 2x sebulan (tanggal 8 dan 22, mewakili minggu ke-2 dan minggu ke-4), plus bisa dipicu manual kapan saja. Watchlist-nya (`scrapers/idx-fundamentals/data/watchlist.csv`) ditulis ulang otomatis oleh update harian dari data screener Zapi yang real (hingga ~500 saham teraktif), bukan daftar statis.

**Mata uang USD vs IDR**: beberapa emiten IDX (kebanyakan sektor tambang/energi, mis. ADRO/INCO/ITMG) melaporkan keuangannya dalam USD karena itu memang mata uang fungsionalnya - sempat ada bug nyata di mana angka USD ini tertampil seolah-olah Rupiah (selisih ~15.000x). Sekarang dideteksi lewat metadata `financialCurrency` dari yfinance dan **dibiarkan apa adanya dalam mata uang aslinya** (tidak dikonversi ke Rupiah) - setiap baris kuartal menyimpan `currency`-nya sendiri ("USD" atau "IDR"), tabel di dashboard menampilkan simbol yang sesuai ($ atau Rp) dan badge mata uang eksplisit per baris, jadi tidak pernah tercampur/salah label. `lib/pipeline.mjs` juga menghormati ini - EPS/BVPS dari saham USD-reporter TIDAK dipakai untuk Max Buy (Graham Number, yang selalu dalam skala harga IDR karena harga saham IDX selalu dikutip dalam Rupiah), otomatis fallback ke pendekatan PER/PBV biasa untuk saham-saham itu, supaya tidak pernah mencampur mata uang dalam satu perhitungan. PER/PBV bawaan yfinance sendiri juga sempat terbukti tidak masuk akal untuk emiten pelapor USD (PBV ADRO pernah terbaca ~16.500x, kemungkinan bug internal Yahoo membagi harga IDR dengan book value USD) - sekarang difilter pakai rentang kewajaran, angka yang jelas tidak masuk akal di-null-kan daripada ditampilkan seolah valid.

Beberapa faktor di dokumen referensi **sengaja tidak diimplementasikan** karena tidak ada sumber data real yang tersedia lewat Zapi: tren kepemilikan asing/institusi KSEI per kuartal (dipakai proxy kasar dari konsentrasi broker harian, bukan data KSEI asli), analisis makro/sektor top-down, penilaian kualitatif moat/manajemen/tata kelola, dan valuasi intrinsik (DCF). Tidak pernah dikarang - kalau datanya tidak ada, faktornya cuma dilewati.

## Win rate

Setiap rekomendasi Buy/Sell (bukan Hold) dicatat dengan **harga close riil saat direkomendasikan** (`last_price`, bukan `entry` - karena entry sekarang bisa berupa target pullback/bounce yang belum tentu ter-fill, jadi tidak adil dipakai sebagai harga acuan win-rate). Di run berikutnya, harga sungguhan (dari screener asli) dicek terhadap catatan itu untuk menentukan benar/salah — ini angka real yang bisa diverifikasi, bukan estimasi. Disimpan di `docs/data/track-record.json`, mulai dilacak sejak **14 September 2026** (bukan sejak awal, biar adil - tidak diseed data lama yang tidak lengkap). Field "Success Rate %" di kartu saham Buy/Strong Buy itu BEDA - itu skor keyakinan dari sinyal teknikal/fundamental saat ini (transparan, dibatasi 50-90%), bukan win rate historisnya.

## Catatan: kenapa pindah dari Netlify

Sempat dicoba pakai Netlify Functions (Scheduled Function + Background Function untuk trigger manual), tapi Background Function ternyata tidak benar-benar berjalan di akun yang dipakai (terbukti lewat pengujian langsung: bahkan operasi paling sederhana pun tidak pernah selesai dieksekusi meski selalu membalas "202 Accepted"), sementara pipeline penuh butuh waktu lebih dari 40 detik sehingga tidak muat di batas waktu function biasa. GitHub Actions tidak punya batasan seperti ini (limitnya jam, bukan detik) dan gratis untuk kebutuhan ini, jadi datanya sekarang disimpan sebagai file statis di repo, bukan lewat database/serverless function.
