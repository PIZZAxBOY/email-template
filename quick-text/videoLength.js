let platform = await this.quicktext.getTag("input", "平台");
let type = output;

console.log(type);

let message = `
  <div>## Video Length</div>
  <p>We're flexible, but ideally **[[INPUT=视频时长(分钟)]] min**. This allows enough time for an engaging and
  informative review without being too lengthy for your viewers. <br>
  </p>
`;

type = type.toLowerCase();
platform = platform.toLowerCase();

switch (platform) {
  case "youtube":
    return message;
  case "instagram":
    if (type === "reel") {
      return message;
    }
    return ""; // 如果不是 Reels，则返回空字符串
  default:
    return message;
}
