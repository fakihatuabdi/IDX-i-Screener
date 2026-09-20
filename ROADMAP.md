# Roadmap Jangka Panjang: Algorithmic Trading System & Machine Learning

Dokumen ini memetakan 3 spesifikasi referensi yang diberikan (`Spesifikasi Algorithmic Trading & ML.pdf`, `Buku Putih Logika Aplikasi Trading.pdf`, `Arsitektur Data & ML Roadmap.pdf`) ke kondisi nyata proyek ini: apa yang sudah cocok, apa yang perlu ditambah, apa yang sengaja diadaptasi, dan kenapa. Prinsip yang tidak berubah dari awal proyek: **tidak pernah mengarang data** — kalau sumber data real tidak tersedia, faktornya dilewati dan didokumentasikan sebagai gap, bukan diisi tebakan.

Status per 2026-09-20. Tiga keputusan arsitektur besar sudah dikonfirmasi bersama user sebelum roadmap ini ditulis (lihat "Keputusan Arsitektur" di bawah).

---

## 1. Gap Analysis: Dokumen Referensi vs Implementasi Saat Ini

### 1.1. Modul Investment (`lib/pipeline.mjs` — `investmentScore`, `computeInvestmentLevels`)

| Parameter dokumen | Status | Catatan |
|---|---|---|
| ROE >= 15% | ✅ Ada (`f.roe`, dari Zapi financials) | |
| DER <= 1.0 (kecuali bank) | ✅ Ada (`f.debt_to_equity`) | Pengecualian bank belum eksplisit di kode — lihat §3.3 |
| PER < 15, PBV < 1.5 | ✅ Ada (`f.pe_ttm`, `f.pb_ratio`, dan versi historis dari scraper) | |
| EPS Growth YoY >= 10% | ✅ Ada (`hist.net_income_growth_yoy`), akan dilengkapi `eps_growth_yoy` murni | |
| Dividend Yield >= 5% | ✅ Ada (`f.dividend_yield`) | |
| FCF positif & bertumbuh 3 tahun | ⚠️ Parsial — FCF per kuartal ada (`hist.free_cash_flow`), tapi histori scraper cuma ~5-6 kuartal (batas gratis Yahoo Finance), bukan 3 tahun penuh | Gap jujur, didokumentasikan di README |
| PEG Ratio <= 1.0 | ✅ **Selesai (2026-09-20)** - data sudah ada sejak §3.1, sekarang benar-benar dipakai untuk scoring: `fundamentalScore` di `lib/pipeline.mjs` menambah skor kalau PEG<1 (murah relatif ke pertumbuhan riilnya), mengurangi kalau PEG>2 | Sebelumnya cuma tampil di tabel Fundamental Historis, belum memengaruhi ranking Investment - sekarang sudah |
| Fair Value: DCF | ✅ **Ditambahkan (2026-09-20)** - dikombinasikan (rata-rata) dengan Graham Number, bukan menggantikannya - lihat §2.2 untuk rincian input real vs asumsi terbuka | `lib/pipeline.mjs` `computeDcfFairValue`, `computeCombinedFairValue` |
| TP2: PBV_Current > PBV_Historical_Avg x 2 | ✅ **Selesai (2026-09-20)** - `historicalPbvAvg` menghitung rata-rata PBV historis riil (harga penutupan riil di tanggal akhir tiap kuartal, dibagi BVPS riil kuartal itu - dari candle harian yang sudah difetch, tanpa call API tambahan), dikonversi jadi harga Target 2 riil: `2 x PBV_Historical_Avg x BVPS_sekarang` | `lib/pipeline.mjs` `historicalPbvAvg`, `computeInvestmentLevels` |
| SL: EPS_Growth_YoY<0 2 kuartal ATAU DER>2.0 → "jual paksa" | ✅ **Selesai (2026-09-20)** - `investmentVerdict` sekarang memaksa verdict minimal Sell/Strong Sell kalau salah satu kondisi ini terpenuhi, mengesampingkan skor berbobot yang mungkin masih positif - persis semantik "jual paksa" dokumen, bukan cuma info di Varian B eksperimental lagi | `lib/pipeline.mjs` `investmentVerdict` |
| TP1: `Price >= Fair_Value` | ✅ **Diperbaiki (2026-09-20)** - sebelumnya proyeksi reward:risk dari Max Buy (`Max Buy + 2,5x risiko`), sekarang literal Fair Value (Graham+DCF gabungan) itu sendiri, yang secara konstruksi selalu di atas Max Buy (Max Buy = Fair Value dikurangi margin of safety positif) | `computeInvestmentLevels` |
| ENTRY: `(SEMUA 6 Parameter==TRUE) AND (Price<Fair Value×0.7)` | ✅ **Ditambahkan sebagai info pembanding (2026-09-20)** - AND ketat 6 gerbang sekaligus, jauh lebih ketat dari skor berbobot yang tetap jadi verdict resmi (keputusan sadar bareng user - literal seperti ini bisa bikin tab Investment sering kosong di pasar riil) | `lib/pipeline.mjs` `investmentLiteralEntryVerdict`, badge "Alt" di kartu (cuma muncul kalau hasilnya "Buy") |
| KSEI institutional ownership trend | ❌ Tidak ada sumber data real | Gap permanen, didokumentasikan |
| Makro/sektor top-down, moat/manajemen kualitatif | ❌ Tidak ada sumber data real | Gap permanen, di luar scope otomatisasi |

### 1.2. Modul Swing (`swingScore`)

| Parameter dokumen | Status | Catatan |
|---|---|---|
| SMA20 > SMA50, Higher-High/Higher-Low | ✅ Ada | |
| RSI(14) - "area aman beli saat pullback" | ✅ **Selesai (2026-09-20)** - diselaraskan persis ke rentang 40-60 dari Buku Putih §3A (sebelumnya rentang 45-70) | `swingScore` di `lib/pipeline.mjs` |
| MACD(12,26,9) `crosses above` Signal_Line | ✅ **Diperbaiki (2026-09-20)** - sebelumnya cuma cek posisi statis "sedang di atas" (state), bukan event "baru saja menembus" (sama kategori bug dengan VWAP Scalping). Sekarang bandingkan MACD hari ini vs kemarin (`macdLinePrev`/`macdSignalPrev` dari `lib/indicators.mjs`, tanpa fetch baru) untuk deteksi cross yang jujur | `swingScore` (`macdCrossUp`/`macdCrossDown`) |
| Volume > 1.5x rata-rata 20 hari | ⚠️ Kode pakai ambang 2.0x (RVOL), bukan 1.5x | Dokumen baru bilang breakout perlu >1.5x, ambang lama 2.0x dipertahankan (lebih ketat, mengurangi false breakout) — tidak diubah tanpa alasan kuat |
| Fibonacci Retracement 0.618/0.5 | ✅ **Selesai (2026-09-20)** - dihitung dari `prior50High`/`prior50Low` riil, bullish kalau harga sedang di zona retracement 50%-61.8% | `swingScore` (`fibZone`) di `lib/pipeline.mjs` |
| Bandarmologi: `Net_Buy_Volume > Net_Sell_Volume (last 5 days)` | ✅ **Diperbaiki (2026-09-20)** - sebelumnya proxy top-3 concentration **1 hari**, sekarang literal: net lot beli vs jual riil dari 10 broker teratas selama ~5 hari bursa terakhir (`pluangBrokerSummary` dengan range tanggal - endpoint yang sama, cuma parameter beda). `broker_buy_concentration` (1 hari) TETAP dipertahankan terpisah untuk margin-of-safety Investment | `lib/pipeline.mjs` `broker_net_buy_5d`, `lib/zapi.mjs` `pluangBrokerSummary` |
| Price Structure: `Current_Low > Previous_Swing_Low` | ✅ **Diperbaiki (2026-09-20)** - sebelumnya pendekatan window 10 hari dibagi dua (kasar), sekarang deteksi pivot/swing low sungguhan (low sesi yang lebih rendah dari 3 sesi riil di kedua sisinya) | `lib/indicators.mjs` `findSwingLow`, `swingScore` (`priceStructureBull`) |
| Entry: `(Sentuh SMA50 OR Fib 0.618) AND Bandarmologi` | ✅ **Selesai (2026-09-20)** - anchor SMA50 ATAU Fibonacci 0.618 riil; gerbang AND Bandarmologi sekarang memakai metrik 5-hari literal di atas (bukan lagi proxy 1-hari) | `computeDirectionalLevels` (`bandarmologiOk`) |
| TP1 = Nearest Resistance Level | ✅ **Selesai (2026-09-20)** - dipakai literal (`prior50High`) saat resistance itu memang masih di depan harga (belum breakout); fallback ke proyeksi reward:risk kalau sudah breakout (tidak ada resistance terdekat lagi untuk disebut) | `computeDirectionalLevels` |
| TP2 = Fibonacci Extension 1.618 | ✅ **Selesai (2026-09-20)** - dihitung dari `prior50Low + (prior50High-prior50Low)*1.618`, dipakai kalau levelnya genuinely lebih jauh dari Target 1 | `computeDirectionalLevels` |
| TP2 "OR RSI_14>80" | ❌ Belum - baru relevan kalau saham sudah naik banyak SETELAH direkomendasikan (butuh pantau state lintas waktu), mirip kategori TP2/SL Scalping yang ditunda - sengaja belum dikerjakan |
| SL = `Close < Previous_Swing_Low` | ✅ **Diperbaiki (2026-09-20)** - sekarang memakai swing low pivot riil di atas (bukan lagi cuma level 50-hari yang lebih dalam/jauh) sebagai anchor snapping stop-loss, terpisah dari struktur Fibonacci yang tetap pakai rentang 50-hari penuh | `computeDirectionalLevels` (`swingLowPivot`) |

### 1.3. Modul Scalping (`scalpingScore`)

Ini gap terbesar. Kode saat ini (`ema9/ema21` harian, RSI7, ATR) adalah **pendekatan harian yang dipercepat**, bukan scalping sungguhan — karena sebelumnya tidak diketahui ada sumber data intraday real. Sekarang terkonfirmasi lewat referensi API Pluang bahwa data berikut **tersedia real**:

| Parameter dokumen | Sumber data real yang tersedia | Status |
|---|---|---|
| Tren mikro EMA 3/5/9 di chart 1 atau 3 menit | `finance:pluang/chart` — **hanya 5 menit**, bukan 1/3 menit (batas upstream) | ✅ Diimplementasikan dengan resolusi 5 menit (real, bukan 1 menit fiktif) |
| VWAP | Dihitung dari candle 5 menit real (`finance:pluang/chart`) — cumulative (typical price × volume) / cumulative volume sepanjang sesi | ✅ |
| Volume Breakout vs `MA_Vol_20` | ✅ **Selesai (2026-09-20)** - rata-rata 20 bar 5-menit sebelumnya (bukan lagi rata-rata seluruh sesi berjalan) | `scripts/scalping-scan.mjs` |
| RSI(7) rebound di 20 | Dihitung dari candle 5 menit, zona `<=25` (bukan deteksi event "baru saja menembus 20" — pendekatan zona statis, bukan cross-event) | ⚠️ Approksimasi, bukan literal |
| Order Book Dynamics (rasio Bid/Offer) | `finance:pluang/orderbook` — **real**, tapi cuma level harga terbaik (best bid/ask), bukan depth-of-book penuh | ✅ |
| Tape Reading (HAKA): `Offer_Eaten_Rate > Bid_Eaten_Rate` | ✅ **Diperbaiki (2026-09-20)** - sebelumnya salah pakai ambang 60/40, sekarang persis mayoritas sederhana (`buyLots > sellLots`) | `lib/scalping.mjs` `scalpingSignals` |
| ATR intraday > rata-rata 5 hari | ✅ **Selesai (2026-09-20)** - ATR(14) harian real (Wilder) dari 5 hari terakhir sebagai baseline, dibandingkan real range intraday sesi berjalan. Informasi konteks (badge "Volatilitas Tinggi/Normal"), bukan vote bull/bear ke-7 - dokumen sendiri memperlakukannya sebagai konfirmasi kondisi, bukan sinyal arah | `lib/scalping.mjs` `atrDailyBaseline`/`isAtrElevated` |
| Entry: `(VWAP) AND (Vol Breakout) AND (Tape Reading)` - AND ketat 3 syarat | ✅ **Selesai (2026-09-20, diperbaiki)** - awalnya salah dikategorikan sebagai "butuh arsitektur real-time"; setelah dipikir ulang, deteksi "crosses above VWAP" bisa dilakukan dalam arsitektur scan berkala yang ada (bandingkan posisi harga-vs-VWAP siklus ini vs siklus sebelumnya, di-cache seperti field lain). `primaryVerdict` di `lib/scalping.mjs` sekarang jadi verdict RESMI; matriks 6-sinyal jadi info pembanding sekunder (`verdict_b`, badge "Alt" di kartu - sama pola dengan Swing/Investment) | `lib/scalping.mjs` `primaryVerdict`, `scripts/scalping-scan.mjs` |
| TP2 "OR Tape Reading==FALSE", SL "OR Price<VWAP" (kondisi keluar dinamis untuk posisi yang sedang berjalan) | ❌ Belum - beda dari Entry di atas, ini butuh melacak STATE "posisi masih terbuka" per rekomendasi per saham lintas siklus (bukan cuma membandingkan 2 snapshot berurutan) - genuinely butuh desain tambahan, sengaja ditunda atas keputusan user (2026-09-20) |

**Kendala nyata: kuota API, bukan lagi ketersediaan data.** Lihat §2.3 dan §3.4 untuk perhitungan detail dan keputusan yang masih perlu diambil user.

### 1.4. Verdict Matrix (`Buku Putih Logika Aplikasi Trading.pdf` §1)

Dokumen mendefinisikan aturan generik: `STRONG BUY = Bullish>=4 AND Bearish==0`, `BUY = Bullish>=3 AND Bearish<=1`, `HOLD = Bullish==Bearish`, `SELL = Bearish>=3 AND Bullish<=1`. Kode saat ini sudah memakai prinsip yang sama (skor bullish/bearish terpisah, tidak saling meniadakan) tapi dengan **bobot per sinyal** (sebagian sinyal bernilai 2, bukan 1) dan **ambang berbeda per modul** (scalping max~9, swing max~11), bukan skema hitung sederhana yang seragam. Ini bukan bug — bobot dipakai supaya sinyal yang secara historis lebih kuat (mis. breakout+volume tervalidasi, akumulasi broker >=60%) punya pengaruh lebih besar dari sinyal lemah. **Keputusan: didokumentasikan sebagai perbedaan desain yang disengaja, opsi realignment dijelaskan di §3.3 tapi menunggu persetujuan eksplisit sebelum diubah** karena ini mengubah rekomendasi Buy/Sell yang sudah tayang ke user.

### 1.5. Skema Database ML (`Arsitektur Data & ML Roadmap.pdf`)

Belum ada tabel `trade_analysis_log`/`trade_labels`. Yang sudah ada (`docs/data/track-record.json`) adalah versi ringan: mencatat rekomendasi Buy/Sell + harga close saat itu, cek kebenarannya di run berikutnya. Ini fondasi yang benar tapi belum menyimpan fitur lengkap (RSI, MACD, PBV, dst.) per baris, dan belum ada mekanisme label H+7/H+30/TP-SL-hit. **Rencana lengkap di §4.**

---

## 2. Keputusan Arsitektur (dikonfirmasi bersama user, 2026-09-20)

### 2.1. Modul Scalping: dipertahankan, bukan dihapus — pakai data real Pluang

Awalnya diperkirakan tidak ada sumber data real untuk VWAP/order book/tape reading, sehingga muncul opsi "hapus modul Scalping". User menunjukkan bahwa Pluang (via Zapi) memang menyediakan endpoint ini. Setelah verifikasi lewat dokumentasi resmi Zapi, dikonfirmasi tersedia: Intraday Chart, Order Book, Running Trade. Modul Scalping dilanjutkan dengan data ini (lihat §1.3, §3.4).

### 2.2. Fair Value Investment: Graham Number + PEG Ratio, lalu ditambah DCF (2026-09-20)

Keputusan awal (masih berlaku sebagian): DCF butuh asumsi growth rate & discount rate masa depan (bukan data yang benar-benar teramati) — bertentangan dengan prinsip "jangan pernah mengarang angka" yang jadi dasar Max Buy (Graham Number) sejak awal. PEG Ratio dipilih sebagai pelengkap karena murni dihitung dari data historis real (PER ÷ EPS Growth YoY riil), tanpa proyeksi masa depan.

**Update 2026-09-20 (atas permintaan eksplisit user): DCF ditambahkan juga, dikombinasikan dengan Graham Number** (rata-rata keduanya untuk Fair Value, fallback ke yang tersedia kalau cuma satu bisa dihitung - lihat `computeCombinedFairValue`/`computeDcfFairValue` di `lib/pipeline.mjs`). Keberatan prinsip di atas diselesaikan dengan menjaga SETIAP input yang bisa real tetap real, dan mendisclose eksplisit input yang terpaksa jadi asumsi:

- **Real**: TTM Free Cash Flow (jumlah 4 kuartal riil terakhir dari scraper), laju pertumbuhan dari net income growth YoY riil historis (dibatasi -15%..+20% supaya anomali 1 kuartal - pernah terlihat >800% untuk beberapa saham tambang - tidak diekstrapolasi jadi angka absurd), bobot struktur modal WACC dari DER riil, jumlah saham beredar riil.
- **Asumsi terbuka/bisa dirujuk** (bukan data live, tidak ada sumber real-time untuk ini): cost of equity ~11% dan cost of debt ~8% (estimasi cost of capital Indonesia, kerangka Damodaran - sama seperti yang dipakai untuk ambang ROE bearish di §3.3), tarif pajak 22% (tarif resmi PPh Badan Indonesia, angka publik), pertumbuhan terminal 3% (proxy pertumbuhan jangka panjang konservatif).
- **Pengaman**: hanya dihitung kalau FCF TTM riil positif dan jumlah saham tersedia; hasil yang jauh dari harga riil (di luar 0,1x-10x) dibuang, sama seperti Graham Number.

Modul Investment `investmentSignals` (matriks Varian B lama) juga diganti dengan `investmentLiteralEntryVerdict` - aturan Entry literal dokumen §4B (SEMUA 6 syarat fundamental TRUE sekaligus DAN harga<70% Fair Value) sebagai perbandingan "Alt" yang lebih setia ke dokumen daripada matriks generik §1 sebelumnya (lihat §3.3).

**Margin of Safety dirombak (2026-09-20, atas permintaan eksplisit user)** - sebelumnya basis 15% dinudge oleh campuran sinyal fundamental DAN teknikal (ADX mingguan, RVOL, konsentrasi broker, corporate action) tanpa sumber literatur spesifik. Sekarang `computeMarginOfSafety` di `lib/pipeline.mjs` murni berbasis literatur value-investing/asset-pricing bernama, ditampilkan langsung di kartu (chip "MoS X%"):

| Faktor | Penyesuaian | Sumber |
|---|---|---|
| Basis | 30% | Benjamin Graham, *The Intelligent Investor* Bab 20 - "no less than a third" |
| Leverage (DER riil) | +10% (DER>200%), +5% (DER>100%), &minus;3% (DER&le;50%) | Kriteria neraca defensif Graham |
| Profitabilitas (ROE riil) | &minus;5% (ROE&ge;20%), +5% (ROE<10%) | Kerangka *excess return* Damodaran (sama dasar dengan ambang ROE §3.3) |
| Ukuran perusahaan (cap tier riil) | +5% (Small Cap), &minus;3% (Big Cap) | Premi risiko small-cap - Fama &amp; French (1992), faktor SMB |
| Prediktabilitas laba (tren revenue/laba riil) | +5% (sama-sama menyusut), &minus;3% (sama-sama tumbuh>5%) | Seth Klarman, *Margin of Safety* (1991) |

Dibatasi 15%-45%. Sinyal teknikal (ADX/RVOL/broker/corporate action) sengaja **dikeluarkan** dari perhitungan ini - itu konsep timing/momentum, bukan konsep margin of safety dari literatur value investing, jadi dipisahkan supaya tiap faktor di sini punya sumber yang bisa dirujuk secara spesifik.

### 2.3. Logging untuk ML: database eksternal (Supabase)

Berbeda dari pola "JSON di git" yang dipakai selama ini — user memilih database eksternal supaya Fase 2 (backtesting kuantitatif) bisa pakai query SQL sungguhan alih-alih memuat seluruh file JSONL ke memori tiap kali analisis. Ini pertama kalinya proyek ini punya dependency "server-ish" di luar GitHub — trade-off yang disadari dan diterima secara eksplisit oleh user demi kemampuan query yang jauh lebih baik untuk kebutuhan ML jangka panjang. Detail schema & setup di §4.

**Yang masih perlu dari user:** buat project gratis di [supabase.com](https://supabase.com), lalu tambahkan `SUPABASE_URL` dan `SUPABASE_SERVICE_KEY` sebagai GitHub Actions secret (sama seperti `ZAPI_KEY`/`ANTHROPIC_API_KEY` sekarang) — **service key**, bukan anon key, karena workflow perlu hak tulis penuh (insert/update) dan tidak boleh dibatasi Row Level Security yang didesain untuk client-side.

---

## 3. Fase 1: Rule-Based Engine Expansion (Bulan 1-6)

### 3.1. Investment: PEG Ratio (langsung diimplementasikan, tanpa dependency baru)

`PEG = PER / EPS_Growth_YoY(%)`, dihitung hanya kalau keduanya positif (PEG negatif atau dari perusahaan menyusut tidak bermakna secara konvensi). `EPS_Growth_YoY` dihitung murni dari EPS riil per kuartal yang sudah ada di scraper (`eps` kuartal ini vs kuartal yang sama tahun lalu) — field baru, bukan derivasi dari `net_income_growth_yoy` (beda kalau jumlah saham beredar berubah). Ditambahkan sebagai kolom baru di tabel Fundamental Historis dan sebagai faktor tambahan (bukan pengganti) di `fundamentalScore()`.

### 3.2. Swing: Fibonacci Retracement + penyelarasan RSI

- Fibonacci 0.618/0.5 dihitung dari real swing high/low 50 hari (`prior50High`/`prior50Low`, sudah ada) — level klasik, bukan indikator baru yang perlu API tambahan.
- RSI(14) diselaraskan ke rentang dokumen baru (30-40 mantul, atau tembus 50) — ini mengubah kapan sinyal `rsiConstructive` menyala, sehingga **perlu direview bareng perubahan verdict matrix di §3.3** supaya tidak dua kali mengubah perilaku live secara terpisah.

### 3.3. Realignment Verdict Matrix — ✅ Varian B diimplementasikan berdampingan (2026-09-20)

Sesuai rekomendasi di bawah: **Varian B** (matriks generik Buku Putih §1, `Bullish>=4 & Bearish==0` dst., unweighted) dihitung **berdampingan** dengan verdict resmi (weighted, tidak berubah) untuk Swing (`swingScore` yang sudah ada, dipetakan lewat `verdictFromCounts`) dan Investment (`investmentSignals` baru - 6 gerbang fundamental persis Buku Putih §4A: ROE, DER kecuali bank, PER&PBV, EPS Growth, Dividend Yield, PEG). Diekspos sebagai `verdict_b` di tiap item rekomendasi, ditampilkan sebagai chip kecil **"Alt: [verdict]"** di kartu HANYA kalau berbeda dari verdict resmi - tidak pernah memengaruhi ranking/Entry/Target/Stop Loss/Max Buy.

Verdict resmi (yang menentukan rekomendasi Buy/Sell yang ditampilkan) **tidak diganti** - tetap skor berbobot yang sudah ada. Rencana selanjutnya: setelah cukup data `trade_labels` terkumpul (Fase 2, §4), bandingkan win-rate kedua metode dari data real, baru putuskan apakah salah satunya layak menggantikan verdict resmi - bukan diputuskan sekarang berdasarkan mana yang "kedengarannya lebih benar".

**Ambang bearish `investmentSignals` (2026-09-20, diperkuat atas permintaan user)** - 6 gerbang bullish persis tabel Buku Putih §4A; dokumen ini tidak punya tabel bearish simetris untuk Investment (beda dari Scalping/Swing yang punya keduanya), jadi tiap ambang bearish sekarang dijangkarkan ke satu sumber literatur/metodologi investasi nyata secara eksplisit, bukan tebakan/estimasi kasar lagi:

| Metrik | Ambang Bearish | Sumber |
|---|---|---|
| ROE | < 10% | Damodaran (NYU Stern) - kerangka *excess return*: nilai perusahaan cuma tercipta kalau ROE > cost of equity; ~10% mendekati estimasi cost of equity pasar Indonesia (BI rate + premi risiko ekuitas dari tabel country risk premium Damodaran) |
| DER | > 2,0x (200%), kecuali bank | Angka persis dari Stop Loss Investment di dokumen referensi sendiri ("Spesifikasi Algorithmic Trading & ML.pdf" §2); juga ambang leverage tinggi yang umum di literatur corporate finance (mis. Brealey/Myers/Allen). Bank dikecualikan - persis alasan Benjamin Graham (*The Intelligent Investor*) kenapa institusi keuangan tidak sebanding dengan industrial di rasio ini (dan persis catatan "(Kecuali Bank)" di tabel dokumen) |
| PER x PBV | > 22,5 | Kombinasi rumus klasik Graham (PER<=15 DAN PBV<=1,5, dikalikan = 22,5) - konstanta yang SAMA dipakai Graham Number (`computeInvestmentLevels`) di file ini - saham sudah berada di atas fair value Graham-nya sendiri, bukan angka baru yang diciptakan terpisah |
| EPS Growth YoY | < 0 selama 2 kuartal berturut-turut | Persis kutipan literal Stop Loss Investment di dokumen referensi ("EPS_Growth_YoY < 0 for 2 Quarters") - sekarang benar-benar dicek 2 kuartal riil (`prev_eps_growth_yoy`), bukan cuma kuartal terakhir |
| PEG | > 2 | Perluasan umum dari metodologi PEG Peter Lynch (*One Up On Wall Street*, 1989) - PEG=1 baseline fair value Lynch, PEG>2 ambang "jelas mahal" yang umum dipakai praktisi |
| Dividend Yield | Sengaja tanpa ambang bearish | Kriteria defensive investor Graham memperlakukan riwayat dividen sebagai penanda kualitas, bukan gerbang wajib - yield rendah/nol normal untuk saham growth. Sinyal bearish yang benar-benar didukung literatur adalah **pemotongan dividen** (bukan level yield), yang butuh histori dividen per-kuartal yang belum dilacak pipeline ini - jujur dilewati daripada didekati asal-asalan |

### 3.4. Modul Scalping: desain konkret + trade-off kuota (perlu keputusan user)

**Sumber data (semua real, dari referensi API di atas):**
- `finance:pluang/chart` — candle 5 menit sesi berjalan → VWAP sesi (cumulative typical-price×volume ÷ cumulative volume), EMA cepat di atas basis 5 menit (bukan 1/3 menit literal — gap jujur terhadap dokumen, didokumentasikan)
- `finance:pluang/orderbook` — `bidPercent`/`askPercent` real untuk rasio Bid/Offer
- `finance:pluang/running-trades` — filter `action=BUY` vs `action=SELL` pada window waktu terbaru → `Offer_Eaten_Rate` vs `Bid_Eaten_Rate` (tape reading/HAKA) dihitung dari lot riil, bukan estimasi
- `finance:pluang/summary` (Multi Quote) — batch hingga 20 kode sekaligus untuk quote dasar, irit kuota dibanding 1 call per saham

**Kendala kuota — sudah diselesaikan lewat upgrade paket Zapi ke 200.000 call/bulan (dikonfirmasi user, 2026-09-20).**

Pipeline harian yang sudah jalan tetap ~9.130 call/bulan (tidak berubah). Sisa untuk Scalping + kebutuhan baru lain: **~190.870 call/bulan**.

**Cakupan universe: 250 saham, hasil filter dari run harian jam 19:00 (dikonfirmasi user, 2026-09-20)** — bukan daftar statis. Pipeline harian sudah menghitung daftar 250 saham paling aktif untuk keperluan lain (`MOST_ACTIVE_SCAN_COUNT` di `lib/pipeline.mjs`, dipakai untuk scan broker Pluang) — daftar yang sama ini ditulis ke `docs/data/scalping-watchlist.json` setiap run 19:00 (tanpa call API tambahan, tinggal reuse), lalu dibaca `scalping-scan.yml` sepanjang jam bursa besoknya.

**Tapi 250 saham dengan full order book + running-trades tiap 5 menit TIDAK muat di kuota, bahkan yang sudah di-upgrade** — 250 × (1 orderbook + 1 running-trades) + 13 batch multi-quote (maks 20 kode/batch) = 513 call/siklus × 82 siklus/hari (sesi ~410 menit ÷ 5) × 22 hari = **~925.000 call/bulan**, hampir 5x dari kuota 200.000. Solusinya **desain dua tingkat**, bukan mengecilkan cakupan 250-nya:

1. **Tingkat penyaringan (murah, semua 250 saham tiap 5 menit)**: Multi Quote batch (13 call/siklus, karena maks 20 kode/call) untuk pantau harga/volume seluruh 250 saham. 82 siklus/hari × 13 = 1.066 call/hari → **~23.450 call/bulan**.
2. **Tingkat mendalam (order book + tape reading, hanya subset "paling bergerak" saat itu — mis. top 30 dari 250 berdasarkan perubahan harga/lonjakan volume di tingkat penyaringan)**: 30 saham × (1 orderbook + 1 running-trades) = 60 call/siklus × 82 siklus/hari = 4.920 call/hari → **~108.240 call/bulan**.
3. **Chart intraday** (VWAP, tidak perlu secepat order book) untuk subset yang sama, tiap 15 menit: 27 siklus/hari × 30 saham = 810 call/hari → **~17.820 call/bulan**.

Total Scalping ≈ 23.450 + 108.240 + 17.820 = **~149.510 call/bulan**, ditambah pipeline harian (9.130) = **~158.640 dari 200.000 (79%)** — sisa **~41.360 call/bulan (21%)** sebagai buffer manual rerun/retry/job label. Ini caranya **seluruh 250 saham tetap terpantau** (level harga/volume dasar) sambil tetap dalam kuota, dan sinyal order-book/tape-reading yang lebih mahal difokuskan ke saham yang benar-benar sedang bergerak — sejalan dengan praktik scalping sungguhan (fokus di saham paling likuid & aktif saat itu, bukan menyebar tipis ke 250 saham sekaligus).

5 menit dipilih bukan angka sembarangan — itu **batas praktis minimum cron GitHub Actions** (dijadwalkan lebih cepat dari ini tidak didukung/tidak reliabel) **dan** persis granularitas asli candle Pluang sendiri (`intervalSeconds: 300`).

Karena repo public (menit GitHub Actions gratis tanpa batas), **biaya compute bukan masalah** — murni soal kuota panggilan API Zapi. Workflow baru (`.github/workflows/scalping-scan.yml`) dijadwalkan cron hanya selama jam bursa (02:00-08:50 UTC = 09:00-15:50 WIB, Senin-Jumat) supaya tidak membuang slot cron di luar jam pasar.

### 3.5. Logging ke Supabase (`trade_analysis_log` + `trade_labels`)

Schema mengikuti persis kolom di `Arsitektur Data & ML Roadmap.pdf` §1A/1B, disesuaikan tipe data ke Postgres:

```sql
create table trade_analysis_log (
  log_id uuid primary key default gen_random_uuid(),
  timestamp timestamptz not null default now(),
  ticker text not null,
  timeframe_type text not null check (timeframe_type in ('Scalping','Swing','Investment')),
  trend_ihsg text,
  feat_rsi_value numeric,
  feat_macd_hist numeric,
  feat_price_vs_sma20 numeric,
  feat_vol_vs_avg20 numeric,
  feat_pbv numeric,
  feat_per numeric,
  feat_der numeric,
  feat_roe numeric,
  score_confluence integer,
  signal_output text,
  entry_price numeric,
  target_tp1 numeric,
  target_sl numeric
);

create table trade_labels (
  log_id uuid primary key references trade_analysis_log(log_id),
  price_h7 numeric,
  price_h30 numeric,
  is_tp1_hit boolean,
  is_sl_hit boolean,
  days_to_outcome integer,
  max_drawdown_pct numeric
);
```

**Alur:**
1. Pipeline harian (`scripts/run-pipeline.mjs`, 20 saham/hari): insert satu baris ke `trade_analysis_log` per kartu yang ditampilkan — semua verdict termasuk Hold, supaya data training nanti tidak bias hanya ke sinyal positif. Volume kecil (~20 baris/hari, ~440/bulan), tidak masalah untuk penyimpanan.
2. Scalping scan (`scalping-scan.yml`, tiap 5 menit): **hanya insert saat sebuah saham PERTAMA KALI memasuki status sinyal baru** (mis. baru saja jadi Buy/Strong Buy/Sell/Strong Sell, dicek terhadap status run sebelumnya) — bukan tiap siklus untuk tiap saham yang dipantau. Ini sejalan dengan definisi dokumen referensi sendiri ("dicatat setiap kali sistem **menghasilkan sebuah rekomendasi**", bukan tiap kali harga di-cek) dan krusial untuk menjaga volume tetap masuk akal: dicek tiap 5 menit terhadap ~250-280 saham (§3.4), tapi kalau tiap siklus tiap saham dicatat sebagai baris baru, volumenya bisa ~450.000 baris/bulan hanya dari Scalping — jauh melebihi 500 MB tier gratis Supabase dalam hitungan minggu. Dengan logging "hanya saat sinyal baru muncul", realistisnya cuma puluhan-ratusan event/hari di seluruh universe yang dipantau — muat nyaman bertahun-tahun di 500 MB.
3. Job harian baru (`update-labels.yml`, jalan ~17:30 WIB setelah bursa tutup, mirip `update_labels.py` di dokumen) query baris `trade_analysis_log` yang belum punya `trade_labels`, cek harga real H+7/H+30 dan riwayat High/Low vs `target_tp1`/`target_sl` dari `zapi.chart()`, lalu upsert ke `trade_labels`. Logikanya paralel dengan yang sudah ada di `track-record.json`, hanya lebih detail dan tersimpan relasional.
4. Kredensial Supabase disimpan sebagai secret, dipanggil lewat REST API Supabase (`@supabase/supabase-js` atau `fetch` langsung ke PostgREST) dari Node — tidak perlu driver Postgres native.

**Apakah tier gratis Supabase ($0/bulan — unlimited API request, 500 MB database, 5 GB egress) cukup?** Ya, dengan kebijakan logging "saat sinyal baru" di atas. Estimasi realistis: baris gabungan `trade_analysis_log`+`trade_labels` sekitar 400-700 byte (termasuk overhead index Postgres). Pipeline harian (~440 baris/bulan) + Scalping event-based (perkiraan konservatif ~100-300 event/hari lintas ~250-280 saham × 22 hari ≈ 2.200-6.600 baris/bulan) masih jauh di bawah yang bisa bikin 500 MB penuh dalam hitungan tahun, bukan bulan. Kalau nanti ternyata volume event Scalping jauh lebih tinggi dari perkiraan (pasar sangat volatil terus-menerus), 500 MB tetap punya headroom besar sebelum perlu upgrade — dipantau, bukan diasumsikan aman selamanya.

---

## 4. Fase 2: Quantitative Backtesting (Bulan 6-12)

Baru bisa mulai efektif setelah `trade_labels` terisi cukup banyak baris berlabel lengkap (idealnya minimal beberapa ratus per modul, supaya statistik tidak bising) — realistis sekitar bulan ke-3 sampai ke-4 setelah §3.5 aktif (bukan langsung bulan ke-6, tapi mengikuti nama fase dokumen referensi untuk konsistensi).

- Script analisis baru (`scripts/backtest-analysis.mjs` atau notebook Python terpisah, dijalankan manual/on-demand — tidak perlu jalan di GitHub Actions tiap hari) query Supabase, hitung win rate `is_tp1_hit=true` per kombinasi kondisi (contoh dari dokumen: `feat_rsi_value < 30` bersamaan `trend_ihsg = Bearish`).
- Hasilnya dipakai untuk **mengusulkan** perubahan bobot/ambang skor konfluensi (§3.3) — perubahan aktual tetap lewat review manual sebelum di-deploy ke pipeline live, bukan otomatis menulis ulang kode sendiri.

## 5. Fase 3: Supervised Machine Learning (Tahun 2+)

Belum dimulai — sesuai dokumen referensi, disyaratkan data historis berlabel yang cukup dari Fase 1/2 dulu. Catatan desain untuk saat itu tiba:
- Training dilakukan offline (lokal atau notebook terpisah), bukan di GitHub Actions — training XGBoost/Random Forest tidak cocok dijalankan tiap hari di runner gratis.
- Model yang sudah dilatih (file `.json`/`.pkl` kecil) di-commit ke repo, inference-nya tetap jalan sebagai langkah tambahan di `scripts/run-pipeline.mjs` (batch, deterministik, konsisten dengan arsitektur statis — tidak perlu server model-serving terpisah).
- Output berubah dari verdict tetap ("Strong Buy") jadi probabilitas (`win_probability`) seperti di dokumen — verdict lama tetap ditampilkan berdampingan sebagai pembanding, tidak langsung menggantikan.

## 6. Gap yang Sengaja Tidak Diimplementasikan

Konsisten dengan prinsip "tidak pernah mengarang data" — faktor berikut dari dokumen referensi tidak punya sumber data real yang tersedia lewat Zapi/Pluang/Yahoo Finance, sehingga sengaja dilewati (bukan diisi tebakan):

- Tren kepemilikan asing/institusi KSEI kuartalan resmi (dipakai proxy broker concentration harian)
- Analisis makro/sektor top-down
- Penilaian kualitatif moat/manajemen/tata kelola
- Full order-book depth (Pluang cuma expose best bid/ask, bukan seluruh antrean)
- Chart 1-menit/3-menit literal (Pluang cuma expose granularitas 5 menit)
- DCF sebagai Fair Value utama (lihat §2.2)

## 7. Status Implementasi (per 2026-09-20)

1. ~~Buat project Supabase gratis~~ — **selesai**. Tabel `trade_analysis_log`/`trade_labels` sudah dibuat (RLS aktif), `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` terpasang di GitHub secret. `lib/supabase.mjs` (klien PostgREST), hook insert di `lib/pipeline.mjs`/`scripts/run-pipeline.mjs`, dan `scripts/update-labels.mjs` + `update-labels.yml` (cron 19:30 WIB Senin-Jumat) sudah jalan.
2. ~~Putuskan trade-off cakupan/cadence Scalping~~ — **selesai**: kuota Zapi di-upgrade ke 200.000 call/bulan, desain dua tingkat 250 saham (screening) + 30 saham (deep scan) dikonfirmasi muat nyaman (§3.4). **Implementasi selesai**: `lib/scalping.mjs` (VWAP/EMA/RSI7/sinyal/matriks verdict/level entry-TP-SL persis rumus Scalping di Buku Putih §2B), `scripts/scalping-scan.mjs`, `.github/workflows/scalping-scan.yml` (cron tiap 5 menit, 09:00-15:50 WIB Senin-Jumat). Verdict matrix modul ini memakai **Varian B** (persis Buku Putih §1, unweighted) sejak awal karena modul baru - tidak mengganggu perilaku live yang sudah ada.
3. **Approve realignment verdict matrix untuk modul Scalping/Swing/Investment yang LAMA** (§3.3) — masih menunggu keputusan, belum diubah. Modul Scalping baru (poin 2 di atas) sudah memakai matriks Varian B secara independen - ini TIDAK menggantikan `recommendations.scalping` yang lama di dashboard utama, keduanya berjalan berdampingan untuk saat ini (data live tersimpan terpisah di `docs/data/scalping-live.json`).
4. ~~Belum dikerjakan: menampilkan `scalping-live.json` di `docs/index.html`~~ — **selesai** (2026-09-20). Atas permintaan eksplisit, tab Scalping di dashboard utama sekarang **menampilkan data real-time ini sepenuhnya**, menggantikan tampilan lama yang bersumber dari `recommendations.scalping` (update harian). Kartu baru (`scalpingLiveCard` di `docs/index.html`) menampilkan 6 sinyal bull/bear secara transparan (bukan Success Rate seperti Swing/Investment, karena metodologinya beda - lihat §1.4), VWAP/EMA/RSI7, Order Book, Tape Reading, dan Entry/TP1/TP2/SL. Catatan: `lib/pipeline.mjs` masih menghitung `recommendations.scalping` yang lama di backend (dipakai untuk `trade_analysis_log`/win-rate lama) - hanya tampilannya di UI yang diganti, bukan penghitungannya dihapus total.

## 8. Catatan Otomasi (pertanyaan yang sering muncul)

Semua fetch data dan commit/push ke repo pada roadmap ini berjalan **otomatis lewat cron GitHub Actions**, persis pola yang sudah terbukti jalan di `daily-update.yml`/`recovery-watchdog.yml`/`fundamental-scraper.yml` — tidak ada tombol manual yang perlu ditekan user setelah workflow live. Satu-satunya langkah manual yang tersisa adalah push commit yang dibuat **selama sesi coding interaktif** (lewat GitHub Desktop), karena environment development ini tidak punya kredensial push — begitu kode sudah tergabung ke `main` dan workflow terjadwal aktif, seluruh siklus fetch → hitung → commit → push berjalan sendiri sesuai cron masing-masing.
