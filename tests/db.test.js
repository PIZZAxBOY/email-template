import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const tempDirs = [];

async function loadRecorder() {
  const tempDir = await mkdtemp(join(tmpdir(), "email-db-test-"));
  tempDirs.push(tempDir);

  process.chdir(tempDir);
  const dbModuleUrl = pathToFileURL(resolve(projectRoot, "db.js")).href;
  const mod = await import(`${dbModuleUrl}?case=${crypto.randomUUID()}`);
  return { recorder: mod.recorder, tempDir };
}

afterAll(async () => {
  process.chdir(projectRoot);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("records are isolated by sender email", async () => {
  const { recorder, tempDir } = await loadRecorder();

  expect(existsSync(join(tempDir, "db"))).toBe(true);
  expect(existsSync(join(tempDir, "db", "recipients.db"))).toBe(true);

  recorder.insertRecords([
    { sender_email: "sender-a@example.com", email: "recipient@example.com", last_sent: 1000 },
    { sender_email: "sender-b@example.com", email: "recipient@example.com", last_sent: 2000 },
  ]);

  expect(recorder.searchSentTime("sender-a@example.com", "recipient@example.com")).toBe(1000);
  expect(recorder.searchSentTime("sender-b@example.com", "recipient@example.com")).toBe(2000);
});

test("upserts only update matching sender and recipient", async () => {
  const { recorder } = await loadRecorder();

  recorder.insertRecords([
    { sender_email: "sender-a@example.com", email: "recipient@example.com", last_sent: 1000 },
    { sender_email: "sender-b@example.com", email: "recipient@example.com", last_sent: 2000 },
  ]);
  recorder.insertRecord("sender-a@example.com", "recipient@example.com", 3000);

  expect(recorder.searchSentTime("sender-a@example.com", "recipient@example.com")).toBe(3000);
  expect(recorder.searchSentTime("sender-b@example.com", "recipient@example.com")).toBe(2000);
});
