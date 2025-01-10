const nodemailer = require('nodemailer');
const fs = require('fs'); // 引入文件系统模块
const readline = require('readline');
const { convert } = require('html-to-text'); // 引入 html-to-text

// 创建 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});


let transporter = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: 'belugua0@qq.com', // 用户名
    pass: 'xqunartaslyuecfa', // 授权码
  }
})


// 提示用户输入收件人地址
rl.question('请输入收件人邮箱地址: ', (recipient) => {
  // 检查用户输入是否有效
  if (!recipient || !/\S+@\S+\.\S+/.test(recipient)) {
    console.log('请输入有效的邮箱地址！');
    rl.close();
    return;
  }


  //阅读html内容
  const htmlContent = fs.readFileSync('template/二次开发.html', 'utf8');

  // 将 HTML 转换为纯文本
  const textContent = convert(htmlContent, {
    wordwrap: 130, // 设置每行最大字符数
  });

  let mailOptions = {
    from: '"Tom Wu" <belugua0@qq.com>', // 发件人
    to: recipient, //收件人
    subject: 'New Gaming Gear! Lets partner up!', // 主题
    text: textContent, // 纯文本
    html: htmlContent, // html内容
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