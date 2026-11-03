"use strict";
// The IDE renders source as text. Project code never runs in this document.
window.KaiBuildIDE = {
  create({ getState, api, base, action, refresh, controls, showTab, preview }) {
    const $ = id => document.getElementById(id);
    const el = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text != null) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
    let proposalKey = "", renameFrom = null, checkKey = "";
    const isContract = () => getState().detail?.project.template === "contract";
    const isApplication = () => getState().detail?.project.template === "workspace";
    const isPlugin = () => ["plugin", "plugin-chain"].includes(getState().detail?.project.template);
    const sourceOnly = () => isContract() || isApplication() || isPlugin();
    const hasSourceWorkspace = () => isContract() || getState().detail?.workspace?.fullSource;
    const locked = () => getState().busy || getState().detail?.jobs.some(j => ["queued", "running", "confirming"].includes(j.status));
    function editorStatus() {
      const input = $("code-editor"), text = input.value;
      $("line-numbers").textContent = Array.from({ length: text.split("\n").length }, (_, i) => i + 1).join("\n");
      $("line-numbers").scrollTop = input.scrollTop;
      const before = text.slice(0, input.selectionStart).split("\n"), name = $("file-select").value;
      const language = name.endsWith(".ts") ? (isContract() || name.startsWith("contract/") ? "AssemblyScript" : "TypeScript") : name.split(".").at(-1)?.toUpperCase();
      $("editor-status").textContent = `${language || "Source"} · Ln ${before.length}, Col ${before.at(-1).length + 1} · ${getState().dirty ? "Unsaved" : "Saved v" + getState().editRevision} · Ctrl/Cmd+S to save`;
    }
    function selectFile(name) {
      $("file-select").value = name;
      $("code-editor").value = getState().files[name] || "";
      editorStatus();
      renderTree();
    }
    function renderTree() {
      const selected = $("file-select").value, filter = $("file-filter").value.toLowerCase();
      $("file-tree").replaceChildren();
      for (const name of Object.keys(getState().files || {}).sort()) {
        if (!name.toLowerCase().includes(filter)) continue;
        const b = el("button", name, name === selected ? "selected" : "");
        b.type = "button";
        b.title = name;
        b.setAttribute("aria-current", name === selected ? "true" : "false");
        b.onclick = () => selectFile(name);
        $("file-tree").append(b);
      }
    }
    function rebuildFiles(selected) {
      $("file-select").replaceChildren(...Object.keys(getState().files).sort().map(name => {
        const o = el("option", name); o.value = name; return o;
      }));
      selectFile(selected || Object.keys(getState().files)[0]);
    }
    function edited() {
      getState().dirty = true;
      checkKey = "";
      $("source-diagnostics").textContent = "Files changed. Run Check files again for current results.";
      editorStatus();
      controls();
    }
    function renderDiagnostics() {
      const target = $("preview-diagnostics"), state = getState();
      target.replaceChildren();
      if (sourceOnly()) target.textContent = isPlugin() ? "Plugin code runs in KAI Core after packaging and approval. It has not been executed in this web workspace." : "Contract workspaces do not run in the frontend preview.";
      else if (!state.previewDiagnostics.length) target.textContent = "No errors observed in this preview. This does not mean interactions have been tested.";
      for (const d of sourceOnly() ? [] : state.previewDiagnostics) {
        target.append(el("p", `${d.kind}${d.line ? " · line " + d.line : ""}${d.action ? " · " + d.action : ""}: ${d.message}`, "diagnostic error"));
      }
    }
    function renderProposal() {
      const state = getState(), p = state.detail?.proposal;
      $("review-pending").hidden = !p;
      $("proposal-conflict").hidden = !p || p.base_revision === state.detail.project.revision;
      const key = `${state.detail?.project.id}:${p?.id}:${state.detail?.project.revision}`;
      if (key === proposalKey) return;
      proposalKey = key;
      $("proposal-summary").textContent = p ? p.summary : "No proposed changes. Ask KAI to edit your project.";
      $("proposal-diff").replaceChildren();
      if (!p) return;
      for (const name of [...new Set([...Object.keys(p.baseFiles), ...Object.keys(p.files)])].sort()) {
        if (p.baseFiles[name] === p.files[name]) continue;
        const row = el("details", null, "file-diff");
        row.open = true;
        const status = p.baseFiles[name] == null ? "Added" : p.files[name] == null ? "Deleted" : "Modified";
        row.append(el("summary", `${status} · ${name}`));
        const columns = el("div", null, "diff-columns");
        for (const [label, content, cls] of [["Saved source", p.baseFiles[name], "before"], ["Proposed source", p.files[name], "after"]]) {
          const col = el("div", null, cls);
          col.append(el("h4", label), el("pre", content == null ? "(file does not exist)" : content));
          columns.append(col);
        }
        row.append(columns);
        $("proposal-diff").append(row);
      }
    }
    function updateControls() {
      const state = getState(), p = state.detail?.proposal;
      $("file-actions").hidden = !hasSourceWorkspace();
      for (const id of ["add-file", "rename-file", "delete-file", "check-files"]) $(id).disabled = !!locked() || !state.detail;
      $("apply-proposal").disabled = !p || !!locked() || state.dirty || p.base_revision !== state.detail.project.revision;
      $("discard-proposal").disabled = !p || !!locked();
      $("open-full-project").hidden = !state.detail || hasSourceWorkspace();
      $("open-full-project").disabled = !!locked() || state.dirty || !!p;
      const target = state.detail?.buildTargets?.targets?.find(t => t.id === $("build-target").value);
      const runLocked = !!locked() || state.dirty || !!p || !state.config?.ide?.runnerConfigured || !target;
      $("compile-target").disabled = runLocked || target?.type !== "koinos-as";
      $("test-target").disabled = runLocked || !target?.tests.length;
      $("check-runner").disabled = !!locked() || !state.config?.ide?.runnerConfigured;
      $("test-preview").hidden = sourceOnly();
      $("test-preview").disabled = !!locked() || state.dirty || !!p || !state.detail;
    }
    let buildKey = "";
    function renderBuilds() {
      const state = getState(), target = $("build-target"), selected = target.value;
      target.replaceChildren(...(state.detail.buildTargets?.targets || []).map(t => { const option = el("option", t.id + " · " + t.type); option.value = t.id; return option; }));
      if ([...target.options].some(o => o.value === selected)) target.value = selected;
      $("runner-status").textContent = state.config?.ide?.runnerConfigured ? "Worker configured. Start a run to check this source, or check worker availability." : "Build worker needs setup on the server. You can write and export source now; compilation and test execution become available after setup.";
      $("build-target-note").textContent = state.detail.buildTargets?.error || (!target.options.length ? "Add build and test targets to kai.project.json. Ask KAI to configure targets for this project." : state.dirty || state.detail.proposal ? "Save your editor changes and review the proposal before running a saved version." : "Choose a target to compile or test.");
      const key = state.detail.project.id + ":" + JSON.stringify(state.detail.builds || []);
      if (key === buildKey) return;
      buildKey = key;
      const results = $("build-results"); results.replaceChildren();
      if (!state.detail.builds?.length) results.append(el("p", "No compiler or test runs yet. Source checks are shown separately in Diagnostics."));
      for (const run of state.detail.builds || []) {
        const row = el("details", null, "build-result"); row.open = results.childElementCount === 0;
        row.append(el("summary", `${run.target} · ${run.operation} · ${run.ok ? "Passed" : "Failed"} · ${run.matchesSource ? "Saved source" : "Different source / proposal"}`));
        row.append(el("p", `${new Date(run.createdAt).toLocaleString()} · ${run.profile} · ${(run.durationMs / 1000).toFixed(1)}s`, "muted"));
        row.append(el("p", "Source SHA-256: " + run.sourceHash, "build-hash"), el("pre", run.logs || "No output."));
        for (const artifact of run.artifacts || []) {
          const link = el("a", "Download " + artifact.name); link.href = base() + "/runs/" + encodeURIComponent(run.id) + "/" + encodeURIComponent(artifact.name); link.download = artifact.name;
          row.append(link, el("p", artifact.sha256, "build-hash"));
        }
        const repair = el("button", "Ask KAI to inspect this run", "button secondary");
        repair.onclick = () => { $("prompt").value = `Read build result ${run.id} for ${run.target}. Compare its source hash with the working files, inspect the errors and propose a focused repair with tests. Do not deploy.`; $("prompt").focus(); };
        row.append(repair); results.append(row);
      }
    }
    $("build-target").onchange = updateControls;
    $("check-runner").onclick = () => action(async () => {
      try { const status = await api("/build/api/runner"); $("runner-status").textContent = status.busy ? "Worker is ready and currently busy." : "Isolated worker is ready · " + status.profile; }
      catch (error) { $("runner-status").textContent = error.message; }
    });
    for (const [id, operation] of [["compile-target", "compile"], ["test-target", "test"]]) $(id).onclick = () => action(async () => {
      const state = getState();
      await api(base() + "/runs", { revision: state.editRevision, target: $("build-target").value, operation });
      await refresh(); showTab("runs");
    });
    $("file-filter").oninput = renderTree;
    $("file-select").addEventListener("change", () => selectFile($("file-select").value));
    $("code-editor").addEventListener("input", edited);
    $("code-editor").addEventListener("click", editorStatus);
    $("code-editor").addEventListener("keyup", editorStatus);
    $("code-editor").addEventListener("scroll", () => { $("line-numbers").scrollTop = $("code-editor").scrollTop; });
    $("code-editor").addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!$("save-files").disabled) $("save-files").click();
      }
      if (event.key === "Tab" && !$("code-editor").readOnly && !event.shiftKey) {
        event.preventDefault();
        const input = $("code-editor");
        input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    function fileDialog(rename) {
      if (!hasSourceWorkspace() || locked()) return;
      renameFrom = rename ? $("file-select").value : null;
      $("source-file-heading").textContent = rename ? "Rename source file" : "New source file";
      $("source-file-path").value = renameFrom || "";
      $("source-file-path").placeholder = isPlugin() ? "plugin/features/panel.js" : isContract() ? "assembly/MyContract.ts" : "contract/assembly/Feature.ts";
      $("source-file-error").textContent = "";
      $("source-file-dialog").showModal();
      $("source-file-path").focus();
    }
    $("add-file").onclick = () => fileDialog(false);
    $("rename-file").onclick = () => fileDialog(true);
    $("source-file-form").onsubmit = event => {
      event.preventDefault();
      if (!hasSourceWorkspace() || locked()) return;
      const name = $("source-file-path").value.trim(), state = getState();
      const sourcePath = ((isPlugin() || isApplication()) ? /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(ts|tsx|jsx|js|cjs|mjs|json|proto|md|yaml|yml|html|css|svg|txt|sql|toml)$/ : /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(ts|js|cjs|json|proto|md|yaml|yml)$/).test(name) && !name.split("/").some(p => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p) || p.endsWith(".") || /^(node_modules|build|dist|vendor|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) && name.length <= 160;
      if (!(sourceOnly() ? sourcePath : ["index.html", "app.css", "app.js", "README.md", "kai.project.json"].includes(name) || (name.startsWith("contract/") && sourcePath))) {
        $("source-file-error").textContent = isPlugin() ? "Use a safe source path, such as plugin/features/panel.js." : isContract() ? "Use a safe relative source path, such as assembly/Feature.ts." : "Use a contract/ source path, such as contract/assembly/Feature.ts."; return;
      }
      if (Object.keys(state.files).some(n => n !== renameFrom && (n.toLowerCase() === name.toLowerCase() || n.toLowerCase().startsWith(name.toLowerCase() + "/") || name.toLowerCase().startsWith(n.toLowerCase() + "/")))) {
        $("source-file-error").textContent = "That path conflicts with an existing file."; return;
      }
      if (!renameFrom && Object.keys(state.files).length >= 512) { $("source-file-error").textContent = "The limit is 512 files."; return; }
      const content = renameFrom ? state.files[renameFrom] : "";
      if (renameFrom) delete state.files[renameFrom];
      state.files[name] = content;
      rebuildFiles(name); edited();
      $("source-file-dialog").close();
    };
    $("delete-file").onclick = () => {
      if (!hasSourceWorkspace() || locked() || Object.keys(getState().files).length <= 1) return;
      const name = $("file-select").value;
      if (!confirm("Delete " + name + " from the draft? You can restore saved versions.")) return;
      delete getState().files[name]; rebuildFiles(); edited();
    };
    function checkFiles(openPreview = false) { return action(async () => {
      const state = getState(), key = JSON.stringify(state.files), project = state.detail.project.id;
      const result = await api(base() + "/check", { files: state.files });
      if (project !== getState().detail?.project.id || key !== JSON.stringify(getState().files)) return;
      checkKey = project + ":" + state.editRevision;
      const target = $("source-diagnostics"); target.replaceChildren();
      target.append(el("p", result.ok ? "Source checks passed." : "Source checks found issues.", result.ok ? "diagnostic" : "diagnostic error"));
      if (result.note) target.append(el("p", result.note));
      for (const d of result.diagnostics || []) {
        if (d.message === result.note) continue;
        const item = el("p", `${d.path ? d.path + ": " : ""}${d.message}`, "diagnostic " + d.severity);
        if (d.path && Object.hasOwn(state.files, d.path)) {
          const open = el("button", "Open file");
          open.onclick = () => { selectFile(d.path); showTab("code"); };
          item.append(open);
        }
        target.append(item);
      }
      if (openPreview && result.ok && !state.dirty && !sourceOnly()) {
        preview(); showTab("preview");
      } else showTab("problems");
    }); }
    $("check-files").onclick = () => checkFiles();
    $("test-preview").onclick = () => checkFiles(true);
    $("open-full-project").onclick = () => action(async () => {
      if (getState().dirty) return;
      await api(base() + "/workspace", { revision: getState().detail.project.revision });
      await refresh(true); showTab("code");
    });
    let referenceLoaded = "";
    async function loadReference() {
      const topic = $("reference-topic").value;
      if (!isPlugin() || referenceLoaded === topic) return;
      $("reference-content").textContent = "Loading Core documentation…";
      try {
        const doc = await api("/build/api/reference/plugins/" + encodeURIComponent(topic));
        if (topic !== $("reference-topic").value) return;
        $("reference-source").href = doc.sourceUrl;
        $("reference-version").textContent = "Core reference · " + doc.coreRevision.slice(0, 12) + " · " + doc.note;
        if (doc.format === "code") $("reference-content").replaceChildren(el("pre", doc.content));
        else $("reference-content").innerHTML = window.mdToHtml(doc.content);
        referenceLoaded = topic;
      } catch (error) { $("reference-content").textContent = error.message; }
    }
    $("reference-topic").onchange = () => { void loadReference(); };
    document.querySelectorAll("[data-plugin-prompt]").forEach(button => { button.onclick = () => {
      $("prompt").value = button.dataset.pluginPrompt; $("prompt").focus();
    }; });
    for (const [id, verb] of [["apply-proposal", "apply"], ["discard-proposal", "discard"]]) {
      $(id).onclick = () => action(async () => {
        const state = getState(), p = state.detail.proposal;
        if (!p || (verb === "apply" && state.dirty)) return;
        await api(base() + "/proposals/" + p.id, { action: verb, revision: state.detail.project.revision });
        await refresh(true);
      });
    }
    return {
      renderDiagnostics, controls: updateControls, loadReference,
      render() {
        const state = getState();
        $("project-workflow-title").textContent = isPlugin() ? (state.detail.project.template === "plugin-chain" ? "KAI plugin + Koinos contract" : "KAI Core plugin workspace") : isApplication() ? "Application workspace · Contracts, services & frontend" : isContract() ? "Contract source workspace" : hasSourceWorkspace() ? "Your project · Frontend, contracts & tests" : "Your guided app";
        $("project-workflow-detail").textContent = state.detail.workspace?.reason || "Chat, preview and deploy your app.";
        $("tab-preview").hidden = sourceOnly();
        $("tab-reference").hidden = !isPlugin();
        if ((sourceOnly() && state.tab === "preview") || (!isPlugin() && state.tab === "reference")) showTab("code");
        if (checkKey && checkKey !== state.detail.project.id + ":" + state.editRevision) {
          checkKey = ""; $("source-diagnostics").textContent = "Source version changed. Run Check files for current results.";
        }
        renderTree(); editorStatus(); renderProposal(); renderDiagnostics(); renderBuilds(); updateControls();
      },
    };
  },
};
