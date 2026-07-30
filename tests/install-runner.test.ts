import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPO_DIR = path.resolve(__dirname, "..");
const INSTALLER_PATH = path.join(REPO_DIR, "install.sh");

function installRunner(homeDir: string): string {
  const runnerName = "auth2api-test";
  const result = spawnSync("bash", [INSTALLER_PATH], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      AUTH2API_RUNNER_NAME: runnerName,
      AUTH2API_ZSHRC_PATH: path.join(homeDir, ".zshrc"),
    },
  });
  assert.deepEqual(
    { status: result.status, stderr: result.stderr },
    { status: 0, stderr: "" },
  );
  return path.join(homeDir, ".local", "bin", runnerName);
}

function runRunner(runnerPath: string, pidFile: string) {
  return spawnSync(runnerPath, ["stop"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: { ...process.env, AUTH2API_PID_FILE: pidFile },
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processPid(childProcess: ChildProcess): number {
  const { pid } = childProcess;
  if (typeof pid !== "number") throw new Error("Expected a live child process");
  return pid;
}

function testHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("installed runner stop succeeds when no managed process exists", (t) => {
  const homeDir = testHome("auth2api-runner-empty-");
  const runnerPath = installRunner(homeDir);
  const pidFile = path.join(homeDir, "server.pid");
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = runRunner(runnerPath, pidFile);

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, pidFileExists: fs.existsSync(pidFile) },
    { status: 0, stdout: "No managed auth2api process found.\n", pidFileExists: false },
  );
});

test("installed runner stop removes malformed PID state without signalling", (t) => {
  const homeDir = testHome("auth2api-runner-malformed-");
  const runnerPath = installRunner(homeDir);
  const pidFile = path.join(homeDir, "server.pid");
  fs.writeFileSync(pidFile, "not-a-pid\n");
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = runRunner(runnerPath, pidFile);

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, pidFileExists: fs.existsSync(pidFile) },
    { status: 0, stdout: "Removed stale auth2api PID file.\n", pidFileExists: false },
  );
});

test("installed runner stop refuses an unrelated live process", (t) => {
  const homeDir = testHome("auth2api-runner-unowned-");
  const runnerPath = installRunner(homeDir);
  const pidFile = path.join(homeDir, "server.pid");
  const foreignProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"]);
  const foreignPid = processPid(foreignProcess);
  fs.writeFileSync(pidFile, `${foreignPid}\n`);
  t.after(() => {
    foreignProcess.kill();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const result = runRunner(runnerPath, pidFile);

  assert.deepEqual(
    {
      status: result.status,
      foreignProcessAlive: isAlive(foreignPid),
      pidFileExists: fs.existsSync(pidFile),
    },
    { status: 1, foreignProcessAlive: true, pidFileExists: true },
  );
});

test("installed runner stop terminates the process recorded by the runner", (t) => {
  const homeDir = testHome("auth2api-runner-owned-");
  const runnerPath = installRunner(homeDir);
  const configPath = path.join(homeDir, "config.yaml");
  const pidFile = path.join(homeDir, "server.pid");
  const managedProcess = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 60_000)",
    path.join(REPO_DIR, "dist", "index.js"),
    `--config=${configPath}`,
  ]);
  const managedPid = processPid(managedProcess);
  fs.writeFileSync(pidFile, `${managedPid}\n`);
  t.after(() => {
    managedProcess.kill();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const result = spawnSync(runnerPath, ["stop"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      AUTH2API_CONFIG_PATH: configPath,
      AUTH2API_PID_FILE: pidFile,
    },
  });

  assert.deepEqual(
    {
      status: result.status,
      pidFileExists: fs.existsSync(pidFile),
    },
    { status: 0, pidFileExists: false },
  );
});
