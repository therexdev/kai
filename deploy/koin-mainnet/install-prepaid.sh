#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run from the reviewed Test branch checkout. This never touches koinos.service,
# its production checkout, its environment, its database or Caddy configuration.
bootstrap=${1:?Usage: bash deploy/koin-mainnet/install-prepaid.sh /absolute/private/bootstrap-directory [/absolute/private/account-auth.json]}
account_auth=${2:-}
[[ $# -le 2 ]] || { echo "Unexpected installer arguments" >&2; exit 1; }
[[ "$bootstrap" = /* ]] || { echo "Use an absolute bootstrap directory" >&2; exit 1; }
[[ "$(id -u)" = 0 ]] || { echo "Run the Test service installer as root" >&2; exit 1; }
test_repo=$(git rev-parse --show-toplevel)
test_sha=$(git rev-parse HEAD)
cd "$test_repo"
[[ -z "$(git status --porcelain)" ]] || { echo "Commit and review the Test checkout before installation" >&2; exit 1; }
test_node=$(command -v node)
[[ "$test_node" != /root/* && "$test_node" != /home/* ]] || { echo "Install a system Node binary accessible to the Test service" >&2; exit 1; }
[[ ! -e /etc/systemd/system/kai-koin-prepaid.service && ! -L /etc/systemd/system/kai-koin-prepaid.service ]] || { echo "Prepaid service already exists; use a reviewed code update that preserves its ledger." >&2; exit 1; }
# Check the destination directories before install -d can follow a link and
# change ownership on another service's configuration, code or state.
require_real_directory() {
  if [[ -L "$1" ]] || { [[ -e "$1" ]] && [[ ! -d "$1" ]]; }; then
    echo "Expected a separate real service directory: $1" >&2
    return 1
  fi
}
release_dir="/opt/kai-koin-prepaid/releases/$test_sha"
for directory in /etc/kai-koin-prepaid /etc/kai-koin-prepaid/tokenizer /var/lib/kai-koin-prepaid /opt/kai-koin-prepaid /opt/kai-koin-prepaid/releases "$release_dir"; do
  require_real_directory "$directory"
done
"$test_node" -e 'const v=Number(process.versions.node.split(".")[0]); if(v<22)throw Error("Node 22 or newer required")'
"$test_node" - "$bootstrap" <<'NODE'
const path = require("path"), fs = require("fs"), root = process.argv[2];
const { read, configuration, loadKeys } = require("./lib/koin-network/test-config");
const c = configuration(JSON.parse(read(path.join(root, "runtime.json"))));
if (c.mode !== "mainnet-pilot") throw Error("Explicit mainnet pilot runtime required");
if (!require("./lib/koin-network/product").isPrepaid(c.deployment)) throw Error("New prepaid contracts required; never install this over legacy custody");
loadKeys(path.join(root, "runtime-keys.json"), c);
const d = JSON.parse(read(path.join(root, "desktop-manifest.json")));
if (JSON.stringify(d.deployment) !== JSON.stringify(c.deployment)) throw Error("Verified desktop manifest required");
const entries = require("./lib/koin-network/model-configuration").entries(c);
for (const entry of entries) require("./lib/koin-network/tokenizer").loadTokenizer(
  path.join(root, "tokenizer", ...(c.schema === 2 ? [entry.tariff.model] : [])), entry.tokenizer);
if (d.policyHash !== c.policyHash || d.version !== c.version || !entries.some(e => e.tariff.model === d.model && e.tariff.maxOutputTokens === d.maxOutput)) throw Error("Desktop model policy differs from reviewed runtime");
if (c.accountMode === "public" && (!c.purchasePricing || d.pricingPolicyHash !== require("./lib/koin-network/v4-purchase-oracle").pricingIdentity(c.purchasePricing, c.deployment))) throw Error("Desktop purchase price policy differs from reviewed runtime");
NODE
# Validate account sign-in and stage immutable copies before changing service
# users, installed configuration or systemd. Never source a private env file.
config_stage=$(mktemp -d /tmp/kai-prepaid-config.XXXXXXXX)
release_stage=""
trap 'rm -rf -- "$config_stage"; if [[ -n "$release_stage" ]]; then rm -rf -- "$release_stage"; fi' EXIT
prepare_args=("$bootstrap" "$config_stage")
if [[ -n "$account_auth" ]]; then prepare_args+=("$account_auth"); fi
"$test_node" deploy/koin-mainnet/prepaid-install-config.js "${prepare_args[@]}"
# Check every destination parent before install -d can follow it, including
# schema-2 per-model tokenizer directories. Staging contains validated names only.
mapfile -d '' config_dirs < <(find "$config_stage" -mindepth 1 -type d -printf '%P\0')
for directory in "${config_dirs[@]}"; do
  require_real_directory "/etc/kai-koin-prepaid/$directory"
done
id kai-koin-prepaid >/dev/null 2>&1 || useradd --system --home-dir /var/lib/kai-koin-prepaid --shell /usr/sbin/nologin kai-koin-prepaid
install -d -m 0755 /opt/kai-koin-prepaid /opt/kai-koin-prepaid/releases
if [[ ! -d "$release_dir" ]]; then
  release_stage=$(mktemp -d "/opt/kai-koin-prepaid/releases/.$test_sha.XXXXXX")
  chmod 0755 "$release_stage"
  # Public application code must be readable by the unprivileged service user.
  # Keep the outer private umask for configuration and keys below.
  (
    umask 022
    git -C "$test_repo" archive HEAD | tar -x -C "$release_stage"
    cd "$release_stage"
    npm ci --omit=dev --ignore-scripts
  )
  mv -T "$release_stage" "$release_dir"
  release_stage=""
fi
# Catch incomplete or unreadable dependencies before enabling the service.
runuser -u kai-koin-prepaid -- "$test_node" -e 'require(process.argv[1])' "$release_dir/test-server.js"
install -d -m 0750 -o root -g kai-koin-prepaid /etc/kai-koin-prepaid /etc/kai-koin-prepaid/tokenizer
for directory in "${config_dirs[@]}"; do
  install -d -m 0750 -o root -g kai-koin-prepaid "/etc/kai-koin-prepaid/$directory"
done
install -d -m 0700 -o kai-koin-prepaid -g kai-koin-prepaid /var/lib/kai-koin-prepaid
# Public accounts have no invitation file. Only the selected, validated files
# are staged; offline keys and existing production account databases stay out.
mapfile -d '' config_files < <(find "$config_stage" -type f -printf '%P\0')
for file in "${config_files[@]}"; do
  if [[ -L "/etc/kai-koin-prepaid/$file" ]] || { [[ -e "/etc/kai-koin-prepaid/$file" ]] && ! cmp -s "$config_stage/$file" "/etc/kai-koin-prepaid/$file"; }; then
    echo "Existing prepaid configuration differs: $file. Review it before changing configuration." >&2
    exit 1
  fi
done
for file in "${config_files[@]}"; do
  if [[ "$file" = account.env ]]; then
    # systemd reads this as root; the service receives only the named settings.
    install -m 0600 -o root -g root "$config_stage/$file" "/etc/kai-koin-prepaid/$file"
  elif [[ "$file" = runtime-keys.json || "$file" = operator-secret || "$file" = invitations.json ]]; then
    # Runtime secret readers deliberately reject group-readable credentials.
    install -m 0600 -o kai-koin-prepaid -g kai-koin-prepaid "$config_stage/$file" "/etc/kai-koin-prepaid/$file"
  else
    install -m 0640 -o root -g kai-koin-prepaid "$config_stage/$file" "/etc/kai-koin-prepaid/$file"
  fi
done
cat > /etc/systemd/system/kai-koin-prepaid.service <<EOF
[Unit]
Description=Koinos AI prepaid AI credit backend
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=kai-koin-prepaid
Group=kai-koin-prepaid
WorkingDirectory=$release_dir
ExecStart=$test_node $release_dir/test-server.js
Environment=KAI_KOIN_TEST_CONFIG_DIR=/etc/kai-koin-prepaid
Environment=KAI_KOIN_TEST_STATE_DIR=/var/lib/kai-koin-prepaid
Environment=KAI_KOIN_TEST_PORT=3109
EnvironmentFile=/etc/kai-koin-prepaid/account.env
Restart=on-failure
RestartSec=10
TimeoutStopSec=35
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/etc/kai-koin-prepaid
ReadWritePaths=/var/lib/kai-koin-prepaid
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kai-koin-prepaid.service
systemctl restart kai-koin-prepaid.service
"$test_node" - "$bootstrap" <<'NODE'
const fs = require("fs"), path = require("path");
const c = JSON.parse(fs.readFileSync(path.join(process.argv[2],"runtime.json"),"utf8"));
console.log("Test service installed at reviewed commit. Add this separate HTTPS virtual host to your reverse proxy:");
console.log(new URL(c.schedulerUrl).host + " {\n  reverse_proxy 127.0.0.1:3109\n}");
if (c.accountMode === "public") {
  console.log("Verify HTTPS /health and /auth/methods, then use /account for normal sign-in. No invitation import is needed.");
  console.log("If Google sign-in is configured, register this exact redirect URI: " + new URL(c.schedulerUrl).origin + "/auth/google/callback");
} else console.log("Verify HTTPS /health before importing the owner's private invitation.");
console.log("The prepaid service keeps its own account database. No production service or account database was reconfigured.");
NODE
