"use strict";
(() => {
  const sidebar = document.createElement("aside"); sidebar.className = "account-sidebar";
  const link = (label, href) => { const node = document.createElement("a"); node.textContent = label; node.href = href; return node; };
  const brand = link("Koinos AI", "/"); brand.className = "account-brand"; sidebar.append(brand);
  const label = document.createElement("p"); label.textContent = "YOUR WORKSPACE"; label.className = "account-eyebrow"; sidebar.append(label);
  const nav = document.createElement("nav"); nav.setAttribute("aria-label", "Account and website tools");
  for (const [name, url] of [["Account overview", "https://credits.koinosai.com/account"], ["Chat", "https://credits.koinosai.com/account#playground"], ["Credits & billing", "https://credits.koinosai.com/account#billing"], ["API keys", "https://credits.koinosai.com/account#keys"], ["Node dashboard", "/dashboard"], ["Builder", "/build"], ["Existing workspace", "/app"], ["Website access", "/account/website"]]) {
    const node = link(name, url); if (location.pathname === url) node.setAttribute("aria-current", "page"); nav.append(node);
  }
  sidebar.append(nav); const bottom = document.createElement("div"); bottom.className = "account-sidebar-bottom"; bottom.setAttribute("data-language-host", "");
  bottom.append(link("Account & security", "https://credits.koinosai.com/account#security"), link("Back to website ↗", "/")); sidebar.append(bottom);
  document.body.prepend(sidebar); document.body.classList.add("account-shell");
  const intro = document.querySelector(".kai-account-intro"); if (intro) intro.hidden = true;
  const main = document.querySelector(".kai-account-main");
  if (main) { for (const node of main.children) { if (node.matches("section.card")) node.remove(); } }
})();
