"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict"), express = require("express");
const { chromium } = require("playwright"), { Builder } = require("../lib/builder/service"),
  { createBuilderRouter } = require("../lib/builder/router"), { createAccounts } = require("../lib/accounts");
(async () => {
  const root = path.join(__dirname, ".."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-browser-")), app = express();
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }), origin = "http://127.0.0.1:" + server.address().port;
  const accounts = createAccounts({ stateDir: dir, siteOrigin: origin }), builder = new Builder({ stateDir: dir, autoStart: false,
    agent: { configured: true, model: "fixture", async run({ files, prompt, pendingProposal }) {
      if (prompt === "Explain this proposal") { assert.equal(pendingProposal, true); return { files, changed: false, summary: "The plugin and contract source remain proposed until you apply them." }; }
      return { files: { ...files, "notes/help.md": (files["notes/help.md"] || "") + "\n" + prompt }, changed: true, summary: "Proposed source documentation. No deployment performed." };
    } } });
  app.use(express.json({ limit: "1mb" }), accounts.router, createBuilderRouter({ accounts, stateDir: dir, builder }).router, express.static(path.join(root, "public")));
  const user = accounts.service._newAccount({ email: "browser@example.test" }), token = accounts.service._issueSession(user.id, "browser-test");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: "kai_session", value: token, url: origin }]);
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/build"); await page.locator('[data-template="plugin-chain"]').waitFor();
    await page.screenshot({ path: path.join(__dirname, "builder-plugins-welcome.png") });
    await page.locator('[data-template="plugin-chain"]').click(); await page.locator("#project-title").fill("My KAI chain plugin"); await page.locator("#create-submit").click();
    await page.locator("#file-tree button").first().waitFor();
    assert.equal(await page.locator("#publish").isVisible(), false); assert.equal(await page.locator("#source-export").isVisible(), true);
    assert.match(await page.locator("#file-tree").textContent(), /contract\/assembly\/Counter.ts/);
    const project = builder.store.list(user.id)[0];
    const send = async prompt => {
      const jobs = builder.store.detail(user.id, project.id).jobs.length;
      await page.locator("#prompt").fill(prompt); assert.equal(await page.locator("#send").isEnabled(), true); await page.locator("#send").click();
      for (let i = 0; builder.store.detail(user.id, project.id).jobs.length === jobs && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(builder.store.detail(user.id, project.id).jobs.length > jobs); await builder.tick();
      await page.waitForFunction(() => !document.getElementById("send").disabled && document.getElementById("prompt").value === "");
    };
    await send("Add plugin help"); const first = builder.store.proposal(user.id, project.id).id;
    await page.locator("#composer-review").waitFor(); await send("Explain this proposal");
    assert.equal(builder.store.proposal(user.id, project.id).id, first);
    await send("Include chain setup"); assert.notEqual(builder.store.proposal(user.id, project.id).id, first);
    assert.match(builder.store.proposal(user.id, project.id).files["notes/help.md"], /Add plugin help\nInclude chain setup/);
    assert.equal(builder.store.owned(user.id, project.id).revision, 1);
    await page.locator("#composer-review").click(); await page.locator("#apply-proposal").click();
    await page.locator("#review-pending").waitFor({ state: "hidden" }); assert.equal(builder.store.owned(user.id, project.id).revision, 2);
    await page.locator("#tab-reference").click(); await page.locator("#reference-content").getByText("Core API boundaries", { exact: true }).waitFor();
    assert.equal(await page.locator("#reference-content table").count(), 2);
    assert.equal(await page.locator("#reference-content a").first().getAttribute("href"), "https://koinosai.com/build");
    await page.screenshot({ path: path.join(__dirname, "builder-plugins-reference.png") });
    await page.selectOption("#reference-topic", "api"); await page.locator("#reference-content pre").waitFor();
    assert.match(await page.locator("#reference-content").textContent(), /FoundationApi/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(__dirname, "builder-plugins-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); console.log("Plugin creation, documentation, pending-proposal chat, explicit apply and mobile layout passed.");
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); builder.close(); accounts.service.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
