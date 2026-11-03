#!/usr/bin/env bash
set -euo pipefail
# Pinned full release, including the sidecars required by runsc after July 2026.
[[ $(id -u) == 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
command -v docker >/dev/null || { printf 'Install Docker first.\n' >&2; exit 1; }
runner_arch=$(uname -m)
[[ $runner_arch == x86_64 || $runner_arch == aarch64 ]] || exit 1
runner_tmp=$(mktemp -d)
trap 'rm -rf "$runner_tmp"' EXIT
runner_url="https://storage.googleapis.com/gvisor/releases/release/20261026.0/$runner_arch"
curl --fail --silent --show-error --location "$runner_url/gvisor.tar.bz2" -o "$runner_tmp/gvisor.tar.bz2"
curl --fail --silent --show-error --location "$runner_url/gvisor.tar.bz2.sha512" -o "$runner_tmp/gvisor.tar.bz2.sha512"
(cd "$runner_tmp" && sha512sum -c gvisor.tar.bz2.sha512)
tar -xjf "$runner_tmp/gvisor.tar.bz2" -C /usr/local/bin
/usr/local/bin/runsc install
systemctl reload docker
/usr/local/bin/runsc --version
