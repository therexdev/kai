# Test deployment verification and owner handoff

The explicit Test payment implementation is available on desktop `test` and
backend `claude/koin-shadow-integration`. The backend is a separate entry point;
the production `server.js` does not start it. Public Test activation still needs
the owner's hostname/host access, public wallet address, explicit test tariff and
spending/resource caps, fresh funded role wallets and a reviewed provider.

Follow [the deployment and owner testing instructions](../deploy/koin-test/README.md).
No public Test custody deployment, funded operator keys or server connection was
available in the implementation workspace. No public transfer or alpha invitation
was performed. Publishing a Test installer does not activate its payment panel.

## Published desktop Test release

[Test 0.54.12-test.166.1](https://github.com/therexdev/kaiapp/releases/tag/test-build)
was published by [run 36479914787](https://github.com/therexdev/kaiapp/actions/runs/36479914787).
All five jobs passed: desktop verification, macOS behavior, Windows packaging,
Linux packaging and publication. The release metadata identifies source
`723e3b73d70670a5cc98a3bb55539d3d91231eec`, matching the native run below.

The versioned Windows setup asset is
`Koinos-AI-Test-Setup-0.54.12-test.166.1-x64.exe`, release asset `596400913`,
227,867,856 bytes, SHA-256
`2ae86af2d4d97f03c704fdbc290b9652e685619f950bb3d4f67d013fc71d74ce`.
Its versioned build JSON, checksums and Windows signature proof are uploaded,
along with Linux x64/arm64 installers and the Test update feeds.

Quit the running app through its tray menu before installing Test. It uses the
existing profile and single-instance lock. The Test payment panel still requires
its separately deployed contracts/backend and imported wallet-bound files.

## Verified implementation

- Desktop native reviews cover purchase, reward funding, bounded reservations,
  revocation, release and refunds. Private invitations are encrypted by the OS.
- Pending signatures and submissions retain their original envelopes across
  restarts. A wallet is bound to one installation through a persistent backend
  lease. Recovery uses original transactions and irreversible chain evidence.
- Paired journal backups retain an external generation witness; old backups
  cannot reset uncertain spending. macOS system path aliases resolve to one
  physical identity while linked journal directories remain refused.
- The separate Test runtime meters pinned Qwen token IDs, settles accepted work,
  derives daily roots from reconciled native paid usage, observes the full root
  review and sends provider payouts automatically. Empty days commit zero claims.
- Owner status reports actual charged tokens, per-request revenue splits and
  native resource receipts. Read-only request recovery distinguishes cancelled,
  settled and still-uncertain requests without repeating work.

## Native contract evidence

[Run 36480378151](https://github.com/therexdev/kai/actions/runs/36480378151)
passed **33 checks** with backend commit
`42d3c34a18ece77c249b09e6f2340ad5dd325c16` and desktop commit
`723e3b73d70670a5cc98a3bb55539d3d91231eec`.

The run used a fresh peerless chain, real custody WASM and native resource
accounting. It retained the previous funding, shared-wallet nonce, external-wallet
recovery and full reward-cycle checks, then exercised the actual Test backend and
desktop payment/session clients together:

| Measurement | Observed fixture result |
| --- | --- |
| Pinned model tokenizer | `koinos-fast` / Qwen2.5-1.5B |
| Input/output tokens | 37 / 1 |
| Irreversible charge | 38 test atoms |
| Automatic work payout | 30 test atoms |
| Restart after lost settlement acknowledgment | 1, recovered without another signature |
| Provider payout signatures | 0 |
| Native desktop transaction reviews | 3: reserve, release, refund |
| Backend transaction signatures | 14 across 13 submissions |

It also finalized an empty reward day without paying the provider again, measured
native RC from irreversible receipts, and recovered the settled charge through
the desktop's owned-request status endpoint.

[The extracted report](koin-test-deployment-results.json) retains transaction
commitments and resource receipts. Full original bytes are in artifact
`10996551824`, ZIP SHA-256
`fbf93eedc6972388e559ea2dabcbd11f6c7c118a5fa762a4d72ac9bf3fa60892`.
The extracted report also records the original report hash and exact source pins.

The worker answer and tariff in this run are controlled fixtures. These results
do not measure a real model's quality, hardware profitability, public-chain Mana
cost, external KoinVault Test compatibility, public deployment health or seven
days of user traffic. Those require the configured Test host and actual owner
testing before alpha rollout.
