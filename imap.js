import { ImapFlow } from "imapflow";
import imap from "./key.json5";
import { recorder } from "./db";

const client = new ImapFlow(imap.client);

export async function searchSentMails() {
  await client.connect();
  let lock = await client.getMailboxLock("Sent messages");

  try {
    let sinceDate;
    const beforeDate = new Date();

    const MS_PER_DAY = 1000 * 60 * 60 * 24;

    const lastrun = imap.lastrun;
    if (lastrun) {
      sinceDate = new Date(lastrun - MS_PER_DAY);
    } else {
      sinceDate = new Date(Date.now() - 30 * MS_PER_DAY);
    }

    console.log(`since: ${sinceDate} before: ${beforeDate}`);
    const result = await client.search(
      { since: sinceDate, before: beforeDate },
      { uid: true },
    );

    console.log(result);

    if (result.length > 0) {
      const messages = await client.fetchAll(
        result,
        { envelope: true },
        { uid: true },
      );

      const records = {};
      for (const m of messages) {
        const recipient = m.envelope.to[0].address;
        const date = m.envelope.date.getTime();
        console.log(new Date(date));

        if (records[recipient]) {
          if (records[recipient] < date) {
            records[recipient] = date;
          }
        }

        records[recipient] = date;
      }

      // 保存到数据库
      console.time("写入数据库");
      // 转换为数组格式
      const recordsArray = Object.entries(records).map(
        ([email, last_sent]) => ({
          email,
          last_sent,
        }),
      );
      recorder.insertRecords(recordsArray);
      console.timeEnd("写入数据库");
    }
  } catch (err) {
    console.error("错误：", err);
  } finally {
    lock.release();
  }

  await client.logout();

  const run_time = Date.now();
  // 记录下运行时间
  imap.lastrun = run_time;
  Bun.write("./key.json5", Bun.JSON5.stringify(imap), null, 2);
}

searchSentMails();
