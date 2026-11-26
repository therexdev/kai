"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { RELEASES, UNIT, USER, verifyInstalled } = require("./native-rollout-release");
function service(release, changes = {}) {
  const properties = { WorkingDirectory: release, User: USER, Group: USER, DropInPaths: "", Restart: "on-failure", FragmentPath: "/etc/systemd/system/" + UNIT, ...changes };
  return (exe, args) => {
    assert.equal(exe, "systemctl"); assert.deepEqual(args.slice(0, 3), ["show", UNIT, "--value"]);
    return properties[args[3].slice("--property=".length)];
  };
}
test("selects either reviewed installed release without requesting a service change", () => {
  for (const release of RELEASES) assert.equal(verifyInstalled(service(release)), release);
});
test("unknown releases and path aliases remain unsupported", () => {
  for (const release of ["/other", RELEASES[1] + "/", RELEASES[1] + "/../65c1d21b85705cd26acc63bd1eedaf5af4ef6400"])
    assert.throws(() => verifyInstalled(service(release)), /Unsupported installed WorkingDirectory/);
});
test("changed identity, overrides, unit location or restart policy refuse both releases", () => {
  for (const release of RELEASES) for (const key of ["User", "Group", "DropInPaths", "Restart", "FragmentPath"])
    assert.throws(() => verifyInstalled(service(release, { [key]: "changed" })), new RegExp("Unexpected installed service " + key));
});
test("a release change during an operation stops even when the replacement is reviewed", () => {
  assert.throws(() => verifyInstalled(service(RELEASES[1]), RELEASES[0]), /release changed/);
  assert.equal(verifyInstalled(service(RELEASES[1]), RELEASES[1]), RELEASES[1]);
});
