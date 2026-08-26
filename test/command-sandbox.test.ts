import assert from "node:assert/strict";
import { access, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MacOSSeatbeltCommandSandbox, type CommandInvocation } from "../src/command-sandbox.js";

function invocation(executable: string, args: string[], cwd: string): CommandInvocation {
  return {
    executable,
    args,
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
  };
}

test("macOS Seatbelt allows workspace and temporary writes and retries other writes with an exact exception", {
  skip: process.platform !== "darwin" ? "Seatbelt is available only on macOS" : false,
}, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "froe-seatbelt-workspace-")));
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "froe-seatbelt-temporary-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "froe-seatbelt-outside-")));
  const sandbox = await MacOSSeatbeltCommandSandbox.create(workspace, temporaryDirectory);
  const insidePath = join(workspace, "inside.txt");
  const temporaryPath = join(temporaryDirectory, "temporary.txt");
  const outsidePath = join(outside, "outside.txt");

  const allowed = await sandbox.run(invocation("/usr/bin/touch", [insidePath], workspace));
  assert.equal(allowed.exitCode, 0, JSON.stringify(allowed));
  assert.equal(allowed.denial, undefined);
  await access(insidePath);

  const temporary = await sandbox.run(invocation("/usr/bin/touch", [temporaryPath], workspace));
  assert.equal(temporary.exitCode, 0, JSON.stringify(temporary));
  assert.equal(temporary.denial, undefined);
  await access(temporaryPath);

  const blocked = await sandbox.run(invocation("/usr/bin/touch", [outsidePath], workspace));
  assert.notEqual(blocked.denial, undefined);
  assert.deepEqual(blocked.denial?.exceptions, [{ type: "file-write", path: outsidePath }]);
  await assert.rejects(() => access(outsidePath));

  const retried = await sandbox.run(
    invocation("/usr/bin/touch", [outsidePath], workspace),
    blocked.denial?.exceptions,
  );
  assert.equal(retried.exitCode, 0, JSON.stringify(retried));
  assert.equal(retried.denial, undefined);
  await access(outsidePath);
});

test("macOS Seatbelt denies network by default and scopes a retry to the denied operation and endpoint", {
  skip: process.platform !== "darwin" ? "Seatbelt is available only on macOS" : false,
}, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "froe-seatbelt-network-")));
  const sandbox = await MacOSSeatbeltCommandSandbox.create(workspace, workspace);
  const command = invocation("/usr/bin/curl", ["--connect-timeout", "1", "http://127.0.0.1:9/"], workspace);

  const blocked = await sandbox.run(command);
  const networkException = blocked.denial?.exceptions[0];
  assert.equal(networkException?.type, "network", JSON.stringify(blocked));
  if (networkException?.type !== "network") assert.fail("Expected a network sandbox exception");
  assert.equal(networkException.operation, "network-outbound");
  assert.match(networkException.target, /^remote:.+:9$/);

  const retried = await sandbox.run(command, blocked.denial?.exceptions);
  assert.equal(retried.denial, undefined);
  assert.equal(retried.exitCode, 7);
});

test("macOS Seatbelt limits command reads to the workspace, temporary directory, system runtime, and trusted toolchains", {
  skip: process.platform !== "darwin" ? "Seatbelt is available only on macOS" : false,
}, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "froe-seatbelt-read-workspace-")));
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "froe-seatbelt-read-temporary-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "froe-seatbelt-read-outside-")));
  const workspaceFile = join(workspace, "workspace.txt");
  const outsideFile = join(outside, "secret.txt");
  await writeFile(workspaceFile, "workspace-only", "utf8");
  await writeFile(outsideFile, "must-not-leak", "utf8");
  const sandbox = await MacOSSeatbeltCommandSandbox.create(workspace, temporaryDirectory);

  const allowed = await sandbox.run(invocation("/bin/cat", [workspaceFile], workspace));
  assert.equal(allowed.exitCode, 0, JSON.stringify(allowed));
  assert.equal(allowed.output, "workspace-only");
  assert.equal(allowed.denial, undefined);

  const blocked = await sandbox.run(invocation("/bin/cat", [outsideFile], workspace));
  assert.notEqual(blocked.denial, undefined);
  assert.match(blocked.denial?.reason ?? "", /file-read/);
  assert.doesNotMatch(blocked.output, /must-not-leak/);

  const isolatedHome = await sandbox.run(invocation("/usr/bin/printenv", ["HOME"], workspace));
  assert.equal(isolatedHome.exitCode, 0);
  assert.equal(isolatedHome.output.trim(), temporaryDirectory);

  const node = await sandbox.run(invocation(process.execPath, ["-e", "process.stdout.write('node-ok')"], workspace));
  assert.equal(node.exitCode, 0);
  assert.equal(node.output, "node-ok");
});
