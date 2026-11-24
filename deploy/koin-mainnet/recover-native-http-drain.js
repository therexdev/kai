"use strict";
// One incident-specific socket recovery. Never sends a process signal, changes
// service configuration, opens a financial journal or rewrites the saved plan.
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const TARGET = "65c1d21b85705cd26acc63bd1eedaf5af4ef6400", BASE = "bc1fca8328cdd463023c472ba3ee5ca84d9c6580";
const UNIT = "kai-koin-prepaid.service", PID = "477847", PEER = "43802";
const FILTER = `src 127.0.0.1 and sport = :3109 and dst 127.0.0.1 and dport = :${PEER}`;
const PROPS = "ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus,Result,NRestarts,WorkingDirectory";
function command(exe, args, cwd) { return execFileSync(exe, args, { cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function clean(s) { return s.ActiveState === "inactive" && s.MainPID === "0" && s.ExecMainCode === "1" && s.ExecMainStatus === "0" && s.Result === "success"; }
async function recover({ repo = process.cwd(), work = "/root", run = command, uid = process.getuid?.(),
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 60000, log = console.log } = {}) {
  if (uid !== 0) throw Error("Run as root");
  if (run("git", ["rev-parse", "HEAD"], repo) !== TARGET || run("git", ["status", "--porcelain"], repo)) throw Error("Keep the original clean, pinned native qualification checkout");
  const lock = path.join(work, "kai-native-qualification-update.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const file = path.join(work, `kai-native-qualification-plan-${TARGET}.json`), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 262144) throw Error("Expected the protected existing deployment plan");
    const bytes = fs.readFileSync(file), plan = JSON.parse(bytes);
    if (plan.schema !== 1 || plan.base !== BASE || plan.target !== TARGET || plan.phase !== "draining" || plan.initial?.MainPID !== PID || plan.initial?.ExecMainPID !== PID || plan.initial?.ActiveState !== "active") throw Error("Deployment plan differs from the observed drain incident");
    const state = () => {
      if (!fs.readFileSync(file).equals(bytes)) throw Error("Deployment plan changed; recovery stopped");
      const s = Object.fromEntries(run("systemctl", ["show", UNIT, "--property=" + PROPS]).split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
      if (s.WorkingDirectory !== `/opt/kai-koin-prepaid/releases/${BASE}` || s.ExecMainPID !== PID || s.NRestarts !== plan.initial.NRestarts) throw Error("Service identity changed; recovery stopped");
      if (!clean(s) && !(s.ActiveState === "active" && s.SubState === "running" && s.MainPID === PID && s.ExecMainCode === "0" && s.ExecMainStatus === "0" && s.Result === "success")) throw Error("Service has not retained the observed running or clean-exit state");
      return s;
    };
    if (clean(state())) { log("The original process has already exited cleanly; resume the same deployment."); return; }
    // A closed listener establishes that HTTP shutdown has already begun.
    if (run("ss", ["-Hlnt", "sport = :3109"])) throw Error("HTTP listener is still open; no connection was touched");
    const rows = run("ss", ["-Hntp", "sport = :3109"]).split("\n").filter(Boolean);
    const expected = /^ESTAB\s+0\s+0\s+127\.0\.0\.1:3109\s+127\.0\.0\.1:43802\s+users:\(\("node",pid=477847,fd=80\)\)$/;
    if (rows.length !== 1 || !expected.test(rows[0].trim())) throw Error("The single observed socket has changed; no connection was touched");
    if (clean(state())) { log("The original process exited cleanly before socket recovery."); return; }
    if (run("ss", ["-Hlnt", "sport = :3109"])) throw Error("HTTP listener changed; no connection was touched");
    log("Closing only the observed loopback HTTP connection. No process signal is sent.");
    run("ss", ["-Knt", FILTER]);
    const deadline = now() + timeoutMs;
    for (;;) {
      if (clean(state())) { log("Original process exited cleanly. Resume the same pinned deployment."); return; }
      if (now() >= deadline) throw Error("Process is still draining after socket recovery. It was not killed or restarted; preserve the plan and report current status");
      await wait(Math.min(500, deadline - now()));
    }
  } finally { fs.rmdirSync(lock); }
}
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== "--disconnect-observed-http") throw Error("Explicit --disconnect-observed-http is required");
  process.umask(0o077);
  recover().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { recover, TARGET, BASE, UNIT, FILTER };
