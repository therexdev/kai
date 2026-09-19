#!/usr/bin/env bash
# Run on the Vultr server after reviewing this commit. No secrets are printed.
set -euo pipefail
umask 077
if [ "$(id -u)" != 0 ]; then echo "Run this installer with sudo." >&2; exit 1; fi
BUILDER_REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
BUILDER_TARGET=/opt/kai-build-signer
command -v node >/dev/null
command -v npm >/dev/null
node -e 'require("node:sqlite")' >/dev/null
if ! id kai-build-signer >/dev/null 2>&1; then useradd --system --home-dir /var/lib/kai-build-signer --shell /usr/sbin/nologin kai-build-signer; fi
install -d -m 0755 "$BUILDER_TARGET" "$BUILDER_TARGET/scripts/build" "$BUILDER_TARGET/lib/builder" "$BUILDER_TARGET/contracts/build-app/build"
for BUILDER_FILE in package.json package-lock.json scripts/build/signer.js lib/builder/chain.js lib/builder/wallet-proof.js lib/builder/store.js contracts/build-app/build/contract.wasm contracts/build-app/build/guard.wasm contracts/build-app/build/contract.abi.json; do
  install -m 0644 "$BUILDER_REPO/$BUILDER_FILE" "$BUILDER_TARGET/$BUILDER_FILE"
done
(cd "$BUILDER_TARGET" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
# Signer code is root-owned. The web account cannot replace it and then wait
# for a signer restart to acquire its WIF. Updates require this installer.
chown -R root:root "$BUILDER_TARGET"
chmod -R a+rX,go-w "$BUILDER_TARGET"
if [ ! -f /etc/kai-build-signer.env ]; then
  read -r -s -p "Dedicated builder TESTNET wallet WIF: " BUILDER_WIF
  printf '\n'
  export BUILDER_WIF
  (cd "$BUILDER_TARGET" && node -e 'require("koilib").Signer.fromWif(process.env.BUILDER_WIF)')
  BUILDER_TOKEN=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
  BUILDER_KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
  {
    printf 'KAI_BUILD_DEPLOYER_WIF=%s\n' "$BUILDER_WIF"
    printf 'KAI_BUILD_KEY_ENCRYPTION_KEY=%s\n' "$BUILDER_KEY"
    printf 'KAI_BUILD_SIGNER_TOKEN=%s\n' "$BUILDER_TOKEN"
    printf 'KAI_BUILD_SIGNER_STATE_DIR=/var/lib/kai-build-signer\nKAI_BUILD_NETWORK=testnet\nKAI_BUILD_RPC_URL=https://testnet.koinosfoundation.org/jsonrpc\nKAI_BUILD_CHAIN_ID=EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==\nKAI_BUILD_DEPLOY_RC_LIMIT=2000000000\nKAI_BUILD_DAILY_MANA=20000000000\n'
  } > /etc/kai-build-signer.env
  unset BUILDER_WIF BUILDER_KEY
else
  # Read only the shared transport token, without sourcing shell code.
  BUILDER_TOKEN=$(sed -n 's/^KAI_BUILD_SIGNER_TOKEN=//p' /etc/kai-build-signer.env)
fi
if [ ! -f /etc/kai-build-web.env ]; then
  read -r -s -p "OpenAI API key for KAI Build (leave blank to use the site's existing OPENAI_API_KEY): " BUILDER_OPENAI_KEY
  printf '\n'
  {
    if [ -n "$BUILDER_OPENAI_KEY" ]; then printf 'KAI_BUILD_OPENAI_API_KEY=%s\n' "$BUILDER_OPENAI_KEY"; fi
    printf 'KAI_BUILD_SIGNER_URL=http://127.0.0.1:3091\nKAI_BUILD_SIGNER_TOKEN=%s\n' "$BUILDER_TOKEN"
    printf 'KAI_BUILD_MODEL=gpt-5.6\nKAI_BUILD_NETWORK=testnet\nKAI_BUILD_RPC_URL=https://testnet.koinosfoundation.org/jsonrpc\nKAI_BUILD_CHAIN_ID=EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==\n'
  } > /etc/kai-build-web.env
  unset BUILDER_OPENAI_KEY
fi
unset BUILDER_TOKEN
chmod 0600 /etc/kai-build-signer.env /etc/kai-build-web.env
install -m 0644 "$BUILDER_REPO/deploy/builder/kai-build-signer.service" /etc/systemd/system/kai-build-signer.service
install -d -m 0755 /etc/systemd/system/koinos.service.d
printf '[Service]\nEnvironmentFile=/etc/kai-build-web.env\n' > /etc/systemd/system/koinos.service.d/builder.conf
systemctl daemon-reload
systemctl enable --now kai-build-signer
systemctl restart kai-build-signer
systemctl restart koinos
systemctl is-active kai-build-signer koinos
echo "KAI Build services installed on testnet. Open https://koinosai.com/build to test the publishing flow. The dedicated wallet needs test KOIN for mana."
echo "Back up /var/lib/kai-build-signer and /etc/kai-build-signer.env securely. Keep the WIF and encryption key out of the website's environment."
