# Model readiness and automatic free access

The previous catalog admission reused Smart's strict twelve-answer quality
exam for every model. That could reject a working runtime, including a model
whose supported conversation template cannot represent one of those questions
as intended. The reviewed replacement distinguishes runtime readiness from
model quality. It requires new signed checks against the selected model's
pinned weights and tokenizer. It does not present an installed model, an old
failed test or a runtime check as a quality benchmark result.

This update includes the earlier recovery scheduling fix. Qualified selected
capacity can serve between model checks, while failed checks retain their
bounded retry behavior. The update changes the reviewed admission policies and
the service code; prices, free-credit rules, reward economics, wallet keys,
accounts and financial records remain in place.

The same release adds automatic free access for a fresh installation. In an
online route, the app proves possession of a separate non-spending installation
key. It does not need a KOIN wallet, email signup, wallet unlock or operating
system keyring for that free connection. Local-only mode remains offline.

The server returns the existing sponsored allowance, subject to its actual
funding, eligible models and current account, origin and network budgets.
No displayed balance is invented by the app. The stable installation identity
reuses the same daily grant after restart or reconnection. New installations
are not a verified human identity; the existing shared origin and network
ceilings continue to bound total sponsorship.

This key can authorize individual free chats only. Its sessions cannot buy or
spend purchased credits, create advanced spending runs, access other accounts,
link wallets or authorize earning. It is never merged with or substituted for
an existing paid account. The installation key stays in a restricted local
file; bearer sessions stay in memory. Private automatic chat-recovery content
uses the existing memory-only free-chat path. Status does not enumerate guest
chat history; a request already known to the same installation may recover its
own saved reply without another charge.

## One update on the existing Vultr service

Run the complete command block from the release handoff in the
`root@koinos-scheduler` shell. That block sets both `KAI_READINESS_RELEASE` to
the immutable backend commit and `KAI_READINESS_APPROVE` to the reviewed policy
hash. Use those exact values; do not substitute a branch name or generate an
approval from an unreviewed file.

```bash
(
set -euo pipefail
umask 077
: "${KAI_READINESS_RELEASE:?Set the exact backend commit from the release instructions}"
: "${KAI_READINESS_APPROVE:?Set the exact policy review hash from the release instructions}"
[[ "$KAI_READINESS_RELEASE" =~ ^[0-9a-f]{40}$ ]]
[[ "$KAI_READINESS_APPROVE" =~ ^[0-9a-f]{64}$ ]]
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_READINESS_STAGE=$(mktemp -d /root/kai-model-readiness.XXXXXXXX)
git -C "$KAI_READINESS_STAGE" init --quiet
git -C "$KAI_READINESS_STAGE" fetch --quiet --no-tags --depth=16 https://github.com/therexdev/kai.git "$KAI_READINESS_RELEASE" 80eb56c94600b800c0b69910acde0937f0da052d
git -C "$KAI_READINESS_STAGE" checkout --quiet --detach "$KAI_READINESS_RELEASE"
cd "$KAI_READINESS_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_READINESS_RELEASE"
git merge-base --is-ancestor 80eb56c94600b800c0b69910acde0937f0da052d HEAD
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high
node deploy/koin-mainnet/update-model-readiness.js --approve "$KAI_READINESS_APPROVE"
)
```

The updater accepts either installed backend
`b85363e6c6188fb215e9a98fc8fdaed5869ede75` or
`80eb56c94600b800c0b69910acde0937f0da052d`, and an exact repeat of the new
release. The existing runtime must contain the complete known catalog
qualification policy, or the exact reviewed replacement on an idempotent
repeat. An edited or incomplete policy is preserved and rejected.

The updater requires the existing isolated `kai-koin-prepaid.service`, its
expected user, storage paths and service settings, a clean reviewed checkout,
and the explicit policy review hash. It excludes concurrent earlier updaters,
runs isolated regressions, prepares dependencies and validates the new code
before stopping the service. It does not touch the separate production website
or the earlier mainnet pilot service.

## Activation and recovery

While the service is stopped, each replacement of the runtime and systemd
unit is atomic and durably flushed. Ownership and file permissions are
retained. Runtime changes outside `qualificationPolicies` are rejected even
if a migration attempts them.

Success requires all of the following:

- The service is active at the exact new release directory.
- Loopback and public HTTPS report a fresh serving heartbeat,
  `purchaseQuotesUnlimited: true`, `providerQualificationRecovery: 1`, and
  `modelReadinessAdmission: 1`.
- Existing buyer and provider capabilities still match the deployment.
- Automatic free-device capabilities are present on loopback and public HTTPS,
  require Ed25519 proof, have the reviewed expiries and free-only scope, and
  match the same deployment and service origin.
- The running service reports the exact reviewed per-model policy hashes,
  required check counts and deadlines. This check uses the existing operator
  credential only on loopback; it is never printed or sent to public HTTPS.

The new policies use separate versioned qualification journals. Previous
quality attempts and signed evidence remain available and are not relabeled
as successful readiness. Each device needs fresh signed readiness evidence
before newly admitted models can receive paid work. Installation alone does
not create eligibility or a reward.

If activation fails, recovery restores the previous code and exact runtime
bytes while retaining all payment, reward, account, device and qualification
records written after startup. Persistence failures before or after rename
are handled from the files actually present. Concurrent operator edits and
unclean service shutdowns are preserved and reported rather than overwritten.
A verified rollback permits an exact retry.

Private backups are under `/root/kai-model-readiness-code-*`. They contain
the previous unit, previous and reviewed runtime files, policy review, and
source archive. They do not copy private key files or live account databases.
Retain the existing bootstrap directories and all transaction and
qualification journals.

After the server update, install the matching Test desktop release and keep
earning enabled. Model rows distinguish readiness checks from earlier quality
results and show the available failure reason when a runtime cannot complete
its checks. No chat message is required to start those checks.
