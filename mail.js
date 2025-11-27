import { createTransport } from "nodemailer";
import { readFileSync } from "fs";
import { convert } from "html-to-text";
import * as p from "@clack/prompts";
import colors from "picocolors";

async function main() {
  p.intro("📧 Mailer");

  // 读取配置文件
  const configPath = "./config.json";
  let config;
  try {
    const configContent = readFileSync(configPath, "utf8");
    config = JSON.parse(configContent);
  } catch (error) {
    p.cancel("Can't read config.json: " + error.message);
    process.exit(1);
  }

  // 选择模板
  const templateChoices = config.emails.map((email, index) => ({
    value: index,
    label: `${email.template} (${email.name})`,
  }));

  const selectedEmailIndex = await p.select({
    message: "Choose the template",
    options: templateChoices,
  });

  if (p.isCancel(selectedEmailIndex)) {
    p.cancel("Canceled");
    process.exit(0);
  }

  const selectedEmail = config.emails[selectedEmailIndex];

  // 创建邮件发送器
  let transporter = createTransport(selectedEmail);

  // 读取模板文件
  const templatePath = `./template/${selectedEmail.template}`;
  if (!templatePath || typeof templatePath !== "string") {
    p.cancel("配置文件中未指定有效的模板路径！");
    process.exit(1);
  }

  let htmlContent;
  try {
    htmlContent = readFileSync(templatePath, "utf8");
  } catch (error) {
    p.cancel("无法读取模板文件: " + error.message);
    process.exit(1);
  }

  // 将 HTML 转换为纯文本
  const textContent = convert(htmlContent, {
    wordwrap: 130,
  });

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

  const recipients = recipientsInput
    .split(",")
    .map((email) => email.trim())
    .filter((email) => /\S+@\S+\.\S+/.test(email));

  // 创建进度条
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
      // 使用 Promise 包装 sendMail
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
    `template: ${selectedEmail.template} | success: ${completed}, fail: ${failed}`,
  );

  if (failed > 0) {
    p.log.error(
      `${failures.map((f) => `• ${colors.red(f.recipient)}`).join("\n")}`,
    );
  } else {
    p.log.success(`All done! ${completed} emails sent successfully.`);
  }
}

// 运行主函数
main().catch((error) => {
  p.cancel("Error: " + error.message);
  process.exit(1);
});
