# Separate prepaid deployment

This replaces the customer business model. It is not an in-place upgrade of refundable custody. The new service is `kai-koin-prepaid.service`, with separate `/etc`, `/var/lib`, `/opt` directories and loopback port 3109. The existing pilot remains available to reconcile old funds and signed transactions. No updater exception or retry-fence reset is needed to install the separate service.

## Reviewable preparation

1. Require passing desktop Test checks, contract tests, backend regressions, and the isolated native-chain prepaid test at the exact source revisions. The native test includes purchase, finality, credit import, normal desktop chat, signed provider response, lost settlement response, restart, and conservation of original custody.
2. Copy `settings.prepaid.example.json` into a private bootstrap location and fill the owner, intended HTTPS scheduler, pricing, and exact KOIN/Mana funding ceilings. Do not infer permission to fund fresh roles from permission to publish code.
3. Run `prepare.js` with a **new** absolute private bootstrap directory and the reviewed desktop contract build directory. `mode: mainnet-prepaid-plan` selects `prepaid.wasm`, generates new contract/role identities, verifies mainnet identity through two RPCs, and writes a reviewable budget. It signs and broadcasts nothing.
4. Review that exact plan. `setup.js configure --dir ... --approve <plan hash>` produces runtime/desktop configuration and invitations. Securely back up the generated keys; offline admin and contract keys never go in the service directory.
5. After the precise role-funding budget and deployment transactions have been approved, use the existing `check-funding`, `tokenizer`, and `deploy` commands. Deployment is journaled and uses the exact new code hashes. The on-chain prepaid product marker must verify before a desktop manifest is exported.
6. Run `install-prepaid.sh` from the reviewed, clean backend commit. Configure the new HTTPS hostname to proxy to `127.0.0.1:3109`; verify `/health` shows `product: prepaid-v1`. This installer refuses to replace an existing prepaid service and never reconfigures the legacy service.
7. Connect the new manifest/invitation in Test. Existing installed pilot users use **Connect prepaid credits** once. This keeps the old account files and refuses to reinterpret an unresolved wallet nonce as a fresh purchase. It does not move the old KOIN balance.

## Existing funds and final acceptance

Reconcile old available and reserved buyer KOIN and any completed paid jobs from their original records. Preserve the old contract's refund rights. A migration must identify the original owner, amount, source transaction/contract, destination account, and a unique conversion receipt. Only verified funding of the destination can become purchased credits. Do not credit the old reserve from a screenshot, erase the legacy ledger, reuse the earlier reward-retry approval, or deploy the new code at the old contract address.

The current owner's 0.1 KOIN is an outstanding migration item, not an already converted purchase. The new service can be tested independently while that legacy obligation remains visible in the operator record. A sponsor-funded replacement would need its own explicit funding authorization and must not also convert the same legacy amount later.

Acceptance is through the actual two computers: provider On → ONLINE; buyer Buy credits → one payment approval → confirmed credits → Chat → answer → one credit debit. Repeat with Stop, provider Off, disconnects, restarts, low balance, and a delayed payout. No reservation, release, settlement, or backend test-panel action belongs in this acceptance flow. Do not promote Alpha/public launch until this passes and the old customer balance is resolved.
