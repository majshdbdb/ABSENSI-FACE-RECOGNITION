require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// Percaya header X-Forwarded-For dari proxy Railway, supaya req.ip akurat
// (dibutuhkan buat rate limiting login per-IP).
app.set('trust proxy', true);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'attendance.db');
const SESSION_HOURS = parseFloat(process.env.SESSION_HOURS || '18');

// ============ MIDDLEWARE ============
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// ============ HELPER: WAKTU WIB ============
// SQLite CURRENT_DATE/CURRENT_TIME selalu UTC. Untuk sekolah di Indonesia (WIB = UTC+7),
// kalau tidak dikoreksi, absen jam 00:00-06:59 WIB (jam siswa berangkat sekolah!)
// akan tercatat dengan TANGGAL KEMARIN. Jadi tanggal & jam selalu dihitung manual.
function getWIBDateTime() {
  const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + WIB_OFFSET_MS);
  const iso = shifted.toISOString();
  return { date: iso.substring(0, 10), time: iso.substring(11, 19) };
}

// ============ HELPER: JARAK GPS (Haversine) ============
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============ RATE LIMIT LOGIN (in-memory, per IP) ============
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function isRateLimited(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return { limited: false };
  const elapsed = Date.now() - record.firstAttempt;
  if (elapsed > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { limited: false };
  }
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    return { limited: true, waitMin: Math.ceil((LOGIN_WINDOW_MS - elapsed) / 60000) };
  }
  return { limited: false };
}

function recordFailedLogin(ip) {
  const record = loginAttempts.get(ip);
  if (!record || Date.now() - record.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    record.count++;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// ============ DATABASE ============
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('❌ Database connection error:', err.message);
  else {
    console.log(`✅ Connected to SQLite database at ${DB_PATH}`);
    initializeDatabase();
  }
});

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

function initializeDatabase() {
  db.serialize(() => {
    // anggota = gabungan siswa, guru, dan karyawan dalam 1 tabel (dibedakan lewat kolom "tipe")
    db.run(`CREATE TABLE IF NOT EXISTS anggota (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipe TEXT NOT NULL CHECK(tipe IN ('siswa','guru','karyawan')),
      nama TEXT NOT NULL,
      nis TEXT,
      nisn TEXT,
      id_pegawai TEXT,
      kelas_jabatan TEXT NOT NULL,
      foto TEXT,
      face_encoding TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anggota_id INTEGER NOT NULL,
      attendance_date DATE NOT NULL,
      time_in TIME NOT NULL,
      confidence REAL,
      FOREIGN KEY (anggota_id) REFERENCES anggota(id),
      UNIQUE(anggota_id, attendance_date)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (admin_id) REFERENCES admin(id)
    )`);

    // ---- Migrasi ringan dari skema versi sebelumnya (tabel "siswa") ----
    // Aman dijalankan berkali-kali: kalau tabel "siswa" lama gak ada, query ini
    // akan gagal diam-diam (callback error diabaikan) dan tidak mengganggu apa pun.
    db.run(
      `INSERT INTO anggota (tipe, nama, nis, nisn, kelas_jabatan, foto, face_encoding, created_at)
       SELECT 'siswa', nama, nis, NULL, kelas, foto, face_encoding, created_at FROM siswa
       WHERE NOT EXISTS (SELECT 1 FROM anggota WHERE anggota.nis = siswa.nis AND siswa.nis IS NOT NULL)`,
      () => {} // tabel lama tidak ada / migrasi sudah pernah jalan -- abaikan errornya
    );

    db.run(
      `INSERT OR IGNORE INTO admin (username, password) VALUES (?, ?)`,
      ['admin', 'admin123'],
      (err) => {
        if (!err) console.log('✅ Database siap (default admin: admin/admin123)');
      }
    );
  });
}

// ============ AUTH MIDDLEWARE ============
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Sesi tidak ditemukan, silakan login ulang' });
    }

    const session = await dbGet('SELECT * FROM sessions WHERE token = ?', [token]);
    if (!session) {
      return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang' });
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      dbRun('DELETE FROM sessions WHERE token = ?', [token]).catch(() => {});
      return res.status(401).json({ error: 'Sesi kedaluwarsa, silakan login ulang' });
    }

    req.adminId = session.admin_id;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ============ PUBLIC CONFIG (buat frontend tau perlu minta lokasi atau tidak) ============
app.get('/api/config', (req, res) => {
  res.json({
    geofenceEnabled: process.env.GEOFENCE_ENABLED === 'true',
  });
});

// ============ LOGIN ============
app.post('/api/login', async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    const rl = isRateLimited(ip);
    if (rl.limited) {
      return res.status(429).json({
        success: false,
        message: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${rl.waitMin} menit.`,
      });
    }

    const { username, password, lat, lng } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username dan password harus diisi' });
    }

    // ---- Geofencing (opsional, aktif kalau GEOFENCE_ENABLED=true) ----
    if (process.env.GEOFENCE_ENABLED === 'true') {
      const schoolLat = parseFloat(process.env.SCHOOL_LAT);
      const schoolLng = parseFloat(process.env.SCHOOL_LNG);
      const radius = parseFloat(process.env.GEOFENCE_RADIUS_M || '300');

      if (isNaN(schoolLat) || isNaN(schoolLng)) {
        // Env var salah/lupa diisi -- jangan sampai mengunci SEMUA login karena typo config.
        // Cukup dicatat di log server, geofence dianggap nonaktif untuk request ini.
        console.error('⚠️ GEOFENCE_ENABLED=true tapi SCHOOL_LAT/SCHOOL_LNG belum diatur dengan benar');
      } else {
        if (typeof lat !== 'number' || typeof lng !== 'number') {
          return res.status(403).json({
            success: false,
            message: 'Lokasi perangkat tidak terdeteksi. Aktifkan izin lokasi di browser lalu coba lagi.',
          });
        }
        const distance = haversineMeters(lat, lng, schoolLat, schoolLng);
        if (distance > radius) {
          return res.status(403).json({
            success: false,
            message: `Login hanya bisa dilakukan dari lokasi sekolah (jarak perangkat kamu: ~${Math.round(distance)}m, maksimal ${radius}m).`,
          });
        }
      }
    }

    const admin = await dbGet('SELECT id, username FROM admin WHERE username = ? AND password = ?', [
      username,
      password,
    ]);

    if (!admin) {
      recordFailedLogin(ip);
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    clearLoginAttempts(ip);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
    await dbRun('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?, ?, ?)', [
      token,
      admin.id,
      expiresAt,
    ]);

    res.json({ success: true, token, username: admin.username, message: 'Login berhasil' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) await dbRun('DELETE FROM sessions WHERE token = ?', [token]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ ANGGOTA (siswa/guru/karyawan) — list + search + pagination ============
app.get('/api/anggota', requireAuth, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const tipe = (req.query.tipe || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    if (search) {
      where.push('(nama LIKE ? OR nis LIKE ? OR nisn LIKE ? OR id_pegawai LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (['siswa', 'guru', 'karyawan'].includes(tipe)) {
      where.push('tipe = ?');
      params.push(tipe);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await dbGet(`SELECT COUNT(*) as total FROM anggota ${whereClause}`, params);
    const rows = await dbAll(
      `SELECT id, tipe, nama, nis, nisn, id_pegawai, kelas_jabatan, foto FROM anggota
       ${whereClause} ORDER BY tipe, kelas_jabatan, nama LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      total: totalRow.total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(totalRow.total / limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Data wajah buat FaceMatcher di browser (dipakai mode Absensi)
app.get('/api/anggota/encodings', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, nama, tipe, nis, nisn, id_pegawai, kelas_jabatan, foto, face_encoding
       FROM anggota WHERE face_encoding IS NOT NULL`
    );
    const data = rows.map((r) => ({
      id: r.id,
      nama: r.nama,
      tipe: r.tipe,
      nis: r.nis,
      nisn: r.nisn,
      id_pegawai: r.id_pegawai,
      kelas_jabatan: r.kelas_jabatan,
      foto: r.foto,
      encoding: JSON.parse(r.face_encoding),
    }));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/anggota', requireAuth, async (req, res) => {
  try {
    const { tipe, nama, nis, nisn, id_pegawai, kelas_jabatan, encoding, foto } = req.body;

    if (!['siswa', 'guru', 'karyawan'].includes(tipe)) {
      return res.status(400).json({ error: 'Tipe harus siswa, guru, atau karyawan' });
    }
    if (!nama || !nama.trim() || !kelas_jabatan || !kelas_jabatan.trim()) {
      return res.status(400).json({
        error: tipe === 'siswa' ? 'Nama dan Kelas harus diisi' : 'Nama dan Jabatan harus diisi',
      });
    }
    if (tipe === 'siswa' && (!nis || !nisn)) {
      return res.status(400).json({ error: 'NIS dan NISN harus diisi untuk siswa' });
    }
    if (tipe !== 'siswa' && !id_pegawai) {
      return res.status(400).json({ error: 'ID Pegawai harus diisi' });
    }
    if (!Array.isArray(encoding) || encoding.length !== 128) {
      return res.status(400).json({
        error: 'Data wajah tidak valid. Pastikan wajah terdeteksi jelas di foto sebelum menyimpan.',
      });
    }

    // Cek duplikat manual (aplikasi-level, bukan constraint DB -- karena field2 ini nullable/kondisional)
    if (tipe === 'siswa') {
      if (await dbGet('SELECT id FROM anggota WHERE nis = ?', [nis])) {
        return res.status(400).json({ error: 'NIS sudah terdaftar' });
      }
      if (await dbGet('SELECT id FROM anggota WHERE nisn = ?', [nisn])) {
        return res.status(400).json({ error: 'NISN sudah terdaftar' });
      }
    } else if (await dbGet('SELECT id FROM anggota WHERE id_pegawai = ?', [id_pegawai])) {
      return res.status(400).json({ error: 'ID Pegawai sudah terdaftar' });
    }

    const result = await dbRun(
      `INSERT INTO anggota (tipe, nama, nis, nisn, id_pegawai, kelas_jabatan, face_encoding, foto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tipe,
        nama.trim(),
        tipe === 'siswa' ? nis : null,
        tipe === 'siswa' ? nisn : null,
        tipe !== 'siswa' ? id_pegawai : null,
        kelas_jabatan.trim(),
        JSON.stringify(encoding),
        foto || null,
      ]
    );

    const label = tipe === 'siswa' ? 'Siswa' : tipe === 'guru' ? 'Guru' : 'Karyawan';
    res.json({ success: true, id: result.lastID, message: `${label} berhasil ditambahkan` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/anggota/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM attendance WHERE anggota_id = ?', [id]);
    await dbRun('DELETE FROM anggota WHERE id = ?', [id]);
    res.json({ success: true, message: 'Data dihapus' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ ATTENDANCE ============
app.post('/api/attendance/check', requireAuth, async (req, res) => {
  try {
    const { anggota_id, confidence } = req.body;
    if (!anggota_id) {
      return res.status(400).json({ error: 'anggota_id wajib diisi' });
    }

    const anggota = await dbGet('SELECT id, nama, tipe FROM anggota WHERE id = ?', [anggota_id]);
    if (!anggota) {
      return res.status(404).json({ error: 'Data tidak ditemukan' });
    }

    const { date: today, time: timeNow } = getWIBDateTime();

    const existing = await dbGet(
      'SELECT * FROM attendance WHERE anggota_id = ? AND attendance_date = ?',
      [anggota_id, today]
    );

    if (existing) {
      return res.json({
        success: false,
        already: true,
        message: `${anggota.nama} sudah absen hari ini (${existing.time_in})`,
        data: { id: anggota.id, nama: anggota.nama, tipe: anggota.tipe },
      });
    }

    const finalConfidence = typeof confidence === 'number' ? confidence : null;

    await dbRun(
      `INSERT INTO attendance (anggota_id, attendance_date, time_in, confidence) VALUES (?, ?, ?, ?)`,
      [anggota_id, today, timeNow, finalConfidence]
    );

    res.json({
      success: true,
      message: `Absen berhasil! ${anggota.nama}`,
      data: { id: anggota.id, nama: anggota.nama, tipe: anggota.tipe, time_in: timeNow, confidence: finalConfidence },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/attendance/report', requireAuth, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const tipe = (req.query.tipe || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const { date: today } = getWIBDateTime();

    const where = [];
    const params = [];
    if (search) {
      where.push('(a.nama LIKE ? OR a.nis LIKE ? OR a.nisn LIKE ? OR a.id_pegawai LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (['siswa', 'guru', 'karyawan'].includes(tipe)) {
      where.push('a.tipe = ?');
      params.push(tipe);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await dbGet(`SELECT COUNT(*) as total FROM anggota a ${whereClause}`, params);

    const report = await dbAll(
      `
      SELECT
        a.id, a.tipe, a.nama, a.nis, a.nisn, a.id_pegawai, a.kelas_jabatan,
        t.time_in, t.confidence,
        CASE WHEN t.id IS NOT NULL THEN 'Hadir' ELSE 'Belum Absen' END as status
      FROM anggota a
      LEFT JOIN attendance t ON a.id = t.anggota_id AND t.attendance_date = ?
      ${whereClause}
      ORDER BY a.tipe, a.kelas_jabatan, a.nama
      LIMIT ? OFFSET ?
    `,
      [today, ...params, limit, offset]
    );

    const summaryRow = await dbGet(
      `SELECT COUNT(*) as hadir FROM attendance WHERE attendance_date = ?`,
      [today]
    );

    res.json({
      data: report,
      total: totalRow.total,
      hadir: summaryRow.hadir,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(totalRow.total / limit)),
      date: today,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend running', timestamp: new Date() });
});

// ============ LOGO (opsional, 404 diam-diam kalau belum di-upload) ============
app.get(['/logo.png', '/favicon.ico'], (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.png'), (err) => {
    if (err) res.status(404).end();
  });
});

// ============ FALLBACK JSON untuk /api/* yang tidak dikenali ============
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Endpoint ${req.method} ${req.originalUrl} tidak ditemukan` });
});

// ============ FRONTEND ============
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============ ERROR HANDLER TERAKHIR ============
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server' });
});

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  🎓 Attendance System Backend v3    ║`);
  console.log(`║  Running on http://localhost:${PORT}       ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});
