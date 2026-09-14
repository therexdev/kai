"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    slug = location.pathname.split("/").filter(Boolean)[1],
    base = "/build/public/" + encodeURIComponent(slug);
  let project;
  const status = (s) => {
    $("host-status").textContent = s;
    $("host-status").hidden = false;
  };
  async function request(url, body) {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "This request did not finish.");
    return data;
  }
  KaiBuildBridge.create($("app-frame"), {
    mode: "live",
    getProject: () => project,
    onError: status,
    api: async (action, args) => {
      if (action === "read")
        return (
          await request(
            base +
              "/read/" +
              encodeURIComponent(args.method) +
              "?args=" +
              encodeURIComponent(JSON.stringify(args.args || {})),
          )
        ).result;
      if (action === "prepare") return request(base + "/prepare", args);
      return request(base + "/submit/" + encodeURIComponent(args.draftId), {
        transaction: args.transaction,
      });
    },
  });
  request(base)
    .then((data) => {
      project = data.project;
      document.title = project.title + " · Koinos AI";
      $("app-title").textContent = project.title;
      $("app-network").textContent = project.network;
      $("app-contract").textContent = project.contract_id;
      $("app-frame").src = "/apps/" + encodeURIComponent(slug) + "/content";
    })
    .catch((e) => status(e.message));
})();
