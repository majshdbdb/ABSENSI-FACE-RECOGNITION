# 🎓 Sistem Absensi Face Recognition — SMK Tamansiswa Mojoagung (v3)

## Apa yang berubah dari versi sebelumnya

- **Siswa + Guru + Karyawan** dalam 1 sistem (sebelumnya cuma siswa)
- **Login & API sekarang benar-benar dilindungi** (token sesi asli di backend — sebelumnya login cuma gerbang tampilan doang, siapapun bisa akses API langsung tanpa login)
- **Geofencing opsional**: login bisa dibatasi hanya dari lokasi sekolah
- **Dibuat buat skala besar**: pencarian + pagination di semua daftar (siap sampai ribuan orang), data wajah dikompres saat dikirim ke browser
- **Lebih cepat & akurat**: GPU browser (WebGL) dipakai buat proses AI, ada "pemanasan" model di awal, dan verifikasi 2 frame berturut-turut sebelum absen resmi tercatat (mengurangi salah kenali)
- **Kartu identitas** muncul tiap kali ada yang berhasil dipindai (foto, nama, kelas/jabatan, NISN/ID Pegawai, jam)
- **Antrian offline**: kalau internet putus pas lagi banyak yang absen, data tersimpan dulu di perangkat & otomatis terkirim begitu internet nyambung lagi
- **Desain baru** sesuai identitas SMK Tamansiswa Mojoagung
- Arsitektur inti tetap sama seperti sebelumnya: **1 service Node.js** (backend + frontend jadi satu), face recognition tetap jalan di browser lewat face-api.js — jadi cara deploy ke Railway-nya gak berubah drastis, cuma ada beberapa environment variable baru (lihat di bawah)

---

## 📋 Prerequisites

- **Node.js** v18+ — [Download](https://nodejs.org/)
- Browser modern (Chrome/Edge/Firefox) dengan akses kamera
- Koneksi internet (buat load model face-api.js & font dari CDN)

---

## 🖼️ Pasang Logo Sekolah

1. Siapkan file logo resmi SMK Tamansiswa Mojoagung (idealnya PNG persegi, latar transparan, minimal 200x200px) — ambil dari Instagram resmi **@smktamansiswamojoagung** atau web sekolah, atau minta ke bagian Humas/TU
2. Simpan dengan nama persis **`logo.png`**, taruh di folder utama project (sejajar dengan `server.js`)
3. Selesai — logo otomatis muncul di navbar & halaman login

Kalau belum sempat pasang logo, sistem tetap jalan normal (otomatis nampilin lencana "TS" sebagai pengganti, gak ada gambar patah/error).

---

## 🚀 Instalasi Local (Testing)

```bash
cd attendance-app
npm install
npm start
```

Buka `http://localhost:5000`. Login default: **admin** / **admin123**

### Kelola Anggota (Siswa/Guru/Karyawan)
1. Tab "Manage Anggota" → pilih tipe (Siswa / Guru / Karyawan) — field form otomatis menyesuaikan
2. Siswa perlu Nama, NIS, NISN, Kelas. Guru/Karyawan perlu Nama, ID Pegawai, Jabatan (atau Mapel untuk guru)
3. Upload foto wajah yang jelas → sistem otomatis mendeteksi & menyimpan data wajahnya

**Tips foto:** pencahayaan terang, wajah menghadap kamera, cuma 1 wajah per foto, jarak ~0.5–1 meter.

### Absensi
1. Tab "Absensi" → "Mulai Kamera"
2. Orang antre menghadap kamera — kotak hijau = dikenali (nama muncul + kartu identitas di kanan), merah = tidak dikenali
3. Sistem butuh **2 frame berturut-turut** yang cocok sebelum absen resmi dicatat (supaya gak salah kenali), jadi proses terasa hampir instan tapi tetap ada verifikasi singkat
4. Kalau internet putus, absen tetap "tersimpan offline" dan otomatis terkirim begitu koneksi kembali (lihat badge kuning di bawah kamera)

### Report
Tab "Report" punya 2 mode:
- **Hari Ini** — status live siapa yang sudah/belum absen hari ini, bisa cari & filter per tipe
- **Rekap & Unduh** — pilih rentang tanggal (atau tombol cepat Hari Ini/Minggu Ini/Bulan Ini), lihat rekap jumlah hadir per orang, lalu **Unduh Excel** untuk dapat file `.xlsx` berisi 2 sheet: Rekap Ringkasan (total hadir per orang) dan Detail Absensi (tiap kejadian absen dengan jam & confidence)

---

## 🔐 Environment Variables

Atur di Railway lewat tab **Variables**, atau di file `.env` untuk lokal (lihat `.env.example`):

| Variable | Wajib? | Default | Keterangan |
|---|---|---|---|
| `PORT` | Tidak | `5000` | Railway isi otomatis |
| `DB_PATH` | Tidak | file lokal | Path database — isi kalau pakai Railway Volume |
| `SESSION_HOURS` | Tidak | `18` | Lama sesi login sebelum harus login ulang |
| `GEOFENCE_ENABLED` | Tidak | `false` | `true` untuk aktifkan pembatasan lokasi login |
| `SCHOOL_LAT` / `SCHOOL_LNG` | Kalau geofence aktif | — | Koordinat sekolah |
| `GEOFENCE_RADIUS_M` | Tidak | `300` | Radius toleransi (meter) |

### Cara dapetin koordinat sekolah
1. Buka Google Maps, cari lokasi sekolah
2. Klik-kanan tepat di titik gedung sekolah
3. Klik angka koordinat yang muncul paling atas (format "lat, lng") — otomatis ke-copy
4. Pisahkan 2 angkanya ke `SCHOOL_LAT` dan `SCHOOL_LNG`

### ⚠️ Yang perlu kamu tau soal geofencing (biar gak salah jual pas presentasi)
- Ini **penghalang**, bukan kunci anti-jebol. Siapapun yang paham DevTools browser bisa memalsukan lokasi GPS yang dikirim ke website dalam beberapa klik — ini bukan celah keamanan yang butuh keahlian tinggi untuk dieksploitasi
- Di laptop/PC tanpa chip GPS asli, akurasi lokasi (lewat WiFi/IP) bisa meleset ratusan meter. Kalau radius terlalu ketat, admin yang beneran di sekolah bisa malah ketolak — mulai dari radius longgar (300–500m) dan sesuaikan
- Kalau `GEOFENCE_ENABLED=true` tapi `SCHOOL_LAT`/`SCHOOL_LNG` lupa diisi, sistem otomatis MENGANGGAP geofence nonaktif (dicatat sebagai warning di log Railway) — supaya typo config gak mengunci semua orang keluar dari sistem

---

## 🚢 Deploy ke Railway

1. Push semua file ke GitHub (`.gitignore` sudah mengecualikan `node_modules/` dan `attendance.db`)
2. Railway.app → New Project → Deploy from GitHub repo
3. Railway otomatis pakai konfigurasi di `railway.json`
4. Atur Environment Variables sesuai kebutuhan (lihat tabel di atas)
5. Buka URL yang diberikan Railway

### ⚠️ Data hilang tiap redeploy?
Filesystem Railway itu sementara (ephemeral) secara default. Supaya data 1000+ orang gak hilang tiap kali kamu update kode:
1. Railway dashboard → service kamu → tab **Volumes** → **New Volume** → mount path `/data`
2. Tab **Variables** → tambah `DB_PATH` = `/data/attendance.db`
3. Redeploy

**Ini WAJIB dilakukan sebelum sistem beneran dipakai produksi** — jangan sampai data ratusan orang hilang gara-gara lupa langkah ini.

---

## 🔧 Troubleshooting

### "JSON.parse: unexpected character..."
Semua route backend ada di `/api/...`. Kalau muncul lagi, cek Console browser (F12) untuk lihat endpoint mana yang gagal, biasanya karena sesi login sudah kedaluwarsa — coba login ulang.

### Model face recognition gagal/lama dimuat
Cek koneksi internet perangkat (model & font diambil dari CDN). Kalau jaringan sekolah memblokir CDN tertentu, coba jaringan lain.

### Kamera terasa lambat / patah-patah
- Pastikan perangkat kamera pakai browser Chrome/Edge terbaru (dukungan GPU/WebGL lebih baik)
- Coba tutup tab/aplikasi lain yang berat
- Turunkan `DETECT_INPUT_SIZE` di `index.html` (cari `CONFIG.DETECT_INPUT_SIZE`, defaultnya `256`, coba `224` atau `192`) — lebih cepat, sedikit kurang akurat

### Orang tidak pernah "match" walau sudah terdaftar
- Enroll ulang dengan foto yang lebih jelas
- `CONFIG.MATCH_THRESHOLD` di `index.html` (default `0.5`) bisa dinaikkan sedikit (mis. `0.55`) — tapi makin tinggi, makin besar juga risiko salah kenali orang lain
- Dengan jumlah orang yang besar (900+), risiko 2 orang "mirip" secara angka wajah makin ada — kalau sering ketemu kasus salah kenali, turunkan threshold jadi lebih ketat (mis. `0.45`) dan naikkan `CONFIG.CONFIRM_FRAMES` jadi `3`

### Login ditolak walau lokasi sudah di sekolah
`GEOFENCE_RADIUS_M` mungkin terlalu ketat untuk akurasi GPS perangkat itu. Naikkan jadi 500-1000 lewat Railway Variables.

### Lupa password admin
Hapus baris admin lewat akses langsung ke database, atau paling gampang: hapus file `attendance.db` (development) — akun `admin`/`admin123` akan dibuat ulang otomatis. **Jangan lakukan ini di production** kalau sudah ada data absensi (akan ikut hilang) — cara amannya, update password langsung lewat query SQL ke tabel `admin`.

---

## 📊 Database Schema

### anggota (gabungan siswa/guru/karyawan)
```
id, tipe ('siswa'|'guru'|'karyawan'), nama,
nis, nisn            -- diisi kalau tipe = siswa
id_pegawai           -- diisi kalau tipe = guru/karyawan
kelas_jabatan        -- kelas (siswa) atau jabatan/mapel (guru/karyawan)
foto                 -- thumbnail base64
face_encoding        -- JSON array 128 angka
created_at
```

### attendance
```
id, anggota_id (FK), attendance_date (dihitung pakai WIB, bukan UTC),
time_in, confidence
```

### admin & sessions
```
admin: id, username, password, created_at
sessions: token (PK), admin_id (FK), created_at, expires_at
```

---

## 🎯 Next Steps (kalau mau dikembangkan lagi)
- [ ] Hash password admin pakai `bcrypt` (sekarang masih plain text di database)
- [ ] Backup database berkala (terutama sebelum redeploy besar)
- [ ] Migrasi ke PostgreSQL kalau data makin besar / butuh multi-instance
- [ ] Absen pulang (time_out), tidak cuma jam masuk
- [ ] Export laporan ke Excel/PDF
- [ ] Multi-admin dengan level akses berbeda (mis. guru piket vs kepala sekolah)

---

## 📞 Kalau Masih Ada Error
1. F12 → Console di browser — error frontend kelihatan di sini
2. Railway dashboard → Deployments → Logs — error backend kelihatan di sini
3. Coba `npm start` di komputer sendiri dulu sebelum deploy, supaya lebih gampang debug

Semoga presentasinya lancar! 🚀
