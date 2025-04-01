const nodemailer = require('nodemailer');
const fs = require('fs');
const readline = require('readline');
const { convert } = require('html-to-text');
const ProgressBar = require('progress');

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

  rl.question('请输入收件人邮箱地址（多个邮箱用逗号分隔）: ', (recipientsInput) => {
    const recipients = recipientsInput.split(',')
      .map(email => email.trim())
      .filter(email => /\S+@\S+\.\S+/.test(email));

    if (recipients.length === 0) {
      console.log('请输入至少一个有效的邮箱地址！');
      rl.close();
      return;
    }

    // 创建进度条
    const bar = new ProgressBar('发送进度 [:bar] :percent :current/:total :etas', {
      total: recipients.length,
      width: 40,
      complete: '=',
      incomplete: ' ',
    });

    let completed = 0;

    // 递归函数用于逐一发送邮件
    const sendEmail = (recipientIndex) => {
      if (recipientIndex >= recipients.length) {
        console.log('\n所有邮件发送完成！');
        console.log(`使用账号: ${selectedEmail.auth.user}`);
        rl.close();
        return;
      }

      const recipient = recipients[recipientIndex];
      let mailOptions = {
        from: selectedEmail.from,
        to: recipient,
        subject: selectedEmail.subject,
        text: textContent,
        html: htmlContent,
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log(`\n发送给 ${recipient} 失败: ${error.message}`);
        } else {
          completed++;
          bar.tick();
        }
        // 无论成功失败，继续发送下一封
        sendEmail(recipientIndex + 1);
      });
    };

    // 开始发送第一封邮件
    sendEmail(0);
  });
});