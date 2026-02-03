import { searchSentMails } from "./imap";
import { createTransport } from "nodemailer";
import { convert } from "html-to-text";
import * as p from "@clack/prompts";
import colors from "picocolors";
import config from "./config.json";
import { recorder } from "./db";

main().catch((error) => {
  p.log.error(colors.redBright(error.message));
  process.exit(1);
});

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
  if (config.length === 0) {
    throw new Error(`未找到任何配置！请重新在此目录下创建配置文件`);
  }

  // 选择模板
  const templateChoices = config.emails.map((email, index) => ({
    value: index,
    label: `${email.name} ${colors.cyan(email.auth.user)}`,
  }));

  const selectedEmailIndex = await p.select({
    message: "选择一个模板",
    options: templateChoices,
  });

  if (p.isCancel(selectedEmailIndex)) {
    p.cancel("操作取消");
    process.exit(0);
  }

  const selectedEmail = config.emails[selectedEmailIndex];

  displayStatus(`${selectedEmail.auth.user}`);

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

  const choice = await p.confirm({
    message: "是否通过文件导入待发送收件人(当前目录下的 sendbox.txt)",
  });

  if (p.isCancel(choice)) {
    p.cancel("操作取消");
    process.exit(0);
  }

  const recipients = await getReceipients(choice);

  const result = recipients
    .map((i) => {
      return colors.green(i);
    })
    .join("\n");

  p.box(result, colors.bold(colors.blue(`待发送：${recipients.length} 个`)));

  const sendConfirm = await p.confirm({
    message: "是否确认并发送？",
  });

  if (!sendConfirm || p.isCancel(sendConfirm)) {
    p.cancel("操作取消");
    process.exit(0);
  }

  await sendMails(recipients, selectedEmail, textContent, htmlContent);

  p.outro("byebye");
  process.exit(1);
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
    const recipientsInput = await p.text({
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
    });

    if (p.isCancel(recipientsInput)) {
      p.cancel("操作取消");
      process.exit(0);
    }

    const recipient = recipientsInput
      .split(",")
      .map((email) => email.trim())
      .filter((email) => /\S+@\S+\.\S+/.test(email));

    return recipient;
  }
}

/**
 * @param {Array.<string>} recipients - 收件人数组
 * @param {Object} selectedEmail - 选中的模板对象
 * @param {string} textContent - 纯文本内容
 * @param {string} htmlContent - HTML 内容
 * */
async function sendMails(recipients, selectedEmail, textContent, htmlContent) {
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
    ...selectedEmail,
  });

  const completed = [];
  const failures = [];
  const skipped = [];

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    const isLast = i === recipients.length - 1;
    let status = "completed";
    let mailOptions = {
      from: selectedEmail.from,
      to: recipient,
      subject: selectedEmail.subject,
      text: textContent,
      html: htmlContent,
    };

    try {
      const currentTime = Date.now();
      const result = recorder.searchSentTime(recipient);
      const sentTime = result?.last_sent;
      if (sentTime) {
        const dayBetween = (currentTime - sentTime) / (24 * 60 * 60 * 1000);
        // 判断发送间隔是否大于 30 天
        if (dayBetween < 30) {
          skipped.push(recipient);
          status = "skipped";
          continue;
        }
      }
      await transporter.sendMail(mailOptions);
      completed.push(recipient);
      // 记录存入数据库
      recorder.insertRecord(recipient, currentTime);
      status = "failed";
    } catch (error) {
      failures.push({ recipient, error: error.message || String(error) });
    } finally {
      progress.advance(
        1,
        `发送中 ${completed.length + failures.length + skipped.length}/${recipients.length}` +
          (status === "skipped" ? ` 跳过：${recipient}` : ""),
      );
      // 如果是最后一个收件人，停留半秒
      if (isLast) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  progress.stop();

  const divider = (message) => {
    const col = process.stdout.columns - message.length - 10;

    return colors.bold(colors.italic(message)) + " " + "─".repeat(col);
  };
  const completeResult =
    completed.length > 0 ? colors.greenBright(completed.join("\n")) : "";
  const skipResult =
    skipped.length > 0 ? colors.blueBright(skipped.join("\n")) : "";
  const failResult =
    failures.length > 0
      ? failures
          .map(
            (obj) =>
              obj.recipient + "\n└╴" + colors.redBright(" " + obj.error),
          )
          .join("\n")
      : "";

  let boxContent = "";
  if (completeResult)
    boxContent += `${divider("Completed")}\n${completeResult}\n`;
  if (skipResult) boxContent += `${divider("Skipped")}\n${skipResult}\n`;
  if (failResult) boxContent += `${divider("Failed")}\n${failResult}\n`;

  p.box(
    boxContent,
    `${selectedEmail.template} | ${colors.green("\uebb3")}  ${completed.length}  ${colors.red(" ")} ${failures.length}  ${colors.blueBright(" ")} ${skipped.length}`,
  );

  return {
    completed,
    failures,
    skipped,
  };
}
