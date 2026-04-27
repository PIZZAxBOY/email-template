import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const tempDirs = [];

async function loadMailModule() {
  const tempDir = await mkdtemp(join(tmpdir(), "email-mail-test-"));
  tempDirs.push(tempDir);

  process.chdir(tempDir);
  const mailModuleUrl = pathToFileURL(resolve(projectRoot, "mail.js")).href;
  return import(`${mailModuleUrl}?case=${crypto.randomUUID()}`);
}

afterAll(async () => {
  process.chdir(projectRoot);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("configured accounts are recognized as test recipients", async () => {
  const { getConfiguredAccountEmails } = await loadMailModule();

  const configuredAccountEmails = getConfiguredAccountEmails([
    {
      imap: { auth: { user: "sender@example.com" } },
      smtp: { auth: { user: "sender@example.com" }, from: "Sender <sender@example.com>" },
    },
    {
      imap: { auth: { user: "Test@Example.com" } },
      smtp: { auth: { user: "Test@Example.com" }, from: "Tester <Test@Example.com>" },
    },
  ]);

  expect(configuredAccountEmails.has("sender@example.com")).toBe(true);
  expect(configuredAccountEmails.has("test@example.com")).toBe(true);
});

test("configured account recipients are not skipped by sent history", async () => {
  const { getConfiguredAccountEmails, shouldKeepRecipient } = await loadMailModule();
  const now = Date.parse("2026-04-27T00:00:00Z");
  const configuredAccountEmails = getConfiguredAccountEmails([
    {
      imap: { auth: { user: "test@example.com" } },
      smtp: { auth: { user: "test@example.com" }, from: "Test <test@example.com>" },
    },
  ]);

  expect(
    shouldKeepRecipient({
      recipient: "test@example.com",
      sentTime: now,
      range: 60,
      configuredAccountEmails,
      now,
    }),
  ).toBe(true);

  expect(
    shouldKeepRecipient({
      recipient: "customer@example.com",
      sentTime: now,
      range: 60,
      configuredAccountEmails,
      now,
    }),
  ).toBe(false);
});
