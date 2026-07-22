require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Lokasi database bisa di-override lewat env var DB_PATH.
// Kalau kamu pasang Railway Volume, arahkan DB_PATH ke folder volume itu
// (mis. /data/attendance.db) supaya data siswa & absensi tidak hilang tiap redeploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'attendance.db');

// ============ MIDDLEWARE ============
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// ============ HELPER: WAKTU WIB ============
// SQLite CURRENT_DATE/CURRENT_TIME selalu UTC, bukan waktu lokal.
// Untuk sekolah di Indonesia (WIB = UTC+7), kalau ini tidak dikoreksi,
// absen jam 00:00-06:59 WIB akan tercatat dengan TANGGAL KEMARIN
// (karena UTC masih di hari sebelumnya) -- persis di jam siswa berangkat sekolah.
// Jadi tanggal & jam selalu dihitung manual di sini, tidak mengandalkan default SQLite.
function getWIBDateTime() {
  const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + WIB_OFFSET_MS);
  const iso = shifted.toISOString(); // format: YYYY-MM-DDTHH:MM:SS.sssZ
  return {
    date: iso.substring(0, 10),
    time: iso.substring(11, 19),
  };
}

// ============ DATABASE ============
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log(`✅ Connected to SQLite database at ${DB_PATH}`);
    initializeDatabase();
  }
});

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

function initializeDatabase() {
  db.serialize(() => {
    // Siswa table (sudah termasuk foto & face_encoding sejak awal)
    db.run(`CREATE TABLE IF NOT EXISTS siswa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama TEXT NOT NULL,
      nis TEXT UNIQUE NOT NULL,
      kelas TEXT NOT NULL,
      foto TEXT,
      face_encoding TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrasi ringan untuk database lama yang dibuat sebelum kolom ini ada.
    // Aman dijalankan berkali-kali -- error "duplicate column" akan diabaikan.
    db.run(`ALTER TABLE siswa ADD COLUMN foto TEXT`, () => {});
    db.run(`ALTER TABLE siswa ADD COLUMN face_encoding TEXT`, () => {});

    // Attendance table -- tanggal & jam SELALU diisi manual dari getWIBDateTime(),
    // bukan default SQLite (lihat penjelasan di atas)
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      siswa_id INTEGER NOT NULL,
      attendance_date DATE NOT NULL,
      time_in TIME NOT NULL,
      confidence REAL,
      FOREIGN KEY (siswa_id) REFERENCES siswa(id),
      UNIQUE(siswa_id, attendance_date)
    )`);

    // Admin users table
    db.run(`CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Insert default admin
    db.run(
      `INSERT OR IGNORE INTO admin (username, password) VALUES (?, ?)`,
      ['admin', 'admin123'],
      (err) => {
        if (!err) {
          console.log('✅ Database siap (default admin: admin/admin123)');
        }
      }
    );
  });
}

// ============ API ROUTES (semua diawali /api) ============

// 1. LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username dan password harus diisi' });
    }

    const admin = await dbGet(
      'SELECT id, username FROM admin WHERE username = ? AND password = ?',
      [username, password]
    );

    if (admin) {
      res.json({ success: true, admin_id: admin.id, message: 'Login berhasil' });
    } else {
      res.status(401).json({ success: false, message: 'Username atau password salah' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. GET ALL SISWA (untuk tabel admin -- tanpa face_encoding, ada foto thumbnail)
app.get('/api/siswa', async (req, res) => {
  try {
    const siswa = await dbAll('SELECT id, nama, nis, kelas, foto FROM siswa ORDER BY kelas, nama');
    res.json(siswa);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2b. GET ENCODINGS (dipakai frontend buat FaceMatcher saat mode Absensi)
app.get('/api/siswa/encodings', async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT id, nama, face_encoding FROM siswa WHERE face_encoding IS NOT NULL'
    );
    const data = rows.map((r) => ({
      id: r.id,
      nama: r.nama,
      encoding: JSON.parse(r.face_encoding),
    }));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. ADD SISWA -- sekarang menerima JSON berisi face descriptor (128 angka)
//    yang sudah dihitung di browser oleh face-api.js, bukan file foto mentah.
app.post('/api/siswa', async (req, res) => {
  try {
    const { nama, nis, kelas, encoding, foto } = req.body;

    if (!nama || !nis || !kelas) {
      return res.status(400).json({ error: 'Nama, NIS, dan Kelas harus diisi' });
    }

    if (!Array.isArray(encoding) || encoding.length !== 128) {
      return res.status(400).json({
        error: 'Data wajah tidak valid. Pastikan wajah terdeteksi jelas di foto sebelum menyimpan.',
      });
    }

    const result = await dbRun(
      `INSERT INTO siswa (nama, nis, kelas, face_encoding, foto) VALUES (?, ?, ?, ?, ?)`,
      [nama, nis, kelas, JSON.stringify(encoding), foto || null]
    );

    res.json({
      success: true,
      id: result.lastID,
      message: 'Siswa berhasil ditambahkan',
    });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      res.status(400).json({ error: 'NIS sudah terdaftar' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// 4. DELETE SISWA (sekalian hapus riwayat absensinya biar rapi)
app.delete('/api/siswa/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM attendance WHERE siswa_id = ?', [id]);
    await dbRun('DELETE FROM siswa WHERE id = ?', [id]);
    res.json({ success: true, message: 'Siswa dihapus' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. CHECK ATTENDANCE -- dipanggil setelah face-api.js di browser berhasil
//    mencocokkan wajah dengan salah satu siswa (siswa_id sudah diketahui di frontend).
app.post('/api/attendance/check', async (req, res) => {
  try {
    const { siswa_id, confidence } = req.body;

    if (!siswa_id) {
      return res.status(400).json({ error: 'siswa_id wajib diisi' });
    }

    const siswa = await dbGet('SELECT id, nama FROM siswa WHERE id = ?', [siswa_id]);
    if (!siswa) {
      return res.status(404).json({ error: 'Siswa tidak ditemukan' });
    }

    const { date: today, time: timeNow } = getWIBDateTime();

    const existing = await dbGet(
      'SELECT * FROM attendance WHERE siswa_id = ? AND attendance_date = ?',
      [siswa_id, today]
    );

    if (existing) {
      return res.json({
        success: false,
        already: true,
        message: `${siswa.nama} sudah absen hari ini (${existing.time_in})`,
      });
    }

    const finalConfidence = typeof confidence === 'number' ? confidence : null;

    await dbRun(
      `INSERT INTO attendance (siswa_id, attendance_date, time_in, confidence) VALUES (?, ?, ?, ?)`,
      [siswa_id, today, timeNow, finalConfidence]
    );

    res.json({
      success: true,
      message: `Absen berhasil! ${siswa.nama}`,
      data: { id: siswa.id, nama: siswa.nama, time_in: timeNow, confidence: finalConfidence },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. GET ATTENDANCE REPORT (hari ini, waktu WIB)
app.get('/api/attendance/report', async (req, res) => {
  try {
    const { date: today } = getWIBDateTime();

    const report = await dbAll(
      `
      SELECT 
        s.id, 
        s.nama, 
        s.nis, 
        s.kelas,
        a.time_in,
        a.confidence,
        CASE WHEN a.id IS NOT NULL THEN 'Hadir' ELSE 'Belum Absen' END as status
      FROM siswa s
      LEFT JOIN attendance a ON s.id = a.siswa_id AND a.attendance_date = ?
      ORDER BY s.kelas, s.nama
    `,
      [today]
    );

    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. HEALTH CHECK (dipakai juga oleh healthcheckPath Railway)
app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend running', timestamp: new Date() });
});

// 8. Fallback untuk /api/* yang tidak cocok route manapun -- SELALU balas JSON,
//    bukan halaman HTML 404. Ini pencegah utama supaya error
//    "JSON.parse: unexpected character at line 1 column 1" tidak muncul lagi.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Endpoint ${req.method} ${req.originalUrl} tidak ditemukan` });
});

// ============ FRONTEND ============
// Seluruh frontend ada dalam satu file index.html (CSS & JS inline),
// jadi cukup di-serve langsung, tidak perlu express.static untuk seluruh folder
// (biar server.js, package.json, dll tidak ikut ke-expose sebagai file publik).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============ ERROR HANDLER TERAKHIR ============
// Jaring pengaman: kalau ada error tak terduga yang lolos dari try/catch di atas,
// tetap balas JSON, bukan halaman error HTML bawaan Express.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server' });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  🎓 Attendance System Backend       ║`);
  console.log(`║  Running on http://localhost:${PORT}       ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});
