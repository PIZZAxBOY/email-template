const nodemailer = require('nodemailer');
const fs = require('fs');
const readline = require('readline');
const { convert } = require('html-to-text');
const config = require('../obsidian/config');

// 创建 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 显示可用的邮箱账号
console.log('请选择发件邮箱:');
config.emails.forEach((email, index) => {
  console.log(`${index + 1}: ${email.name} (${email.auth.user})`);
});

// 让用户选择邮箱账号
rl.question('请输入邮箱账号编号: ', (emailIndex) => {
  const selectedEmailIndex = parseInt(emailIndex, 10) - 1;

  if (isNaN(selectedEmailIndex) || selectedEmailIndex < 0 || selectedEmailIndex >= config.emails.length) {
    console.log('无效的邮箱账号编号，请重新运行脚本！');
    rl.close();
    return;
  }

  const selectedEmail = config.emails[selectedEmailIndex];
  // 创建邮件发送器
  let transporter = nodemailer.createTransport(selectedEmail);

  // 读取 template 文件夹中的所有 HTML 文件
  const templateDir = 'template';
  const templates = fs.readdirSync(templateDir).filter(file => file.endsWith('.html'));

  if (templates.length === 0) {
    console.log('模板文件夹中没有找到 HTML 文件，请添加模板后重试！');
    rl.close();
    process.exit(1);
  }

  // 显示模板索引
  console.log('请选择一个模板文件:');
  templates.forEach((file, index) => {
    console.log(`${index + 1}: ${file}`);
  });

  rl.question('请输入模板编号: ', (templateIndex) => {
    const index = parseInt(templateIndex, 10) - 1;

    if (isNaN(index) || index < 0 || index >= templates.length) {
      console.log('无效的编号，请重新运行脚本并输入正确的编号！');
      rl.close();
      return;
    }

    const selectedTemplate = templates[index];
    const htmlContent = fs.readFileSync(`${templateDir}/${selectedTemplate}`, 'utf8');

    // 将 HTML 转换为纯文本
    const textContent = convert(htmlContent, {
      wordwrap: 130,
    });

    rl.question('请输入收件人邮箱地址: ', (recipient) => {
      if (!recipient || !/\S+@\S+\.\S+/.test(recipient)) {
        console.log('请输入有效的邮箱地址！');
        rl.close();
        return;
      }

      let mailOptions = {
        from: selectedEmail.from,
        to: recipient,
        subject: selectedEmail.subject,
        text: textContent,
        html: htmlContent,
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log('邮件发送失败:', error);
        } else {
          console.log('邮件已发送:', info.messageId);
          console.log(`使用账号: ${selectedEmail.auth.user}`);
        }
        rl.close();
      });
    });
  });
});
