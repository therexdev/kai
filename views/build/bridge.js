"use strict";
(() => {
  const READ = new Set(["get_config", "list_records", "get_record"]),
    WRITE = new Set(["create_record", "edit_record", "vote", "close_poll"]);
  async function bounded(promise, ms = 180000) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "The wallet did not respond. Close any pending wallet prompt and try again.",
                ),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function accounts() {
    if (!window.kondor)
      throw Error("Kondor could not load. Refresh the page and try again.");
    const result = await bounded(kondor.getAccounts());
    if (!Array.isArray(result) || !result.length)
      throw Error("Choose an account in Kondor to continue.");
    return result;
  }
  async function sign(draft) {
    const list = await accounts();
    if (!list.some((a) => a.address === draft.signerAddress))
      throw Error("Choose " + draft.signerAddress + " in Kondor.");
    const result = await bounded(
      kondor
        .getSigner(draft.signerAddress)
        .signTransaction(structuredClone(draft.transaction), {
          [draft.contractId]: draft.abi,
          ...(draft.guardId ? { [draft.guardId]: draft.guardAbi } : {}),
        }),
    );
    return result.transaction || result;
  }
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
      api = null,
    } = {},
  ) {
    let connected = null,
      working = false,
      start = Date.now(),
      reads = 0,
      writes = 0,
      version = null,
      records = [],
      votes = new Set();
    function reset() {
      connected = null;
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
        onError(String(d.message).slice(0, 500));
        return;
      }
      if (
        d?.type !== "kai-app-request" ||
        typeof d.id !== "string" ||
        d.id.length > 30
      )
        return;
      let result, error;
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
          if (mode === "preview") result = { address: "Preview wallet" };
          else {
            if (working)
              throw Error("Finish the current wallet request first.");
            if (!connected) {
              working = true;
              try {
                if (
                  !(await review(
                    "Connect this app",
                    "Share your public wallet address with " +
                      (getProject()?.title || "this app") +
                      ".",
                    {
                      app: getProject()?.title,
                      network: getProject()?.network,
                    },
                  ))
                )
                  throw Error("Connection cancelled.");
                connected = (await accounts())[0].address;
              } finally {
                working = false;
              }
            }
            result = { address: connected };
          }
        } else if (d.method === "read" && READ.has(d.args?.method)) {
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
              const { draft } = await api("prepare", {
                ...d.args,
                address: connected,
              });
              if (
                !(await review(
                  "Review app transaction",
                  "This action uses your wallet's mana. Nothing is signed until you approve it in your wallet.",
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
              const transaction = await sign(draft);
              result = await api("submit", { draftId: draft.id, transaction });
            } finally {
              working = false;
            }
          }
        } else throw Error("This app requested an unsupported action.");
      } catch (e) {
        error = e.message;
      }
      if (event.source === frame.contentWindow)
        frame.contentWindow.postMessage(
          { type: "kai-app-response", id: d.id, result, error },
          "*",
        );
    };
    window.addEventListener("message", listener);
    return {
      reset,
      destroy: () => window.removeEventListener("message", listener),
    };
  }
  window.KaiBuildBridge = { create, sign, review };
})();
