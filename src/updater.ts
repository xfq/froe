import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface UpdateCheckState {
  checkedAt: number;
}

export interface UpdateStateStore {
  load(): Promise<UpdateCheckState | undefined>;
  save(state: UpdateCheckState): Promise<void>;
}

export interface PackageUpdater {
  isManagedInstall(packageRoot: string, packageName: string): Promise<boolean>;
  latestVersion(packageName: string): Promise<string>;
  installGlobal(packageName: string, version: string): Promise<void>;
}

export interface AutoUpdateOptions {
  enabled: boolean;
  packageName: string;
  packageRoot: string;
  currentVersion: string;
  stateStore?: UpdateStateStore;
  updater?: PackageUpdater;
  now?: () => number;
  intervalMs?: number;
  onUpdateAvailable?: (currentVersion: string, latestVersion: string) => void;
}

export type AutoUpdateResult =
  | { status: "skipped"; reason: "disabled" | "recently_checked" | "unmanaged_install" }
  | { status: "current"; currentVersion: string; latestVersion: string }
  | { status: "updated"; previousVersion: string; version: string }
  | { status: "failed"; phase: "detect" | "check" | "install"; message: string };

export async function maybeAutoUpdate(options: AutoUpdateOptions): Promise<AutoUpdateResult> {
  if (!options.enabled) return { status: "skipped", reason: "disabled" };

  const now = options.now?.() ?? Date.now();
  const intervalMs = options.intervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  const stateStore = options.stateStore ?? new FileUpdateStateStore();
  const updater = options.updater ?? new NpmPackageUpdater();
  const state = await loadState(stateStore);
  const elapsed = state === undefined ? undefined : now - state.checkedAt;
  if (elapsed !== undefined && elapsed >= 0 && elapsed < intervalMs) {
    return { status: "skipped", reason: "recently_checked" };
  }

  let managed: boolean;
  try {
    managed = await updater.isManagedInstall(options.packageRoot, options.packageName);
  } catch (error) {
    return { status: "failed", phase: "detect", message: errorMessage(error) };
  }
  if (!managed) return { status: "skipped", reason: "unmanaged_install" };

  await saveState(stateStore, { checkedAt: now });

  let latestVersion: string;
  try {
    latestVersion = await updater.latestVersion(options.packageName);
  } catch (error) {
    return { status: "failed", phase: "check", message: errorMessage(error) };
  }

  if (!isNewerStableVersion(options.currentVersion, latestVersion)) {
    return { status: "current", currentVersion: options.currentVersion, latestVersion };
  }

  options.onUpdateAvailable?.(options.currentVersion, latestVersion);
  try {
    await updater.installGlobal(options.packageName, latestVersion);
  } catch (error) {
    return { status: "failed", phase: "install", message: errorMessage(error) };
  }
  return { status: "updated", previousVersion: options.currentVersion, version: latestVersion };
}

export class FileUpdateStateStore implements UpdateStateStore {
  readonly path: string;

  constructor(path = defaultUpdateStatePath()) {
    this.path = path;
  }

  async load(): Promise<UpdateCheckState | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }

    try {
      const parsed = JSON.parse(contents) as unknown;
      if (!isRecord(parsed) || typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) {
        return undefined;
      }
      return { checkedAt: parsed.checkedAt };
    } catch {
      return undefined;
    }
  }

  async save(state: UpdateCheckState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(this.path, 0o600);
  }
}

export class NpmPackageUpdater implements PackageUpdater {
  readonly #command: string;

  constructor(command = process.platform === "win32" ? "npm.cmd" : "npm") {
    this.#command = command;
  }

  async isManagedInstall(packageRoot: string, packageName: string): Promise<boolean> {
    const globalRoot = (await run(this.#command, ["root", "--global"], 10_000)).trim();
    if (!globalRoot) throw new Error("npm did not report its global package directory");
    const installedRoot = join(globalRoot, ...packageName.split("/"));
    try {
      if ((await lstat(installedRoot)).isSymbolicLink()) return false;
      const [actualRoot, expectedRoot] = await Promise.all([realpath(packageRoot), realpath(installedRoot)]);
      return actualRoot === expectedRoot;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async latestVersion(packageName: string): Promise<string> {
    const output = await run(this.#command, ["view", packageName, "version", "--json"], 15_000);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("npm returned an invalid package version");
    }
    if (typeof parsed !== "string" || parseSemVer(parsed) === undefined) {
      throw new Error("npm returned an invalid package version");
    }
    return parsed;
  }

  async installGlobal(packageName: string, version: string): Promise<void> {
    if (parseSemVer(version) === undefined) throw new Error("Refusing to install an invalid package version");
    await run(this.#command, ["install", "--global", `${packageName}@${version}`, "--no-audit", "--no-fund"], 120_000);
  }
}

export function defaultUpdateStatePath(): string {
  const root = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(root, "froe", "update.json");
}

export function isNewerStableVersion(currentVersion: string, candidateVersion: string): boolean {
  const current = parseSemVer(currentVersion);
  const candidate = parseSemVer(candidateVersion);
  if (current === undefined || candidate === undefined || candidate.prerelease.length > 0) return false;
  return compareSemVer(candidate, current) > 0;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

function parseSemVer(value: string): SemVer | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4]?.split(".").map((identifier) => /^\d+$/.test(identifier) ? Number(identifier) : identifier) ?? [];
  if (prerelease.some((identifier) => typeof identifier === "number" && !Number.isSafeInteger(identifier))) return undefined;
  return { major, minor, patch, prerelease };
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === "number" && typeof rightIdentifier === "string") return -1;
    if (typeof leftIdentifier === "string" && typeof rightIdentifier === "number") return 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

async function loadState(store: UpdateStateStore): Promise<UpdateCheckState | undefined> {
  try {
    return await store.load();
  } catch {
    return undefined;
  }
}

async function saveState(store: UpdateStateStore, state: UpdateCheckState): Promise<void> {
  try {
    await store.save(state);
  } catch {
    // Update throttling is best-effort and must not block a coding task.
  }
}

function run(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
