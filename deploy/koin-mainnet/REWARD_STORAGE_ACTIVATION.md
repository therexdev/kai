# Offline reward storage activation

`shadow-storage-activation.js` is the reusable offline storage boundary. It does
not deploy code, stop/start services, load signing or operator keys, change a
payment journal, or select a fallback after activation. The reviewed installer
owns release pins, service-unit checks, draining, exclusive updater locks, file
ownership and forward-only restart/recovery.

## Public API

The library at `lib/koin-network/shadow-storage-activation.js` exports:

- `storageIdentity(config)`: the scheduler URL, policy hash and canonical public
  reward deployment target, including the USD reward basis when configured.
- `storagePaths(stateDir)`: physical paths for the legacy JSON, SQLite candidate,
  preserved backup, preparation intent, active marker and maintenance lock.
- `inspectStorage(stateDir, { identity })`: a bounded filesystem-only startup
  selector. It returns `{mode:"legacy",paths}` or
  `{mode:"sqlite-shadow",paths,directory,markerFile,descriptor}`. It never opens a
  database or parses a large legacy ledger. Incomplete activation, maintenance,
  unsupported schema, linked paths and marker/sentinel disagreement fail closed.
- `prepareStorage({stateDir,identity,assertQuiescent})`: migrate or resume a
  verified candidate and reconcile saved manifest seals without replacing the
  source. Returns the descriptor, manifest count, sealed epochs and backup path.
- `activateStorage({stateDir,identity,assertQuiescent})`: reverify that exact
  preparation and replace the legacy path with the downgrade sentinel, then
  create the active marker. Repeating activation after completion verifies the
  active binding without comparing the now-live database against its old source.

Offline calls are synchronous and require a synchronous `assertQuiescent`
callback. The caller must hold the shared installer/maintenance lock set and
repeatedly verify the same cleanly exited service and deployment. The library's
state lock rejects a live local owner. Under that outer exclusion it can resume
a lock whose recorded owner has provably exited on this same host. A malformed,
foreign-host or uncertain owner requires review; it is never assumed stale.

## Durable phases and verification

1. Preserve the exact legacy JSON as `legacy-koin-shadow.json` with mode `0400`.
   Verify migration evidence, both allocation bases and exact imported records.
2. Verify every saved manifest's signature, public deployment, filename epoch,
   evidence hash, positive allocations and root. Reconcile those seals before
   any replay or interval closure. Recheck all semantic indexes: progress,
   eligibility, presence timestamps/retention, allocation totals and row counts.
   Both presence receipt tables must still be empty.
3. Write and fsync the preparation intent, binding physical paths, descriptor,
   source hash, raw manifest hashes and expected seals. The original source
   remains byte-identical. Repeated preparation rejects source/manifest changes.
4. Reverify preparation under quiescence. Atomically replace the exact old JSON
   path with an unsupported-schema sentinel and fsync its directory. Never
   delete the JSON path: older constructors interpret absence as a blank ledger.
5. Atomically create the exact schema-2 SQLite descriptor marker and fsync its
   directory. The runtime requires strict marker/sentinel agreement. An older
   JSON runtime rejects the sentinel, and the provider source's new exclusive
   identity supplies its separate downgrade boundary.

A crash after the sentinel but before the marker can resume only the same
verified preparation. A partial/unverified candidate or a JournalSet data/anchor
generation mismatch fails closed for reviewed recovery. No recovery path resets
an anchor, discards receipts, restores a payment journal or copies the original
JSON back into service. After activation, code rollback must stay above the
schema-2 worker/source-identity boundary. A JSON rollback is not supported.

The installer must ensure that its service user owns the newly created
candidate and its new recovery anchor before starting the service. Ownership
changes must target only those verified new storage files, preserving modes;
never recursively chown the entire live state directory. Preparation, sentinel
and marker files preserve the legacy source's uid/gid. The immutable original
backup remains readable by the service user after the installer's ownership
step. Its contents and read-only mode remain unchanged.
The full installer verifies the original JSON owner against the service
account's uid/gid before draining; unexpected ownership requires review.

## Standalone maintenance command

The production entry point is `node deploy/koin-mainnet/update-reward-storage.js`
from the clean, reviewed checkout, using system Node 22 as root. Its exact file
allowlist and probes must match the final reviewed release. It validates and
stages code and dependencies, verifies pinned RPC reads, then permits up to 240
seconds for application-owned graceful shutdown. It writes a durable deployment
plan and verifies that same cleanly exited process throughout offline storage
work. It only starts the new runtime after the downgrade sentinel and marker
are durable. Failed readiness retains the new code and current state; it never
restarts the old JSON writer. An exact retry checks the saved plan, source blobs,
configuration metadata and clean process identity before continuing.

A killed installer can leave the shared `/root` updater lock directories behind.
Those locks do not have provable owner metadata and are **not** removed
automatically. Their cleanup requires review of the stopped installer/process
and deployment plan before exact retry. Automatic recovery of the state-local
maintenance lock does not bypass that outer lock requirement. Likewise a drain
that did not exit cleanly requires review; there is no forced signal fallback.
A crash after the staged release is renamed but before its deployment plan is
durable leaves an orphan target directory. That directory is preserved and the
installer refuses to infer its provenance; review is required before retry.

`deploy/koin-mainnet/activate-reward-storage.js` accepts `prepare` or `activate`
and `--expected-release /opt/kai-koin-prepaid/releases/<reviewed-commit>`. It
requires an already cleanly stopped service, exact release/unit settings and
unchanged public runtime configuration. It takes all existing updater locks,
checks the provider-source writer leases, and does not stop/start or install
anything. It applies service ownership only to the verified candidate and its
new anchor, preserving modes, after its final offline database open. The full
installer also repeats that step after activation so newly created WAL/SHM files
are service-accessible. Prefer the reviewed full installer for production so release and
ownership checks remain one maintenance operation.

`scripts/probe-koin-shadow-activation.js` exercises signed-manifest verification,
semantic-index mutation rejection, real process death after sentinel creation,
resume, live-writer exclusion, strict startup agreement, unchanged payment-state
bytes, configuration binding and updater-lock contention. These tests establish
the offline boundary; they do not establish production capacity or uptime.
