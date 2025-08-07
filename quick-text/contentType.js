let platform = await this.quicktext.getTag("input", "平台");
console.log(`平台为：${platform}`);
platform = platform.toLowerCase();
let type;

if (platform === "instagram") {
  type = await this.quicktext.getTag(
    "input",
    "产出类型",
    "select",
    "post;reel",
  );
} else if (platform === "youtube") {
  type = await this.quicktext.getTag(
    "input",
    "产出类型",
    "select",
    "shorts;Integration;dedicated video",
  );
}
// 空值检查
if (!platform) {
  return "No input provided!";
}

output = type; // output 设置为 type

// 转为小写进行比较

switch (platform) {
  case "youtube":
    return type;
  case "instagram":
    return type;
  default:
    output = "tiktok";
    return "TikTok video";
}
