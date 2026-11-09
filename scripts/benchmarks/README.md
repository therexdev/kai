# KOIN scheduler reliability benchmark

Run this from a checkout with dependencies installed, using the Node version used by the scheduler:

```bash
node scripts/bench-koin-reliability.js > /tmp/koin-reliability.jsonl
node --test scripts/probe-koin-reliability-bench.js
```

The default matrix offers **100, 500 and 1,000 providers**, with 16 selected and qualified models per admitted provider, against **0 and 24 MiB of retained shadow history**. Each case runs in a fresh child process for a nominal five seconds. A single synchronous call may overrun that deadline; the actual duration is recorded. The parent kills a stuck synthetic child after at least 30 seconds and removes its temporary directory. It never stops a service or accesses a live ledger.

Examples:

```bash
# Longer sustained run; explicitly selected cadence assumptions.
node scripts/bench-koin-reliability.js --providers=100 --history-mib=24 --duration-ms=30000 --poll-ms=5000 --heartbeat-ms=25000

# Larger retained history, or a quiet RPC baseline without a burst/outage.
node scripts/bench-koin-reliability.js --providers=100 --history-mib=96
node scripts/bench-koin-reliability.js --providers=100 --history-mib=0 --burst=0 --fault-ms=0
```

## What runs

- The actual `KoinShadow.observe()` followed by `tick()`, including persistence in a fresh temporary directory. Presence is staggered at 25-second intervals by default; this exercises shadow presence, not the inexpensive `/worker/heartbeat` endpoint.
- The actual `ProviderQualificationSet.next()` for every offered provider, staggered at five-second intervals. These periods are explicit load assumptions, not claims that every released client uses them.
- The actual `PinnedRpcProvider` with an injected local transport. Two availability reads and four background reads are offered each second. A burst of 64 independent background reads is offered at 100 ms. Each logical read includes the provider's real chain-ID check. The injected transport takes 25 ms per wire request by default.
- A one-second synthetic primary timeout window begins halfway through each case. `faultsInjected` reports whether requests actually exercised that window; heavy CPU starvation may cause the entire window to pass without a dispatch. No DNS, sockets, TLS, upstream rate limits, real signatures, inference, or financial transactions are involved.
- If the tested checkout includes `rpc-scheduler.js`, reads use its real class scopes and bounded endpoint statistics. Without that module, first-dispatch wait and outstanding logical calls still report delay; exact queue metrics are explicitly unavailable.

Historical interval and slot objects are distinct, as after parsing a persisted JSON document. The history target describes approximate serialized archive bytes; `serializedBytesInitial` reports the actual complete fixture size. Qualification records contain deployment/identity bindings but omit full signed answer archives, so their memory footprint is a lower bound. All records are synthetic, preverified fixture inputs; enrollment cryptography is outside the measured workload.

## Admission and overload

The `d449184` implementation allows at most **256 run records per model** and **10,000 shadow qualifications**. A 500-provider, 16-model cohort therefore cannot fully enroll even though its requested 8,000 shadow qualifications fit. A 1,000-provider cohort requests 16,000 qualifications and violates both limits.

The harness never loads an impossible qualified cohort: it admits the minimum permitted by both caps and leaves the remaining offered providers unqualified. Their polling and presence traffic remains in the offered workload. Every result reports requested, admitted and unqualified counts. `operations.*.byAdmission` separates their measured cost. A quick rejected presence request is not evidence that a fully qualified 1,000-provider cohort performs well. Before loading a case, the harness exercises both actual admission boundaries with synthetic state and stubbed persistence. If either boundary changes, it fails closed until its assumptions are updated. Persistence is never stubbed in the measured workload.

The main driver stops dispatching when the wall-time budget expires. `notStartedByDeadline`, scheduling lateness and four-second deadline misses expose overload. Remaining local RPCs are cancelled and accounted for; cancellations at the benchmark boundary are not upstream RPC failures. Each case reports both nominal and actual duration, completed/failed/aborted RPC counts, first-dispatch wait, event-loop lag/utilization and memory.

## Baseline and comparisons

`koin-reliability-d449184-node22.jsonl` is the recorded baseline from the unchanged `d449184` production code. The environment row identifies Node, CPU, container resource limits, temporary filesystem and source commit. The measurements come from a development container, not the production VPS.

Use identical options and the same machine/Node/filesystem when comparing implementations. Compare complete event counts and deadline misses alongside latency percentiles: an overloaded case can show a low percentile merely because expensive events were never dispatched. Setup/reload is excluded from operation latency and reported separately. `rssObservedMaxBytes` samples the active workload; `processMaxRssKiBIncludingSetup` includes fixture construction and parsing.

This is a repeatable capacity investigation, **not a supported-provider-count guarantee**. HTTP authentication, full signed journals, real network faults and a sustained production workload require separate validation.

## Recorded runtime version 3 comparison

`koin-reliability-v3-node22.jsonl` records the same six cases at local integration snapshot `8d7af874020ad87006b385a5ab9302cfd3c3453b`; its production code is the release candidate's production code. Later changes cover installer checks, test fixtures and documentation. The run used Node 22.23.4 in the same shared container (8 CPU quota, 8 GiB memory quota). Concurrent serial regression testing may affect absolute timings.

| Offered/admitted providers | Retained archive | Poll p95 before → after | Maximum event-loop delay before → after | Events not started before deadline, before → after |
| --- | --- | --- | --- | --- |
| 100 / 100 | 0 MiB | 379 → 24 ms | 729 → 41 ms | 126 → 0 |
| 100 / 100 | 24 MiB | 413 → 20 ms | 823 → 195 ms | 129 → 0 |

Both 100-provider cases completed all 10 offered availability RPC reads despite the 64-read background burst and injected primary timeouts. Availability RPC p95 was approximately 274 ms and 392 ms respectively. Background calls still pending at the five-second boundary were cancelled and counted; all active connections and queued requests drained. A backlog intentionally offered faster than the endpoint's start limit is not silently treated as completed work.

The larger cases remain overloaded and admission-limited: 500 offered providers admitted 256 and left 421/466 events unstarted (0/24 MiB); 1,000 offered providers admitted 256 and left 1,031/1,058 events unstarted. The 100-provider 24 MiB presence p95 remained about 176 ms because complete JSON persistence is still synchronous. These results support the targeted improvements and identify remaining storage/polling limits. They do not establish 500- or 1,000-provider support.
