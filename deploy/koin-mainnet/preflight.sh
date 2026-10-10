#!/usr/bin/env bash
set -euo pipefail
# Read-only host checks. No environment files, private keys or process arguments.
printf 'Host: '; hostname
printf 'Kernel: '; uname -r
if command -v node >/dev/null; then node --version; else echo 'Node is not installed'; fi
if command -v npm >/dev/null; then npm --version; else echo 'npm is not installed'; fi
free -m
df -h /
printf '\nRelevant service states (no logs or environment):\n'
for unit in koinos.service caddy.service nginx.service kai-koin-mainnet-pilot.service; do
  printf '%s: ' "$unit"
  systemctl is-active "$unit" || true
done
printf '\nListening TCP ports (no process arguments):\n'
ss -lnt
printf '\nFirewall status:\n'
if command -v ufw >/dev/null && [[ "$(id -u)" = 0 ]]; then ufw status; else echo 'Run ufw status with admin access if needed'; fi
