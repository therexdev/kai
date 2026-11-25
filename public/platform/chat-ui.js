"use strict";
(function (root) {
  const MarkdownIt = typeof module !== "undefined" && module.exports ? require("./markdown-it.min") : root.markdownit;
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  md.validateLink = value => { try { return !/[\u0000-\u001f\u007f]/.test(value) && ["https:", "http:", "mailto:"].includes(new URL(value).protocol); } catch { return false; } };
  // Model output can link to an image, but cannot load remote tracking pixels.
  md.disable("image");
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    tokens[index].attrSet("target", "_blank"); tokens[index].attrSet("rel", "noopener noreferrer");
    tokens[index].attrSet("referrerpolicy", "no-referrer");
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index], language = token.info.trim().split(/\s+/)[0] || "Code", escape = md.utils.escapeHtml;
    return '<div class="code-block"><div class="code-toolbar"><span>' + escape(language) + '</span><button type="button" class="code-copy">Copy code</button></div><pre><code>' + escape(token.content) + '</code></pre></div>';
  };
  const renderMarkdown = text => md.render(String(text));
  function create({ messages, prompt, form, send, notice }) {
    const doc = messages.ownerDocument, win = doc.defaultView;
    const node = (tag, text, cls) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const status = doc.getElementById("chat-status"), jump = doc.getElementById("jump-latest");
    let following = true;
    function latest() { following = true; messages.scrollTop = messages.scrollHeight; jump.hidden = true; }
    messages.addEventListener("scroll", () => { following = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80; jump.hidden = following; });
    jump.onclick = latest;
    function resize() { prompt.style.height = "auto"; prompt.style.height = Math.min(180, Math.max(48, prompt.scrollHeight)) + "px"; }
    prompt.addEventListener("input", resize);
    prompt.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !win.matchMedia("(pointer: coarse)").matches) {
        event.preventDefault(); if (!send.disabled && prompt.value.trim()) form.requestSubmit();
      }
    });
    async function copy(button, text) {
      try { await win.navigator.clipboard.writeText(text); const label = button.textContent; button.textContent = "Copied"; win.setTimeout(() => { button.textContent = label; }, 1600); }
      catch { notice("Copy is unavailable in this browser. Select the text to copy it.", true); }
    }
    messages.addEventListener("click", event => {
      const button = event.target.closest(".code-copy");
      if (button) void copy(button, button.closest(".code-block").querySelector("code").textContent);
    });
    function message(role, text) {
      messages.querySelector(".empty")?.remove();
      const element = node("article", undefined, "message " + role), body = node("div", undefined, "message-body");
      const label = node("strong", role === "user" ? "YOU" : "KOINOS AI", "message-role");
      const actions = node("div", undefined, "message-actions"), button = node("button", "Copy", "quiet copy-message");
      button.type = "button"; button.setAttribute("aria-label", role === "user" ? "Copy message" : "Copy response");
      let source = String(text), queued = false;
      button.onclick = () => copy(button, source); actions.append(button); element.append(label, body, actions); messages.append(element);
      function paint() {
        queued = false;
        if (role === "assistant") body.innerHTML = renderMarkdown(source); else body.textContent = source;
        if (following) latest();
      }
      paint();
      return { element, set(text) { source = String(text); if (!queued) { queued = true; win.requestAnimationFrame(paint); } },
        finish(text) { if (text !== undefined) source = String(text); paint(); }, meta(text) { actions.append(node("span", text, "message-meta")); } };
    }
    doc.addEventListener("click", event => { const settings = doc.querySelector(".chat-settings"); if (settings?.open && !settings.contains(event.target)) settings.open = false; });
    doc.addEventListener("keydown", event => { if (event.key === "Escape") { const settings = doc.querySelector(".chat-settings"); if (settings) settings.open = false; } });
    return { message, latest, resize, status(text) { status.textContent = text; },
      busy(value) { messages.setAttribute("aria-busy", String(value)); doc.getElementById("model").disabled = value; doc.getElementById("tokens").disabled = value; doc.getElementById("auto-tokens").disabled = value; },
      reset() { messages.replaceChildren(node("p", "What would you like to work on?", "empty")); latest(); status.textContent = ""; } };
  }
  const api = { renderMarkdown, create };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KaiChatUI = api;
})(typeof window === "undefined" ? globalThis : window);
