import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export async function listHtmlTemplates(templateDir) {
  try {
    const info = await stat(templateDir);
    if (!info.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files = [];
  for await (const file of new Bun.Glob("**/*").scan({ cwd: templateDir })) {
    if (file.toLowerCase().endsWith(".html")) {
      files.push(file.split(sep).join("/"));
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

export function normalizeTemplatePath(input, templateDir) {
  const value = String(input || "").trim();
  const normalizedDir = templateDir.replace(/\\/g, "/").replace(/\/$/, "");
  let normalized = value.replace(/\\/g, "/");

  if (normalized.startsWith(`${normalizedDir}/`)) {
    normalized = normalized.slice(normalizedDir.length + 1);
  } else if (normalized.startsWith("/")) {
    normalized = relative(resolve(templateDir), resolve(normalized)).replace(/\\/g, "/");
  }

  return normalized.replace(/^\.\//, "");
}

export function buildTemplateConfigRecord({ name, subject, template }) {
  const record = {
    name: String(name || "").trim(),
    subject: String(subject || "").trim(),
    template: String(template || "").trim(),
  };

  if (!record.name) {
    throw new Error("模板名称不能为空");
  }
  if (!record.subject) {
    throw new Error("邮件主题不能为空");
  }
  if (!record.template) {
    throw new Error("模板文件不能为空");
  }

  return record;
}

export async function appendTemplateConfig(configPath, record) {
  const file = Bun.file(configPath);
  const config = (await file.exists()) ? await file.json() : [];

  if (!Array.isArray(config)) {
    throw new Error(`${configPath} 必须是 JSON 数组`);
  }

  const nextConfig = [...config, buildTemplateConfigRecord(record)];
  await Bun.write(configPath, JSON.stringify(nextConfig, null, 2));

  return nextConfig.length;
}
