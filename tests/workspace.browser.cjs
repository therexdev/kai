"use strict";
// Two real loopback services behind intercepted HTTPS test origins. No request
// reaches production. Both the chat gateway and Build run their real handlers.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http"), os = require("node:os"), express = require("express");
const { chromium, _electron } = require("playwright");
const CREDIT = "https://credits.koinosai.com", WEBSITE = "https://koinosai.com";
(async () => {
  if (!process.env.KAI_CREDIT_BACKEND) throw Error("Set KAI_CREDIT_BACKEND to the companion credit-server checkout");
  const cleanup = [], s = await require(path.join(process.env.KAI_CREDIT_BACKEND, "scripts/helpers/credit-gateway-fixture")).service({ after: fn => cleanup.push(fn) });
  s.auth.service.siteOrigin = CREDIT; s.runtime.webApiEnabled = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-website-browser-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = require("../lib/accounts").createAccounts({ stateDir: dir, siteOrigin: WEBSITE });
  cleanup.push(() => accounts.service.db.close());
  const existing = accounts.service._newAccount({ email: "shared-browser@example.test" });
  const app = express();
  app.use(require("../lib/web-account-entry").webAccountEntry({ accounts, fetchImpl: (url, init) => {
    assert.ok(url.startsWith(CREDIT + "/")); return fetch(s.base + url.slice(CREDIT.length), init);
  } }));
  const builder = new (require("../lib/builder/service").Builder)({ stateDir: dir, autoStart: false, agent: { configured: false, model: "fixture" } });
  cleanup.push(() => builder.close());
  builder.store.create(existing.id, "Existing saved project", "plugin", require("../lib/builder/projects").starter("plugin", "Existing saved project"));
  app.use(express.json(), require("../lib/builder/router").createBuilderRouter({ accounts, stateDir: dir, builder }).router);
  app.use(express.static(path.join(__dirname, "../public")));
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  const webBase = "http://127.0.0.1:" + server.address().port;
  cleanup.push(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  let browser, mail, sends = 0;
  s.auth.service.sendMail = async m => { mail = m; sends++; };
  try {
    if (process.env.KAI_TEST_ELECTRON) {
      const entry = path.join(dir, "browser.cjs");
      fs.writeFileSync(entry, 'const {app,BrowserWindow}=require("electron");app.disableHardwareAcceleration();app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.setContentSize(1440,1000);w.loadURL("about:blank")});');
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const electron = await _electron.launch({ executablePath: process.env.KAI_TEST_ELECTRON, args: ["--ozone-platform=headless", entry], env });
      browser = { page: () => electron.firstWindow(), close: () => electron.close() };
    } else {
      const instance = await chromium.launch({ headless: true, ...(process.env.KAI_TEST_CHROMIUM ? { executablePath: process.env.KAI_TEST_CHROMIUM } : {}) }); browser = { page: () => instance.newPage(), close: () => instance.close() };
    }
    const page = await browser.page(), errors = [];
    page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
    page.on("pageerror", e => errors.push(e.message));
    // Headless Electron's native input does not reliably enter an OOP iframe.
    // Exercise the real form handler there; Chromium exercises native clicks.
    const submitChat = async chat => process.env.KAI_TEST_ELECTRON
      ? chat.locator("#chat").evaluate(form => form.requestSubmit()) : chat.locator("#send").click();
    const openFrameLink = async link => {
      if (process.env.KAI_TEST_ELECTRON) {
        assert.equal(await link.getAttribute("target"), "_top");
        await page.goto(await link.evaluate(a => a.href));
      } else await link.click();
    };
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/*", async route => {
      const req = route.request(), u = new URL(req.url()), base = u.origin === WEBSITE ? webBase : u.origin === CREDIT ? s.base : null;
      if (!base) { await route.abort(); return; }
      if (process.env.KAI_BROWSER_DEBUG) console.log("Fixture request", req.method(), u.origin, u.pathname);
      const headers = { ...await req.allHeaders() }; delete headers.host; delete headers["accept-encoding"]; delete headers["content-length"];
      const response = await fetch(base + u.pathname + u.search, { method: req.method(), headers, body: req.postDataBuffer() || undefined, redirect: "manual" });
      if (process.env.KAI_BROWSER_DEBUG) console.log("Fixture route", u.origin, u.pathname, response.status);
      const output = Object.fromEntries(response.headers); delete output["content-encoding"]; delete output["content-length"]; delete output["transfer-encoding"];
      if (response.headers.getSetCookie().length) output["set-cookie"] = response.headers.getSetCookie().join("\n");
      if (response.status >= 300 && response.status < 400 && output.location) {
        // Playwright does not intercept subsequent hops of a fulfilled HTTP
        // redirect. Keep every hop on fixtures by navigating a new document;
        // the HTTP tests separately verify the actual redirect responses.
        assert.equal(req.method(), "GET");
        const next = new URL(output.location, u); assert.ok([WEBSITE, CREDIT].includes(next.origin));
        delete output.location; output["content-type"] = "text/html; charset=utf-8";
        const escaped = next.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        await route.fulfill({ status: 200, headers: output, body: '<!doctype html><meta http-equiv="refresh" content="0;url=' + escaped + '">' }); return;
      }
      await route.fulfill({ status: response.status, headers: output, body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(WEBSITE + "/login");
    await page.locator("#login-email").fill("shared-browser@example.test"); await page.locator("#email-submit").click();
    await page.locator("#login-code").waitFor(); await page.locator("#login-code").fill(mail.text.match(/\b(\d{6})\b/)[1]); await page.locator("#email-submit").click();
    await page.waitForURL(WEBSITE + "/chat");
    const chat = page.frameLocator("#chat-workspace");
    await chat.locator("#email").getByText("shared-browser@example.test", { exact: true }).waitFor();
    assert.equal(await chat.getByRole("link", { name: /Documents|Tasks|Earlier workspace/ }).count(), 0);
    await chat.locator("#prompt").fill("A real chat at the website address");
    await submitChat(chat);
    const job = await s.dispatch().catch(async e => {
      console.error("Chat notice:", await chat.locator("#notice").textContent(), "Page errors:", errors);
      console.error("Chat state:", await chat.locator("#chat").evaluate(form => ({ valid: form.checkValidity(), prompt: document.getElementById("prompt").value, disabled: document.getElementById("send").disabled, model: document.getElementById("model").value, messages: document.getElementById("messages").textContent })));
      throw e;
    });
    await s.result(job, "Shared login and real chat work together");
    await chat.getByText("Shared login and real chat work together", { exact: true }).waitFor();
    assert.equal(page.url(), WEBSITE + "/chat");
    const images = path.join(__dirname, "website-workspace-preview"); fs.mkdirSync(images, { recursive: true });
    await page.screenshot({ path: path.join(images, "chat-desktop.png"), fullPage: true });
    const cookies = await page.context().cookies(WEBSITE), session = cookies.find(c => c.name === "kai_session");
    assert.equal(accounts.service.sessionAccount(session.value).id, existing.id);
    await openFrameLink(chat.getByRole("link", { name: "Build", exact: true })); await page.waitForURL(WEBSITE + "/build");
    await page.locator("#project-list").getByText("Existing saved project", { exact: true }).waitFor();
    await page.locator("#new-project").click(); await page.locator("#project-title").fill("Workspace project");
    await page.locator("#template-select").selectOption("plugin"); await page.locator("#create-submit").click();
    await page.locator("#project-crumb").getByText("Workspace project", { exact: true }).waitFor();
    assert.equal(builder.store.list(existing.id).length, 2);
    await page.screenshot({ path: path.join(images, "build-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByRole("link", { name: "Chat", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("link", { name: "Credits & API", exact: true }).isVisible(), true);
    await page.locator("#menu-toggle").click();
    await page.locator("#project-list").getByText("Existing saved project", { exact: true }).click();
    await page.locator("#project-crumb").getByText("Existing saved project", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(images, "build-mobile.png"), fullPage: true });
    await page.getByRole("link", { name: "Chat", exact: true }).click(); await page.waitForURL(WEBSITE + "/chat");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await chat.locator("#email").getByText("shared-browser@example.test", { exact: true }).waitFor();
    assert.equal(accounts.service.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1, "workspace switches reuse the website session");
    await page.goto(WEBSITE + "/app/history#tasks"); await page.waitForURL(WEBSITE + "/chat");
    await chat.locator("#prompt").waitFor();
    await openFrameLink(chat.locator('[data-area-link="account"]')); await page.waitForURL(CREDIT + "/account");
    await page.locator("#email").getByText("shared-browser@example.test", { exact: true }).waitFor();
    const d = (await s.call("/auth/device/start", {})).value; assert.match(d.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await page.goto(d.verifyUrl); await page.locator("#device-code").waitFor(); assert.equal(await page.locator("#device-code").inputValue(), d.userCode);
    await page.locator("#device-form button").click(); await page.getByText("Device approved. KAI Core will finish signing in shortly.").waitFor();
    const connected = (await s.call("/auth/device/poll", { userCode: d.userCode, deviceSecret: d.deviceSecret })).value;
    assert.equal(connected.account.email, "shared-browser@example.test"); assert.equal(sends, 1);
    await page.locator('[data-area-link="workspace"]').click(); await page.waitForURL(WEBSITE + "/chat");
    await page.setViewportSize({ width: 390, height: 844 });
    await chat.locator("#prompt").waitFor();
    assert.equal(await chat.getByRole("link", { name: "Build", exact: true }).isVisible(), true);
    assert.equal(await chat.locator('[data-area-link="account"]').isVisible(), true);
    assert.equal(await chat.locator("body").evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(images, "chat-mobile.png"), fullPage: true });
    if (process.env.KAI_TEST_ELECTRON) await chat.locator("#logout").evaluate(button => button.click());
    else await chat.locator("#logout").click();
    await page.waitForURL(url => url.origin === CREDIT && url.pathname === "/login");
    await page.goto(WEBSITE + "/build"); await page.waitForURL(url => url.origin === CREDIT && url.pathname === "/login");
    assert.deepEqual(errors, []);
    console.log("Passed: website /chat, actual streamed chat, Build navigation, Credits/API, one sign-in, prefilled desktop/Android device approval, mobile, shared-login sign-out.");
  } finally {
    await browser?.close();
    for (const fn of cleanup.reverse()) await fn();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
