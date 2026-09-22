'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'public/i18n/i18n.js'), 'utf8');
const catalogs = fs.readFileSync(path.join(root, 'public/i18n/catalogs.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function make(html, preferences = ['es-MX'], saved = null, blocked = false) {
  const dom = new JSDOM(html, { url: 'https://kai.test/', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: preferences, configurable: true });
  if (saved) w.localStorage.setItem('kai-website-language', saved);
  if (blocked) Object.defineProperty(w, 'localStorage', { get() { throw Error('Storage blocked'); } });
  w.eval(catalogs); w.eval(runtime);
  return dom;
}

(async () => {
  execFileSync(process.execPath, [path.join(__dirname, 'build-site-locales.js'), '--check']);
  // Validate every shipped page script, including the inline controllers.
  const pages = ['public/index.html', 'public/account.html', 'public/network.html', 'public/testers.html',
    'public/privacy.html', 'public/dashboard.html', 'public/updates.html', 'public/docs/index.html',
    'views/app.html', 'views/build/index.html'];
  for (const page of pages) {
    const source = fs.readFileSync(path.join(root, page), 'utf8');
    for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      if (match[1].trim()) new vm.Script(match[1], { filename: page });
    }
    for (const language of ['en', 'es', 'pt-BR', 'fr', 'de']) {
      const dom = make(source, [language]); const w = dom.window;
      assert.equal(w.document.documentElement.lang, language, page);
      assert.equal(w.document.querySelectorAll('[data-language-select]').length, 1, page);
      assert.equal(w.KaiI18n.preference, null);
      const links = [...w.document.querySelectorAll('a')].map(a => a.getAttribute('href'));
      w.KaiI18n.setLanguage('de'); w.KaiI18n.setLanguage('en');
      assert.deepEqual([...w.document.querySelectorAll('a')].map(a => a.getAttribute('href')), links);
      dom.window.close();
    }
  }
  const base = '<header></header><h1>Home</h1><form><input placeholder="Your email address"><textarea></textarea><button type="button">Send</button></form><div id="dynamic"></div><pre>Home</pre>';
  const dom = make(base, ['ja-JP', 'pt-PT']); const w = dom.window, i = w.KaiI18n;
  assert.equal(i.language, 'pt-BR');
  w.document.querySelector('input').value = 'user@example.com';
  w.document.querySelector('textarea').value = 'Home';
  let clicked = 0; w.document.querySelector('button').onclick = () => clicked++;
  i.setLanguage('de', { persist: true });
  assert.equal(w.localStorage.getItem(i.storageKey), 'de');
  assert.equal(w.document.querySelector('input').value, 'user@example.com');
  assert.equal(w.document.querySelector('textarea').value, 'Home');
  assert.equal(w.document.querySelector('pre').textContent, 'Home');
  w.document.querySelector('button').click(); assert.equal(clicked, 1);
  // Dynamic user content is never scanned for English words.
  const host = w.document.getElementById('dynamic');
  host.innerHTML = '<p>Home</p><code>Send</code>';
  await flush(); i.setLanguage('fr');
  assert.equal(host.textContent, 'HomeSend');
  const address = 'Home <img src=x onerror=alert(1)>';
  const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  host.innerHTML = i.html`<p>Unlink ${escape(address)}?</p><button>Send</button>`;
  await flush();
  assert.equal(host.querySelector('img'), null);
  assert.equal(host.querySelector('p').textContent, 'Dissocier ' + address + ' ?');
  i.setLanguage('en');
  assert.equal(host.querySelector('p').textContent, 'Unlink ' + address + '?');
  const status = host.querySelector('p');
  i.setText(status, 'Loading…'); status.textContent = 'Controller replaced this status';
  i.setLanguage('de'); assert.equal(status.textContent, 'Controller replaced this status');
  i.setLanguage('auto', { persist: true }); assert.equal(i.language, 'pt-BR');
  assert.equal(w.localStorage.getItem(i.storageKey), null);
  Object.defineProperty(w.navigator, 'languages', { value: ['fr-CA'], configurable: true });
  w.dispatchEvent(new w.Event('languagechange')); assert.equal(i.language, 'fr');
  i.setLanguage('de', { persist: true });
  w.dispatchEvent(new w.StorageEvent('storage', { key: i.storageKey, newValue: null }));
  assert.equal(i.language, 'fr');
  dom.window.close();
  for (const [prefs, saved, blocked, expected] of [
    [['zh-CN'], null, false, 'en'], [['es-MX'], 'de', false, 'de'],
    [['fr-CA'], 'invalid', false, 'fr'], [['de-DE'], null, true, 'de'],
  ]) {
    const d = make(base, prefs, saved, blocked); assert.equal(d.window.KaiI18n.language, expected); d.window.close();
  }
  console.log('PASS: 10 pages × 5 languages; regional detection, preference persistence, blocked storage, form/event preservation, safe dynamic translations, user-content isolation and English restoration.');
})().catch(error => { console.error(error); process.exitCode = 1; });
