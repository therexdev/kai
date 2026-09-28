# Shared desktop wallet nonce rehearsal

The pinned desktop funding journal and ordinary `ChainService` now share a durable
wallet nonce reservation in the disposable-chain harness. Both are real desktop
modules; signing uses only public fixture keys and RPC stays inside the peerless
Docker network.

For both reward-pool and credit funding, the native approval driver first saves
a stopped signature. An ordinary desktop wallet send from the same owner must
then fail before signing. Funding resumes through its exact reviewed envelope,
recovers a lost acknowledgment across restart and confirms irreversibly.

After funding releases the reservation, the desktop send transfers one fixture
atom to the harness's manual account. Its inclusion response is deliberately
lost. A new deposit and another send must stay blocked across restart. Read-only
reconciliation releases the reservation only from that send's exact irreversible
transaction and receipt. The harness requires one signature and one submission
for each ordinary send and records both conflict directions.

The manifest pins the desktop coordinator and chain-service source hashes as well
as the existing client, approval, funding recovery, observer and custody hashes.
`report.json` includes `walletNonceCoordination` plus the actual send records.
All previous custody, daily-cycle, automatic-claim, resource and refund checks
remain required.

Desktop unit tests also cover KOIN/VHP sends, burns, registration, exported offline
drafts, two journal handles, partial-write recovery, forked/malformed finality,
missing journals and concurrent external import. The focused suite has 81 passes
and two browser skips locally; all three desktop/master integration tests pass.

The adapter remains explicitly isolated and owner-paid. Sponsored bridge/DEX and
remote Koin Vault nonce allocation, production wiring, cross-host ownership,
reviewed repair and backup/recovery controls remain separate work. No production
wallet, live service, key or payment activation is changed. Native fixture RC
measurements are not production costs or a capacity benchmark.

Native execution results will be recorded after the pinned workflow completes.
