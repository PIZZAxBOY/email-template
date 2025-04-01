const nodemailer = require('nodemailer');
const fs = require('fs');
const readline = require('readline');
const { convert } = require('html-to-text');

// 创建 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 读取配置文件
const configPath = './config.json';
let config;

try {
  const configContent = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configContent);
  console.log('配置文件已加载:', config);
} catch (error) {
  console.log('无法读取配置文件:', error.message);
  rl.close();
  process.exit(1);
}

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

  // 从选中的邮箱配置中读取模板文件路径
  const templatePath = `./template/${selectedEmail.template}`;
  
  // 检查模板文件是否存在
  if (!templatePath || typeof templatePath !== 'string') {
    console.log('配置文件中未指定有效的模板路径！');
    rl.close();
    return;
  }

  let htmlContent;
  try {
    htmlContent = fs.readFileSync(templatePath, 'utf8');
  } catch (error) {
    console.log('无法读取模板文件:', error.message);
    rl.close();
    return;
  }

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