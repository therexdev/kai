/* Website interface localization. Only static UI and explicit text sinks are registered. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KaiI18n = api;
})(typeof window === 'object' ? window : globalThis, function (root) {
  'use strict';
  const languages = [
    { code: 'en', name: 'English' }, { code: 'es', name: 'Español' },
    { code: 'pt-BR', name: 'Português (Brasil)' }, { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
  ];
  const supported = new Set(languages.map(l => l.code));
  const storageKey = 'kai-website-language';
  const normalize = value => {
    if (typeof value !== 'string') return null;
    const tag = value.trim().replace(/_/g, '-').toLowerCase();
    if (/^pt(?:-|$)/.test(tag)) return 'pt-BR';
    const base = tag.split('-')[0];
    return supported.has(base) ? base : null;
  };
  const detect = preferences => {
    for (const tag of Array.isArray(preferences) ? preferences : [preferences]) {
      const locale = normalize(tag); if (locale) return locale;
    }
    return 'en';
  };
  let preference = null;
  try { preference = normalize(root.localStorage?.getItem(storageKey)); } catch { /* restricted storage */ }
  const browserLanguage = () => detect(root.navigator?.languages?.length ? root.navigator.languages : [root.navigator?.language]);
  let locale = preference || browserLanguage();
  const descriptors = new Map();
  const normalizeText = text => String(text).replace(/\s+/g, ' ').trim();
  const interpolate = (text, values = []) => text.replace(/\{(\d+)\}/g, (match, n) => n < values.length ? String(values[n]) : match);
  const translate = (source, values = [], lang = locale) => {
    const key = normalizeText(source);
    const table = root.KaiLocaleCatalogs?.[lang];
    const translated = table && Object.hasOwn(table, key) ? table[key] : key;
    return interpolate(translated, values);
  };
  const preserveSpace = (source, translated) => source.match(/^\s*/)[0] + translated + source.match(/\s*$/)[0];
  const remember = (node, source, attr = null, values = []) => {
    if (!normalizeText(source)) return;
    let map = descriptors.get(node); if (!map) descriptors.set(node, map = new Map());
    const entry = { source, values };
    map.set(attr, entry);
    apply(node, attr, entry);
  };
  const currentText = (node, attr) => attr ? node.getAttribute(attr) : node.nodeType === 3 ? node.data : node.textContent;
  function apply(node, attr, entry) {
    const text = preserveSpace(entry.source, translate(entry.source, entry.values));
    if (attr) { if (node.getAttribute(attr) !== text) node.setAttribute(attr, text); }
    else if (node.nodeType === 3) { if (node.data !== text) node.data = text; }
    else if (node.textContent !== text) node.textContent = text;
    entry.rendered = text;
  }
  function setText(node, source) {
    if (!node) return;
    // Only callers at interface-text sinks use this API. No DOM-wide matching
    // of user messages, files, model output, names, keys or addresses.
    if (source == null || source === '') { descriptors.get(node)?.delete(null); node.textContent = ''; return; }
    if (source && typeof source === 'object' && Array.isArray(source.values)) remember(node, source.source, null, source.values);
    else remember(node, String(source ?? ''));
  }
  function message(strings, ...values) {
    return { source: strings.reduce((text, part, i) => text + part + (i < values.length ? `{${i}}` : ''), ''), values };
  }
  function tMessage(strings, ...values) { const item = message(strings, ...values); return translate(item.source, item.values); }
  function setAttribute(node, attr, source) {
    if (!node) return;
    if (source && typeof source === 'object' && Array.isArray(source.values)) remember(node, source.source, attr, source.values);
    else remember(node, String(source ?? ''), attr);
  }
  function setLanguage(value, { persist = false } = {}) {
    const automatic = value === 'auto';
    const next = automatic ? browserLanguage() : normalize(value);
    if (!next) throw new Error('Unsupported interface language');
    locale = next;
    if (persist) {
      preference = automatic ? null : next;
      try { if (automatic) root.localStorage?.removeItem(storageKey); else root.localStorage?.setItem(storageKey, next); } catch { /* Storage can be unavailable in private or embedded browsers. */ }
    }
    if (root.document) {
      root.document.documentElement.lang = next;
      root.document.documentElement.dir = 'ltr';
      for (const [node, entries] of descriptors) {
        if (!node.isConnected) { descriptors.delete(node); continue; }
        for (const [attr, item] of entries) {
          // A controller may have replaced a status since it was registered.
          // Never resurrect stale status/error text when switching languages.
          if (currentText(node, attr) !== item.rendered) { entries.delete(attr); continue; }
          apply(node, attr, item);
        }
      }
      for (const select of root.document.querySelectorAll('[data-language-select]')) {
        select.value = next;
        select.title = languages.find(language => language.code === next).name;
      }
      root.document.dispatchEvent(new root.CustomEvent('kai:language-changed', { detail: { language: next } }));
    }
    return next;
  }
  const ignored = 'script,style,code,pre,textarea,svg,[translate="no"],[data-i18n-ignore],[data-language-select]';
  function registerStatic(container) {
    if (!root.document) return;
    const walker = root.document.createTreeWalker(container, 4);
    for (let node; (node = walker.nextNode());) {
      if (!node.parentElement?.closest(ignored) && /[A-Za-z]/.test(node.data)) remember(node, node.data);
    }
    for (const el of container.querySelectorAll('[title],[placeholder],[aria-label],[alt]')) {
      if (el.closest(ignored)) continue;
      for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
        if (el.hasAttribute(attr)) remember(el, el.getAttribute(attr), attr);
      }
    }
    for (const template of container.querySelectorAll('template')) {
      // Templates are translated only after cloning, from explicit markers.
      template.innerHTML = html(template.innerHTML);
    }
  }
  function registerMarkers(container) {
    if (!container || !root.document) return;
    const nodes = container.nodeType === 1 ? [container, ...container.querySelectorAll('[data-i18n],[data-i18n-attrs]')] : [];
    for (const el of nodes) {
      if (el.hasAttribute('data-i18n')) remember(el, el.getAttribute('data-i18n'));
      if (el.hasAttribute('data-i18n-attrs')) {
        try { for (const [attr, source] of Object.entries(JSON.parse(el.getAttribute('data-i18n-attrs')))) remember(el, source, attr); } catch { /* malformed markup */ }
      }
    }
    const walker = root.document.createTreeWalker(container, 128);
    for (let node; (node = walker.nextNode());) {
      if (!node.data.startsWith('kai-i18n:') || node.nextSibling?.nodeType !== 3) continue;
      try { const { source, values } = JSON.parse(decodeURIComponent(node.data.slice(9))); remember(node.nextSibling, source, null, values); } catch { /* not a localization marker */ }
    }
  }
  const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function textHTML(source, values = []) {
    const marker = encodeURIComponent(JSON.stringify({ source, values }));
    return "<!--kai-i18n:" + marker + "-->" + escapeHTML(translate(source, values));
  }
  function html(strings, ...values) {
    if (typeof strings === 'string') strings = [strings];
    const source = strings.reduce((text, part, i) => text + part + (i < values.length ? `KAI_I18N_SLOT_${i}_END` : ''), '');
    const replaceSlots = text => text.replace(/KAI_I18N_SLOT_(\d+)_END/g, (_, i) => String(values[i] ?? ''));
    if (!root.document) return replaceSlots(source);
    const decode = text => { const t = root.document.createElement('template'); t.innerHTML = text; return t.content.textContent; };
    const stack = [];
    const result = source.replace(/<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g, token => {
      if (token.startsWith('<!--')) return token;
      if (token.startsWith('<')) {
        const match = /^<(\/?)([a-z][\w-]*)/i.exec(token);
        if (!match) return token;
        const tag = match[2].toLowerCase();
        if (match[1]) { const index = stack.lastIndexOf(tag); if (index >= 0) stack.splice(index); return token; }
        if (!['input','br','hr','img','meta','link','source','wbr','area','embed','col'].includes(tag) && !token.endsWith('/>')) stack.push(tag);
        const attrs = {};
        token = token.replace(/\b(title|placeholder|aria-label)=("[^"]*"|'[^']*')/g, (attribute, name, quoted) => {
          const value = quoted.slice(1, -1);
          if (/KAI_I18N_SLOT_\d+_END/.test(value)) return attribute;
          attrs[name] = decode(value); return name + '="' + escapeHTML(translate(attrs[name])) + '"';
        });
        if (Object.keys(attrs).length) token = token.replace(/(\/?>)$/, ' data-i18n-attrs="' + escapeHTML(JSON.stringify(attrs)) + '"$1');
        return token;
      }
      if (stack.some(tag => ['script','style','textarea','pre','code','svg'].includes(tag))) return token;
      if (!/[A-Za-z]{2}/.test(token.replace(/KAI_I18N_SLOT_\d+_END/g, ''))) return token;
      // Do not reinterpret an interpolated child component as prose.
      const slots = [...token.matchAll(/KAI_I18N_SLOT_(\d+)_END/g)];
      if (slots.some(([, i]) => /<[a-z!\/]/i.test(String(values[i] ?? '')))) return token;
      const params = [];
      const key = decode(token).replace(/KAI_I18N_SLOT_(\d+)_END/g, (_, i) => { params.push(decode(String(values[i] ?? ''))); return `{${params.length - 1}}`; });
      const marker = '<!--kai-i18n:' + encodeURIComponent(JSON.stringify({ source: key, values: params })) + '-->';
      return marker + escapeHTML(preserveSpace(key, translate(key, params)));
    });
    // One non-recursive substitution preserves user data and attribute syntax.
    return replaceSlots(result);
  }
  function addSelector() {
    const doc = root.document;
    // Resolve hosts in priority order: a comma-separated query would pick an
    // outer header before its menu, leaving the control on a separate row.
    const host = ['[data-language-host]', '.site-nav .nav-links', '.kai-site-links',
      '.nav-cta', '.kai-header-inner', '.workspace-bar', '.topbar .topbar-actions',
      '.topbar', '.wrap .nav', 'header', '.wrap'].map(selector => doc.querySelector(selector)).find(Boolean);
    if (!host) return;
    const label = doc.createElement('label');
    label.className = 'kai-language-control';
    const caption = doc.createElement('span');
    caption.textContent = 'Language';
    const select = doc.createElement('select');
    select.setAttribute('data-language-select', '');
    select.setAttribute('aria-label', 'Language');
    remember(select, 'Language', 'aria-label');
    for (const language of languages) {
      const option = doc.createElement('option');
      option.value = language.code;
      option.textContent = language.code.slice(0, 2).toUpperCase();
      option.lang = language.code;
      option.setAttribute('aria-label', language.name);
      select.append(option);
    }
    select.value = locale;
    select.title = languages.find(language => language.code === locale).name;
    select.addEventListener('change', () => setLanguage(select.value, { persist: true }));
    label.append(caption, select); host.append(label);
    const mobileHost = host.matches('.site-nav .nav-links') ? doc.querySelector('.site-nav .mobile-nav')
      : host.matches('.kai-site-links') ? doc.querySelector('.kai-site-menu nav') : null;
    if (mobileHost && root.matchMedia) {
      const mobile = root.matchMedia(host.matches('.site-nav .nav-links') ? '(max-width: 850px)' : '(max-width: 720px)');
      const placeSelector = () => {
        (mobile.matches ? mobileHost : host).append(label);
        if (!mobile.matches) {
          if (mobileHost.matches('.mobile-nav')) {
            mobileHost.hidden = true;
            doc.querySelector('.menu-toggle')?.setAttribute('aria-expanded', 'false');
          } else mobileHost.closest('details').open = false;
        }
      };
      placeSelector();
      mobile.addEventListener('change', placeSelector);
    }
  }
  function start() {
    addSelector();
    registerStatic(root.document.body);
    if (root.document.querySelector('title')) remember(root.document.querySelector('title'), root.document.title);
    for (const meta of root.document.querySelectorAll('meta[name="description"],meta[property="og:title"],meta[property="og:description"]')) remember(meta, meta.content, 'content');
    root.document.documentElement.lang = locale;
    const observer = new root.MutationObserver(records => {
      if (records.some(record => record.removedNodes.length)) for (const node of descriptors.keys()) if (!node.isConnected) descriptors.delete(node);
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 || node.nodeType === 11) registerMarkers(node);
        // innerHTML can add adjacent comment and text nodes directly.
        else if (node.nodeType === 8 && node.data.startsWith('kai-i18n:')) registerMarkers(node.parentNode);
      }
    });
    observer.observe(root.document.body, { childList: true, subtree: true });
    root.addEventListener('storage', event => {
      if (event.key !== storageKey && event.key !== null) return;
      preference = normalize(event.newValue); setLanguage(preference || 'auto');
    });
    root.addEventListener('languagechange', () => { if (!preference) setLanguage('auto'); });
  }
  if (root.document?.body) start();
  return { languages, normalize, detect, t: translate, tMessage, html, textHTML, message, setText, setAttribute, setLanguage, registerStatic, registerMarkers,
    get language() { return locale; }, get preference() { return preference; }, storageKey };
});
