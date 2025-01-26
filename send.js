const nodemailer = require('nodemailer');
const fs = require('fs'); // 引入文件系统模块
const readline = require('readline');
const { convert } = require('html-to-text'); // 引入 html-to-text

// 创建 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 邮件发送配置
let transporter = nodemailer.createTransport({
  host: 'smtp.exmail.qq.com',
  port: 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: 'sns@playvital.com', // 用户名
    pass: 'rLFN9XD5xUzc6i5m', // 授权码
  }
});

// 读取 template 文件夹中的所有 HTML 文件
const templateDir = 'template';
const templates = fs.readdirSync(templateDir).filter(file => file.endsWith('.html'));

if (templates.length === 0) {
  console.log('模板文件夹中没有找到 HTML 文件，请添加模板后重试！');
  process.exit(1);
}

// 显示模板索引
console.log('请选择一个模板文件:');
templates.forEach((file, index) => {
  console.log(`${index + 1}: ${file}`);
});

// 让用户选择模板
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
    wordwrap: 130, // 设置每行最大字符数
  });

  // 提示用户输入收件人邮箱地址
  rl.question('请输入收件人邮箱地址: ', (recipient) => {
    // 检查用户输入是否有效
    if (!recipient || !/\S+@\S+\.\S+/.test(recipient)) {
      console.log('请输入有效的邮箱地址！');
      rl.close();
      return;
    }

    let mailOptions = {
      from: '"PlayVital Gaming" <sns@playvital.com>', // 发件人
      to: recipient, // 收件人
      subject: 'Partnering with PlayVital!', // 主题
      text: textContent, // 纯文本
      html: htmlContent, // html 内容
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.log('邮件发送失败:', error);
      } else {
        console.log('邮件已发送:', info.messageId);
      }
      rl.close(); // 确保在发送邮件完成后关闭 readline
    });
  });
});
