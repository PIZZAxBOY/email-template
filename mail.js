import { createTransport } from "nodemailer";
import { ImapFlow } from "imapflow";
import { convert } from "html-to-text";
import * as p from "@clack/prompts";
import colors from "picocolors";
import config from "./config.json";
import { recorder } from "./db";

const s = p.spinner({
  indicator: "dots",
  cancelMessage: "操作取消",
  delay: 50,
});

const MS_PER_DAY = 1000 * 60 * 60 * 24;

main().catch((error) => {
  p.log.error(colors.redBright(error.message));
  process.exit(1);
});

async function main() {
  console.log(
    colors.yellow(`
                                                                      z 
                                                                    z
    ██╗      █████╗ ███████╗██╗   ██╗███╗   ███╗ █████╗ ██╗██╗     z
    ██║     ██╔══██╗╚══███╔╝╚██╗ ██╔╝████╗ ████║██╔══██╗██║██║     
    ██║     ███████║  ███╔╝  ╚████╔╝ ██╔████╔██║███████║██║██║     
    ██║     ██╔══██║ ███╔╝    ╚██╔╝  ██║╚██╔╝██║██╔══██║██║██║     
    ███████╗██║  ██║███████╗   ██║   ██║ ╚═╝ ██║██║  ██║██║███████╗
    ╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝
    `),
  );
  await cleanData();

  if (!(await Bun.file("./secrets.json").exists())) {
    const since = await setAccount("init");
    const changes = colors.yellow(colors.bold(await searchSentMails(since)));
    s.stop(`更新了 ${changes} 条记录`);
  } else {
    const changes = colors.yellow(colors.bold(await searchSentMails()));
    s.stop(`更新了 ${changes} 条记录`);
  }

  const accounts = await Bun.file("./secrets.json").json();
  const selectedAccount = await chooseAccount(accounts);
  displayStatus(selectedAccount.smtp.auth.user);

  if (config.length === 0) {
    throw new Error(`未找到任何配置！请添加配置 => ./config.json`);
  }

  // 选择模板
  const templateChoices = config.map((email, index) => ({
    value: index,
    label: `${email.name}`,
  }));

  const selectedEmailIndex = checkCancel(
    await p.select({
      message: "选择一个模板",
      options: templateChoices,
    }),
  );

  const selectedEmail = config[selectedEmailIndex];

  // 读取模板文件
  const templatePath = `template/${selectedEmail.template}`;

  if (!templatePath || typeof templatePath !== "string") {
    p.cancel("配置文件中未指定有效的模板路径！");
    process.exit(1);
  }

  const html = Bun.file(templatePath);
  const exists = await html.exists();

  if (!exists) {
    throw new Error(`文件不存在`);
  }

  const htmlContent = await html.text();

  // 将 HTML 转换为纯文本
  const textContent = convert(htmlContent, {
    wordwrap: 130,
  });

  const choice = checkCancel(
    await p.confirm({
      message: `是否通过文件导入待发送收件人${colors.greenBright("(当前目录下的 sendbox.txt)")}`,
    }),
  );

  const recipients = await getReceipients(choice);
  const filteredReci = await filterRecipients(recipients);

  const skipped = recipients.length - filteredReci.length;

  p.box(`跳过了 ${skipped} 个邮箱`);

  const result = filteredReci
    .map((i) => {
      return colors.green(i);
    })
    .join("\n");

  p.box(result, colors.bold(colors.blue(`待发送：${filteredReci.length} 个`)));

  const sendConfirm = checkCancel(
    await p.confirm({
      message: "是否确认并发送？",
    }),
  );

  if (!sendConfirm) {
    p.cancel("操作取消");
    process.exit(0);
  }

  const { done, failed } = await sendMails(
    selectedAccount.smtp,
    filteredReci,
    selectedEmail,
    textContent,
    htmlContent,
  );

  if (done || failed) {
    showResult(done, failed);
  }

  p.outro("byebye");
  process.exit(0);
}

async function getReceipients(choice) {
  if (choice) {
    const sendbox = Bun.file("./sendbox.txt");
    const text = await sendbox.text();
    const arr = text
      .split("\n")
      .map((email) => email.trim())
      .filter((email) => /\S+@\S+\.\S+/.test(email));

    const set = new Set(arr);
    const recipients = Array.from(set);
    return recipients;
  } else {
    // 输入收件人邮箱地址
    const recipientsInput = checkCancel(
      await p.text({
        message:
          "在下方输入收件人的地址，多个收件人请使用" +
          colors.redBright(colors.bold("英语逗号分割")),
        placeholder: "example@email.com, test@email.com",
        validate: (value) => {
          if (!value) return "请输入至少一个邮箱地址";
          const recipients = value
            .split(",")
            .map((email) => email.trim())
            .filter((email) => /\S+@\S+\.\S+/.test(email));
          if (recipients.length === 0) return "请输入有效的邮箱地址";
          return;
        },
      }),
    );

    const recipient = recipientsInput
      .split(",")
      .map((email) => email.trim())
      .filter((email) => /\S+@\S+\.\S+/.test(email));

    return recipient;
  }
}

/**
 * @param {Object} smtpConfig - SMTP 配置（包含 host, port, auth 等）
 * @param {Array.<string>} recipients - 收件人数组
 * @param {Object} selectedEmail - 选中的模板对象
 * @param {string} textContent - 纯文本内容
 * @param {string} htmlContent - HTML 内容
 * */
async function sendMails(
  smtpConfig,
  recipients,
  selectedEmail,
  textContent,
  htmlContent,
) {
  const progress = p.progress({
    size: process.stdout.columns - 70,
    max: recipients.length,
    style: "block",
    frames: ["󱡯 "],
  });

  progress.start(`使用模板 ${selectedEmail.template}`);

  let transporter = createTransport({
    // 设置连接池
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    ...smtpConfig,
    ...selectedEmail,
  });

  const done = [];
  const failed = [];
  const skipped = [];

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    const isLast = i === recipients.length - 1;
    let mailOptions = {
      from: selectedEmail.from,
      to: recipient,
      subject: selectedEmail.subject,
      text: textContent,
      html: htmlContent,
    };

    try {
      await transporter.sendMail(mailOptions);
      done.push(recipient);
      // 记录存入数据库
      recorder.insertRecord(recipient, Date.now());
    } catch (error) {
      failed.push({ recipient, error: error.message || String(error) });
    } finally {
      progress.advance(
        1,
        `发送中 ${done.length + failed.length + skipped.length}/${recipients.length}`,
      );
      // 如果是最后一个收件人，停留半秒
      if (isLast) {
        Bun.sleep(800);
      }
    }
  }

  progress.stop();

  return {
    done,
    failed,
  };
}

async function filterRecipients(recipients) {
  const recipientsSet = new Set(recipients);
  const hang = 30;

  const rawFile = await Bun.file("./blacklist.txt").text();

  const blacklist = rawFile.replace("\r", "").split("\n").filter(Boolean);

  const filtered = [...recipientsSet].filter((i) => {
    const sentTime = recorder.searchSentTime(i)?.last_sent;
    return (
      (sentTime < Date.now() - MS_PER_DAY * hang || !sentTime) &&
      !blacklist.includes(i)
    );
  });
  return filtered;
}

function showResult(done, failed) {
  const divider = (message) => {
    const col = process.stdout.columns - message.length - 10;

    return colors.bold(colors.italic(message)) + " " + "─".repeat(col);
  };
  const completeResult =
    done.length > 0 ? colors.greenBright(done.join("\n")) : "";

  const failResult =
    failed.length > 0
      ? failed
          .map(
            (obj) =>
              obj.recipient + "\n└╴" + colors.redBright(" " + obj.error),
          )
          .join("\n")
      : "";

  let boxContent = "";

  if (completeResult)
    boxContent += `${divider("Completed")}\n${completeResult}\n`;

  if (failResult) boxContent += `${divider("Failed")}\n${failResult}\n`;

  p.box(
    boxContent,
    `${colors.green("\uebb3")}  ${done.length}  ${colors.red(" ")} ${failed.length}`,
  );
}

async function cleanData() {
  if (process.argv.length > 1 && process.argv[2] === "clean") {
    const input = process?.argv[3];
    if (!input || isNaN(new Date(input)))
      throw new Error("至少输入一个有效日期!");
    const date = new Date(input);

    const confirm = checkCancel(
      await p.confirm({
        message: `确定删除 ${colors.cyanBright(date)} 之前的记录吗?`,
      }),
    );

    if (confirm) {
      const result = cleanRecords(date.getTime());
      p.log.message(`删除了 ${colors.yellow(result)} 条记录`);
    }
    p.outro("byebye");
    process.exit(1);
  }
}

function cleanRecords(input = MS_PER_DAY * 30) {
  const dueDate = new Date(input);
  const result = recorder.deleteDueRecords(dueDate);
  return result?.changes;
}

async function setAccount(option) {
  const account = checkCancel(
    await p.text({
      message: "QQ 邮箱账号",
      placeholder: "example@email.com",
      validate: (value) => {
        if (!value) return "请输入至少一个邮箱地址";
        const recipients = value
          .split(",")
          .map((email) => email.trim())
          .filter((email) => /\S+@\S+\.\S+/.test(email));
        if (recipients.length === 0) return "请输入有效的邮箱地址";
        return;
      },
    }),
  );

  const password = checkCancel(
    await p.password({
      message: "邮箱授权码",
    }),
  );

  const range = checkCancel(
    await p.select({
      message: "选择需要筛选的时间范围",
      options: [
        { label: "60 天", value: 60 },
        { label: "30 天", value: 30 },
        { label: "20 天", value: 20 },
      ],
    }),
  );

  const since = new Date(Date.now() - MS_PER_DAY * range);

  let newContent = [];

  const content = {
    imap: {
      host: "imap.exmail.qq.com",
      port: "993",
      secure: true,
      logger: false,
      auth: {
        user: account,
        pass: password,
      },
    },
    // 发件服务器
    smtp: {
      host: "smtp.exmail.qq.com",
      port: "465",
      secure: true,
      logger: false,
      auth: {
        user: account,
        pass: password,
      },
    },
    selected: true,
  };

  // 第一次启动写入 secrets.json
  if (option === "init") {
    newContent = [content];
    // 添加账号方法
  } else if (option === "add") {
    const original = await Bun.file("./secrets.json").json();
    newContent = [...original, content];
  }

  await Bun.write("./secrets.json", JSON.stringify(newContent, null, 2));

  return since;
}

async function searchSentMails(since) {
  const accounts = await Bun.file("./secrets.json").json();
  const choice = await chooseAccount(accounts);
  const client = new ImapFlow(choice.imap);
  await client.connect();
  let lock = await client.getMailboxLock("Sent messages");

  let changes = 0;

  try {
    s.start("初始化数据");
    let sinceDate;
    // 加两天确保搜索结果包括了今天
    const beforeDate = new Date(Date.now() + MS_PER_DAY * 2);

    // 调用时是否使用 since 如果没有就使用 lastrun
    const lastrun = choice?.lastrun;

    if (since) {
      sinceDate = since;
    } else if (lastrun) {
      sinceDate = new Date(lastrun - MS_PER_DAY * 2);
    }

    s.message("从服务器获取邮件信息");

    const result = await client.search(
      { since: sinceDate, before: beforeDate },
      { uid: true },
    );

    if (result.length > 0) {
      const messages = await client.fetchAll(
        result,
        { envelope: true },
        { uid: true },
      );

      s.message("写入中");

      const records = {};
      for (const m of messages) {
        const recipient = m.envelope.to[0].address;
        const date = m.envelope.date.getTime();

        if (records[recipient]) {
          if (records[recipient] < date) {
            records[recipient] = date;
          }
        }

        records[recipient] = date;
      }

      // 转换为数组格式
      const recordsArray = Object.entries(records).map(
        ([email, last_sent]) => ({
          email,
          last_sent,
        }),
      );
      changes = recorder.insertRecords(recordsArray);
    }
  } catch (err) {
    throw err;
  } finally {
    lock.release();
  }

  await client.logout();

  // 记录下运行时间
  const run_time = Date.now();
  choice.lastrun = run_time;

  await Bun.write("./secrets.json", JSON.stringify(accounts, null, 2));

  return changes;
}

function checkCancel(value, message = "操作取消") {
  if (p.isCancel(value)) {
    p.cancel(message);
    process.exit(0);
  }

  return value;
}

// 在终端右上角显示当前账号
function displayStatus(message) {
  const row = 1;
  const col = Math.max(1, process.stdout.columns - message.length - 5);
  // 保存当前光标位置
  process.stderr.write("\x1b[s");
  process.stderr.write(`\x1b[${row};${col}H`);
  process.stderr.write(` :${colors.italic(colors.yellow(message))}`);
  // 恢复光标位置
  process.stderr.write("\x1b[u");
}

async function chooseAccount(accounts) {
  // 检查是否有账号已被选中
  const selectedIndex = accounts.findIndex((item) => item?.selected);

  let choice;

  if (selectedIndex === -1) {
    const options = accounts.map((account) => ({
      label: account.imap.auth.user,
      value: account,
    }));

    choice =
      accounts.length === 1
        ? accounts[0]
        : checkCancel(await p.select({ message: "选择账号", options }));
  } else {
    choice = accounts[selectedIndex];
  }

  return choice;
}
