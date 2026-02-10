import { Database } from "bun:sqlite";

const db = new Database("./db/recipients.db");

function ensureTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      email TEXT NOT NULL UNIQUE,
      last_sent INTEGER NOT NULL
    )
`);
}

class Recorder {
  constructor() {
    // 不需要初始化属性
  }
  searchSentTime(email) {
    return db
      .query(`
      SELECT last_sent FROM records WHERE email = ?
    `)
      .get(email)?.last_sent;
  }
  // 保存记录（单条）
  insertRecord(email, sentTime) {
    db.query(`
    INSERT OR REPLACE INTO records (email, last_sent)
    VALUES (?,?)
  `).run(email, sentTime);
  }

  // 批量保存记录
  insertRecords(records) {
    const insert = db.query(`
      INSERT INTO records (email, last_sent)
      VALUES (?,?)
      ON CONFLICT(email) DO UPDATE SET
      last_sent = excluded.last_sent
      WHERE records.last_sent != excluded.last_sent
    `);

    let changes = 0;

    const insertRows = db.transaction((records) => {
      for (const record of records) {
        const change = insert.run(record.email, record.last_sent).changes;
        changes += change;
      }
    });

    insertRows(records);

    return changes;
  }

  deleteDueRecords(dueDate) {
    return db
      .query(`
      DELETE FROM "records" where last_sent < ?
    `)
      .run(dueDate);
  }
}

ensureTable();
export const recorder = new Recorder();
