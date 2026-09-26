#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: run-in-network.sh DISPOSABLE_DIRECTORY' >&2
  exit 1
fi
isolated_dir=$(realpath "$1")
rpc_container=$(docker compose -f "$isolated_dir/compose.json" ps -q jsonrpc)
test -n "$rpc_container"
rpc_pid=$(docker inspect --format '{{.State.Pid}}' "$rpc_container")
test "$rpc_pid" -gt 1
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Keep the host filesystem, enter only the peerless RPC network. Node reads
# published fixture keys from the pinned checkout after validating genesis.
sudo nsenter --target "$rpc_pid" --net -- "$(command -v node)" "$script_dir/run.js" "$isolated_dir"
