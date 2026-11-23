"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom"), { service } = require("./helpers/credit-gateway-fixture");
const { renderMarkdown } = require("../public/platform/chat-ui");
test("assistant Markdown formats tables, nested lists, links and code without executing model markup", t => {
  const source = '# Heading\n\n**Bold** and _italic_. https://koinosai.com\n\n- First\n  - Nested\n\n| Name | Value |\n| --- | --- |\n| KAI | `code` |\n\n> Quoted\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [encoded](jav&#x61;script:alert(1)) ![pixel](https://evil.test/pixel)';
  const dom = new JSDOM(renderMarkdown(source)); t.after(() => dom.window.close()); const doc = dom.window.document;
  assert.equal(doc.querySelector("h1").textContent, "Heading"); assert.equal(doc.querySelector("strong").textContent, "Bold");
  assert.equal(doc.querySelectorAll("ul ul li").length, 1); assert.equal(doc.querySelector("tbody td").textContent, "KAI");
  assert.equal(doc.querySelector("pre code").textContent, "<script>alert(1)</script>\n"); assert.ok(doc.querySelector(".code-copy"));
  assert.equal(doc.querySelectorAll("script,img,iframe,svg").length, 0);
  for (const a of doc.querySelectorAll("a")) { assert.match(a.href, /^https?:\/\//); assert.equal(a.target, "_blank"); assert.equal(a.rel, "noopener noreferrer"); }
  assert.match(renderMarkdown('```js\nconst x = "<tag>";'), /&lt;tag&gt;/, "incomplete streaming fences stay escaped");
});
test("automatic reply sizing uses remaining context, checks the account and does not reserve credits", async t => {
  const s = await service(t), a = await s.signup("context@example.test"), b = await s.signup("another@example.test");
  const body = { model: "fixture", messages: [{ role: "user", content: "Hello" }] };
  const call = (value = body, headers = { cookie: a.cookie, "x-kai-account": a.account.id }) => s.call("/platform/api/chat/limits", value, headers);
  assert.equal((await call(body, {})).status, 401);
  assert.equal((await call(body, { cookie: b.cookie, "x-kai-account": a.account.id })).status, 409);
  const before = s.prepaid.ledger.db.prepare("SELECT * FROM accounts").all();
  const full = await call(); assert.equal(full.status, 200); assert.equal(full.value.maxOutput, 64); assert.equal(full.value.contextTokens, 4096);
  const near = { ...body, messages: [{ role: "user", content: "x".repeat(4096 - full.value.inputTokens - 20 + 5) }] };
  const limited = await call(near); assert.equal(limited.status, 200); assert.equal(limited.value.maxOutput, 20);
  assert.equal((await call({ ...body, messages: [{ role: "user", content: "x".repeat(4096) }] })).status, 400);
  assert.equal((await call({ ...body, model: "missing" })).status, 400);
  assert.equal((await call({ ...body, creditWallet: "wrong" })).status, 400);
  assert.deepEqual(s.prepaid.ledger.jobs(), []); assert.deepEqual(s.prepaid.ledger.db.prepare("SELECT * FROM accounts").all(), before);
});
test("managed GPT OSS offers its supported output maximum without calling the inference provider", async t => {
  const s = await service(t, { managedFetch: () => assert.fail("Sizing must not invoke inference") }), a = await s.signup("managed-context@example.test");
  const response = await s.call("/platform/api/chat/limits", { model: "akash-gpt-oss-120b", messages: [{ role: "user", content: "Hello" }] }, { cookie: a.cookie });
  assert.equal(response.status, 200); assert.equal(response.value.maxOutput, 8192); assert.equal(response.value.contextTokens, 131072);
  assert.deepEqual(s.prepaid.ledger.jobs(), []);
});
test("new Chat visits choose GPT OSS and automatic limits increase with the model while manual choices survive refresh", async t => {
  const s = await service(t), a = await s.signup("model-default@example.test");
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../public/platform/index.html"), "utf8"), { url: s.base + "/app?embed=workspace", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close()); const w = dom.window, $ = id => w.document.getElementById(id);
  let gptAvailable = true;
  w.fetch = async (url, options = {}) => {
    const response = await fetch(s.base + url, { ...options, headers: { ...options.headers, cookie: a.cookie } });
    if (!url.startsWith("/platform/api/overview")) return response;
    const value = await response.json(); value.models = [
      { model: "gemma", label: "Gemma", available: true, maxOutput: 256, contextTokens: 8192 },
      { model: "akash-gpt-oss-120b", label: "GPT OSS 120B", available: gptAvailable, maxOutput: 8192, contextTokens: 131072 }];
    return Response.json(value);
  };
  for (const file of ["account-routes.js", "markdown-it.min.js", "chat-ui.js", "platform.js"]) w.eval(fs.readFileSync(path.join(__dirname, "../public/platform", file), "utf8"));
  for (let n = 0; !$("model").value && n < 100; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal($("model").value, "akash-gpt-oss-120b"); assert.equal($("tokens").value, "8192");
  $("model").value = "gemma"; $("model").onchange(); assert.equal($("tokens").value, "256");
  $("model").value = "akash-gpt-oss-120b"; $("model").onchange(); assert.equal($("tokens").value, "8192");
  $("tokens").value = "1024"; $("tokens").oninput(); await $("refresh").onclick();
  assert.equal($("auto-tokens").checked, false); assert.equal($("tokens").value, "1024");
  gptAvailable = false; await $("refresh").onclick(); assert.equal($("model").value, "gemma"); assert.equal($("tokens").value, "256");
  assert.equal(w.document.querySelector('a[href*="app%2Fhistory"]'), null);
  assert.equal([...w.document.querySelectorAll('nav[data-area="workspace"] a')].map(n => n.textContent).join(","), "Build");
});
