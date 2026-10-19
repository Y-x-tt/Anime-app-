const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.resolve(
  process.env.DB_PATH || './data/hunter.db'
);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    device_id TEXT,
    faction TEXT NOT NULL DEFAULT '',
    points INTEGER NOT NULL DEFAULT 0,
    quiz_score INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS point_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS quiz_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    answer_index INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, question_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS case_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    conclusion TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    reviewed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

function addColumnIfMissing(table, column, definition) {
  const allowed = {
    users: ['device_id', 'faction', 'quiz_score']
  };

  if (!allowed[table] || !allowed[table].includes(column)) {
    throw new Error('اسم الجدول أو العمود غير مسموح.');
  }

  const columns = db.prepare(
    `PRAGMA table_info("${table}")`
  ).all();

  if (!columns.some(item => item.name === column)) {
    db.exec(
      `ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`
    );
  }
}

addColumnIfMissing('users', 'device_id', 'TEXT');

addColumnIfMissing(
  'users',
  'faction',
  "TEXT NOT NULL DEFAULT ''"
);

addColumnIfMissing(
  'users',
  'quiz_score',
  'INTEGER NOT NULL DEFAULT 0'
);

function addPoints(userId, amount, reason) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('قيمة النقاط غير صحيحة.');
  }

  const transaction = db.transaction(() => {
    const user = db.prepare(
      'SELECT id FROM users WHERE id = ?'
    ).get(userId);

    if (!user) {
      throw new Error('المستخدم غير موجود.');
    }

    db.prepare(
      'UPDATE users SET points = points + ? WHERE id = ?'
    ).run(amount, userId);

    db.prepare(`
      INSERT INTO point_logs (user_id, amount, reason)
      VALUES (?, ?, ?)
    `).run(userId, amount, String(reason).slice(0, 200));
  });

  transaction();
}

function getLeaderboard(limit = 50) {
  return db.prepare(`
    SELECT username, faction, points
    FROM users
    ORDER BY points DESC, username ASC
    LIMIT ?
  `).all(limit);
}

function getFactionScores() {
  return db.prepare(`
    SELECT faction, SUM(points) AS points, COUNT(*) AS members
    FROM users
    WHERE faction != ''
    GROUP BY faction
    ORDER BY points DESC
  `).all();
}

module.exports = {
  db,
  addPoints,
  getLeaderboard,
  getFactionScores
};
