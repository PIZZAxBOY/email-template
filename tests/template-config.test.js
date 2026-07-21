import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendTemplateConfig,
  buildTemplateOptions,
  buildTemplateConfigRecord,
  listHtmlTemplates,
  normalizeTemplatePath,
} from "../template-config.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "email-template-config-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("lists html files in template directory recursively", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, "welcome.html"), "<html></html>");
  await writeFile(join(dir, "ignored.txt"), "ignore");
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "promo.HTML"), "<html></html>");

  await expect(listHtmlTemplates(dir)).resolves.toEqual([
    "nested/promo.HTML",
    "welcome.html",
  ]);
});

test("builds required template config record", () => {
  expect(
    buildTemplateConfigRecord({
      name: " Launch ",
      subject: " New Product ",
      template: "welcome.html",
    }),
  ).toEqual({
    name: "Launch",
    subject: "New Product",
    template: "welcome.html",
  });
});

test("normalizes selected template path relative to template directory", () => {
  expect(normalizeTemplatePath("template/welcome.html", "template")).toBe("welcome.html");
  expect(normalizeTemplatePath("/project/template/nested/promo.html", "/project/template")).toBe("nested/promo.html");
});

test("builds autocomplete options from template-relative html paths", () => {
  expect(buildTemplateOptions(["nested/promo.html", "welcome.html"])).toEqual([
    { label: "nested/promo.html", value: "nested/promo.html" },
    { label: "welcome.html", value: "welcome.html" },
  ]);
});

test("appends template config to existing config file", async () => {
  const dir = await makeTempDir();
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify([{ name: "Old", subject: "Old subject", template: "old.html" }], null, 2));

  const result = await appendTemplateConfig(configPath, {
    name: "New",
    subject: "New subject",
    template: "new.html",
  });

  expect(result).toBe(2);
  const config = await Bun.file(configPath).json();
  expect(config).toEqual([
    { name: "Old", subject: "Old subject", template: "old.html" },
    { name: "New", subject: "New subject", template: "new.html" },
  ]);
});
