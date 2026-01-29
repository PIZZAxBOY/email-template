import { Database } from "bun:sqlite";

const db = new Database("./db/receipients.db");

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

export const mailFinder = {
  // 保存发送记录
  insertRecord: db.prepare(`
    INSERT OR REPLACE INTO records (email, last_sent)
    VALUES (?,?)
  `),
};
