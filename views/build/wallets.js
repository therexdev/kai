"use strict";
(() => {
  const VAULT = "https://koinvault.app";
  const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
  const element = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "Kondor did not respond. Open Kondor, check its network, and try again.",
                ),
              ),
            120000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function vaultApi(path, credentials, body) {
    const url = new URL("/api/dapp/" + path, VAULT);
    if (!body) url.search = new URLSearchParams(credentials).toString();
    let response;
    try {
      response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify({ ...credentials, ...body }) : undefined,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw Error(
        "KOIN Vault is temporarily unreachable. Check the wallet before starting another request.",
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw Error("KOIN Vault is temporarily unavailable.");
    }
    if (!response.ok || !data.ok)
      throw Object.assign(
        Error(data.error || "KOIN Vault could not finish this request."),
        { status: response.status },
      );
    return data;
  }
  function dialog(title, description) {
    const root = element("dialog", null, "wallet-choice"),
      status = element("p", description),
      buttons = element("div", null, "button-row"),
      cancel = element("button", "Cancel", "button secondary");
    status.setAttribute("role", "status");
    root.append(element("h2", title), status, buttons);
    buttons.append(cancel);
    document.body.append(root);
    let cancelled = false;
    cancel.onclick = () => root.close();
    root.oncancel = () => {
      cancelled = true;
    };
    root.onclose = () => {
      cancelled = true;
    };
    root.showModal();
    return {
      root,
      status,
      buttons,
      cancel,
      get cancelled() {
        return cancelled;
      },
      close() {
        root.close();
        root.remove();
      },
    };
  }
  function choose(preview = false) {
    return new Promise((resolve) => {
      const ui = dialog(
        "Connect wallet",
        preview
          ? "Preview uses sample data. Choose how the published app will connect."
          : "Choose your Koinos wallet.",
      );
      ui.root.onclose = () => {
        ui.root.remove();
        resolve(null);
      };
      for (const [id, label] of [
        ["kondor", "Kondor"],
        ["koinvault", "KOIN Vault"],
      ]) {
        const b = element("button", label, "button primary");
        b.onclick = () => {
          resolve(id);
          ui.close();
        };
        ui.buttons.prepend(b);
      }
    });
  }
  function walletLink(ui, uri, pairing = false) {
    const url = new URL(uri);
    if (url.origin !== VAULT || url.pathname !== "/")
      throw Error("Unexpected KOIN Vault destination.");
    const link = element("a", "Open KOIN Vault", "button primary");
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    ui.buttons.prepend(link);
    if (pairing) {
      const qr = qrcode(0, "M");
      qr.addData(url.href);
      qr.make();
      const image = element("img", null, "wallet-qr");
      image.src = qr.createDataURL(5, 10);
      image.alt = "Scan with KOIN Vault to connect";
      ui.root.insertBefore(image, ui.buttons);
    }
  }
  function create() {
    let selected = null,
      address = null,
      session = null,
      pending = null,
      monitor = null;
    const approved = new Map();
    const credentials = () => ({
      sessionId: session.sessionId,
      secret: session.secret,
    });
    function clear() {
      selected = address = session = null;
      clearTimeout(monitor);
    }
    async function status() {
      const current = session;
      if (!current || current.expiresAt <= Date.now()) {
        clear();
        throw Error("KOIN Vault connection expired. Connect again.");
      }
      let data;
      try {
        data = await vaultApi("status", credentials());
      } catch (e) {
        if ([404, 410].includes(e.status)) clear();
        throw e;
      }
      if (session !== current) throw Error("Wallet connection changed.");
      if (
        !data.connected ||
        data.address !== address ||
        data.origin !== location.origin
      ) {
        clear();
        throw Error("KOIN Vault disconnected. Connect your wallet again.");
      }
      return data;
    }
    function watch() {
      clearTimeout(monitor);
      if (!session || !address) return;
      monitor = setTimeout(async () => {
        try {
          await status();
        } catch {}
        watch();
      }, 10000);
    }
    async function kondorAccounts() {
      if (!window.kondor)
        throw Error(
          "Kondor could not load. Install or enable Kondor, then refresh.",
        );
      const accounts = await bounded(window.kondor.getAccounts());
      if (!Array.isArray(accounts) || !accounts[0]?.address)
        throw Error("Choose an account in Kondor.");
      return accounts;
    }
    function checkNetwork(project) {
      const chainId =
        project.chainId ||
        project.chain_id ||
        project.transaction?.header?.chain_id;
      // koinvault.app is the mainnet wallet. Its API does not switch networks.
      if (chainId !== MAINNET)
        throw Error(
          "KOIN Vault is currently on mainnet. This app is on testnet; use Kondor configured for the app's testnet. KOIN Vault will be available for mainnet apps.",
        );
    }
    async function connect(project = {}, wallet) {
      if (wallet && !["kondor", "koinvault"].includes(wallet))
        throw Error("Choose Kondor or KOIN Vault.");
      if (address && (!wallet || wallet === selected)) {
        if (selected === "koinvault") await status();
        return { address, wallet: selected };
      }
      if (pending)
        throw Error("A KOIN Vault transaction is still unresolved. Check its outcome in the wallet before reconnecting or starting another action.");
      const choice = wallet || (await choose());
      if (!choice) throw Error("Connection cancelled.");
      if (choice === "kondor") {
        const list = await kondorAccounts();
        if (session) await disconnect();
        selected = choice;
        address = list[0].address;
        return { address, wallet: selected };
      }
      checkNetwork(project);
      if (session) await disconnect();
      selected = address = null;
      const ui = dialog(
        "Connect KOIN Vault",
        "Scan this QR code with KOIN Vault, or open the wallet and approve this connection.",
      );
      try {
        session = await vaultApi(
          "create",
          {},
          { name: String(project.title || "KAI Build").slice(0, 60) },
        );
        if (ui.cancelled) throw Error("Connection cancelled.");
        walletLink(ui, session.uri, true);
        const current = session,
          until = Math.min(session.expiresAt, Date.now() + 180000);
        while (!ui.cancelled && session === current && Date.now() < until) {
          const data = await vaultApi("status", credentials());
          if (
            data.connected &&
            data.address &&
            data.origin === location.origin
          ) {
            address = data.address;
            selected = choice;
            watch();
            return { address, wallet: selected };
          }
          await delay(2000);
        }
        throw Error("Connection cancelled or expired.");
      } finally {
        ui.close();
        if (!address) clear();
      }
    }
    async function disconnect() {
      if (pending)
        throw Error("Resolve the pending transaction in KOIN Vault before disconnecting.");
      if (session) {
        try {
          await vaultApi("disconnect", credentials(), {});
        } catch (e) {
          if (![404, 410].includes(e.status)) throw e;
        }
      }
      clear();
    }
    async function sign(draft, wallet) {
      if (approved.has(draft.id)) return approved.get(draft.id);
      await connect(draft, wallet);
      if (address !== draft.signerAddress)
        throw Error(
          "Choose " +
            draft.signerAddress +
            " in " +
            (selected === "kondor" ? "Kondor" : "KOIN Vault") +
            ".",
        );
      if (selected === "kondor") {
        const list = await kondorAccounts();
        if (!list.some((a) => a.address === address))
          throw Error(
            "Your Kondor account changed. Reconnect the correct wallet.",
          );
        const signed = await bounded(
          window.kondor
            .getSigner(address)
            .signTransaction(structuredClone(draft.transaction), {
              [draft.contractId]: draft.abi,
              ...(draft.guardId ? { [draft.guardId]: draft.guardAbi } : {}),
            }),
        );
        return signed.transaction || signed;
      }
      checkNetwork(draft);
      await status();
      if (pending && pending.draftId !== draft.id)
        throw Error(
          "Resolve the pending request in KOIN Vault before starting another action.",
        );
      const ui = dialog(
        "Approve in KOIN Vault",
        "Open KOIN Vault and approve this transaction. Keep this page open while it confirms.",
      );
      try {
        walletLink(ui, VAULT + "/");
        if (!pending) {
          // Mark uncertain submissions before POST. Never retry that POST automatically.
          pending = { draftId: draft.id };
          const request = await vaultApi("request", credentials(), {
            operations: draft.transaction.operations,
            mana: "wallet",
          });
          pending = { ...request, draftId: draft.id };
        }
        if (!pending.requestId)
          throw Error(
            "The request outcome is unknown. Check KOIN Vault before reconnecting or trying again.",
          );
        const until = Math.min(pending.expiresAt, Date.now() + 180000);
        while (!ui.cancelled && Date.now() < until) {
          await status();
          const data = await vaultApi("request-status", {
            ...credentials(),
            requestId: pending.requestId,
          });
          if (
            data.status === "approved" &&
            /^0x1220[0-9a-f]{64}$/i.test(data.txid || "")
          ) {
            const result = { wallet: "koinvault", txId: data.txid };
            approved.set(draft.id, result);
            pending = null;
            return result;
          }
          if (["rejected", "failed"].includes(data.status)) {
            pending = null;
            throw Error(
              data.error || "The transaction was declined in KOIN Vault.",
            );
          }
          await delay(2000);
        }
        throw Error(
          "Approval is still pending in KOIN Vault. Check the wallet; signing again resumes this request.",
        );
      } finally {
        ui.close();
      }
    }
    return {
      connect,
      sign,
      disconnect,
      destroy() {
        clearTimeout(monitor);
      },
    };
  }
  window.KaiBuildWallets = Object.freeze({ create, choose });
})();
