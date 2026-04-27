import { spawn } from "node:child_process";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { createTransport } from "nodemailer";
import { ImapFlow } from "imapflow";
import { checkServerIdentity as defaultCheckServerIdentity } from "node:tls";
import { convert } from "html-to-text";
import * as p from "@clack/prompts";
import colors from "picocolors";
import { recorder } from "./db";
import { getAccessToken } from "./auth";
import {
  appendTemplateConfig,
  buildTemplateConfigRecord,
  buildTemplateOptions,
  listHtmlTemplates,
} from "./template-config";

// ==================== 配置常量 ====================
const CONFIG = {
  SECRETS_FILE: "./secrets.json",
  HOSTS_FILE: "./hosts.json",
  CONFIG_FILE: "./config.json",
  BLACKLIST_FILE: "./blacklist.txt",
  TEMPLATE_DIR: "./template/",
  SENDBOX_FILE: "./sendbox.txt",
  MS_PER_DAY: 1000 * 60 * 60 * 24,
};

const UI_CONSTANTS = {
  SPINNER_DELAY: 50,
  FINAL_DELAY_MS: 500,
  PROGRESS_SIZE_OFFSET: 70,
  SMTP_POOL_MAX_CONNECTIONS: 5,
  SMTP_POOL_MAX_MESSAGES: 100,
};

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const MESSAGES = {
  PROMPTS: {
    IMPORT_RECIPIENTS: `是否通过文件导入待发送收件人${colors.greenBright("(当前目录下的 sendbox.txt)")}`,
    CONFIRM_SEND: "是否确认并发送？",
    INPUT_RECIPIENTS:
      "在下方输入收件人的地址，多个收件人请使用" +
      colors.redBright(colors.bold("英语逗号分割")),
  },
  ERRORS: {
    NO_CONFIG: `未找到任何配置！请添加配置 => ${CONFIG.CONFIG_FILE}`,
    FILE_NOT_EXISTS: "文件不存在",
    INVALID_TEMPLATE: "配置文件中未指定有效的模板路径！",
    INVALID_EMAIL: "请输入有效的邮箱地址",
    NO_EMAIL: "请输入至少一个邮箱地址",
    NO_USERNAME: "输入有效用户名",
    INVALID_DATE: "至少输入一个有效日期!",
  },
};

// ==================== 工具函数 ====================
const s = p.spinner({
  indicator: "timer",
  cancelMessage: "操作取消",
  delay: UI_CONSTANTS.SPINNER_DELAY,
});

/**
 * 验证邮箱地址字符串
 * @param {string} value - 包含邮箱地址的字符串
 * @returns {string[]} 有效的邮箱地址数组
 * @throws {Error} 如果没有有效的邮箱地址
 */
function validateEmails(value) {
  if (!value) throw new Error(MESSAGES.ERRORS.NO_EMAIL);

  const recipients = value
    .split(/[,，]/) // 支持中英文逗号
    .map((email) => email.trim())
    .filter((email) => /\S+@\S+\.\S+/.test(email));

  if (recipients.length === 0) throw new Error(MESSAGES.ERRORS.INVALID_EMAIL);

  return recipients;
}

/**
 * 验证邮箱地址字符串（用于 clack/prompts 的 validate）
 * @param {string} value - 包含邮箱地址的字符串
 * @returns {string|undefined} 错误信息或 undefined（验证通过）
 */
function validateEmailInput(value) {
  try {
    validateEmails(value);
    return undefined;
  } catch (error) {
    return error.message;
  }
}

/**
 * 加载 JSON 配置文件
 * @param {string} path - 文件路径
 * @returns {Promise<any>} JSON 数据
 * @throws {Error} 如果文件不存在或加载失败
 */
async function loadConfig(path) {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new Error(`配置文件不存在: ${path}`);
    }
    return await file.json();
  } catch (error) {
    throw new Error(`加载配置失败 ${path}: ${error.message}`);
  }
}

/**
 * 检查用户是否取消了操作
 * @param {any} value - clack/prompts 返回的值
 * @param {string} message - 取消时的提示信息
 * @returns {any} 原始值
 */
function checkCancel(value, message = "操作取消") {
  if (p.isCancel(value)) {
    p.cancel(message);
    process.exit(0);
  }
  return value;
}

/**
 * 显示 Banner 和欢迎信息
 */
function displayBanner() {
  console.log(
    colors.cyanBright(`
                                                                      z
                                                                    z
    ██╗      █████╗ ███████╗██╗   ██╗███╗   ███╗ █████╗ ██╗██╗     z
    ██║     ██╔══██╗╚══███╔╝╚██╗ ██╔╝████╗ ████║██╔══██╗██║██║
    ██║     ███████║  ███╔╝  ╚████╔╝ ██╔████╔██║███████║██║██║
    ██║     ██╔══██║ ███╔╝    ╚██╔╝  ██║╚██╔╝██║██╔══██║██║██║
    ███████╗██║  ██║███████╗   ██║   ██║ ╚═╝ ██║██║  ██║██║███████╗
    ╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝
    `),
  );
  p.intro("今天有点懒zZZ");
}

/**
 * 在终端右上角显示当前账号
 * @param {string} message - 要显示的账号信息
 */
function displayStatus(message) {
  p.log.message(`${colors.italic(colors.yellow(message))}`, {
    symbol: "",
  });
}

if (import.meta.main) {
  main().catch((error) => {
    p.log.error(colors.redBright(error.message));
    process.exit(1);
  });
}

/**
 * 主函数
 */
async function main() {
  displayBanner();

  await ensureTemplateConfig();
  await addTemplateConfig();
  await initializeData();

  const { account, config } = await setupAccount();
  const selectedEmail = await selectTemplate(config);

  await sendEmails(account, selectedEmail);

  p.outro("byebye");
  process.exit(0);
}

/**
 * 添加邮件模板配置
 */
async function addTemplateConfig() {
  if (!["add-template", "template"].includes(process.argv[2])) {
    return;
  }

  const templates = await listHtmlTemplates(CONFIG.TEMPLATE_DIR);
  if (templates.length === 0) {
    throw new Error(`未在 ${CONFIG.TEMPLATE_DIR} 找到 HTML 模板文件`);
  }

  const template = checkCancel(
    await p.autocomplete({
      message: "选择 HTML 模板文件",
      options: buildTemplateOptions(templates),
      placeholder: "输入文件名搜索 template 目录下的 HTML 文件",
      initialValue: templates[0],
    }),
  );
  const name = checkCancel(
    await p.text({
      message: "模板名称",
      placeholder: "例如：NS2 Launch",
      validate: (value) => {
        if (!value?.trim()) return "模板名称不能为空";
      },
    }),
  );
  const subject = checkCancel(
    await p.text({
      message: "邮件主题",
      placeholder: "例如：Collaboration Opportunity",
      validate: (value) => {
        if (!value?.trim()) return "邮件主题不能为空";
      },
    }),
  );

  const record = buildTemplateConfigRecord({ name, subject, template });
  const count = await appendTemplateConfig(CONFIG.CONFIG_FILE, record);

  p.outro(`已添加模板配置：${record.name}，当前共 ${count} 个模板`);
  process.exit(0);
}

/**
 * 首次启动时创建空模板配置文件
 */
async function ensureTemplateConfig() {
  const configFile = Bun.file(CONFIG.CONFIG_FILE);
  if (await configFile.exists()) {
    return;
  }

  await Bun.write(CONFIG.CONFIG_FILE, JSON.stringify([], null, 2));
  p.log.message(`未找到模板配置，已创建空配置 => ${CONFIG.CONFIG_FILE}`);
}

/**
 * 初始化数据
 */
async function initializeData() {
  await cleanData();
  await addAccount();
  await switchAccount();
  await syncSentEmails();
}

/**
 * 同步已发送邮件
 */
async function syncSentEmails() {
  if (!(await Bun.file(CONFIG.SECRETS_FILE).exists())) {
    const since = await setAccount("init");
    const changes = colors.yellow(colors.bold(await searchSentMails(since)));
    s.stop(`更新了 ${changes} 条记录`);
  } else {
    const changes = colors.yellow(colors.bold(await searchSentMails()));
    s.stop(`更新了 ${changes} 条记录`);
  }
}

/**
 * 设置账户和并行加载配置
 * @returns {Promise<{account: Object, config: Object}>} 选中的账户和配置
 */
async function setupAccount() {
  // 并行读取配置文件
  const [accounts, config] = await Promise.all([
    loadConfig(CONFIG.SECRETS_FILE),
    loadConfig(CONFIG.CONFIG_FILE),
  ]);

  const account = await chooseAccount(accounts);

  return { account, config };
}

/**
 * 选择邮件模板
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>} 选中的模板对象
 */
async function selectTemplate(config) {
  if (config.length === 0) {
    throw new Error(MESSAGES.ERRORS.NO_CONFIG);
  }

  // 选择模板
  const templateChoices = config.map((email, index) => ({
    value: index,
    label: `${email.name}`,
    hint: email.template,
  }));

  const selectedEmailIndex = checkCancel(
    await p.select({
      message: "选择一个模板",
      options: templateChoices,
    }),
  );

  return config[selectedEmailIndex];
}

/**
 * 准备收件人列表和邮件内容
 * @param {Object} selectedAccount - 选中的账户
 * @param {Object} selectedEmail - 选中的邮件模板
 * @returns {Promise<{recipients: string[], email: {text: string, html: string}}>}
 */
async function prepareRecipients(selectedAccount, selectedEmail) {
  // 准备邮件内容
  const emailContent = await prepareEmailContent(selectedEmail);

  // 获取收件人
  const choice = checkCancel(
    await p.confirm({
      message: MESSAGES.PROMPTS.IMPORT_RECIPIENTS,
    }),
  );

  const recipients = await getRecipients(choice);
  const filteredReci = await filterRecipients(recipients, selectedAccount);

  const skipped = recipients.length - filteredReci.length;
  p.box(`跳过了 ${skipped} 个邮箱`);

  const result = filteredReci.map((i) => colors.green(i)).join("\n");

  p.box(result, colors.bold(colors.blue(`待发送：${filteredReci.length} 个`)));

  const sendConfirm = checkCancel(
    await p.confirm({
      message: MESSAGES.PROMPTS.CONFIRM_SEND,
    }),
  );

  if (!sendConfirm) {
    p.cancel("操作取消");
    process.exit(0);
  }

  return {
    recipients: filteredReci,
    email: emailContent,
  };
}

/**
 * 发送邮件
 * @param {Object} selectedAccount - 选中的账户
 * @param {Object} selectedEmail - 选中的邮件模板
 */
async function sendEmails(selectedAccount, selectedEmail) {
  const { recipients: filteredReci, email } = await prepareRecipients(
    selectedAccount,
    selectedEmail,
  );

  const { done, failed } = await sendMails(
    selectedAccount.smtp,
    filteredReci,
    selectedEmail,
    email.text,
    email.html,
    getSenderEmail(selectedAccount),
  );

  if (done || failed) {
    showResult(done, failed);
  }
}

/**
 * 准备邮件内容
 * @param {Object} selectedEmail - 选中的邮件模板
 * @returns {Promise<{text: string, html: string}>} 邮件内容
 */
async function prepareEmailContent(selectedEmail) {
  const templatePath = `${CONFIG.TEMPLATE_DIR}${selectedEmail.template}`;

  if (!templatePath || typeof templatePath !== "string") {
    p.cancel(MESSAGES.ERRORS.INVALID_TEMPLATE);
    process.exit(1);
  }

  const htmlFile = Bun.file(templatePath);
  const exists = await htmlFile.exists();

  if (!exists) {
    throw new Error(MESSAGES.ERRORS.FILE_NOT_EXISTS);
  }

  let htmlContent;
  try {
    htmlContent = await htmlFile.text();
  } catch (error) {
    throw new Error(`读取模板文件失败: ${error.message}`);
  }

  // 将 HTML 转换为纯文本
  const textContent = convert(htmlContent, {
    wordwrap: 130,
  });

  return { text: textContent, html: htmlContent };
}

/**
 * 获取收件人列表
 * @param {boolean} useFile - 是否从文件导入
 * @returns {Promise<string[]>} 收件人邮箱地址数组
 */
async function getRecipients(useFile) {
  if (useFile) {
    const sendbox = Bun.file(CONFIG.SENDBOX_FILE);
    const text = await sendbox.text();

    // 按换行符和逗号分割，支持多种分隔符
    const emails = text
      .split(/[,，\n]/)
      .map((email) => email.trim())
      .filter((email) => email.length > 0);

    // 验证每个邮箱地址
    const validEmails = emails.filter((email) => /\S+@\S+\.\S+/.test(email));

    if (validEmails.length === 0) {
      throw new Error(MESSAGES.ERRORS.INVALID_EMAIL);
    }

    // 使用 Set 去重
    const uniqueRecipients = new Set(validEmails);
    return Array.from(uniqueRecipients);
  }

  // 手动输入收件人邮箱地址
  const recipientsInput = checkCancel(
    await p.text({
      message: MESSAGES.PROMPTS.INPUT_RECIPIENTS,
      placeholder: "example@email.com, test@email.com",
      validate: validateEmailInput,
    }),
  );

  return validateEmails(recipientsInput);
}

/**
 * 获取发件邮箱地址，用于隔离不同邮箱的发送记录
 * @param {Object} account - 账户或 SMTP 配置
 * @returns {string} 发件邮箱地址
 */
function getSenderEmail(account) {
  const senderEmail =
    account?.imap?.auth?.user ||
    account?.smtp?.auth?.user ||
    account?.auth?.user ||
    account?.from?.match(/<([^>]+)>/)?.[1] ||
    account?.from;

  if (!senderEmail) {
    throw new Error("缺少发件邮箱，无法记录发送历史");
  }

  return senderEmail;
}

function normalizeEmailAddress(email) {
  return String(email || "").trim().toLowerCase();
}

function certificateNamesMatchHost(host, cert) {
  const subjectAltName = String(cert?.subjectaltname || "");
  const dnsNames = subjectAltName
    .split(/,\s*/)
    .map((entry) => entry.replace(/^DNS:/i, "").toLowerCase())
    .filter(Boolean);

  return dnsNames.includes(host.toLowerCase()) || cert?.subject?.CN === host;
}

function checkTlsServerIdentity(host, cert) {
  const error = defaultCheckServerIdentity(host, cert);
  if (!error || certificateNamesMatchHost(host, cert)) {
    return undefined;
  }

  return error;
}

export function withTlsServername(config) {
  const host = config?.host;
  if (!host) {
    return config;
  }

  return {
    ...config,
    tls: {
      ...(config.tls || {}),
      servername: config.tls?.servername || host,
      checkServerIdentity: config.tls?.checkServerIdentity || checkTlsServerIdentity,
    },
  };
}

function quoteCurlConfigValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

async function requestGmailApiJson(url, accessToken, options = {}) {
  const configFile = `/tmp/gmail-api-curl-${crypto.randomUUID()}.conf`;
  const method = options.method || "GET";
  const body = options.body;
  const headers = [
    `header = "Authorization: Bearer ${quoteCurlConfigValue(accessToken)}"`,
    'header = "Accept: application/json"',
  ];

  if (body !== undefined) {
    headers.push('header = "Content-Type: application/json"');
  }

  await writeFile(
    configFile,
    [
      `url = "${quoteCurlConfigValue(url)}"`,
      `request = "${quoteCurlConfigValue(method)}"`,
      ...headers,
    ].join("\n"),
    { mode: 0o600 },
  );
  await chmod(configFile, 0o600).catch(() => undefined);

  return await new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "--max-time",
      "30",
      "--connect-timeout",
      "10",
      "-w",
      "\n%{http_code}",
      "--config",
      configFile,
    ];

    if (body !== undefined) {
      args.push("--data-binary", "@-");
    }

    const child = spawn("curl", args);

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      void unlink(configFile).catch(() => undefined);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }

      const separatorIndex = stdout.lastIndexOf("\n");
      const text = separatorIndex >= 0 ? stdout.slice(0, separatorIndex) : "";
      const statusText = separatorIndex >= 0 ? stdout.slice(separatorIndex + 1).trim() : stdout.trim();
      const status = Number(statusText);

      if (!Number.isInteger(status)) {
        reject(new Error(`Gmail API 返回了无效 HTTP 状态码: ${statusText || "empty"}`));
        return;
      }

      if (status < 200 || status >= 300) {
        reject(new Error(`Gmail API 请求失败 HTTP ${status}: ${text}`));
        return;
      }

      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error(`Gmail API 响应不是 JSON: ${error.message}`));
      }
    });

    child.stdin.end(body);
  });
}

function formatGmailSearchDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function getSentSyncSinceDate(choice, since) {
  if (since) {
    return since;
  }

  const lastrun = choice?.lastrun;
  if (lastrun) {
    return new Date(lastrun - CONFIG.MS_PER_DAY * 2);
  }

  const range = choice?.range || 30;
  return new Date(Date.now() - CONFIG.MS_PER_DAY * range);
}

function extractEmailAddress(value) {
  return String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function getGmailHeader(headers, name) {
  return headers?.find((header) => header?.name?.toLowerCase() === name.toLowerCase())?.value;
}

function getGmailRecipientAddress(headers) {
  return (
    extractEmailAddress(getGmailHeader(headers, "To")) ||
    extractEmailAddress(getGmailHeader(headers, "Cc")) ||
    extractEmailAddress(getGmailHeader(headers, "Bcc"))
  );
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function listGmailSentMessageIds(accessToken, sinceDate, beforeDate) {
  const ids = [];
  let pageToken;

  do {
    const url = new URL(`${GMAIL_API_BASE}/messages`);
    url.searchParams.set("labelIds", "SENT");
    url.searchParams.set("maxResults", "500");
    url.searchParams.set(
      "q",
      `after:${formatGmailSearchDate(sinceDate)} before:${formatGmailSearchDate(beforeDate)}`,
    );
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const data = await requestGmailApiJson(url.toString(), accessToken);
    ids.push(...(data.messages || []).map((message) => message.id).filter(Boolean));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return ids;
}

async function getGmailMessageMetadata(accessToken, id) {
  const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", "metadata");
  for (const header of ["To", "Cc", "Bcc", "Date"]) {
    url.searchParams.append("metadataHeaders", header);
  }

  return await requestGmailApiJson(url.toString(), accessToken);
}

async function syncGmailSentMails(choice, accessToken, testAccount, senderEmail, since) {
  const sinceDate = getSentSyncSinceDate(choice, since);
  const beforeDate = new Date(Date.now() + CONFIG.MS_PER_DAY * 2);
  const dateString = sinceDate.toLocaleString();

  s.message(`通过 Gmail API 获取 ${colors.magentaBright(dateString)} 以来的邮件信息`);

  const ids = await listGmailSentMessageIds(accessToken, sinceDate, beforeDate);
  if (ids.length === 0) {
    return 0;
  }

  s.message(`通过 Gmail API 拉取 ${ids.length} 封已发送邮件`);
  const messages = await mapWithConcurrency(ids, 5, (id) =>
    getGmailMessageMetadata(accessToken, id),
  );

  const records = {};
  for (const message of messages) {
    const headers = message?.payload?.headers || [];
    const recipient = getGmailRecipientAddress(headers);
    if (!recipient || testAccount.has(normalizeEmailAddress(recipient))) {
      continue;
    }

    const date = Date.parse(getGmailHeader(headers, "Date")) || Number(message.internalDate) || Date.now();
    const prev = records[recipient];
    if (!prev || date > prev) {
      records[recipient] = date;
    }
  }

  const recordsArray = Object.entries(records).map(([email, last_sent]) => ({
    sender_email: senderEmail,
    email,
    last_sent,
  }));

  return recordsArray.length > 0 ? recorder.insertRecords(recordsArray) : 0;
}

function encodeBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function buildRawEmail(mailOptions) {
  const transport = createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });
  const info = await transport.sendMail(mailOptions);
  return encodeBase64Url(info.message);
}

async function sendGmailApiMail(smtpConfig, mailOptions) {
  const accessToken = smtpConfig?.auth?.accessToken || (await getAccessToken());
  const raw = await buildRawEmail(mailOptions);
  await requestGmailApiJson(`${GMAIL_API_BASE}/messages/send`, accessToken, {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
}

export function getConfiguredAccountEmails(accounts) {
  return new Set(
    accounts
      .flatMap((account) => [
        account?.imap?.auth?.user,
        account?.smtp?.auth?.user,
        account?.auth?.user,
        account?.smtp?.from?.match(/<([^>]+)>/)?.[1],
        account?.smtp?.from,
        account?.from?.match(/<([^>]+)>/)?.[1],
        account?.from,
      ])
      .map(normalizeEmailAddress)
      .filter(Boolean),
  );
}

export function shouldKeepRecipient({ recipient, sentTime, range, configuredAccountEmails, now = Date.now() }) {
  const normalizedRecipient = normalizeEmailAddress(recipient);
  const isConfiguredAccount = configuredAccountEmails.has(normalizedRecipient);
  const sentHistoryExpired = sentTime < now - CONFIG.MS_PER_DAY * range;

  return isConfiguredAccount || sentHistoryExpired || !sentTime;
}

/**
 * 发送邮件
 * @param {Object} smtpConfig - SMTP 配置（包含 host, port, auth, from 等）
 * @param {Array.<string>} recipients - 收件人数组
 * @param {Object} selectedEmail - 选中的模板对象
 * @param {string} textContent - 纯文本内容
 * @param {string} htmlContent - HTML 内容
 * @param {string} senderEmail - 发件邮箱
 * @returns {Promise<{done: string[], failed: Array<{recipient: string, error: string}>}>}
 **/
async function sendMails(
  smtpConfig,
  recipients,
  selectedEmail,
  textContent,
  htmlContent,
  senderEmail,
) {
  const progress = p.progress({
    indicator: "timer",
    size: process.stdout.columns - UI_CONSTANTS.PROGRESS_SIZE_OFFSET,
    max: recipients.length,
    style: "block",
    frames: ["󱡯 "],
  });

  progress.start(`使用模板 ${selectedEmail.template}`);

  let transporter;
  const useGmailApi = smtpConfig.host === "smtp.gmail.com";
  try {
    if (!useGmailApi) {
      transporter = createTransport({
        // 设置连接池
        pool: true,
        maxConnections: UI_CONSTANTS.SMTP_POOL_MAX_CONNECTIONS,
        maxMessages: UI_CONSTANTS.SMTP_POOL_MAX_MESSAGES,
        ...withTlsServername({
          ...smtpConfig,
          ...selectedEmail,
        }),
      });
    }
  } catch (error) {
    progress.stop(colors.red("SMTP 连接失败"));
    throw new Error(`SMTP 连接失败: ${error.message}`);
  }

  const done = [];
  const failed = [];
  const batchRecords = []; // 用于批量插入数据库

  try {
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const isLast = i === recipients.length - 1;

      // 验证 selectedEmail 是否包含必需的属性
      if (!selectedEmail || !selectedEmail.subject) {
        throw new Error("邮件模板缺少主题信息，请检查配置文件");
      }

      let mailOptions = {
        from: smtpConfig.from,
        to: recipient,
        subject: selectedEmail.subject,
        text: textContent,
        html: htmlContent,
      };

      try {
        if (useGmailApi) {
          await sendGmailApiMail(smtpConfig, mailOptions);
        } else {
          await transporter.sendMail(mailOptions);
        }
        done.push(recipient);
        // 批量收集记录
        batchRecords.push({
          sender_email: senderEmail,
          email: recipient,
          last_sent: Date.now(),
        });
      } catch (error) {
        failed.push({ recipient, error: error.message || String(error) });
      } finally {
        progress.advance(
          1,
          `发送中 ${done.length + failed.length}/${recipients.length}`,
        );
        // 如果是最后一个收件人，停留半秒
        if (isLast) {
          await Bun.sleep(UI_CONSTANTS.FINAL_DELAY_MS);
        }
      }
    }
  } finally {
    // 批量插入数据库
    if (batchRecords.length > 0) {
      try {
        recorder.insertRecords(batchRecords);
      } catch (error) {
        console.error(`批量插入数据库失败: ${error.message}`);
      }
    }

    // 关闭传输器连接
    if (transporter) {
      transporter.close();
    }
    progress.stop();
  }

  return {
    done,
    failed,
  };
}

/**
 * 筛选收件人（排除黑名单和已发送）
 * @param {string[]} recipients - 收件人列表
 * @param {Object} account - 账户对象
 * @returns {Promise<string[]>} 过滤后的收件人列表
 */
async function filterRecipients(recipients, account) {
  const recipientsSet = new Set(recipients);
  const senderEmail = getSenderEmail(account);
  const accounts = await loadConfig(CONFIG.SECRETS_FILE);
  const configuredAccountEmails = getConfiguredAccountEmails(accounts);

  // 加载黑名单
  const rawFile = await Bun.file(CONFIG.BLACKLIST_FILE).text();
  const blacklist = rawFile.replace("\r", "").split("\n").filter(Boolean);

  const filtered = [...recipientsSet].filter((i) => {
    const sentTime = recorder.searchSentTime(senderEmail, i);
    return (
      shouldKeepRecipient({
        recipient: i,
        sentTime,
        range: account.range,
        configuredAccountEmails,
      }) && !blacklist.includes(i)
    );
  });

  return filtered;
}

/**
 * 清理过期数据
 */
async function cleanData() {
  if (process.argv.length > 1 && process.argv[2] === "clean") {
    const input = checkCancel(
      await p.select({
        message: "选择需要清理的时间范围",
        options: [
          { label: "60 天", value: 60 },
          { label: "30 天", value: 30 },
          { label: "20 天", value: 20 },
        ],
      }),
    );

    const cleanBefore = new Date(Date.now() - CONFIG.MS_PER_DAY * input);

    if (!cleanBefore || isNaN(cleanBefore)) {
      throw new Error(MESSAGES.ERRORS.INVALID_DATE);
    }

    const confirm = checkCancel(
      await p.confirm({
        message: `确定删除 ${colors.cyanBright(cleanBefore)} 之前的记录吗?`,
      }),
    );

    if (confirm) {
      const result = cleanRecords(cleanBefore.getTime());
      p.log.message(`删除了 ${colors.yellow(result)} 条记录`);
    }
    p.outro("byebye");
    process.exit(1);
  }
}

/**
 * 清理过期记录
 * @param {number} input - 时间戳（默认30天前）
 * @returns {number} 删除的记录数
 */
function cleanRecords(input = CONFIG.MS_PER_DAY * 30) {
  const dueDate = input;
  const result = recorder.deleteDueRecords(dueDate);
  return result?.changes;
}

/**
 * 设置账户信息并保存到 secrets.json
 * @param {string} option - 操作类型（"init" | "add"）
 * @returns {Promise<Date>} since 日期
 */
async function setAccount(option) {
  const host = checkCancel(
    await p.select({
      message: "选择邮箱类型",
      options: [
        { label: "QQ 企业邮箱", value: "exmail" },
        { label: "QQ 邮箱", value: "qq" },
        { label: "Gmail", value: "gmail" },
      ],
    }),
  );

  const account = checkCancel(
    await p.text({
      message: "邮箱账号",
      placeholder: "example@email.com",
      validate: validateEmailInput,
    }),
  );

  const password = checkCancel(
    host !== "gmail"
      ? await p.password({
          message: "邮箱授权码",
        })
      : await getAccessToken(),
  );

  const username = checkCancel(
    await p.text({
      message: "输入用户名",
      validate: (value) => {
        if (value.length === 0) return MESSAGES.ERRORS.NO_USERNAME;
      },
    }),
  );

  const range = checkCancel(
    await p.select({
      message: "选择需要筛选的时间范围",
      options: [
        { label: "60 天", value: 60 },
        { label: "30 天", value: 30 },
        { label: "20 天", value: 20 },
      ],
    }),
  );

  const hostMap = await loadConfig(CONFIG.HOSTS_FILE);
  if (host !== "gmail") {
    hostMap[host].imap.auth.user = account;
    hostMap[host].imap.auth.pass = password;
    hostMap[host].smtp.auth.user = account;
    hostMap[host].smtp.auth.pass = password;
    hostMap[host].smtp.from = `${username} <${account}>`;
  } else {
    hostMap[host].imap.auth.user = account;
    hostMap[host].smtp.auth.user = account;
    hostMap[host].smtp.from = `${username} <${account}>`;
  }

  const since = new Date(Date.now() - CONFIG.MS_PER_DAY * range);

  let newContent = [];

  const content = {
    ...hostMap[host],
    range,
    selected: true,
  };

  // 第一次启动写入 secrets.json
  if (option === "init") {
    newContent = [content];
  } else if (option === "add") {
    const original = await loadConfig(CONFIG.SECRETS_FILE);
    const selected = original.findIndex((item) => item?.selected);
    // 只有找到选中的账号时才取消选中
    if (selected >= 0) {
      original[selected].selected = false;
    }
    newContent = [...original, content];
  }

  await Bun.write(CONFIG.SECRETS_FILE, JSON.stringify(newContent, null, 2));

  return since;
}

/**
 * 搜索已发送邮件并同步到数据库
 * @param {Date} since - 开始日期
 * @returns {Promise<number>} 更新的记录数
 */
async function searchSentMails(since) {
  const accounts = await loadConfig(CONFIG.SECRETS_FILE);
  const testAccount = getConfiguredAccountEmails(accounts);
  const choice = await chooseAccount(accounts);
  const senderEmail = getSenderEmail(choice);

  displayStatus(choice.imap.auth.user);

  let client;
  let lock;
  let stage = "连接前";

  s.start("开始初始化数据");
  try {
    if (choice.imap.host === "imap.gmail.com") {
      stage = "更新 Gmail token";
      s.message("更新 token");
      const newToken = await getAccessToken();
      choice.imap.auth.accessToken = newToken;
      choice.smtp.auth.accessToken = newToken;

      stage = "通过 Gmail API 同步已发送邮件";
      const changes = await syncGmailSentMails(
        choice,
        newToken,
        testAccount,
        senderEmail,
        since,
      );

      stage = "写入运行时间";
      choice.lastrun = Date.now();
      await Bun.write(CONFIG.SECRETS_FILE, JSON.stringify(accounts, null, 2));
      return changes;
    }
    // client = new ImapFlow({ ...choice.imap, proxy: process.env.HTTP_PROXY });
    client = new ImapFlow(withTlsServername(choice.imap));
    stage = `连接 IMAP ${choice.imap.host}:${choice.imap.port}`;
    await client.connect();

    // 获取邮箱列表
    stage = "读取邮箱列表";
    const mailboxes = await client.list();

    stage = "打开已发送邮箱";
    lock = await getSentMailboxLock(client, mailboxes, choice.imap.host);

    let changes = 0;
    let sinceDate;
    const beforeDate = new Date(Date.now() + CONFIG.MS_PER_DAY * 2);

    const lastrun = choice?.lastrun;
    const range = choice?.range;

    if (since) {
      sinceDate = since;
    } else if (lastrun) {
      sinceDate = new Date(lastrun - CONFIG.MS_PER_DAY * 2);
    } else if (range) {
      sinceDate = new Date(Date.now() - CONFIG.MS_PER_DAY * range);
    }

    const dateString = sinceDate.toLocaleString();

    stage = "搜索已发送邮件";
    s.message(`获取 ${colors.magentaBright(dateString)} 以来的邮件信息`);

    const result = await client.search(
      { since: sinceDate, before: beforeDate },
      { uid: true },
    );

    if (result.length > 0) {
      stage = "拉取邮件 envelope";
      const messages = await client.fetchAll(
        result,
        { envelope: true },
        { uid: true },
      );

      s.message("写入中");
      stage = "写入本地记录";

      const records = {};
      for (const m of messages) {
        const recipient = getRecipientAddress(m.envelope);
        if (!recipient) {
          continue;
        }

        const date = m.envelope.date ? m.envelope.date.getTime() : Date.now();

        if (!testAccount.has(normalizeEmailAddress(recipient))) {
          const prev = records[recipient];
          if (!prev || date > prev) {
            records[recipient] = date;
          }
        }
      }

      // 转换为数组格式
      const recordsArray = Object.entries(records).map(
        ([email, last_sent]) => ({
          sender_email: senderEmail,
          email,
          last_sent,
        }),
      );

      if (recordsArray.length > 0) {
        changes = recorder.insertRecords(recordsArray);
      }
    }

    // 记录下运行时间
    stage = "写入运行时间";
    const run_time = Date.now();
    choice.lastrun = run_time;

    await Bun.write(CONFIG.SECRETS_FILE, JSON.stringify(accounts, null, 2));

    return changes;
  } catch (error) {
    s.stop(colors.red("IMAP 操作失败"));
    throw new Error(formatImapError(error, stage));
  } finally {
    // 确保释放锁
    if (lock) {
      try {
        lock.release();
      } catch (error) {
        console.error(`释放锁失败: ${error.message}`);
      }
    }
    // 确保关闭连接
    if (client) {
      try {
        await client.logout();
      } catch (error) {
        if (error.message !== "Connection not available") {
          console.error(`关闭 IMAP 连接失败: ${error.message}`);
        }
      }
    }
  }
}

/**
 * 格式化 IMAP 错误，尽量带上服务端返回细节
 * @param {Error & {responseStatus?: string, responseText?: string, serverResponseCode?: string, command?: string}} error
 * @param {string} stage
 * @returns {string}
 */
function formatImapError(error, stage) {
  const details = [
    stage ? `阶段: ${stage}` : "",
    error?.command ? `命令: ${error.command}` : "",
    error?.responseStatus ? `状态: ${error.responseStatus}` : "",
    error?.serverResponseCode ? `响应码: ${error.serverResponseCode}` : "",
    error?.responseText ? `服务端: ${error.responseText}` : "",
    error?.message ? `消息: ${error.message}` : "",
  ].filter(Boolean);

  return `IMAP 操作失败: ${details.join(" | ")}`;
}

/**
 * 获取收件人地址，优先使用 To，其次回退到 Cc/Bcc
 * @param {Object} envelope - IMAP 邮件 envelope
 * @returns {string|undefined} 收件人地址
 */
function getRecipientAddress(envelope) {
  const recipients = [
    ...(envelope?.to || []),
    ...(envelope?.cc || []),
    ...(envelope?.bcc || []),
  ];

  return recipients.find((item) => item?.address)?.address;
}

/**
 * 获取已发送邮箱的锁，兼容不同服务商的文件夹命名
 * @param {ImapFlow} client - IMAP 客户端
 * @param {Array<{path: string, specialUse?: string}>} mailboxes - 邮箱列表
 * @param {string} host - IMAP 主机
 * @returns {Promise<any>} 邮箱锁
 */
async function getSentMailboxLock(client, mailboxes, host) {
  const exactSent = mailboxes.find((mailbox) => mailbox.specialUse === "\\Sent");
  if (exactSent) {
    return client.getMailboxLock(exactSent.path);
  }

  const normalizedHost = (host || "").toLowerCase();
  const providerFallbacks = normalizedHost.includes("gmail")
    ? ["[Gmail]/Sent Mail"]
    : ["Sent Messages", "Sent Items", "Sent", "已发送"];

  const inferredPaths = mailboxes
    .filter((mailbox) => /sent|已发送/i.test(mailbox.path || ""))
    .map((mailbox) => mailbox.path);

  const candidates = [...new Set([...inferredPaths, ...providerFallbacks])];
  let lastError;

  for (const path of candidates) {
    try {
      return await client.getMailboxLock(path);
    } catch (error) {
      lastError = error;
    }
  }

  const availablePaths = mailboxes.map((mailbox) => mailbox.path).join(", ");
  throw new Error(
    `未找到可用的已发送邮箱。可用文件夹: ${availablePaths}${lastError ? `。最后一次错误: ${lastError.message}` : ""}`,
  );
}

/**
 * 显示发送结果
 * @param {string[]} done - 成功发送的邮箱列表
 * @param {Array<{recipient: string, error: string}>} failed - 失败的邮箱列表
 */
function showResult(done, failed) {
  const divider = (message) => {
    const col = process.stdout.columns - message.length - 10;
    return colors.bold(colors.italic(message)) + " " + "─".repeat(col);
  };

  const completeResult =
    done.length > 0 ? colors.greenBright(done.join("\n")) : "";

  const failResult =
    failed.length > 0
      ? failed
          .map(
            (obj) =>
              obj.recipient + "\n└╴" + colors.redBright(" " + obj.error),
          )
          .join("\n")
      : "";

  let boxContent = "";

  if (completeResult)
    boxContent += `${divider("Completed")}\n${completeResult}\n`;

  if (failResult) boxContent += `${divider("Failed")}\n${failResult}\n`;

  p.box(
    boxContent,
    `${colors.green("\uebb3")}  ${done.length}  ${colors.red(" ")} ${failed.length}`,
  );
}

/**
 * 选择账户
 * @param {Array<Object>} accounts - 账户列表
 * @returns {Promise<Object>} 选中的账户
 */
async function chooseAccount(accounts) {
  // 检查是否有账号已被选中
  const selectedIndex = accounts.findIndex((item) => item?.selected);

  let choice;

  if (selectedIndex === -1) {
    const options = accounts.map((account) => ({
      label: account.imap.auth.user,
      value: account,
    }));

    choice =
      accounts.length === 1
        ? accounts[0]
        : checkCancel(await p.select({ message: "选择账号", options }));
  } else {
    choice = accounts[selectedIndex];
  }

  return choice;
}

/**
 * 添加账户
 */
async function addAccount() {
  if (process.argv.length > 1 && process.argv[2] === "add") {
    await setAccount("add");

    p.outro("byebye");
    process.exit(0);
  }
}

/**
 * 切换账户
 */
async function switchAccount() {
  if (process.argv.length > 1 && process.argv[2] === "switch") {
    const accounts = await loadConfig(CONFIG.SECRETS_FILE);

    const options = accounts.map((account, index) => ({
      label: account.imap.auth.user,
      value: index,
    }));

    const choice = checkCancel(
      await p.select({ message: "切换账号", options }),
    );

    const selectedIndex = accounts.findIndex((item) => item?.selected);
    accounts[selectedIndex].selected = false;
    accounts[choice].selected = true;

    await Bun.write(CONFIG.SECRETS_FILE, JSON.stringify(accounts, null, 2));

    p.outro("切换完成");
    process.exit(0);
  }
}
