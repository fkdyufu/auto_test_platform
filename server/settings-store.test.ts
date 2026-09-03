import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readZentaoSettings,
  saveZentaoSettings,
  toPublicZentaoSettings,
} from "./settings-store.js";

async function createSettingsPath(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "zentao-settings.json");
}

test("returns default Zentao settings when no configuration exists", async (t) => {
  const filePath = await createSettingsPath(t);

  assert.deepEqual(await readZentaoSettings(filePath), {
    baseUrl: "",
    apiBasePath: "/api.php/v1",
    account: "",
    password: "",
  });
});

test("saves Zentao settings and never exposes the password publicly", async (t) => {
  const filePath = await createSettingsPath(t);
  const saved = await saveZentaoSettings({
    baseUrl: "https://zentao.example.com/",
    apiBasePath: "/api.php/v1/",
    account: " tester ",
    password: "secret-value",
  }, filePath);

  assert.deepEqual(saved, {
    baseUrl: "https://zentao.example.com",
    apiBasePath: "/api.php/v1",
    account: "tester",
    password: "secret-value",
  });
  const publicSettings = toPublicZentaoSettings(saved);
  assert.deepEqual(publicSettings, {
    baseUrl: "https://zentao.example.com",
    apiBasePath: "/api.php/v1",
    account: "tester",
    hasPassword: true,
    configured: true,
  });
  assert.equal("password" in publicSettings, false);
  assert.match(await readFile(filePath, "utf8"), /"password": "secret-value"/);
});

test("keeps the saved Zentao password when an update leaves it blank", async (t) => {
  const filePath = await createSettingsPath(t);
  await saveZentaoSettings({
    baseUrl: "https://zentao.example.com",
    apiBasePath: "/api.php/v1",
    account: "tester",
    password: "first-password",
  }, filePath);

  const updated = await saveZentaoSettings({
    baseUrl: "https://new-zentao.example.com",
    apiBasePath: "/api.php/v1",
    account: "tester",
    password: "",
  }, filePath);

  assert.equal(updated.baseUrl, "https://new-zentao.example.com");
  assert.equal(updated.password, "first-password");
});

test("validates required Zentao connection fields", async (t) => {
  const filePath = await createSettingsPath(t);

  await assert.rejects(
    saveZentaoSettings({ baseUrl: "ftp://zentao.example.com", apiBasePath: "/api.php/v1", account: "tester", password: "secret" }, filePath),
    /必须使用 http 或 https/,
  );
  await assert.rejects(
    saveZentaoSettings({ baseUrl: "https://zentao.example.com", apiBasePath: "api.php/v1", account: "tester", password: "secret" }, filePath),
    /必须以 \/ 开头/,
  );
  await assert.rejects(
    saveZentaoSettings({ baseUrl: "https://zentao.example.com", apiBasePath: "/api.php/v1", account: "", password: "secret" }, filePath),
    /禅道账号不能为空/,
  );
});
