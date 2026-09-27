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
