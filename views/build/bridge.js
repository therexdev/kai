"use strict";
(() => {
  const READ = new Set(["get_config", "list_records", "get_record"]),
    WRITE = new Set(["create_record", "edit_record", "vote", "close_poll"]);
  const ownerWallet = KaiBuildWallets.create();
  const sign = (draft, wallet = "kondor") => ownerWallet.sign(draft, wallet);
  function review(title, description, details) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog"),
        head = document.createElement("h2"),
        p = document.createElement("p"),
        pre = document.createElement("pre"),
        buttons = document.createElement("div"),
        yes = document.createElement("button"),
        no = document.createElement("button");
      head.textContent = title;
      p.textContent = description;
      pre.textContent = JSON.stringify(details, null, 2);
      buttons.className = "button-row";
      yes.className = "button primary";
      yes.textContent = "Continue to wallet";
      no.className = "button secondary";
      no.textContent = "Cancel";
      buttons.append(yes, no);
      dialog.append(head, p, pre, buttons);
      document.body.append(dialog);
      let accepted = false;
      yes.onclick = () => {
        accepted = true;
        dialog.close();
      };
      no.onclick = () => dialog.close();
      dialog.onclose = () => {
        dialog.remove();
        resolve(accepted);
      };
      dialog.showModal();
    });
  }
  function create(
    frame,
    {
      mode = "preview",
      getProject = () => null,
      onError = () => {},
      onDiagnostic = () => {},
      api = null,
    } = {},
  ) {
    const wallet = KaiBuildWallets.create();
    let connected = null,
      connectedWallet = null,
      previewWallet = null,
      pendingSubmission = null,
      working = false,
      start = Date.now(),
      reads = 0,
      writes = 0,
      version = null,
      records = [],
      votes = new Set();
    function reset() {
      connected = null;
      connectedWallet = null;
      previewWallet = null;
      working = false;
      version = null;
      records = [];
      votes = new Set();
    }
    function seed() {
      const p = getProject();
      if (version === p?.id) return;
      version = p?.id;
      const poll = p?.template === "voting";
      records = poll
        ? [
            {
              id: 1,
              author: "Preview wallet",
              title: "What should we build next?",
              body: "A small idea can bring a whole community together.",
              options: [
                "A community game",
                "An events calendar",
                "An NFT showcase",
              ],
              votes: [12, 8, 5],
              closed: false,
            },
            {
              id: 2,
              author: "Preview wallet",
              title: "When should we meet?",
              body: "Pick a day for our next community call.",
              options: ["Wednesday", "Saturday"],
              votes: [6, 9],
              closed: false,
            },
          ]
        : [
            {
              id: 1,
              author: "Preview wallet",
              title: "Welcome to our community",
              body: "Share an idea, leave an update, or start a conversation.",
              options: [],
              votes: [],
              closed: false,
            },
          ];
    }
    async function demo(method, args) {
      seed();
      const config = {
        owner: "Preview wallet",
        title: getProject()?.title || "Preview",
        count: records.length,
        revision: 1,
      };
      if (method === "get_config") return { config };
      if (method === "list_records")
        return {
          config,
          records: records.slice(
            Number(args.offset) || 0,
            (Number(args.offset) || 0) + 20,
          ),
        };
      if (method === "get_record")
        return {
          record: records.find((r) => r.id === Number(args.id)) || null,
        };
      const r = records.find((r) => r.id === Number(args.id));
      if (method === "create_record") {
        if (!args.title?.trim()) throw Error("Add a title first.");
        if (args.options?.length === 1 || args.options?.length > 8)
          throw Error("Polls need 2 to 8 options.");
        records.push({
          id: records.length + 1,
          author: "Preview wallet",
          title: String(args.title).slice(0, 160),
          body: String(args.body || "").slice(0, 4000),
          options: args.options || [],
          votes: (args.options || []).map(() => 0),
          closed: false,
        });
      } else if (method === "vote") {
        if (!r || r.closed || !r.options?.[args.choice])
          throw Error("This poll is closed or the option is invalid.");
        if (votes.has(r.id)) throw Error("This preview wallet already voted.");
        votes.add(r.id);
        r.votes[args.choice]++;
      } else if (method === "close_poll") {
        if (!r) throw Error("Poll not found.");
        r.closed = true;
      } else if (method === "edit_record") {
        if (!r) throw Error("Record not found.");
        if (r.options.length) throw Error("Polls cannot be edited.");
        r.title = args.title;
        r.body = args.body || "";
      }
      return { preview: true };
    }
    const listener = async (event) => {
      if (event.source !== frame.contentWindow || event.origin !== "null")
        return;
      const d = event.data;
      if (d?.type === "kai-app-error") {
        onDiagnostic(d);
        onError(String(d.message).slice(0, 500));
        return;
      }
      if (
        d?.type !== "kai-app-request" ||
        typeof d.id !== "string" ||
        d.id.length > 30
      )
        return;
      let result, error, failure;
      let phase = "request";
      try {
        if (JSON.stringify(d).length > 12000)
          throw Error("App request is too large.");
        if (Date.now() - start > 60000) {
          start = Date.now();
          reads = writes = 0;
        }
        if (++reads > 80)
          throw Error("This app is sending too many requests. Wait a moment.");
        if (d.method === "connect") {
          phase = "connect";
          if (mode === "preview") {
            const choice =
              d.args?.wallet ||
              previewWallet ||
              (await KaiBuildWallets.choose(true));
            if (!["kondor", "koinvault"].includes(choice))
              throw Error("Choose Kondor or KOIN Vault.");
            previewWallet = choice;
            result = {
              address: "Preview wallet",
              wallet: choice,
              preview: true,
            };
          } else {
            if (working)
              throw Error("Finish the current wallet request first.");
            working = true;
            try {
              result = await wallet.connect(getProject() || {}, d.args?.wallet);
              connected = result.address;
              connectedWallet = result.wallet;
            } finally {
              working = false;
            }
          }
        } else if (d.method === "disconnect") {
          if (working) throw Error("Finish the current wallet request first.");
          if (mode !== "preview") await wallet.disconnect();
          connected = null;
          connectedWallet = null;
          previewWallet = null;
          result = { disconnected: true };
        } else if (d.method === "read" && READ.has(d.args?.method)) {
          phase = "read";
          result =
            mode === "preview"
              ? await demo(d.args.method, d.args.args || {})
              : await api("read", d.args);
        } else if (d.method === "call" && WRITE.has(d.args?.method)) {
          if (mode === "preview")
            result = await demo(d.args.method, d.args.args || {});
          else {
            if (working)
              throw Error("Finish the current wallet request first.");
            if (!connected) throw Error("Connect your wallet first.");
            if (++writes > 8)
              throw Error("Too many wallet requests. Wait a minute.");
            working = true;
            try {
              if (pendingSubmission) {
                if (JSON.stringify(d.args) !== pendingSubmission.action)
                  throw Error(
                    "The previous wallet request is unresolved. Retry that action to check its status before starting another.",
                  );
              } else {
                phase = "prepare";
                const { draft } = await api("prepare", {
                  ...d.args,
                  address: connected,
                });
                phase = "review";
                if (
                  !(await review(
                    "Review app transaction",
                    "Review this app action, then approve it in your wallet. Your wallet may adjust the mana limit; the app action and account stay the same.",
                    {
                      app: getProject()?.title,
                      network: draft.network,
                      wallet: connected,
                      contract: draft.contractId,
                      action: draft.method,
                      arguments: draft.args,
                    },
                  ))
                )
                  throw Error("Transaction cancelled.");
                pendingSubmission = {
                  action: JSON.stringify(d.args),
                  draft,
                  request: null,
                };
              }
              if (!pendingSubmission.request) {
                phase = "sign";
                let transaction;
                try { transaction = await wallet.sign(pendingSubmission.draft); }
                catch (e) {
                  // Kondor signs only; no submission has happened. A fresh
                  // attempt may prepare a current nonce after cancellation.
                  // Vault broadcasts inside its wallet; preserve its request.
                  if (connectedWallet === "kondor") pendingSubmission = null;
                  throw e;
                }
                pendingSubmission.request = {
                  draftId: pendingSubmission.draft.id,
                  transaction,
                };
              }
              phase = "submit";
              try { result = await api("submit", pendingSubmission.request); }
              catch (e) {
                if (e.retryable === true) pendingSubmission = null;
                throw e;
              }
              pendingSubmission = null;
            } finally {
              working = false;
            }
          }
        } else throw Error("This app requested an unsupported action.");
      } catch (e) {
        error = e.message;
        failure = { phase, code: e.code || "", retryable: e.retryable === true };
        onDiagnostic({
          kind: "bridge",
          message: String(error).slice(0, 500),
          action:
            String(d.method || "") +
            (typeof d.args?.method === "string" ? ":" + d.args.method : ""),
          phase,
          wallet: connectedWallet,
          code: e.code,
        });
      }
      if (event.source === frame.contentWindow)
        frame.contentWindow.postMessage(
          { type: "kai-app-response", id: d.id, result, error, failure },
          "*",
        );
    };
    window.addEventListener("message", listener);
    return {
      reset,
      destroy: () => {
        wallet.destroy();
        window.removeEventListener("message", listener);
      },
    };
  }
  window.KaiBuildBridge = { create, sign, review };
})();
