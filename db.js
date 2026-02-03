import { Database } from "bun:sqlite";

const db = new Database("./db/recipients.db");

export const recorder = new Recorder();
ensureTable();

function ensureTable() {
  console.log("初始化数据库");
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
      .get(email);
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
      INSERT OR REPLACE INTO records (email, last_sent)
      VALUES (?,?)
    `);

    const transaction = db.transaction((records) => {
      for (const record of records) {
        insert.run(record.email, record.last_sent);
      }
    });

    transaction(records);
  }
}
