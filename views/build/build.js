"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    state = {
      config: null,
      detail: null,
      projects: [],
      files: null,
      dirty: false,
      tab: "preview",
      generation: 0,
      draft: null,
      busy: false,
      chain: null,
      previewDiagnostics: [],
      previewRevision: null,
    };
  let queuedIdea = "",
    poller = null;
  const bridge = KaiBuildBridge.create($("preview"), {
    getProject: () => state.detail?.project,
    onError: (message) => {
      $("preview-error").textContent = message;
      $("preview-error").hidden = false;
    },
    onDiagnostic: (d) => {
      if (
        !state.detail ||
        state.previewRevision !== state.detail.project.revision
      )
        return;
      const entry = {
        kind: d.kind,
        message: String(d.message || "").slice(0, 500),
        action: String(d.action || "").slice(0, 80),
        phase: d.phase,
        wallet: d.wallet,
        code: d.code,
        line: d.line,
        column: d.column,
      };
      if (
        !state.previewDiagnostics.some(
          (e) => JSON.stringify(e) === JSON.stringify(entry),
        )
      )
        state.previewDiagnostics = [...state.previewDiagnostics, entry].slice(
          -8,
        );
    },
  });
  function note(message, error = false) {
    $("notice").textContent = message;
    $("notice").classList.toggle("error", error);
    $("notice").hidden = !message;
  }
  async function api(url, body, method) {
    const r = await fetch(url, {
      method: method || (body ? "POST" : "GET"),
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      location.href = "/account?next=/build";
      throw Error("Please sign in again.");
    }
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "This request did not finish.");
    return data;
  }
  const base = () => "/build/api/projects/" + state.detail.project.id;
  const active = () =>
    state.detail?.jobs.find((j) => ["running", "queued"].includes(j.status));
  function node(tag, text, cls) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function controls() {
    const running = !!active();
    const project = state.detail?.project;
    if (project?.live_revision)
      $("live-draft-note").hidden =
        !state.dirty && project.revision === project.live_revision;
    $("send").disabled =
      running || state.busy || state.dirty || !state.config?.aiReady;
    $("code-editor").readOnly = running || state.busy;
    $("save-files").disabled = running || state.busy || !state.dirty;
    $("publish").disabled = running || state.busy || state.dirty;
    $("propose-owner").disabled =
      running || state.busy || !state.detail?.project.contract_id;
    $("job-status").hidden = !running;
    if (running) $("job-stage").textContent = active().stage;
    $("file-dirty").textContent = state.dirty ? "Unsaved changes" : "";
  }
  function renderProjects() {
    $("project-list").replaceChildren();
    if (!state.projects.length)
      $("project-list").append(
        node("p", "Your ideas will live here.", "empty-projects"),
      );
    for (const p of state.projects) {
      const b = node(
        "button",
        p.title,
        "project-link" + (state.detail?.project.id === p.id ? " active" : ""),
      );
      b.title = p.title;
      b.onclick = () => openProject(p.id).catch((e) => note(e.message, true));
      $("project-list").append(b);
    }
  }
  async function listProjects() {
    state.projects = (await api("/build/api/projects")).projects;
    renderProjects();
  }
  function renderMessages() {
    const area = $("messages"),
      nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    area.replaceChildren();
    for (const m of state.detail.messages) {
      const div = node("div", null, "message " + m.role),
        body = node("div", null, "message-body");
      if (m.role === "assistant") {
        // Make saved publication notices from older releases useful as well.
        const content = m.content.replace(
          /^(Version \d+ is published\. Your live app is at )(\/apps\/[a-z0-9-]+)\.$/,
          (_match, prefix, path) => {
            const url = new URL(
              path,
              state.config.publicOrigin || location.origin,
            ).href;
            return prefix + "[" + url + "](" + url + ").";
          },
        );
        // Shared renderer escapes raw HTML first and permits only safe links.
        body.innerHTML = window.mdToHtml(content);
      } else body.textContent = m.content;
      div.append(node("span", m.role === "user" ? "You" : "KAI", "role"), body);
      area.append(div);
    }
    const failed = state.detail.jobs.find((j) => j.status === "failed");
    if (failed && ["publish", "propose"].includes(failed.kind)) {
      area.append(
        node(
          "p",
          failed.error || "Publishing needs attention. Your project is saved.",
          "publish-error",
        ),
      );
      const retry = node(
        "button",
        "Retry saved publishing request",
        "retry-job",
      );
      retry.onclick = () =>
        action(async () => {
          await api(base() + "/jobs/" + failed.id + "/retry", {});
          await refresh();
        });
      area.append(retry);
    }
    if (nearBottom || !area.scrollTop) area.scrollTop = area.scrollHeight;
  }
  function renderVersions() {
    $("versions").replaceChildren();
    for (const v of state.detail.versions) {
      const row = node("article", null, "version"),
        content = node("div"),
        title = node("strong", "Version " + v.revision);
      if (v.revision === state.detail.project.live_revision)
        title.append(node("span", "LIVE", "live"));
      content.append(
        title,
        node("p", v.summary),
        node("time", new Date(v.created_at).toLocaleString()),
      );
      const b = node("button", "Restore", "button secondary");
      b.disabled = v.revision === state.detail.project.revision || !!active();
      b.onclick = () =>
        action(async () => {
          if (state.dirty && !confirm("Discard the unsaved file changes?"))
            return;
          await api(base() + "/restore", {
            revision: v.revision,
            currentRevision: state.detail.project.revision,
          });
          state.dirty = false;
          await refresh(true);
          note(
            "Version " +
              v.revision +
              " restored to a new draft. Publish when ready.",
          );
        });
      row.append(content, b);
      $("versions").append(row);
    }
  }
  function preview() {
    bridge.reset();
    state.previewDiagnostics = [];
    state.previewRevision = state.detail.project.revision;
    $("preview-error").hidden = true;
    $("preview").src =
      base() + "/preview?revision=" + state.detail.project.revision;
    $("revision-label").textContent = "v" + state.detail.project.revision;
  }
  function render(detail, force = false) {
    const old = state.detail,
      changed =
        force ||
        old?.project.id !== detail.project.id ||
        old?.project.revision !== detail.project.revision;
    state.detail = detail;
    $("welcome").hidden = true;
    $("workspace").hidden = false;
    $("project-crumb").hidden = false;
    $("project-crumb").textContent = detail.project.title;
    $("publish").hidden = false;
    const published = !!detail.project.live_revision;
    $("live-link").hidden = !published;
    $("published-app").hidden = !published;
    if (published) {
      const url = new URL(
        "/apps/" + encodeURIComponent(detail.project.slug),
        state.config.publicOrigin || location.origin,
      ).href;
      $("live-link").href = url;
      $("live-url").href = url;
      $("live-url").textContent = url;
      $("live-version").textContent =
        "Version " +
        detail.project.live_revision +
        " · " +
        (detail.project.network || state.config.network);
      $("live-draft-note").hidden =
        detail.project.revision === detail.project.live_revision;
    } else {
      $("live-link").removeAttribute("href");
      $("live-url").removeAttribute("href");
      $("live-url").textContent = "";
    }
    if (changed && !state.dirty) {
      state.files = { ...detail.files };
      state.editRevision = detail.project.revision;
      const selected = $("file-select").value;
      $("file-select").replaceChildren(
        ...Object.keys(state.files).map((name) => {
          const o = node("option", name);
          o.value = name;
          return o;
        }),
      );
      $("file-select").value =
        state.files[selected] != null ? selected : "index.html";
      $("code-editor").value = state.files[$("file-select").value] || "";
      preview();
    }
    renderMessages();
    renderVersions();
    renderProjects();
    controls();
  }
  async function refresh(force = false) {
    if (!state.detail) return;
    const id = state.detail.project.id,
      g = state.generation,
      data = await api("/build/api/projects/" + id);
    if (g !== state.generation || state.detail?.project.id !== id) return;
    render(data, force);
  }
  async function openProject(id) {
    if (state.dirty && !confirm("Discard the unsaved file changes?")) return;
    state.dirty = false;
    const g = ++state.generation;
    const data = await api("/build/api/projects/" + encodeURIComponent(id));
    if (g !== state.generation) return;
    render(data, true);
    history.replaceState(null, "", "/build?project=" + encodeURIComponent(id));
    $("messages").scrollTop = $("messages").scrollHeight;
    $("sidebar")?.classList.remove("open");
    document.querySelector(".sidebar").classList.remove("open");
    $("menu-toggle").setAttribute("aria-expanded", "false");
    note("");
  }
  async function action(fn) {
    if (state.busy) return;
    state.busy = true;
    controls();
    try {
      await fn();
    } catch (e) {
      note(e.message, true);
      for (const id of ["settings", "publish", "wallet"])
        if ($(id + "-dialog").open) $(id + "-status").textContent = e.message;
    } finally {
      state.busy = false;
      controls();
    }
  }
  function showTab(tab) {
    state.tab = tab;
    for (const name of ["preview", "code", "history"]) {
      $("pane-" + name).hidden = name !== tab;
      $("tab-" + name).setAttribute("aria-selected", String(name === tab));
    }
  }
  $("copy-live-link").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("live-url").href);
      note("Live app link copied.");
    } catch {
      note("Select and copy the live app URL shown above the preview.");
    }
  };
  $("messages").addEventListener("click", async (event) => {
    const button = event.target.closest(".code-copy");
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("pre code");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      note("Code copied.");
    } catch {
      note("Select the code to copy it.");
    }
  });
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  document
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
  $("menu-toggle").onclick = () => {
    const open = document.querySelector(".sidebar").classList.toggle("open");
    $("menu-toggle").setAttribute("aria-expanded", String(open));
  };
  function createDialog(template = "blank", idea = "") {
    queuedIdea = idea;
    $("project-title").value =
      template === "voting"
        ? "Community voting"
        : template === "board"
          ? "Community board"
          : "My Koinos app";
    $("template-select").value = template;
    $("create-dialog").showModal();
    $("project-title").select();
  }
  $("new-project").onclick = () => createDialog();
  document
    .querySelectorAll("[data-template]")
    .forEach((b) => (b.onclick = () => createDialog(b.dataset.template)));
  $("start-form").onsubmit = (e) => {
    e.preventDefault();
    const idea = $("idea").value.trim();
    createDialog(
      /vot|poll|decid/i.test(idea)
        ? "voting"
        : /post|board|community/i.test(idea)
          ? "board"
          : "blank",
      idea,
    );
  };
  $("create-form").onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      $("create-submit").disabled = true;
      try {
        const { project } = await api("/build/api/projects", {
          title: $("project-title").value,
          template: $("template-select").value,
        });
        $("create-dialog").close();
        await listProjects();
        await openProject(project.id);
        if (queuedIdea) {
          $("prompt").value = queuedIdea;
          if (state.config.aiReady) {
            await api(base() + "/messages", { prompt: queuedIdea });
            $("prompt").value = "";
            await refresh();
          } else
            note(
              "Your starter is ready. AI editing becomes available after the server setup is completed.",
            );
        }
        queuedIdea = "";
      } finally {
        $("create-submit").disabled = false;
      }
    });
  };
  $("chat-form").onsubmit = (e) => {
    e.preventDefault();
    const prompt = $("prompt").value.trim();
    if (!prompt) return;
    action(async () => {
      await api(base() + "/messages", {
        prompt,
        diagnostics: {
          revision: state.previewRevision,
          errors: state.previewDiagnostics,
        },
      });
      $("prompt").value = "";
      await refresh();
    });
  };
  $("prompt").onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $("chat-form").requestSubmit();
    }
  };
  $("file-select").onchange = () => {
    $("code-editor").value = state.files[$("file-select").value] || "";
  };
  $("code-editor").oninput = () => {
    state.files[$("file-select").value] = $("code-editor").value;
    state.dirty = true;
    controls();
  };
  $("save-files").onclick = () =>
    action(async () => {
      await api(
        base() + "/files",
        { revision: state.editRevision, files: state.files },
        "PUT",
      );
      state.dirty = false;
      await refresh(true);
      note("Version saved. The preview is updated.");
    });
  $("refresh-preview").onclick = () => {
    if (state.detail) preview();
  };
  $("device-toggle").onclick = () => {
    const phone = $("frame-wrap").classList.toggle("phone");
    $("device-toggle").setAttribute(
      "aria-label",
      phone ? "Switch to desktop preview" : "Switch to phone preview",
    );
  };
  $("import-project").onclick = () => $("import-file").click();
  $("import-file").onchange = () =>
    action(async () => {
      const f = $("import-file").files[0];
      if (!f) return;
      if (f.size > 900000)
        throw Error("Choose a project export smaller than 900 KB.");
      const data = JSON.parse(await f.text());
      const { project } = await api("/build/api/projects/import", data);
      await listProjects();
      await openProject(project.id);
      $("import-file").value = "";
    });
  async function chainInfo() {
    const data = await api(base() + "/chain");
    state.chain = data;
    return data;
  }
  $("project-settings").onclick = () =>
    action(async () => {
      $("settings-status").textContent = "";
      $("settings-dialog").showModal();
      $("ownership-info").textContent = "Checking app ownership…";
      const { config, managed } = await chainInfo(),
        p = state.detail.project;
      $("ownership-info").textContent = config
        ? "Contract: " +
          p.contract_id +
          "\nOwner: " +
          config.owner +
          (config.pending_owner ? "\nOffered to: " + config.pending_owner : "")
        : "This app has not been published yet.";
      $("accept-owner").hidden = !config?.pending_owner;
      $("propose-owner").disabled = !config;
      $("owner-address").value = config?.pending_owner || "";
    });
  $("export").onclick = () => {
    location.href = base() + "/export.zip";
  };
  $("propose-owner").onclick = () =>
    action(async () => {
      const target = $("owner-address").value.trim();
      if (!target)
        throw Error("Enter the wallet address that should own the app.");
      const data = await chainInfo();
      if (!data.config) throw Error("Publish this app first.");
      if (data.managed) {
        await api(base() + "/ownership/propose", { target });
        $("settings-status").textContent =
          "The ownership offer is being recorded. Once it is confirmed, accept it with the new wallet.";
        await refresh();
      } else await prepareWallet("propose", { target });
    });
  $("accept-owner").onclick = () => action(() => prepareWallet("accept"));
  $("publish").onclick = () =>
    action(async () => {
      $("publish-status").textContent = "";
      const p = state.detail.project,
        updating = !!p.contract_id,
        alreadyLive = p.revision === p.live_revision;
      $("publish-heading").textContent = updating
        ? "Publish frontend update"
        : "Deploy and publish app";
      $("publish-description").textContent =
        "Version " +
        p.revision +
        " of “" +
        p.title +
        "”" +
        (alreadyLive ? " is already live." : " will become public.");
      $("publish-details").textContent =
        "Network: " +
        state.config.network +
        "\nLive URL: " +
        new URL(
          "/apps/" + encodeURIComponent(p.slug),
          state.config.publicOrigin || location.origin,
        ).href +
        (updating
          ? "\nExisting contract: " + p.contract_id
          : "\nFirst publish: creates this app's contract on " +
            state.config.network +
            ".");
      $("publish-explanation").textContent = updating
        ? "This updates your frontend and keeps the same contract, address, and stored data. A Koinos transaction records the new frontend version; it does not deploy or upgrade contract code."
        : "The first publish deploys the app's contract and makes your frontend live. Later frontend updates reuse this contract and its stored data.";
      $("publish-platform").textContent = alreadyLive
        ? "Already published"
        : updating
          ? "Publish frontend update"
          : "Deploy and publish";
      $("publish-wallet").textContent = "Approve frontend update";
      // Clear the previous project's actions while ownership is checked.
      $("publish-platform").hidden = false;
      $("publish-platform").disabled = true;
      $("publish-wallet").hidden = true;
      $("publish-wallet").disabled = alreadyLive;
      $("publish-dialog").showModal();
      if (alreadyLive) {
        $("publish-status").textContent =
          "There are no unpublished changes. No transaction is needed.";
        return;
      }
      let managed = true;
      if (updating) {
        try {
          const chain = await chainInfo();
          if (!chain.config)
            throw Error(
              "The existing contract could not be verified. Publishing is paused; please retry shortly.",
            );
          managed = chain.managed;
        } catch (e) {
          $("publish-status").textContent = e.message;
          return;
        }
      }
      $("publish-platform").hidden = !managed;
      $("publish-platform").disabled = !state.config.publishingReady;
      $("publish-wallet").hidden = !p.contract_id || managed;
      if (managed && !state.config.publishingReady)
        $("publish-status").textContent =
          "Publishing is waiting for the server's signing service to be configured. Your draft is saved.";
    });
  $("publish-platform").onclick = () =>
    action(async () => {
      const updating = !!state.detail.project.contract_id;
      await api(base() + "/publish", {
        revision: state.detail.project.revision,
      });
      $("publish-dialog").close();
      await refresh();
      note(
        (updating
          ? "Frontend update started using the existing contract. "
          : "Initial contract deployment started. ") +
          "You can leave this page and return to check progress.",
      );
    });
  $("publish-wallet").onclick = () =>
    action(() =>
      prepareWallet("publish", { revision: state.detail.project.revision }),
    );
  async function prepareWallet(action, extra = {}) {
    const { draft } = await api(base() + "/wallet/prepare", {
      action,
      ...extra,
    });
    state.draft = { ...draft, projectId: state.detail.project.id };
    sessionStorage.setItem("kai-build-draft", JSON.stringify(state.draft));
    showWallet();
  }
  function showWallet() {
    $("settings-dialog").close();
    $("publish-dialog").close();
    const d = state.draft;
    $("wallet-description").textContent = {
      accept: "Accept ownership of this app with your wallet.",
      propose: "Offer ownership to the wallet below.",
      publish:
        "Approve the new frontend version with the app owner's wallet. This records a release on the existing contract and preserves its code, address, and stored data.",
    }[
      d.method === "accept_owner"
        ? "accept"
        : d.method === "propose_owner"
          ? "propose"
          : "publish"
    ];
    $("wallet-details").textContent = JSON.stringify(
      {
        network: d.network,
        signer: d.signerAddress,
        contract: d.contractId,
        action: d.method,
        arguments: d.args,
        expires: new Date(d.expiresAt).toLocaleString(),
      },
      null,
      2,
    );
    $("wallet-status").textContent =
      "Review the request, then sign here or import a signed transaction.";
    $("wallet-confirm").hidden = false;
    $("wallet-dialog").showModal();
  }
  async function submitWallet(transaction) {
    const d = state.draft;
    await api(
      "/build/api/projects/" + d.projectId + "/wallet/" + d.id + "/submit",
      { transaction: transaction.transaction || transaction },
    );
    $("wallet-status").textContent =
      "Transaction submitted. Waiting for blockchain confirmation…";
    $("wallet-confirm").hidden = false;
    await confirmWallet();
  }
  async function confirmWallet() {
    const d = state.draft;
    try {
      await api(
        "/build/api/projects/" + d.projectId + "/wallet/" + d.id + "/confirm",
        {},
      );
      $("wallet-status").textContent = "Confirmed on Koinos.";
      sessionStorage.removeItem("kai-build-draft");
      $("wallet-confirm").hidden = true;
      await refresh();
      note("Your wallet action is confirmed.");
    } catch (e) {
      $("wallet-status").textContent =
        e.message + " Use Check confirmation to continue.";
    }
  }
  $("wallet-sign").onclick = () =>
    action(async () => {
      const tx = await KaiBuildBridge.sign(state.draft);
      await submitWallet(tx);
    });
  $("wallet-vault").onclick = () =>
    action(async () => {
      const tx = await KaiBuildBridge.sign(state.draft, "koinvault");
      await submitWallet(tx);
    });
  $("wallet-confirm").onclick = () => action(confirmWallet);
  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("wallet-download").onclick = () =>
    download("kai-build-unsigned.json", state.draft);
  $("wallet-import").onclick = () => $("wallet-file").click();
  $("wallet-file").onchange = () =>
    action(async () => {
      const f = $("wallet-file").files[0];
      if (!f) return;
      if (f.size > 100000)
        throw Error("Choose a signed transaction smaller than 100 KB.");
      await submitWallet(JSON.parse(await f.text()));
      $("wallet-file").value = "";
    });
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  async function init() {
    state.config = await api("/build/api/config");
    $("account-name").textContent =
      state.config.account.email || "Koinos AI account";
    $("network").textContent = state.config.network;
    $("model-label").textContent = "OpenAI · " + state.config.model;
    if (!state.config.aiReady) {
      $("setup-note").hidden = false;
      $("setup-note").textContent =
        "AI editing is waiting for server setup. You can create projects, edit their files, and try the previews now.";
    }
    await listProjects();
    const id = new URLSearchParams(location.search).get("project");
    if (id) await openProject(id);
    const saved = sessionStorage.getItem("kai-build-draft");
    if (saved) {
      try {
        const d = JSON.parse(saved);
        if (
          d.expiresAt > Date.now() &&
          state.projects.some((p) => p.id === d.projectId)
        ) {
          state.draft = d;
          if (state.detail?.project.id === d.projectId) showWallet();
        }
      } catch {
        sessionStorage.removeItem("kai-build-draft");
      }
    }
    poller = setInterval(() => {
      if (state.detail && !document.hidden && !state.busy)
        refresh().catch((e) => note(e.message, true));
    }, 4000);
    controls();
  }
  init().catch((e) => note(e.message, true));
})();
