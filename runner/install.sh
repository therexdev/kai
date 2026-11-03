#!/usr/bin/env bash
set -euo pipefail
# Run from a reviewed production checkout. Never enable shell tracing here.
[[ $(id -u) == 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
runner_source=$(cd "$(dirname "$0")/.." && pwd)
command -v node >/dev/null
command -v docker >/dev/null
getent group docker >/dev/null
docker info --format '{{json .Runtimes}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!JSON.parse(s).runsc)process.exit(1)})'
docker build --pull -f "$runner_source/runner/Dockerfile" -t kai-build-toolchain:v1 "$runner_source"
runner_image=$(docker image inspect kai-build-toolchain:v1 --format '{{.Id}}')
[[ $runner_image =~ ^sha256:[a-f0-9]{64}$ ]]
id kai-build-runner >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin kai-build-runner
install -d -m 755 -o root -g root /opt/kai-build-runner/runner /opt/kai-build-runner/lib/builder
install -m 644 -o root -g root "$runner_source/runner/server.cjs" "$runner_source/runner/sandbox.cjs" /opt/kai-build-runner/runner/
for runner_file in build-config.js workspace.js store.js; do
  install -m 644 -o root -g root "$runner_source/lib/builder/$runner_file" /opt/kai-build-runner/lib/builder/
done
umask 077
if [[ ! -f /etc/kai-build-runner.env ]]; then
  printf 'KAI_RUNNER_TOKEN=%s\n' "$(openssl rand -hex 32)" > /etc/kai-build-runner.env
fi
sed -i '/^KAI_RUNNER_IMAGE=/d; /^KAI_RUNNER_PORT=/d' /etc/kai-build-runner.env
printf 'KAI_RUNNER_IMAGE=%s\nKAI_RUNNER_PORT=8092\n' "$runner_image" >> /etc/kai-build-runner.env
chown root:root /etc/kai-build-runner.env
chmod 600 /etc/kai-build-runner.env
runner_node=$(command -v node)
[[ $runner_node == /usr/bin/node || $runner_node == /usr/local/bin/node ]] || { printf 'Install system Node 22 before continuing.\n' >&2; exit 1; }
sed "s|/usr/bin/node|$runner_node|" "$runner_source/runner/kai-build-runner.service" > /etc/systemd/system/kai-build-runner.service
chmod 644 /etc/systemd/system/kai-build-runner.service
systemctl daemon-reload
systemctl enable --now kai-build-runner
systemctl restart kai-build-runner
# Only runner transport credentials are added to the existing web environment.
python3 - <<'PY'
from pathlib import Path
runner = dict(line.split('=', 1) for line in Path('/etc/kai-build-runner.env').read_text().splitlines() if '=' in line)
web = Path('/etc/kai-build-web.env')
if not web.exists(): raise SystemExit('Existing /etc/kai-build-web.env is required; runner installed, web configuration unchanged.')
lines = [line for line in web.read_text().splitlines() if not line.startswith(('KAI_BUILD_RUNNER_URL=', 'KAI_BUILD_RUNNER_TOKEN='))]
lines += ['KAI_BUILD_RUNNER_URL=http://127.0.0.1:8092', 'KAI_BUILD_RUNNER_TOKEN=' + runner['KAI_RUNNER_TOKEN']]
web.write_text('\n'.join(lines) + '\n')
PY
systemctl restart koinos
printf 'Runner installed. Open Builds & tests and click Check worker, then compile and test the counter target.\n'
systemctl is-active koinos kai-build-runner
