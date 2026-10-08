#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run from the reviewed Test branch checkout. This never touches koinos.service,
# its production checkout, its environment, its database or Caddy configuration.
bootstrap=${1:?Usage: bash deploy/koin-mainnet/install.sh /absolute/private/bootstrap-directory}
[[ "$bootstrap" = /* ]] || { echo "Use an absolute bootstrap directory" >&2; exit 1; }
[[ "$(id -u)" = 0 ]] || { echo "Run the Test service installer as root" >&2; exit 1; }
test_repo=$(git rev-parse --show-toplevel)
test_sha=$(git rev-parse HEAD)
cd "$test_repo"
[[ -z "$(git status --porcelain)" ]] || { echo "Commit and review the Test checkout before installation" >&2; exit 1; }
test_node=$(command -v node)
[[ "$test_node" != /root/* && "$test_node" != /home/* ]] || { echo "Install a system Node binary accessible to the Test service" >&2; exit 1; }
"$test_node" -e 'const v=Number(process.versions.node.split(".")[0]); if(v<22)throw Error("Node 22 or newer required")'
"$test_node" - "$bootstrap" <<'NODE'
const path = require("path"), fs = require("fs"), root = process.argv[2];
const { read, configuration, loadKeys } = require("./lib/koin-network/test-config");
const c = configuration(JSON.parse(read(path.join(root, "runtime.json"))));
if (c.mode !== "mainnet-pilot") throw Error("Explicit mainnet pilot runtime required");
loadKeys(path.join(root, "runtime-keys.json"), c);
const d = JSON.parse(read(path.join(root, "desktop-manifest.json")));
if (JSON.stringify(d.deployment) !== JSON.stringify(c.deployment)) throw Error("Verified desktop manifest required");
require("./lib/koin-network/tokenizer").loadTokenizer(path.join(root,"tokenizer"), c.tokenizer);
NODE
id kai-koin-mainnet-pilot >/dev/null 2>&1 || useradd --system --home-dir /var/lib/kai-koin-mainnet-pilot --shell /usr/sbin/nologin kai-koin-mainnet-pilot
install -d -m 0755 /opt/kai-koin-mainnet-pilot /opt/kai-koin-mainnet-pilot/releases
release_dir="/opt/kai-koin-mainnet-pilot/releases/$test_sha"
if [[ ! -d "$release_dir" ]]; then
  install -d -m 0755 "$release_dir"
  git -C "$test_repo" archive HEAD | tar -x -C "$release_dir"
  (cd "$release_dir" && npm ci --omit=dev --ignore-scripts)
fi
install -d -m 0700 -o kai-koin-mainnet-pilot -g kai-koin-mainnet-pilot /etc/kai-koin-mainnet-pilot /etc/kai-koin-mainnet-pilot/tokenizer /var/lib/kai-koin-mainnet-pilot
# Never copy offline-keys.json or the owner's invitation into the service tree.
for file in runtime.json runtime-keys.json operator-secret invitations.json qualifications.json; do
  if [[ -e "/etc/kai-koin-mainnet-pilot/$file" ]] && ! cmp -s "$bootstrap/$file" "/etc/kai-koin-mainnet-pilot/$file"; then
    echo "Existing Test configuration differs: $file. Drain and review it before changing configuration." >&2
    exit 1
  fi
  install -m 0600 -o kai-koin-mainnet-pilot -g kai-koin-mainnet-pilot "$bootstrap/$file" "/etc/kai-koin-mainnet-pilot/$file"
done
for file in tokenizer.json tokenizer_config.json; do
  install -m 0600 -o kai-koin-mainnet-pilot -g kai-koin-mainnet-pilot "$bootstrap/tokenizer/$file" "/etc/kai-koin-mainnet-pilot/tokenizer/$file"
done
cat > /etc/systemd/system/kai-koin-mainnet-pilot.service <<EOF
[Unit]
Description=Koinos AI mainnet pilot payment backend
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=kai-koin-mainnet-pilot
Group=kai-koin-mainnet-pilot
WorkingDirectory=$release_dir
ExecStart=$test_node $release_dir/test-server.js
Environment=KAI_KOIN_TEST_CONFIG_DIR=/etc/kai-koin-mainnet-pilot
Environment=KAI_KOIN_TEST_STATE_DIR=/var/lib/kai-koin-mainnet-pilot
Environment=KAI_KOIN_TEST_PORT=3108
Restart=on-failure
RestartSec=10
TimeoutStopSec=35
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/etc/kai-koin-mainnet-pilot
ReadWritePaths=/var/lib/kai-koin-mainnet-pilot
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kai-koin-mainnet-pilot.service
systemctl restart kai-koin-mainnet-pilot.service
"$test_node" - "$bootstrap" <<'NODE'
const fs = require("fs"), path = require("path");
const c = JSON.parse(fs.readFileSync(path.join(process.argv[2],"runtime.json"),"utf8"));
console.log("Test service installed at reviewed commit. Add this separate HTTPS virtual host to your reverse proxy:");
console.log(new URL(c.schedulerUrl).host + " {\n  reverse_proxy 127.0.0.1:3108\n}");
console.log("Verify /health through that HTTPS hostname before importing the owner's private Test invitation. No production service was reconfigured.");
NODE
