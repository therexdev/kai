# Desktop funding recovery on the disposable chain

The isolated harness now loads the actual desktop `FundingRecovery` journal,
`FundingRecoveryRunner`, `FundingObserver` and `KoinChain` from the pinned desktop
checkout. Its manifest records the client, recovery and observer source hashes,
in addition to the compiled custody hashes and upstream/genesis pins.

Both initial deposits (reward pool and customer credits) use the desktop's exact
approval/deposit bundle and durable journal. The harness deliberately loses the
response after each actual inclusion, closes and reopens the journal, then
recovers the same transaction through irreversible native receipts and backed
custody observations. Each must finish with one signature, one submission, zero
remaining allowance and no second deposit when the request ID is reused.

A later signed deposit is durably staged before the contract is paused. The
desktop submitter rejects it; the isolated producer then includes those held
bytes to exercise contract rollback. The restarted journal must identify the
exact irreversible revert, and customer/custody balances must stay unchanged.
This models a signed transaction included externally after local preparation.

The daily reward cycle, full review hold, automatic fixed-recipient claims,
lost-response recovery, Mana checks, duplicate protection and paused refund
checks continue to run. `report.json` retains the funding recovery statuses,
signing/submission counts, lifecycle status and full transaction receipts.

The desktop's [funding recovery documentation](https://github.com/therexdev/kaiapp/blob/90ae03efa7726efc0b53615e3108f28ff7c30fbe/docs/koin-network/FUNDING_RECOVERY.md)
describes the interface and remaining limits. Production wallet approval,
coordination with other wallet nonces, reviewed repair, durable backup/failover
and activation remain separate work. No actual user wallet or live payment flow
imports this isolated driver. Fixture resource measurements are not production
Mana costs or a capacity benchmark.

## Verified result

The [2026-09-27 isolated run](https://github.com/therexdev/kai/actions/runs/36327541297)
passed all **21 checks** at master
`eed7d3b1782924347b83547b8b0721afa4265fb3` and desktop
`90ae03efa7726efc0b53615e3108f28ff7c30fbe`. Both funding journals recovered
lost inclusion responses after restart, with one signature, one submission and
one attempt each. Both reached `funded` only after irreversible confirmation.
The saved paused deposit reached `reverted` without a replacement transaction.
The daily cycle and both automatic provider payouts also completed.

[Saved results](koin-funding-recovery-results.json) preserve the exact funding,
lifecycle and claim transactions/receipts, journal outcomes, source hashes,
chain/bytecode pins and artifact digest. Claim resource use was 14,528,476 and
14,153,718 RC; the fixture limitations above apply.

The initial native run trapped when the observer sent an irrelevant customer
account parameter to the aggregate reward-pool balance read. Native diagnostics
confirmed empty aggregate reward custody and per-account credit custody reads
work. The observer now uses those separate request shapes; errors are never
interpreted as zero balances. The final run checks both empty pools before funding.
The SDK MockVM did not expose this request-shape difference, reinforcing the need
for the native-node gate and independent contract review before activation.

Desktop verification passed 20 focused funding/chain tests plus five compiled
WASM checks, including empty custody. Three desktop/master integration checks
also passed. The full local desktop run had 1,019 passes and five missing-Chromium
failures; Test 154's CI verification and macOS suite passed with Chromium installed.
Test 155 contains the subsequent aggregate-read correction; publication must be
checked separately from its successful isolated-chain rehearsal.
