# Automatic KOIN claim rehearsal

Providers receive automatic sponsored claims by default in the approved KOIN
plan. They do not sign individual reward payments. The contract's Merkle leaf
fixes the provider address and both amounts; the sponsor signs only its claim
transaction. A manual claim remains a recovery option. The daily root must be
finalized after its 24-hour review hold, and the keeper must observe that state
on the irreversible chain before signing.

This branch exercises that path with deterministic fixture keys and an
in-memory RPC, and includes a separate disposable-chain CI harness using the
compiled custody contracts and native token. It does **not** enable payments on the live master. Nothing in
`server.js`, scheduler routes, legacy payouts, desktop signing or the live
pricing configuration imports the new driver. There is no new HTTP endpoint,
production key loader, RPC write transport, timer or deployment switch.

## Components

| Component | Responsibility |
| --- | --- |
| `reward-manifest.js` | Verify a canonical, verifier-signed rehearsal allocation list; regenerate its Merkle-sum root and proofs |
| `reward-observer.js` | Read pinned native token/contracts, epoch, claimed flag, liabilities and finalized paid-work totals; require stable reads and irreversible snapshots |
| `reward-claims.js` | Persist manifests, entitlements, signing fences, exact signed envelopes, attempts and daily Mana reservations in one SQLite database |
| `rehearsal-submitter.js` | Run bounded claim/settlement recovery, invoke a restricted injected claim signer, and hand only durably checkpointed envelopes to the injected transport |

The Merkle implementation and generated rewards ABI are copied from the desktop
contract prototype and pinned in `lib/koin-network/SOURCE.json`.
Claim encoding omits zero-valued categories, epoch zero and false proof flags,
matching the compiled contract's canonical protobuf requirements.
The observer also accepts omitted empty protobuf results for unclaimed/zero-spend
reads, while rejecting malformed responses and missing required deployment state.

## Rehearsal interface

`RewardClaims(directory, { target, policy, observer, clock })` requires an actual
`RewardObserver`. The target contains exactly `chainId`, `rewards`,
`rewardsHash`, `credits`, `creditsHash`, `token`, `tokenHash`, `verifier`,
`version`, and `workCapBps`. Chain ID and bytecode hashes are canonical pins;
the native token address is also checked through the RPC's `koin` mapping.
Policy contains `verifier`, `payer`, `maxRcPerTransaction`, `maxRcPerDay`,
`maxAttempts`, and `minRetryMs`. For claims, both policy roles must be the same
dedicated sponsor, distinct from contract custody and the root verifier.
Combining settlement and claim recovery also requires different sponsor
accounts, so their separately persisted budgets cannot overcommit one account.

`importManifest({ manifest, signature })` admits at most 1,024 nonzero,
address-sorted allocations and returns their durable claim IDs. A manifest has
schema `1`, mode `reward-rehearsal`, the exact target, decimal-string `epoch`,
`evidenceHash`, `root`, and `allocations`. Each allocation contains only
`address`, `availability`, and `work`. The signature authenticates
`signingHash(manifest)` under `KAI-KOIN-REWARD-MANIFEST-REHEARSAL-V1` and the
pinned verifier. Duplicate imports are idempotent; an admitted day cannot be
replaced. Raw prompts and outputs are not accepted in this schema. The existing
shadow-manifest HTTP route still returns its original hashed simulation report;
it does not automatically become a signed reward manifest.

`RehearsalSubmitter` requires `mode: "isolated-rehearsal"`. It accepts the claim
ledger, a trusted `prepareClaim(decision, { signal })` callback and a trusted
`submit(transaction, { signal })` callback. The preparation callback must only
sign and return the requested claim; it must never broadcast. Returned bytes
are validated against the exact chain, sponsor, single claim operation,
signature, nonce and RC limit before staging. The transport is called only
after the complete envelope and attempt/Mana checkpoint commit with SQLite
WAL and FULL synchronization. Both callbacks have bounded response time;
cancellation or a lost response never proves that an action did not happen.

An isolated driver calls `tick({ claimLimit, settlementIds })`; limits are
bounded to 16. No provider interaction is needed as admitted claims advance.
Only one unresolved claim sponsor nonce is allowed. Settlement IDs refer to
the existing funded ledger's already-staged signed transactions; settlement
recovery also needs the trusted `observeSettlement(id)` callback to obtain a
fresh reconciliation observation. This service does not generate or sign
customer settlement transactions.

## Recovery rules

- Before requesting a signature, persist `signing`. A crash or lost signing
  response blocks further signing until the exact envelope is recovered and
  staged. It never silently creates a replacement nonce.
- Save the complete signed envelope before invoking the transport. Retries
  reuse identical bytes, validate the proof and contract state again, honor a
  cooldown/attempt cap, and reserve the full RC ceiling once per transaction
  per UTC day. A retry on a later day reserves that day's capacity too.
- Pending/reversible inclusion and transport receipts never mean paid. Require
  the exact claim transaction's irreversible successful receipt and an
  irreversible `claimed` flag observed at or after that transaction's block.
  Even a revert that leaves state unchanged needs a sufficiently recent
  snapshot to establish that its nonce was consumed.
- A manual claim before signing becomes `paid_elsewhere`, with no sponsor
  transaction. If a signed transaction is already outstanding, retain its
  nonce fence for review until its own finality is known. A finalized revert
  plus a proven external claim can resolve that fence.
- Reverts without a paid entitlement, retry exhaustion, unavailable signing
  envelopes, mismatched proofs, changed code/policy, damaged journal records
  and backwards clocks cannot authorize replacements or release uncertainty.
  Later proven successful finality can still resolve an exhausted attempt.

The database, including its WAL, must be shared by every process for this
deployment. Concurrent handles elect one signer and checkpoint attempts
atomically. Cross-host failover fencing, rollback-resistant backups, key
rotation and reviewed repair of failed/unused nonces remain future work.
This conservative implementation may stop the entire sponsor queue behind one
unresolved claim or a day that needs review. It prioritizes preserving the
entitlement over throughput. Old-policy claims also require explicit reviewed
configuration/recovery; policy changes do not silently rewrite local pins.

## Verification and remaining activation work

The [2026-09-26 isolated-chain run](https://github.com/therexdev/kai/actions/runs/36260927761)
passed all 12 checks using desktop contract commit
`3537631fae4790efcbb971f6ba4f55ccfd670be6` and master commit
`f404b40a1b376318bd5e01515065e9fb9e8a114d`. Two providers received
5 KOIN and 0.5 KOIN in fixture native tokens, with two sponsor signatures,
two submissions and no provider signatures. Restart after a deliberately lost
inclusion response recovered the exact transaction through irreversible
finality without another signature or payment. The run also checked native
deposits, the 60/25/15 settlement split, the full review hold, empty-Mana and
insufficient-RC rejection, duplicate rejection, and refunds while paused.

The successful claim receipts used 12,005,376 and 11,855,739 resource credits,
each below its signed ceiling of 10,000,000,000. Sponsor Mana fell while the
sponsor's native-token balance stayed unchanged. These are isolated fixture
measurements, **not production fees, capacity calibration or recommended
limits**: the fixture uses a two-leaf proof tree and generously funded test
accounts. [The saved results](koin-isolated-results.json) retain the exact
receipts, measured resources, chain/bytecode pins and workflow/artifact provenance.

Testing exposed and corrected differences hidden by mocks: canonical omitted
zero protobuf fields, omitted empty RPC results, SDK traps on empty native-token
or void contract replies, and treasury caller authorization during day sealing.
Native deposits also require an exact allowance to the custody contract;
the harness submits that approval and the custody deposit in one transaction
and verifies no allowance remains. The desktop client now prepares and validates
this entire two-operation bundle, with an in-process native review rehearsal.
The isolated workflow exercises that same client and paused-deposit approval
rollback. Production wallet confirmation, durable funding recovery and finality
reconciliation remain disconnected; no purchase control has been enabled.

The [subsequent desktop-funding run](https://github.com/therexdev/kai/actions/runs/36262517451)
passed **14 checks** at master `3c1027de9ceda033cb717697538a3aaffa35981d`
and desktop `72510618f407374c2c96ed53db01e32fb5f96744`. It uses the actual
desktop client for both native funding bundles and confirms approval rollback
when a deposit is paused after preparation. Customer/custody balances and
liabilities stay unchanged on rejection. Automatic sponsor-only claims and
restart recovery still pass. [The funding results](koin-funding-results.json)
save the full funding/claim transactions and receipts, source hashes and
artifact provenance. The same isolated-fixture limitations apply.

Run `node --test scripts/probe-koin-automatic-claims.js` on Node 22 or newer.
The probe uses fixture-only keys, ABI encoding and local SQLite; it covers
automatic fixed-recipient claims, review/finality/custody gates, signatures,
manual races, exact-envelope retry, resource budgets, concurrent handles,
timeouts, process death, journal damage, forks and settlement integration.

See [`scripts/koin-isolated/README.md`](../scripts/koin-isolated/README.md) for
the fresh peerless chain workflow and its native-transfer/receipt report. Only
a completed passing report establishes those isolated transfer checks; neither
the in-memory fixtures nor an isolated resource measurement establishes
production Mana costs. A manifest signature authenticates the allocation issuer; it does not
prove telemetry accuracy or that its evidence hash came from reconciled work.
Production ingestion must generate manifests only from approved availability
evidence and irreversibly reconciled charges. Epoch opening/root submission/
finalization, production signing/transport/monitoring, broader proof-size/load
testing and resource calibration, contract review and the owner's concrete
deployment and funding approval remain required. The app's live network and
prices are intact.
