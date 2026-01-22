import { createTransport } from "nodemailer";
import { convert } from "html-to-text";
import * as p from "@clack/prompts";
import colors from "picocolors";
import config from "./config.json";

// 在终端右下角显示状态信息
function displayStatus(message) {
  const row = 1;
  const col = Math.max(1, process.stdout.columns - message.length - 5);
  // 保存当前光标位置
  process.stderr.write("\x1b[s");
  process.stderr.write(`\x1b[${row};${col}H`);
  process.stderr.write(`󰀆 : ${colors.italic(colors.yellow(message))}`);
  // 恢复光标位置
  process.stderr.write("\x1b[u");
}

async function main() {
  // 清空终端
  process.stdout.write("\x1b[2J\x1b[0;0H");

  p.box("📧 a simple template batch sending script", "Mailer", {
    rounded: true,
  });

  p.note(`${colors.dim("↑↓/jk Navigate")}`, "Instructions");

  if (config.length === 0) {
    throw new Error(`未找到任何配置！请重新在此目录下创建配置文件`);
  }

  // 选择模板
  const templateChoices = config.emails.map((email, index) => ({
    value: index,
    label: `${email.name} ${colors.cyan(email.auth.user)}`,
  }));

  const selectedEmailIndex = await p.select({
    message: "Choose a template",
    options: templateChoices,
  });

  if (p.isCancel(selectedEmailIndex)) {
    p.cancel("Canceled");
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
    p.cancel("canceled");
    process.exit(0);
  }

  const recipients = await getReceipients(choice);

  const s = p.spinner();
  s.start(
    `Using ${selectedEmail.template}, ${recipients.length} receipients in total`,
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
      s.message(`Progress: ${completed}/${recipients.length}`);
    } catch (error) {
      failed++;
      failures.push({ recipient, error: error.message });

      s.message(
        `Progress: ${completed}/${recipients.length} (Failed: ${failed})`,
      );
    }
  }

  // 完成后显示总结
  s.stop(
    `${selectedEmail.template} | ${colors.green("\uebb3")}  ${completed} ${colors.red("\ue654")}  ${failed}`,
  );

  if (failed > 0) {
    p.log.warning(
      `${colors.yellowBright("Failed recipients")}: ${failures.map((f) => `${f.recipient}`).join(",")}`,
    );
  } else {
    p.log.success(
      `${colors.green("All done!")} ${completed} emails sent successfully.`,
    );
  }
  p.outro("End...");
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
      message: "Input recipients email adresses here. (use comma to separate)",
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
      p.cancel("canceled");
      process.exit(0);
    }

    const recipient = recipientsInput
      .split(",")
      .map((email) => email.trim())
      .filter((email) => /\S+@\S+\.\S+/.test(email));

    return recipient;
  }
}
