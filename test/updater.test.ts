import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileUpdateStateStore,
  NpmPackageUpdater,
  isNewerStableVersion,
  maybeAutoUpdate,
  type PackageUpdater,
  type UpdateCheckState,
  type UpdateStateStore,
} from "../src/updater.js";

class MemoryStateStore implements UpdateStateStore {
  state: UpdateCheckState | undefined;
  loads = 0;
  saves: UpdateCheckState[] = [];

  constructor(state?: UpdateCheckState) {
    this.state = state;
  }

  async load(): Promise<UpdateCheckState | undefined> {
    this.loads += 1;
    return this.state;
  }

  async save(state: UpdateCheckState): Promise<void> {
    this.state = state;
    this.saves.push(state);
  }
}

class FakePackageUpdater implements PackageUpdater {
  managed = true;
  latest = "1.0.0";
  detectionError: Error | undefined;
  checkError: Error | undefined;
  installError: Error | undefined;
  detections: Array<{ packageRoot: string; packageName: string }> = [];
  checks: string[] = [];
  installs: Array<{ packageName: string; version: string }> = [];

  async isManagedInstall(packageRoot: string, packageName: string): Promise<boolean> {
    this.detections.push({ packageRoot, packageName });
    if (this.detectionError !== undefined) throw this.detectionError;
    return this.managed;
  }

  async latestVersion(packageName: string): Promise<string> {
    this.checks.push(packageName);
    if (this.checkError !== undefined) throw this.checkError;
    return this.latest;
  }

  async installGlobal(packageName: string, version: string): Promise<void> {
    this.installs.push({ packageName, version });
    if (this.installError !== undefined) throw this.installError;
  }
}

const baseOptions = {
  enabled: true,
  packageName: "@xfq/froe",
  packageRoot: "/packages/froe",
  currentVersion: "1.0.0",
  now: () => 2_000,
  intervalMs: 1_000,
};

test("automatic updates can be disabled without touching update state or npm", async () => {
  const stateStore = new MemoryStateStore();
  const updater = new FakePackageUpdater();

  const result = await maybeAutoUpdate({ ...baseOptions, enabled: false, stateStore, updater });

  assert.deepEqual(result, { status: "skipped", reason: "disabled" });
  assert.equal(stateStore.loads, 0);
  assert.equal(updater.detections.length, 0);
});

test("a recent check suppresses npm work", async () => {
  const stateStore = new MemoryStateStore({ checkedAt: 1_500 });
  const updater = new FakePackageUpdater();

  const result = await maybeAutoUpdate({ ...baseOptions, stateStore, updater });

  assert.deepEqual(result, { status: "skipped", reason: "recently_checked" });
  assert.equal(updater.detections.length, 0);
});

test("source, npx, and other unmanaged installs are not changed", async () => {
  const stateStore = new MemoryStateStore();
  const updater = new FakePackageUpdater();
  updater.managed = false;

  const result = await maybeAutoUpdate({ ...baseOptions, stateStore, updater });

  assert.deepEqual(result, { status: "skipped", reason: "unmanaged_install" });
  assert.deepEqual(updater.detections, [{ packageRoot: "/packages/froe", packageName: "@xfq/froe" }]);
  assert.equal(stateStore.saves.length, 0);
  assert.equal(updater.checks.length, 0);
});

test("an npm-managed install updates to a newer stable release", async () => {
  const stateStore = new MemoryStateStore();
  const updater = new FakePackageUpdater();
  updater.latest = "1.2.0";
  const available: string[] = [];

  const result = await maybeAutoUpdate({
    ...baseOptions,
    stateStore,
    updater,
    onUpdateAvailable: (currentVersion, latestVersion) => available.push(`${currentVersion} -> ${latestVersion}`),
  });

  assert.deepEqual(result, { status: "updated", previousVersion: "1.0.0", version: "1.2.0" });
  assert.deepEqual(stateStore.saves, [{ checkedAt: 2_000 }]);
  assert.deepEqual(updater.installs, [{ packageName: "@xfq/froe", version: "1.2.0" }]);
  assert.deepEqual(available, ["1.0.0 -> 1.2.0"]);
});

test("current, older, and prerelease candidates are not installed", async () => {
  for (const latest of ["1.0.0", "0.9.9", "1.1.0-beta.1"]) {
    const updater = new FakePackageUpdater();
    updater.latest = latest;

    const result = await maybeAutoUpdate({ ...baseOptions, stateStore: new MemoryStateStore(), updater });

    assert.deepEqual(result, { status: "current", currentVersion: "1.0.0", latestVersion: latest });
    assert.equal(updater.installs.length, 0);
  }
});

test("update check and install failures do not throw", async () => {
  const checkUpdater = new FakePackageUpdater();
  checkUpdater.checkError = new Error("offline");
  const check = await maybeAutoUpdate({ ...baseOptions, stateStore: new MemoryStateStore(), updater: checkUpdater });
  assert.deepEqual(check, { status: "failed", phase: "check", message: "offline" });

  const installUpdater = new FakePackageUpdater();
  installUpdater.latest = "2.0.0";
  installUpdater.installError = new Error("permission denied");
  const install = await maybeAutoUpdate({ ...baseOptions, stateStore: new MemoryStateStore(), updater: installUpdater });
  assert.deepEqual(install, { status: "failed", phase: "install", message: "permission denied" });
});

test("stable semantic version precedence controls update eligibility", () => {
  assert.equal(isNewerStableVersion("1.9.9", "2.0.0"), true);
  assert.equal(isNewerStableVersion("2.0.0-beta.2", "2.0.0"), true);
  assert.equal(isNewerStableVersion("2.0.0", "2.0.0+build.4"), false);
  assert.equal(isNewerStableVersion("2.0.0", "2.1.0-rc.1"), false);
  assert.equal(isNewerStableVersion("invalid", "2.0.0"), false);
});

test("file update state is private, reloadable, and tolerant of invalid cache data", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-update-"));
  const path = join(root, "nested", "update.json");
  const store = new FileUpdateStateStore(path);

  await store.save({ checkedAt: 42 });

  assert.deepEqual(await store.load(), { checkedAt: 42 });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writeFile(path, "not JSON");
  assert.equal(await store.load(), undefined);
});

test("the npm adapter recognizes its global package and uses exact update arguments", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-npm-updater-"));
  const globalRoot = join(root, "global", "node_modules");
  const packageRoot = join(globalRoot, "@xfq", "froe");
  const logPath = join(root, "calls.jsonl");
  const npmPath = join(root, "npm");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(npmPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "root") process.stdout.write(${JSON.stringify(`${globalRoot}\n`)});
if (args[0] === "view") process.stdout.write('"1.2.3"\\n');
`);
  await chmod(npmPath, 0o700);
  const updater = new NpmPackageUpdater(npmPath);

  assert.equal(await updater.isManagedInstall(packageRoot, "@xfq/froe"), true);
  assert.equal(await updater.isManagedInstall(join(root, "different"), "@xfq/froe"), false);
  assert.equal(await updater.latestVersion("@xfq/froe"), "1.2.3");
  await updater.installGlobal("@xfq/froe", "1.2.3");

  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
  assert.deepEqual(calls, [
    ["root", "--global"],
    ["root", "--global"],
    ["view", "@xfq/froe", "version", "--json"],
    ["install", "--global", "@xfq/froe@1.2.3", "--no-audit", "--no-fund"],
  ]);
});
