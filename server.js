require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SECRET =
  process.env.JWT_SECRET ||
  'local-development-secret-change-before-deployment';

if (!process.env.JWT_SECRET) {
  console.warn('Warning: Set JWT_SECRET in .env before using real accounts.');
}

/* ------------------------------------------------------------------ *
 *  HOW ATTENDANCE WORKS (the only way attendance is created)
 *
 *  1. Faculty create a subject. Each subject has a join code.
 *  2. Students join the subject once with that join code (enrollment).
 *  3. Faculty start a LIVE CLASS. A 6-digit code appears on the faculty
 *     screen and changes every 20 seconds.
 *  4. Students type the code they see on the classroom screen.
 *     Only enrolled students can check in, only while the class is open.
 *  5. When the class ends (button or timer), every enrolled student who
 *     did not check in is marked ABSENT automatically.
 *  6. Faculty can correct a single student in that class's roster.
 * ------------------------------------------------------------------ */

const STEP_MS = 20000; // how often the live code changes
const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tracker.db'));
const query = sql => db.prepare(sql);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student','faculty'))
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    faculty TEXT DEFAULT '',
    target REAL DEFAULT 75,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    join_code TEXT,
    UNIQUE(code, owner_id)
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (subject_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS timetable (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    room TEXT DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    class_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('present','absent')),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recorded_by INTEGER,
    UNIQUE(subject_id, class_date, user_id)
  );

  CREATE TABLE IF NOT EXISTS class_sessions (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    class_date TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    closed_at INTEGER,
    UNIQUE(subject_id, class_date)
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    action TEXT,
    detail TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

/* ---- Upgrade databases created by older versions of this app ---- */
const subjectColumns = query('PRAGMA table_info(subjects)')
  .all()
  .map(column => column.name);

if (!subjectColumns.includes('join_code')) {
  db.exec('ALTER TABLE subjects ADD COLUMN join_code TEXT');
}

function newJoinCode() {
  for (;;) {
    let code = '';
    for (const byte of crypto.randomBytes(6)) {
      code += JOIN_ALPHABET[byte % JOIN_ALPHABET.length];
    }
    if (!query('SELECT 1 FROM subjects WHERE join_code = ?').get(code)) {
      return code;
    }
  }
}

for (const s of query(
  "SELECT id FROM subjects WHERE join_code IS NULL OR join_code = ''"
).all()) {
  query('UPDATE subjects SET join_code = ? WHERE id = ?')
    .run(newJoinCode(), s.id);
}

db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_join_code ' +
  'ON subjects(join_code)'
);

// Old versions stored faculty "self attendance" and used a different
// code table. Neither is part of the new method.
db.exec(`
  DELETE FROM attendance
  WHERE user_id IN (SELECT id FROM users WHERE role = 'faculty');
  DROP TABLE IF EXISTS sessions;
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const clean = (value, max = 120) =>
  String(value ?? '').trim().slice(0, max);

const days = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday'
];

// Local date of the server, as YYYY-MM-DD
const todayString = () => new Date().toLocaleDateString('en-CA');

function log(userId, action, detail = '') {
  query(
    'INSERT INTO audit(user_id, action, detail) VALUES (?, ?, ?)'
  ).run(userId, action, String(detail).slice(0, 200));
}

function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) throw new Error();

    req.user = jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in again.' });
  }
}

function role(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        error: 'This action is not allowed for your role.'
      });
    }
    next();
  };
}

/* ------------------------- live code helpers ------------------------ */

function codeFor(secret, windowNumber) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(String(windowNumber))
    .digest();
  return String(digest.readUInt32BE(0) % 1000000).padStart(6, '0');
}

const currentWindow = () => Math.floor(Date.now() / STEP_MS);

// The current code and the previous one are accepted, so a student who
// types slowly (up to about 40 seconds) is not rejected.
function acceptedCodes(secret) {
  const w = currentWindow();
  return [codeFor(secret, w), codeFor(secret, w - 1)];
}

function loadSession(id) {
  return query(`
    SELECT c.*, s.name AS subject_name, s.code AS subject_code
    FROM class_sessions c
    JOIN subjects s ON s.id = c.subject_id
    WHERE c.id = ?
  `).get(id);
}

// Close a class: everyone enrolled who has no record yet becomes absent.
function finalize(session) {
  if (session.closed_at) return;

  try {
    db.exec('BEGIN');
    query(`
      INSERT OR IGNORE INTO attendance
        (subject_id, class_date, status, user_id, recorded_by)
      SELECT ?, ?, 'absent', e.student_id, ?
      FROM enrollments e
      WHERE e.subject_id = ?
    `).run(
      session.subject_id,
      session.class_date,
      session.owner_id,
      session.subject_id
    );
    query('UPDATE class_sessions SET closed_at = ? WHERE id = ?')
      .run(Date.now(), session.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  log(session.owner_id, 'class_closed', `${session.subject_id} ${session.class_date}`);
}

function sweepExpired() {
  for (const s of query(
    'SELECT * FROM class_sessions WHERE closed_at IS NULL AND ends_at <= ?'
  ).all(Date.now())) {
    finalize(s);
  }
}

setInterval(() => {
  try {
    sweepExpired();
  } catch (error) {
    console.error('Sweep failed:', error);
  }
}, 15000).unref();

// Slow down people guessing codes
const failedAttempts = new Map();

function isBlocked(userId) {
  const a = failedAttempts.get(userId);
  return Boolean(a && a.blockedUntil > Date.now());
}

function recordFailure(userId) {
  const now = Date.now();
  let a = failedAttempts.get(userId);
  if (!a || a.resetAt < now) {
    a = { count: 0, resetAt: now + 60000, blockedUntil: 0 };
  }
  a.count += 1;
  if (a.count >= 6) a.blockedUntil = now + 60000;
  failedAttempts.set(userId, a);
}

/* ------------------------------ auth -------------------------------- */

app.get('/api/status', (req, res) => {
  res.json({ message: 'CampusTrack API is running.' });
});

app.post('/api/auth/register', async (req, res) => {
  const name = clean(req.body.name, 80);
  const email = clean(req.body.email, 150).toLowerCase();
  const password = String(req.body.password || '');
  const userRole = req.body.role;

  if (
    !name ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 8 ||
    !['student', 'faculty'].includes(userRole)
  ) {
    return res.status(400).json({
      error: 'Enter valid details and a password of at least 8 characters.'
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = query(
      'INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)'
    ).run(name, email, hash, userRole);

    const user = {
      id: Number(result.lastInsertRowid),
      name,
      email,
      role: userRole
    };

    log(user.id, 'register');
    res.status(201).json({
      user,
      token: jwt.sign(user, SECRET, { expiresIn: '8h' })
    });
  } catch {
    res.status(400).json({
      error: 'Email already exists or account could not be created.'
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = clean(req.body.email, 150).toLowerCase();
  const password = String(req.body.password || '');

  const userRecord = query(
    'SELECT * FROM users WHERE email = ?'
  ).get(email);

  if (
    !userRecord ||
    !await bcrypt.compare(password, userRecord.password_hash)
  ) {
    return res.status(401).json({
      error: 'Incorrect email or password.'
    });
  }

  const user = {
    id: userRecord.id,
    name: userRecord.name,
    email: userRecord.email,
    role: userRecord.role
  };

  log(user.id, 'login');
  res.json({
    user,
    token: jwt.sign(user, SECRET, { expiresIn: '8h' })
  });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: req.user });
});

/* ----------------------------- subjects ----------------------------- */

function withPercentage(rows) {
  return rows.map(s => ({
    ...s,
    attended: s.attended || 0,
    conducted: s.conducted || 0,
    percentage: s.conducted
      ? Math.round(s.attended / s.conducted * 100)
      : 0
  }));
}

app.get('/api/subjects', auth, (req, res) => {
  if (req.user.role === 'faculty') {
    // Class-wide totals for the faculty's own subjects.
    return res.json(withPercentage(query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM enrollments e
          WHERE e.subject_id = s.id) AS enrolled,
        (SELECT COUNT(*) FROM class_sessions c
          WHERE c.subject_id = s.id AND c.closed_at IS NOT NULL)
          AS classes_held,
        SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS attended,
        COUNT(a.id) AS conducted
      FROM subjects s
      LEFT JOIN attendance a ON a.subject_id = s.id
      WHERE s.owner_id = ?
      GROUP BY s.id
      ORDER BY s.name
    `).all(req.user.id)));
  }

  // A student's own attendance in the subjects they have joined.
  res.json(withPercentage(query(`
    SELECT s.id, s.name, s.code, s.target, s.owner_id,
      u.name AS teacher_name,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS attended,
      COUNT(a.id) AS conducted
    FROM subjects s
    JOIN users u ON u.id = s.owner_id
    LEFT JOIN attendance a
      ON a.subject_id = s.id AND a.user_id = ?
    WHERE s.id IN (SELECT subject_id FROM enrollments WHERE student_id = ?)
    GROUP BY s.id
    ORDER BY s.name
  `).all(req.user.id, req.user.id)));
});

app.post('/api/subjects', auth, role('faculty'), (req, res) => {
  const name = clean(req.body.name, 100);
  const code = clean(req.body.code, 20).toUpperCase();
  const target = Number(req.body.target || 75);
  const faculty = clean(req.body.faculty, 100);

  if (!name || !code || !(target >= 1 && target <= 100)) {
    return res.status(400).json({
      error: 'Enter a subject, code and target between 1 and 100.'
    });
  }

  try {
    const result = query(`
      INSERT INTO subjects(name,code,faculty,target,owner_id,join_code)
      VALUES(?,?,?,?,?,?)
    `).run(name, code, faculty, target, req.user.id, newJoinCode());

    log(req.user.id, 'subject_created', code);

    res.status(201).json(query(
      'SELECT * FROM subjects WHERE id = ?'
    ).get(Number(result.lastInsertRowid)));
  } catch {
    res.status(400).json({ error: 'You already have a subject with this code.' });
  }
});

app.delete('/api/subjects/:id', auth, role('faculty'), (req, res) => {
  const result = query(
    'DELETE FROM subjects WHERE id=? AND owner_id=?'
  ).run(Number(req.params.id), req.user.id);

  result.changes
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'Subject not found.' });
});

// Student joins a subject with the join code from the faculty.
// Joining twice is harmless: it never creates a duplicate.
app.post('/api/subjects/join', auth, role('student'), (req, res) => {
  const code = clean(req.body.code, 12)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const subject = code
    ? query('SELECT id, name, code FROM subjects WHERE join_code = ?').get(code)
    : null;

  if (!subject) {
    return res.status(404).json({
      error: 'No subject found for that join code. Check it with your faculty.'
    });
  }

  const result = query(
    'INSERT OR IGNORE INTO enrollments(subject_id, student_id) VALUES (?, ?)'
  ).run(subject.id, req.user.id);

  if (!result.changes) {
    return res.status(409).json({
      error: `You have already joined ${subject.name}.`
    });
  }

  log(req.user.id, 'joined_subject', subject.code);
  res.status(201).json({ ok: true, subject });
});

// Faculty: every student in a subject with their own percentage.
app.get('/api/subjects/:id/students', auth, role('faculty'), (req, res) => {
  const subjectId = Number(req.params.id);

  if (!query(
    'SELECT id FROM subjects WHERE id=? AND owner_id=?'
  ).get(subjectId, req.user.id)) {
    return res.status(404).json({ error: 'Subject not found.' });
  }

  res.json(withPercentage(query(`
    SELECT u.id, u.name, u.email,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS attended,
      COUNT(a.id) AS conducted
    FROM enrollments e
    JOIN users u ON u.id = e.student_id
    LEFT JOIN attendance a
      ON a.subject_id = e.subject_id AND a.user_id = u.id
    WHERE e.subject_id = ?
    GROUP BY u.id
    ORDER BY u.name
  `).all(subjectId)));
});

/* ----------------------------- timetable ---------------------------- */

app.get('/api/timetable', auth, (req, res) => {
  res.json(query(`
    SELECT t.*, s.name AS subject_name, s.code
    FROM timetable t
    JOIN subjects s ON s.id = t.subject_id
    WHERE t.owner_id = ?
    ORDER BY
      CASE t.day
        WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2
        WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4
        WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
        ELSE 7
      END,
      t.start_time
  `).all(req.user.id));
});

app.post('/api/timetable', auth, (req, res) => {
  const subjectId = Number(req.body.subject_id);
  const { day, start_time, end_time } = req.body;
  const room = clean(req.body.room, 50);

  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

  const allowedSubject = query(`
    SELECT id FROM subjects
    WHERE id = ?
      AND (owner_id = ?
           OR id IN (SELECT subject_id FROM enrollments WHERE student_id = ?))
  `).get(subjectId, req.user.id, req.user.id);

  if (
    !days.includes(day) ||
    !timePattern.test(start_time || '') ||
    !timePattern.test(end_time || '') ||
    start_time >= end_time ||
    !allowedSubject
  ) {
    return res.status(400).json({
      error: 'Check subject, day and time.'
    });
  }

  const clash = query(`
    SELECT id FROM timetable
    WHERE owner_id=? AND day=?
      AND start_time < ? AND end_time > ?
      AND (room=? OR subject_id=?)
  `).get(
    req.user.id, day, end_time, start_time, room, subjectId
  );

  if (clash) {
    return res.status(409).json({
      error: 'Room or subject timetable clash detected.'
    });
  }

  const result = query(`
    INSERT INTO timetable
      (subject_id,day,start_time,end_time,room,owner_id)
    VALUES(?,?,?,?,?,?)
  `).run(
    subjectId, day, start_time, end_time, room, req.user.id
  );

  res.status(201).json(query(
    'SELECT * FROM timetable WHERE id=?'
  ).get(Number(result.lastInsertRowid)));
});

app.delete('/api/timetable/:id', auth, (req, res) => {
  const result = query(
    'DELETE FROM timetable WHERE id=? AND owner_id=?'
  ).run(Number(req.params.id), req.user.id);

  result.changes
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'Entry not found.' });
});

/* ------------------------ attendance (read only) -------------------- */

app.get('/api/attendance', auth, (req, res) => {
  if (req.user.role === 'faculty') {
    return res.json(query(`
      SELECT a.*, s.name AS subject_name, s.code,
             u.name AS student_name, u.email AS student_email
      FROM attendance a
      JOIN subjects s ON s.id = a.subject_id
      JOIN users u ON u.id = a.user_id
      WHERE s.owner_id = ?
      ORDER BY a.class_date DESC, u.name
    `).all(req.user.id));
  }

  res.json(query(`
    SELECT a.*, s.name AS subject_name, s.code
    FROM attendance a
    JOIN subjects s ON s.id = a.subject_id
    WHERE a.user_id = ?
    ORDER BY a.class_date DESC
  `).all(req.user.id));
});

/* ----------------------------- live class --------------------------- */

// Faculty: start taking attendance for a subject (today).
app.post('/api/live/start', auth, role('faculty'), (req, res) => {
  sweepExpired();

  const subjectId = Number(req.body.subject_id);
  const minutes = Math.min(15, Math.max(1, Number(req.body.duration) || 10));

  const subject = query(
    'SELECT * FROM subjects WHERE id=? AND owner_id=?'
  ).get(subjectId, req.user.id);

  if (!subject) {
    return res.status(404).json({ error: 'Subject not found.' });
  }

  const date = todayString();
  const existing = query(
    'SELECT * FROM class_sessions WHERE subject_id=? AND class_date=?'
  ).get(subjectId, date);

  if (existing) {
    if (existing.closed_at) {
      return res.status(409).json({
        error: 'Attendance for this subject is already taken today. ' +
               'Open it from "Today\'s classes" to correct a student.'
      });
    }
    return res.json({ id: existing.id });
  }

  const enrolled = query(
    'SELECT COUNT(*) AS n FROM enrollments WHERE subject_id=?'
  ).get(subjectId).n;

  if (!enrolled) {
    return res.status(400).json({
      error: 'No students have joined this subject yet. ' +
             'Share its join code from the Subjects page first.'
    });
  }

  const now = Date.now();
  const result = query(`
    INSERT INTO class_sessions
      (subject_id, owner_id, secret, class_date, started_at, ends_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    subjectId,
    req.user.id,
    crypto.randomBytes(16).toString('hex'),
    date,
    now,
    now + minutes * 60000
  );

  log(req.user.id, 'class_started', `${subjectId} ${date}`);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

// Faculty: today's classes (so a refreshed page can reopen them).
app.get('/api/live/today', auth, role('faculty'), (req, res) => {
  sweepExpired();

  res.json(query(`
    SELECT c.id, c.class_date, c.ends_at, c.closed_at,
           s.name AS subject_name, s.code
    FROM class_sessions c
    JOIN subjects s ON s.id = c.subject_id
    WHERE c.owner_id = ? AND c.class_date = ?
    ORDER BY c.started_at DESC
  `).all(req.user.id, todayString()));
});

// Student: which of my classes are taking attendance right now?
app.get('/api/live/active', auth, role('student'), (req, res) => {
  sweepExpired();

  res.json(query(`
    SELECT c.id, s.name AS subject_name, c.ends_at
    FROM class_sessions c
    JOIN subjects s ON s.id = c.subject_id
    JOIN enrollments e
      ON e.subject_id = c.subject_id AND e.student_id = ?
    WHERE c.closed_at IS NULL AND c.ends_at > ?
  `).all(req.user.id, Date.now()));
});

// Student: type the code shown on the classroom screen.
app.post('/api/live/checkin', auth, role('student'), (req, res) => {
  sweepExpired();

  if (isBlocked(req.user.id)) {
    return res.status(429).json({
      error: 'Too many wrong codes. Wait a minute and try again.'
    });
  }

  const code = String(req.body.code || '').replace(/\D/g, '').slice(0, 6);

  const openClasses = query(`
    SELECT c.*, s.name AS subject_name
    FROM class_sessions c
    JOIN subjects s ON s.id = c.subject_id
    JOIN enrollments e
      ON e.subject_id = c.subject_id AND e.student_id = ?
    WHERE c.closed_at IS NULL AND c.ends_at > ?
  `).all(req.user.id, Date.now());

  if (!openClasses.length) {
    return res.status(400).json({
      error: 'None of your classes is taking attendance right now.'
    });
  }

  const match = code.length === 6
    ? openClasses.find(c => acceptedCodes(c.secret).includes(code))
    : null;

  if (!match) {
    recordFailure(req.user.id);
    return res.status(400).json({
      error: 'Wrong or expired code. Type the code currently on the screen.'
    });
  }

  try {
    query(`
      INSERT INTO attendance
        (subject_id, class_date, status, user_id, recorded_by)
      VALUES (?, ?, 'present', ?, ?)
    `).run(match.subject_id, match.class_date, req.user.id, match.owner_id);
  } catch {
    return res.status(409).json({
      error: 'Your attendance is already recorded for this class.'
    });
  }

  failedAttempts.delete(req.user.id);
  log(req.user.id, 'checked_in', `${match.subject_id} ${match.class_date}`);
  res.json({ ok: true, subject_name: match.subject_name });
});

// Faculty: live view of one class (code + roster).
app.get('/api/live/:id', auth, role('faculty'), (req, res) => {
  sweepExpired();

  const session = loadSession(Number(req.params.id));
  if (!session || session.owner_id !== req.user.id) {
    return res.status(404).json({ error: 'Class not found.' });
  }

  const closed = Boolean(session.closed_at);
  const windowNumber = currentWindow();

  const roster = query(`
    SELECT u.id, u.name, u.email, a.status
    FROM enrollments e
    JOIN users u ON u.id = e.student_id
    LEFT JOIN attendance a
      ON a.subject_id = e.subject_id
     AND a.user_id = u.id
     AND a.class_date = ?
    WHERE e.subject_id = ?
    ORDER BY u.name
  `).all(session.class_date, session.subject_id);

  res.json({
    id: session.id,
    subject_name: session.subject_name,
    subject_code: session.subject_code,
    class_date: session.class_date,
    ends_at: session.ends_at,
    closed,
    code: closed ? null : codeFor(session.secret, windowNumber),
    step_ms: STEP_MS,
    rotates_at: (windowNumber + 1) * STEP_MS,
    server_time: Date.now(),
    roster
  });
});

// Faculty: end the class now. Everyone not checked in becomes absent.
app.post('/api/live/:id/end', auth, role('faculty'), (req, res) => {
  const session = loadSession(Number(req.params.id));
  if (!session || session.owner_id !== req.user.id) {
    return res.status(404).json({ error: 'Class not found.' });
  }

  finalize(session);
  res.json({ ok: true });
});

// Faculty: correct one student in this class (present or absent).
app.post('/api/live/:id/mark', auth, role('faculty'), (req, res) => {
  const session = loadSession(Number(req.params.id));
  if (!session || session.owner_id !== req.user.id) {
    return res.status(404).json({ error: 'Class not found.' });
  }

  const studentId = Number(req.body.student_id);
  const status = req.body.status;

  const enrolled = query(
    'SELECT 1 FROM enrollments WHERE subject_id=? AND student_id=?'
  ).get(session.subject_id, studentId);

  if (!enrolled || !['present', 'absent'].includes(status)) {
    return res.status(400).json({
      error: 'Choose a student from this class and a present/absent status.'
    });
  }

  query(`
    INSERT INTO attendance
      (subject_id, class_date, status, user_id, recorded_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subject_id, class_date, user_id)
    DO UPDATE SET status = excluded.status,
                  recorded_by = excluded.recorded_by
  `).run(
    session.subject_id, session.class_date, status, studentId, req.user.id
  );

  log(req.user.id, 'attendance_corrected', `${session.id} ${studentId} ${status}`);
  res.json({ ok: true });
});

/* ------------------------------ audit ------------------------------- */

app.get('/api/audit', auth, role('faculty'), (req, res) => {
  res.json(query(`
    SELECT action,detail,created_at
    FROM audit
    WHERE user_id=?
    ORDER BY id DESC
    LIMIT 100
  `).all(req.user.id));
});

// Unknown API routes should return JSON, not the frontend page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// Frontend fallback (Express 5 compatible)
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`CampusTrack running at http://localhost:${PORT}`);
});