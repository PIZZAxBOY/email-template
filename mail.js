import { createTransport } from "nodemailer";
import { convert } from "html-to-text";
import * as p from "@clack/prompts";
import colors from "picocolors";
import config from "./config.json";

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
  // 清空终端
  process.stdout.write("\x1b[2J\x1b[0;0H");

  p.box("📧 一个简单的 MJML 邮件发送脚本", "Mailer", {
    rounded: true,
  });

  p.note(`${colors.dim("↑↓/jk 切换选项")}`, "指引");

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

  // 创建邮件发送器
  let transporter = createTransport(selectedEmail);

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

  const progress = p.progress({
    max: recipients.length,
    style: "block",
    frames: ["󱡯 "],
  });
  progress.start(
    `使用模板 ${selectedEmail.template}， 一共 ${recipients.length} 个收件人`,
  );

  // 将邮件列表转换为 Async Iterator
  async function* emailStream(recipientList) {
    for (const recipient of recipientList) {
      yield recipient;
    }
  }

  let completed = 0;
  let failed = 0;
  const failures = [];

  // 使用 for await 处理邮件流
  for await (const recipient of emailStream(recipients)) {
    let mailOptions = {
      from: selectedEmail.from,
      to: recipient,
      subject: selectedEmail.subject,
      text: textContent,
      html: htmlContent,
    };

    try {
      await new Promise((resolve, reject) => {
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) reject(error);
          else resolve(info);
        });
      });

      completed++;
      progress.advance(1, `正在发送 ${completed}/${recipients.length}`);
    } catch (error) {
      failed++;
      failures.push({ recipient, error: error.message });

      progress.advance(
        1,
        `发送 ${completed}/${recipients.length} (失败: ${failed})`,
      );
    }
  }

  // 完成后显示总结
  progress.stop(
    `${selectedEmail.template} | ${colors.green("\uebb3")}  ${completed} ${colors.red("\ue654")}  ${failed}`,
  );

  if (failed > 0) {
    p.log.warning(
      `${colors.yellowBright("送信失败")}: ${failures.map((f) => `${f.recipient}`).join(",")}`,
    );
  } else {
    p.log.success(
      colors.green(colors.buld("全部发送成功：")) +
        "发送了 ${completed} 封邮件 ",
    );
  }
  p.outro("byebye");
}

main().catch((error) => {
  p.log.error(colors.redBright(error.message));
  process.exit(1);
});

// 让用户选择如何 输入收件人邮箱
async function getReceipients(choice) {
  if (choice) {
    const sendbox = Bun.file("./sendbox.txt");
    const text = await sendbox.text();
    const receipients = text
      .split("\n")
      .map((email) => email.trim())
      .filter((email) => /\S+@\S+\.\S+/.test(email));
    return receipients;
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
