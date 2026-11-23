"use strict";
// Uses isolated accounts, signed fixture-provider responses and no real funds.
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { chromium, _electron } = require("playwright");
const { service } = require("../scripts/helpers/credit-gateway-fixture");
(async () => {
  const cleanup = [], s = await service({ after: fn => cleanup.push(fn) });
  let browser;
  try {
    const user = await s.signup("browser@example.test");
    if (process.env.KAI_TEST_ELECTRON) {
      const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "kai-portal-browser-")); cleanup.push(() => fs.rmSync(temp, { recursive: true, force: true }));
      const entry = path.join(temp, "browser.cjs");
      fs.writeFileSync(entry, 'const {app,BrowserWindow}=require("electron");app.disableHardwareAcceleration();app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.setContentSize(1440,1000);w.loadURL("about:blank")});');
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const electron = await _electron.launch({ executablePath: process.env.KAI_TEST_ELECTRON, args: ["--ozone-platform=headless", entry], env });
      browser = { newPage: async ({ viewport }) => { const page = await electron.firstWindow(); await page.setViewportSize(viewport); return page; }, close: () => electron.close() };
    } else browser = await chromium.launch({ headless: true, ...(process.env.KAI_TEST_CHROMIUM ? { executablePath: process.env.KAI_TEST_CHROMIUM } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let testMail; s.auth.service.sendMail = async mail => { testMail = mail; };
    await page.goto(s.base + "/login?next=/account");
    await page.locator("#login-email").fill("browser@example.test"); await page.locator("#email-submit").click();
    await page.locator("#login-code").waitFor();
    await page.locator("#login-code").fill(testMail.text.match(/\b(\d{6})\b/)[1]); await page.locator("#email-submit").click();
    await page.waitForURL(s.base + "/account");
    await page.goto(s.base + "/app?embed=workspace");
    await page.waitForFunction(() => document.getElementById("email").textContent === "browser@example.test");
    const screenshots = path.join(__dirname, "credit-platform-preview"); fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, "desktop.png"), fullPage: true });
    assert.equal(await page.locator('[data-area="account"]').isVisible(), false);
    assert.equal(await page.locator('nav[data-area="workspace"]').isVisible(), true);
    await page.locator('[data-tab="playground"]').first().click();
    await page.locator("#prompt").fill("Say hello"); await page.locator("#send").click();
    const job = await s.dispatch(); await s.result(job, "Verified browser response");
    await page.getByText("Verified browser response", { exact: true }).waitFor();
    await page.locator("#chat-history").getByText("Say hello", { exact: true }).waitFor();
    await page.reload(); await page.locator("#chat-history").getByText("Say hello", { exact: true }).click();
    await page.getByText("Verified browser response", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByRole("link", { name: "Build", exact: true }).isVisible(), true);
    assert.equal(await page.locator('[data-area-link="account"]').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "chat fits mobile");
    await page.screenshot({ path: path.join(screenshots, "mobile-chat.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const original = s.auth.service._newAccount({});
    s.auth.service.db.prepare("INSERT INTO wallets(address,account_id,label,linked_at) VALUES(?,?,NULL,?)").run(s.f.owner, original.id, Date.now());
    const ts = Date.now(), hash = require("node:crypto").createHash("sha256").update(require("../lib/credit-wallet-links").message(s.base, s.f.owner, user.account.id, ts)).digest();
    s.auth.service.creditLinks.link(s.auth.service.getAccount(user.account.id), { address: s.f.owner, ts, signature: Buffer.from(await s.f.buyer.signHash(hash)).toString("base64") });
    await page.goto(s.base + "/account#keys");
    await page.waitForFunction(address => document.getElementById("wallet").value === address, s.f.owner);
    assert.match(await page.locator("#wallet option:checked").textContent(), /^Core/);
    await page.locator("#key-name").fill("Browser QA"); await page.locator('#key-form button').click();
    await page.locator("#new-key").waitFor();
    const key = await page.locator("#secret").inputValue(); assert.match(key, /^kai_api_/);
    await page.locator("#hide-key").click(); assert.equal(await page.locator("#secret").inputValue(), "");
    await page.locator("#key-list button").click();
    assert.equal((await s.call("/v1/credits", undefined, { authorization: "Bearer " + key })).status, 401);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#logout").isVisible(), true);
    assert.equal(await page.locator('[data-tab="security"]').isVisible(), true);
    assert.equal(await page.locator('.sidebar-bottom a[href="/platform/docs"]').isVisible(), true);
    for (const tab of ["overview", "billing", "keys", "usage", "wallets", "devices", "security"]) {
      await page.locator(`[data-tab="${tab}"]`).first().click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, tab + " must fit mobile width");
      await page.screenshot({ path: path.join(screenshots, "mobile-" + tab + ".png"), fullPage: true });
    }
    await page.locator('[data-tab="devices"]').first().click();
    const device = await s.call("/auth/device/start", {});
    await page.locator("#device-code").fill(device.value.userCode); await page.locator("#device-form button").click();
    await page.getByText("Device approved. KAI Core will finish signing in shortly.").waitFor();
    const poll = await s.call("/auth/device/poll", { userCode: device.value.userCode, deviceSecret: device.value.deviceSecret });
    assert.equal(poll.value.account.id, user.account.id);
    await page.locator('[data-tab="security"]').click(); await page.reload();
    await page.locator("#profile-email").getByText("browser@example.test", { exact: true }).waitFor();
    assert.equal(await page.locator("#security").isVisible(), true);
    await page.locator('[data-tab="wallets"]').click();
    await page.getByText("Linked Core credits · original balance and daily allowance", { exact: true }).waitFor();
    // Electron's headless test shell has no native message-box display.
    // CI Chromium still exercises the real confirmation dialog.
    if (process.env.KAI_TEST_ELECTRON) await page.evaluate(() => { window.confirm = text => { window.creditLinkReview = text; return true; }; });
    else page.once("dialog", dialog => { void dialog.accept(); });
    await page.getByRole("button", { name: "Remove credit access", exact: true }).click();
    await page.getByText("No wallets connected yet. Your daily free allowance is available without one.", { exact: true }).waitFor();
    if (process.env.KAI_TEST_ELECTRON) assert.match(await page.evaluate(() => window.creditLinkReview), /API keys.*revoked/);
    assert.equal(s.auth.service.db.prepare("SELECT account_id FROM wallets WHERE address=?").get(s.f.owner).account_id, original.id);
    await page.locator("#logout").click(); await page.waitForURL(s.base + "/login");
    assert.equal((await page.request.get(s.base + "/platform", { maxRedirects: 0 })).status(), 302);
    await page.locator("#login-email").waitFor();
    await page.screenshot({ path: path.join(screenshots, "mobile-login.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(screenshots, "desktop-login.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log("Browser checks passed: desktop/mobile, real gateway chat, API key create/hide/revoke, no page errors.");
  } finally {
    if (browser) await browser.close();
    for (const fn of cleanup.reverse()) await fn();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
