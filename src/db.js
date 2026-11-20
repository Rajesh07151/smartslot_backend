import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Support configurable persistent disk (e.g. Render persistent disk /var/data or custom DB_PATH)
const defaultDbDir = path.resolve(__dirname, '../data');
const customDbPath = process.env.RENDER_DISK_PATH || process.env.DB_PATH;
const dbPath = customDbPath
  ? path.resolve(customDbPath)
  : (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR, 'smartslot.db') : path.resolve(defaultDbDir, 'smartslot.db'));

const resolvedDir = path.dirname(dbPath);
if (!fs.existsSync(resolvedDir)) {
  fs.mkdirSync(resolvedDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for high concurrency read/write
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      vehicle_details TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'CUSTOMER', -- 'ADMIN', 'CUSTOMER'
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      duration_minutes INTEGER NOT NULL,
      price REAL NOT NULL,
      buffer_minutes INTEGER DEFAULT 10,
      icon TEXT DEFAULT 'Wrench',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      role TEXT NOT NULL,
      avatar TEXT,
      bio TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff_services (
      staff_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      PRIMARY KEY (staff_id, service_id),
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS staff_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL, -- 0=Sunday, 1=Monday, ..., 6=Saturday
      start_time TEXT NOT NULL,     -- '08:30'
      end_time TEXT NOT NULL,       -- '17:00'
      break_start TEXT,             -- '12:30'
      break_end TEXT,               -- '13:30'
      is_working INTEGER DEFAULT 1,
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      UNIQUE(staff_id, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      booking_reference TEXT NOT NULL UNIQUE,
      user_id TEXT,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      service_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      date TEXT NOT NULL,          -- 'YYYY-MM-DD'
      start_time TEXT NOT NULL,    -- 'HH:MM'
      end_time TEXT NOT NULL,      -- 'HH:MM'
      duration_minutes INTEGER NOT NULL,
      total_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED', -- 'PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'
      cancellation_reason TEXT,
      vehicle_details TEXT,
      customer_notes TEXT,
      staff_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id),
      FOREIGN KEY (staff_id) REFERENCES staff(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS slot_holds (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, -- timestamp in ms
      FOREIGN KEY (staff_id) REFERENCES staff(id)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      response_data TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      appointment_id TEXT,
      booking_reference TEXT,
      recipient_name TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      recipient_phone TEXT,
      type TEXT NOT NULL, -- 'CONFIRMATION', 'REMINDER_24H', 'REMINDER_2H', 'RESCHEDULED', 'CANCELLED', 'STATUS_CHANGE'
      channel TEXT NOT NULL, -- 'EMAIL', 'SMS'
      subject TEXT,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'DELIVERED',
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `;

  db.exec(schema);

  // Check if user_id or idempotency_key column exists in existing appointments table
  const colCheck = db.prepare(`PRAGMA table_info(appointments)`).all();
  if (!colCheck.some(c => c.name === 'user_id')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN user_id TEXT;`);
  }
  if (!colCheck.some(c => c.name === 'idempotency_key')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN idempotency_key TEXT;`);
  }
  if (!colCheck.some(c => c.name === 'service_ids')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN service_ids TEXT;`);
  }

  // Check if staff_id column exists in existing users table
  const userColCheck = db.prepare(`PRAGMA table_info(users)`).all();
  if (!userColCheck.some(c => c.name === 'staff_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN staff_id TEXT;`);
  }

  // Create indexes after ensuring columns exist
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
    CREATE INDEX IF NOT EXISTS idx_users_staff ON users (staff_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_staff_date ON appointments (staff_id, date, status);
    CREATE INDEX IF NOT EXISTS idx_appointments_ref ON appointments (booking_reference);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments (date);
    CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments (user_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_idempotency ON appointments (idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_slot_holds_lookup ON slot_holds (staff_id, date, expires_at);
  `);

  // Auto-seed if database is empty on clean startup
  try {
    const serviceCount = db.prepare(`SELECT COUNT(*) as count FROM services`).get().count;
    if (serviceCount === 0 && process.env.NODE_ENV !== 'test') {
      import('./seed.js').then(module => {
        module.runSeed();
      }).catch(err => {
        console.warn('Auto-seed notice:', err.message);
      });
    }
  } catch (err) {
    // Ignore during initial migration
  }
}

// Automatically initialize schema on load
initDatabase();

export default db;
