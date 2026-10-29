# CampusTrack — Timetable & Attendance Tracker

## Run
1. Use a current Node.js LTS version that supports `node:sqlite` (Node 22.13+ recommended).
2. Open this folder in VS Code.
3. Run `npm.cmd install`.
4. Copy `.env.example` to `.env` and set a long random `JWT_SECRET`.
5. Run `npm.cmd start` and visit http://localhost:3000.

Features in backend: student/faculty registration and login, bcrypt password hashing, JWT-protected APIs, SQLite persistence, subject CRUD, timetable CRUD with room/subject clash checks, faculty attendance recording with duplicate prevention, temporary expiring attendance codes, and audit events.

This is a project starter, not production-ready institutional software. Registration allows users to select their role for demonstration; a real system must restrict faculty accounts and implement student enrollment linking students to faculty-owned subjects. Temporary attendance codes are not camera-scannable QR images. Test and secure before deployment.
