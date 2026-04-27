import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const DB_DIR = "./db";
const DB_FILE = `${DB_DIR}/recipients.db`;

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_FILE);

function hasColumn(table, column) {
  return db
    .query(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column);
}

function ensureTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      sender_email TEXT NOT NULL,
      email TEXT NOT NULL,
      last_sent INTEGER NOT NULL,
      UNIQUE(sender_email, email)
    )
  `);

  if (!hasColumn("records", "sender_email")) {
    db.run(`DROP TABLE records`);
    db.run(`
      CREATE TABLE records (
        sender_email TEXT NOT NULL,
        email TEXT NOT NULL,
        last_sent INTEGER NOT NULL,
        UNIQUE(sender_email, email)
      )
    `);
  }
}

class Recorder {
  constructor() {
    // 不需要初始化属性
  }

  searchSentTime(senderEmail, email) {
    return db
      .query(`
        SELECT last_sent FROM records WHERE sender_email = ? AND email = ?
      `)
      .get(senderEmail, email)?.last_sent;
  }

  // 保存记录（单条）
  insertRecord(senderEmail, email, sentTime) {
    db.query(`
      INSERT INTO records (sender_email, email, last_sent)
      VALUES (?, ?, ?)
      ON CONFLICT(sender_email, email) DO UPDATE SET
        last_sent = excluded.last_sent
      WHERE records.last_sent != excluded.last_sent
    `).run(senderEmail, email, sentTime);
  }

  // 批量保存记录
  insertRecords(records) {
    const insert = db.query(`
      INSERT INTO records (sender_email, email, last_sent)
      VALUES (?, ?, ?)
      ON CONFLICT(sender_email, email) DO UPDATE SET
        last_sent = excluded.last_sent
      WHERE records.last_sent != excluded.last_sent
    `);

    let changes = 0;

    const insertRows = db.transaction((records) => {
      for (const record of records) {
        const change = insert.run(
          record.sender_email,
          record.email,
          record.last_sent,
        ).changes;
        changes += change;
      }
    });

    insertRows(records);

    return changes;
  }

  deleteDueRecords(dueDate) {
    return db
      .query(`
        DELETE FROM records WHERE last_sent < ?
      `)
      .run(dueDate);
  }

  deleteAllRecords() {
    return db.query(`DELETE FROM records`).run();
  }
}

ensureTable();
export const recorder = new Recorder();
