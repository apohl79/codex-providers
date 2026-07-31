import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPO_DIR = path.resolve(__dirname, "..");
const INSTALLER_PATH = path.join(REPO_DIR, "install.sh");

function installRunner(homeDir: string): string {
  const runnerName = "codex-providers-test";
  const result = spawnSync("bash", [INSTALLER_PATH], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_PROVIDERS_RUNNER_NAME: runnerName,
      CODEX_PROVIDERS_ZSHRC_PATH: path.join(homeDir, ".zshrc"),
    },
  });
  assert.deepEqual(
    { status: result.status, stderr: result.stderr },
    { status: 0, stderr: "" },
  );
  return path.join(homeDir, ".local", "bin", runnerName);
}

function runRunner(runnerPath: string, pidFile: string) {
  return spawnSync(runnerPath, ["proxy", "stop"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: { ...process.env, HOME: path.dirname(pidFile), CODEX_PROVIDERS_PID_FILE: pidFile },
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

test("installed codex-providers dispatches setup and configure to the wizard", (t) => {
  const homeDir = testHome("codex-providers-dispatch-");
  const runnerPath = installRunner(homeDir);
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const setupResult = spawnSync(runnerPath, ["setup", "--help"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: process.env,
  });
  const configureResult = spawnSync(runnerPath, ["configure", "gemini", "--help"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: process.env,
  });

  assert.deepEqual(
    {
      setupStatus: setupResult.status,
      configureStatus: configureResult.status,
      setupUsage: setupResult.stdout.includes("usage: codex-providers"),
      configureUsage: configureResult.stdout.includes("usage: codex-providers"),
    },
    { setupStatus: 0, configureStatus: 0, setupUsage: true, configureUsage: true },
  );
});

test("installer removes this repository's legacy auth2api runner and shell hook", (t) => {
  const homeDir = testHome("codex-providers-migration-");
  const legacyRunnerPath = path.join(homeDir, ".local", "bin", "auth2api");
  fs.mkdirSync(path.dirname(legacyRunnerPath), { recursive: true });
  fs.writeFileSync(legacyRunnerPath, `REPO_DIR=${REPO_DIR}\n`);
  fs.writeFileSync(
    path.join(homeDir, ".zshrc"),
    "# >>> auth2api ensure >>>\nlegacy\n# <<< auth2api ensure <<<\n",
  );
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const runnerPath = installRunner(homeDir);
  const zshrc = fs.readFileSync(path.join(homeDir, ".zshrc"), "utf8");

  assert.deepEqual(
    {
      runnerExists: fs.existsSync(runnerPath),
      legacyRunnerExists: fs.existsSync(legacyRunnerPath),
      containsLegacyHook: zshrc.includes("auth2api ensure"),
      containsNewHook: zshrc.includes("codex-providers proxy ensure"),
    },
    {
      runnerExists: true,
      legacyRunnerExists: false,
      containsLegacyHook: false,
      containsNewHook: true,
    },
  );
});

test("codex-providers proxy stop succeeds when no managed process exists", (t) => {
  const homeDir = testHome("codex-providers-runner-empty-");
  const runnerPath = installRunner(homeDir);
  const pidFile = path.join(homeDir, "server.pid");
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = runRunner(runnerPath, pidFile);

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, pidFileExists: fs.existsSync(pidFile) },
    { status: 0, stdout: "No managed proxy process found.\n", pidFileExists: false },
  );
});

test("codex-providers proxy stop removes malformed PID state without signalling", (t) => {
  const homeDir = testHome("codex-providers-runner-malformed-");
  const runnerPath = installRunner(homeDir);
  const pidFile = path.join(homeDir, "server.pid");
  fs.writeFileSync(pidFile, "not-a-pid\n");
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = runRunner(runnerPath, pidFile);

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, pidFileExists: fs.existsSync(pidFile) },
    { status: 0, stdout: "Removed stale proxy PID file.\n", pidFileExists: false },
  );
});

test("codex-providers proxy stop refuses an unrelated live process", (t) => {
  const homeDir = testHome("codex-providers-runner-unowned-");
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

test("codex-providers proxy stop terminates the process recorded by the runner", (t) => {
  const homeDir = testHome("codex-providers-runner-owned-");
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

  const result = spawnSync(runnerPath, ["proxy", "stop"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      AUTH2API_CONFIG_PATH: configPath,
      CODEX_PROVIDERS_PID_FILE: pidFile,
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

test("codex-providers proxy stop accepts the legacy managed PID during migration", (t) => {
  const homeDir = testHome("codex-providers-runner-legacy-pid-");
  const runnerPath = installRunner(homeDir);
  const configPath = path.join(homeDir, "config.yaml");
  const legacyPidFile = path.join(homeDir, ".local", "state", "auth2api", "server.pid");
  fs.mkdirSync(path.dirname(legacyPidFile), { recursive: true });
  const managedProcess = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 60_000)",
    path.join(REPO_DIR, "dist", "index.js"),
    `--config=${configPath}`,
  ]);
  const managedPid = processPid(managedProcess);
  fs.writeFileSync(legacyPidFile, `${managedPid}\n`);
  t.after(() => {
    managedProcess.kill();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const result = spawnSync(runnerPath, ["proxy", "stop"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    env: { ...process.env, HOME: homeDir, AUTH2API_CONFIG_PATH: configPath },
  });

  assert.deepEqual(
    { status: result.status, pidFileExists: fs.existsSync(legacyPidFile) },
    { status: 0, pidFileExists: false },
  );
});
