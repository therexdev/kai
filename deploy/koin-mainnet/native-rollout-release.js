"use strict";
const { execFileSync } = require("node:child_process");
// Explicitly reviewed releases with identical native qualification/replay code.
const RELEASES = Object.freeze([
  "/opt/kai-koin-prepaid/releases/65c1d21b85705cd26acc63bd1eedaf5af4ef6400",
  "/opt/kai-koin-prepaid/releases/a7cf99f42cc853255d295cba19ccb609cd884ba6",
]);
const UNIT = "kai-koin-prepaid.service", USER = "kai-koin-prepaid";
const command = (exe, args, cwd) => execFileSync(exe, args, { cwd, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] }).trim();
function verifyInstalled(run = command, expectedRelease) {
  const read = key => run("systemctl", ["show", UNIT, "--value", "--property=" + key]);
  const release = read("WorkingDirectory");
  if (!RELEASES.includes(release)) throw Error("Unsupported installed WorkingDirectory: " + release + "; preserve the running release for review");
  if (expectedRelease !== undefined && release !== expectedRelease) throw Error("Installed release changed during native rollout; preserve it for review");
  for (const [key, value] of Object.entries({ User: USER, Group: USER, DropInPaths: "", Restart: "on-failure", FragmentPath: "/etc/systemd/system/" + UNIT }))
    if (read(key) !== value) throw Error("Unexpected installed service " + key + "; preserve it for review");
  return release;
}
module.exports = { RELEASES, UNIT, USER, command, verifyInstalled };
