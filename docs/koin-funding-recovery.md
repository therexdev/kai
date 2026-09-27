# Desktop funding recovery on the disposable chain

The isolated harness now loads the actual desktop `FundingRecovery` journal,
native approval coordinator, `FundingObserver` and `KoinChain` from the pinned desktop
checkout. Its manifest records the client, approval, recovery and observer source hashes,
in addition to the compiled custody hashes and upstream/genesis pins.

Both initial deposits (reward pool and customer credits) use the desktop's exact
approval/deposit bundle and durable journal. Fixture native dialogs approve the
exact transaction. The driver deliberately stops before the signing callback
delivers its signature: the late envelope must be saved without any broadcast.
After journal restart, read-only checks cannot submit; a second native review
must resume exactly those saved bytes with no replacement signature.

The harness then deliberately loses the
response after each actual inclusion, closes and reopens the journal, then
recovers the same transaction through irreversible native receipts and backed
custody observations. Each must finish with one signature, one submission, zero
remaining allowance, exactly two reviews and no second deposit when the request ID is reused.

A later signed deposit is durably staged before the contract is paused. The
desktop submitter rejects it; the isolated producer then includes those held
bytes to exercise contract rollback. The restarted journal must identify the
exact irreversible revert, and customer/custody balances must stay unchanged.
This models a signed transaction included externally after local preparation.

The daily reward cycle, full review hold, automatic fixed-recipient claims,
lost-response recovery, Mana checks, duplicate protection and paused refund
checks continue to run. `report.json` retains the funding recovery statuses,
signing/submission counts, lifecycle status and full transaction receipts.

The desktop's [funding recovery documentation](https://github.com/therexdev/kaiapp/blob/e5d933c9336c312333ded100b3c744443490c6e6/docs/koin-network/FUNDING_RECOVERY.md)
describes the interface and remaining limits. Production wallet approval,
coordination with other wallet nonces, reviewed repair, durable backup/failover
and activation remain separate work. No actual user wallet or live payment flow
imports this isolated driver. Fixture resource measurements are not production
Mana costs or a capacity benchmark.

## Verified result

The [2026-09-27 approval/Stop/resume run](https://github.com/therexdev/kai/actions/runs/36330663437)
passed all **23 checks** at master
`20c88908ea4d0871dd2d0181c7d3082c01130e9c` and desktop
`e5d933c9336c312333ded100b3c744443490c6e6`. Both funding deposits required
exactly two native fixture reviews, one signature, one submission and one
attempt. Stop saved a late signature without broadcasting; restart retained the
hold. A fresh review resumed the original signed envelope. Both journals then
recovered lost inclusion responses after another restart and reached `funded`
only after irreversible confirmation. The saved paused deposit reached `reverted`
without a replacement transaction. The daily cycle and both automatic provider
payouts also completed, with no provider signatures.

[Saved results](koin-funding-recovery-results.json) preserve the exact funding,
lifecycle and claim transactions/receipts, review/Stop/restart outcomes, source
hashes, chain/bytecode pins and verified artifact digest. Claim resource use was
14,528,476 and 14,153,718 RC; the fixture limitations above apply.

The initial native run trapped when the observer sent an irrelevant customer
account parameter to the aggregate reward-pool balance read. Native diagnostics
confirmed empty aggregate reward custody and per-account credit custody reads
work. The observer now uses those separate request shapes; errors are never
interpreted as zero balances. The final run checks both empty pools before funding.
The SDK MockVM did not expose this request-shape difference, reinforcing the need
for the native-node gate and independent contract review before activation.

Desktop verification passed **32 focused funding/chain tests** and **three
desktop/master integration checks**. Both master CI runs passed. Automatic review
blocked completion of the broad local desktop test command because it includes
public-testnet checks outside this isolated task; it is not counted as a pass.
Test 155 was published and its Windows/Linux installer assets verified before
this increment. The new desktop commit starts Test 156; its installer workflow
was still running when this result was saved. Publication must be checked
separately from the successful isolated-chain rehearsal.
