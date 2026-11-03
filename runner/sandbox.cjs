"use strict";
const { spawn } = require("node:child_process"), crypto = require("node:crypto");
const PROFILE = require("../lib/builder/build-config").PROFILE;
function processRun(bin, args, { input, timeout = 10000, maxBytes = 7000000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" } });
    let stdout = "", stderr = "", size = 0, error = "";
    const stop = message => { error = message; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("Runner deadline exceeded"), timeout);
    for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) stream.on("data", data => {
      size += data.length;
      if (size > maxBytes) return stop("Runner output exceeded its limit");
      if (name === "stdout") stdout += data; else stderr += data;
    });
    child.on("error", e => { error = e.message; });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, error }); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
function dockerArgs(image, name) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image || "")) throw Error("Set KAI_RUNNER_IMAGE to an immutable Docker image ID");
  return ["run", "--rm", "--name", name, "--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1g", "--memory-swap=1g", "--cpus=1", "--user=1000:1000", "--tmpfs=/workspace:rw,nosuid,nodev,size=100m,uid=1000,gid=1000,mode=700", "--tmpfs=/tmp:rw,nosuid,nodev,size=100m,uid=1000,gid=1000,mode=700", "--ulimit=nofile=256:256", "--ulimit=fsize=16777216:16777216", "--log-driver=none", "--env=NODE_OPTIONS=--max-old-space-size=512", "-i", image];
}
async function ready(image) {
  dockerArgs(image, "check");
  const info = await processRun("docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (info.error || info.code !== 0 || !JSON.parse(info.stdout || "{}").runsc) throw Error("gVisor runsc is required; ordinary Docker execution is disabled");
  const inspected = await processRun("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  if (inspected.code !== 0 || inspected.stdout.trim() !== image) throw Error("The pinned toolchain image is unavailable");
  return { profile: PROFILE, image, runtime: "runsc" };
}
async function run(job, { image, timeout = 120000 } = {}) {
  await ready(image);
  const name = "kai-job-" + crypto.randomBytes(12).toString("hex"), started = Date.now();
  let result;
  try {
    const output = await processRun("docker", dockerArgs(image, name), { input: JSON.stringify(job), timeout });
    if (output.error || output.code !== 0) result = { ok: false, logs: output.error || output.stderr.slice(-2000) || "Build process failed", artifacts: [] };
    else {
      try { result = JSON.parse(output.stdout); } catch { result = { ok: false, logs: "Invalid sandbox output", artifacts: [] }; }
    }
  } finally {
    // Killing the Docker client does not necessarily kill its container.
    await processRun("docker", ["rm", "-f", name], { timeout: 15000, maxBytes: 10000 });
  }
  return { ...result, sourceHash: job.sourceHash, target: job.target.id, operation: job.operation, profile: PROFILE, image, runtime: "runsc", durationMs: Date.now() - started };
}
module.exports = { processRun, dockerArgs, ready, run };
