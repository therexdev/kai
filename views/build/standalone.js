"use strict";
// Included only in exported standalone bundles, where every file is public.
(() => {
  const { utils, Provider, Contract, Transaction, Serializer } = window;
  const $ = (id) => document.getElementById(id);
  let project, provider, contract;
  const drafts = new Map();
  const status = (s) => {
    $("host-status").textContent = s;
    $("host-status").hidden = false;
  };
  const addr = (a) => utils.encodeBase64url(utils.decodeBase58(a));
  const printable = (r) => {
    if (r.config) {
      r.config.owner = r.config.owner
        ? utils.encodeBase58(utils.decodeBase64url(r.config.owner))
        : null;
      r.config.pending_owner = r.config.pending_owner
        ? utils.encodeBase58(utils.decodeBase64url(r.config.pending_owner))
        : null;
    }
    for (const item of [...(r.records || []), ...(r.record ? [r.record] : [])])
      item.author = item.author
        ? utils.encodeBase58(utils.decodeBase64url(item.author))
        : null;
    return r;
  };
  async function metadata(id) {
    if (!project.metadataContract)
      return provider.invokeGetContractMetadata(id);
    const serializer = new Serializer(project.abi.koilib_types),
      args = utils.encodeBase64url(
        await serializer.serialize(
          { contract_id: addr(id) },
          "app.MetadataArgs",
        ),
      ),
      r = await provider.call("chain.read_contract", {
        contract_id: project.metadataContract,
        entry_point: 0x784faa08,
        args,
      });
    const d = r?.result
      ? await serializer.deserialize(r.result, "app.MetadataResult")
      : {};
    if (d.value?.hash)
      d.value.hash =
        "0x" +
        Array.from(utils.decodeBase64url(d.value.hash), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
    return d;
  }
  async function guard() {
    if (!project.guard_id)
      throw Error("Configure the immutable guard before using a wallet.");
    const [app, g] = await Promise.all([
      metadata(project.contract_id),
      metadata(project.guard_id),
    ]);
    if (
      app?.value?.hash?.toLowerCase() !== project.appHash ||
      app.value.system ||
      !app.value.authorizes_call_contract ||
      !app.value.authorizes_transaction_application ||
      !app.value.authorizes_upload_contract ||
      g?.value?.hash?.toLowerCase() !== project.guardHash ||
      g.value.system ||
      !g.value.authorizes_upload_contract
    )
      throw Error(
        "The contract or guard was changed. Wallet actions are disabled.",
      );
    const target = utils.decodeBase58(project.contract_id),
      encoded = new Uint8Array(2 + target.length);
    encoded.set([10, target.length]);
    encoded.set(target, 2);
    return {
      call_contract: {
        contract_id: project.guard_id,
        entry_point: 1,
        args: utils.encodeBase64url(encoded),
      },
    };
  }
  async function chain() {
    if ((await provider.getChainId()) !== project.chainId)
      throw Error("The RPC network does not match this app.");
  }
  KaiBuildBridge.create($("app-frame"), {
    mode: "live",
    getProject: () => project,
    onError: status,
    api: async (action, args) => {
      if (!project.contract_id)
        throw Error(
          "This export does not have a deployed contract. Update config.json after deployment.",
        );
      await chain();
      if (action === "read") {
        const { result } = await contract.functions[args.method](
          args.args || {},
        );
        return printable(result || {});
      }
      if (action === "prepare") {
        const check = await guard();
        const operation = (
          await contract.functions[args.method](
            { ...args.args, account: addr(args.address) },
            { onlyOperation: true },
          )
        ).operation;
        const transaction = await Transaction.prepareTransaction(
            {
              header: {
                payer: args.address,
                chain_id: project.chainId,
                rc_limit: "200000000",
              },
              operations: [check, operation],
            },
            provider,
            args.address,
          ),
          id = crypto.randomUUID(),
          draft = {
            id,
            transaction,
            signerAddress: args.address,
            contractId: project.contract_id,
            method: args.method,
            args: args.args,
            abi: project.abi,
            guardId: project.guard_id,
            guardAbi: project.guardAbi,
            network: project.network,
          };
        drafts.set(id, draft);
        return { draft };
      }
      const d = drafts.get(args.draftId);
      if (!d) throw Error("Wallet request expired.");
      const tx = args.transaction;
      if (
        JSON.stringify(tx.header) !== JSON.stringify(d.transaction.header) ||
        JSON.stringify(tx.operations) !==
          JSON.stringify(d.transaction.operations) ||
        tx.id !== d.transaction.id
      )
        throw Error(
          "The wallet changed this request. Turn off Use free mana and retry.",
        );
      await provider.sendTransaction(tx);
      drafts.delete(args.draftId);
      return { txId: tx.id };
    },
  });
  fetch("config.json")
    .then((r) => r.json())
    .then((config) => {
      project = config;
      provider = new Provider([project.rpc]);
      provider.onError = () => true;
      if (project.contract_id)
        contract = new Contract({
          id: project.contract_id,
          abi: project.abi,
          provider,
        });
      $("app-title").textContent = project.title;
      $("app-network").textContent = project.network || "Not deployed";
      $("app-contract").textContent = project.contract_id || "Draft export";
      document.title = project.title;
      $("app-frame").src = "app.html";
    })
    .catch((e) => status(e.message));
})();
