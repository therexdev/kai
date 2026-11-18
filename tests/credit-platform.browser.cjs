"use strict";
// Uses isolated accounts, signed fixture-provider responses and no real funds.
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { chromium } = require("playwright");
const { service } = require("../scripts/helpers/credit-gateway-fixture");
(async () => {
  const cleanup = [], s = await service({ after: fn => cleanup.push(fn) });
  let browser;
  try {
    const user = await s.signup("browser@example.test");
    browser = await chromium.launch({ headless: true, ...(process.env.KAI_TEST_CHROMIUM ? { executablePath: process.env.KAI_TEST_CHROMIUM } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let testMail; s.auth.service.sendMail = async mail => { testMail = mail; };
    await page.goto(s.base + "/login");
    await page.locator("#login-email").fill("browser@example.test"); await page.locator("#email-submit").click();
    await page.locator("#login-code").waitFor();
    await page.locator("#login-code").fill(testMail.text.match(/\b(\d{6})\b/)[1]); await page.locator("#email-submit").click();
    await page.waitForURL(s.base + "/account");
    await page.waitForFunction(() => document.getElementById("email").textContent === "browser@example.test");
    const screenshots = path.join(__dirname, "credit-platform-preview"); fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, "desktop.png"), fullPage: true });
    await page.locator('[data-tab="playground"]').first().click();
    await page.locator("#prompt").fill("Say hello"); await page.locator("#send").click();
    const job = await s.dispatch(); await s.result(job, "Verified browser response");
    await page.getByText("Verified browser response", { exact: true }).waitFor();
    await page.locator('[data-tab="keys"]').first().click();
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
    for (const tab of ["overview", "playground", "billing", "keys", "usage", "wallets", "devices", "security"]) {
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
