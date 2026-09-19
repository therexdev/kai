"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path");
const { previewDiagnostics } = require("../lib/builder/diagnostics");
const {
  FRAME_SANDBOX,
  FRAME_CSP,
  FRAME_CONTENT_CSP,
} = require("../lib/builder/frame-policy");
const { starter, html } = require("../lib/builder/projects");
const { bundle } = require("../lib/builder/export");

test("preview, hosted and exported forms enable submit handlers while blocking native form requests", () => {
  for (const name of ["index.html", "host.html"]) {
    const shell = fs.readFileSync(
      path.join(__dirname, "../views/build", name),
      "utf8",
    );
    assert.ok(shell.includes('sandbox="' + FRAME_SANDBOX + '"'));
  }
  assert.equal(FRAME_SANDBOX, "allow-scripts allow-forms");
  assert.ok(FRAME_CSP.startsWith("sandbox " + FRAME_SANDBOX + ";"));
  assert.match(FRAME_CONTENT_CSP, /form-action 'none'/);
  assert.match(FRAME_CSP, /connect-src 'none'/);
  assert.doesNotMatch(
    FRAME_CSP,
    /allow-same-origin|allow-popups|allow-top-navigation/,
  );
  const files = starter("voting", "Form probe"),
    page = html(files);
  assert.match(page, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(page, /form-action &#39;none&#39;/);
  assert.ok(
    page.indexOf('http-equiv="Content-Security-Policy"') <
      page.indexOf("<script>"),
  );
  const exported = bundle(
    { title: "Form probe", template: "voting", network: "testnet" },
    { files, revision: 1, hash: "a".repeat(64) },
  ).toString();
  assert.ok(exported.includes('sandbox="' + FRAME_SANDBOX + '"'));
  assert.ok(exported.includes(page));
});

test("preview diagnostics are revision scoped, bounded, stripped of client extras and redact keys", () => {
  const payload = {
    revision: 2,
    errors: [
      {
        kind: "bridge",
        action: "call:create_feature",
        message: "Unsupported method",
        formValues: { secret: "do not send" },
      },
    ],
  };
  assert.deepEqual(previewDiagnostics(payload, 3), []);
  assert.deepEqual(
    previewDiagnostics({ ...payload, errors: "invalid" }, 2),
    [],
  );
  const first = previewDiagnostics(payload, 2)[0];
  assert.equal(first.action, "call:create_feature");
  assert.equal(first.formValues, undefined);
  const key = "sk-proj-" + "x".repeat(48);
  const errors = Array.from({ length: 20 }, () => ({
    kind: "instructions",
    message: key + "a".repeat(1000),
    action: "x".repeat(150),
    line: -1,
    column: 2,
  }));
  const result = previewDiagnostics({ revision: 2, errors }, 2);
  assert.equal(result.length, 8);
  assert.equal(result[0].kind, "javascript");
  assert.equal(result[0].line, null);
  assert.equal(result[0].column, 2);
  assert.equal(result[0].action.length, 80);
  assert.ok(result[0].message.length <= 500);
  assert.doesNotMatch(JSON.stringify(result), /sk-proj-/);
});
