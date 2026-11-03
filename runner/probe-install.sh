#!/usr/bin/env bash
set -euo pipefail
# Only an ephemeral CI machine: creates a dummy web service and fixture token.
[[ ${CI:-} == true && $(id -u) == 0 ]]
[[ ! -e /etc/kai-build-web.env && ! -e /etc/kai-build-runner.env ]]
runner_source=$(cd "$(dirname "$0")/.." && pwd)
trap 'systemctl stop kai-build-runner koinos || true' EXIT
umask 077
printf 'KAI_RUNNER_TOKEN=ci-fixture-runner-token-not-a-real-secret-123456\n' > /etc/kai-build-runner.env
printf 'KAI_BUILD_MODEL=ci-fixture\n' > /etc/kai-build-web.env
cat > /etc/systemd/system/koinos.service <<'UNIT'
[Unit]
Description=CI fixture web service
[Service]
Type=oneshot
RemainAfterExit=true
ExecStart=/usr/bin/true
UNIT
bash "$runner_source/runner/install.sh"
cd "$runner_source"
node <<'JS'
const assert = require('node:assert/strict');
const { RunnerClient } = require('./lib/builder/runner');
const { starter } = require('./lib/builder/projects');
(async () => {
 const client = new RunnerClient({ url: 'http://127.0.0.1:8092', token: 'ci-fixture-runner-token-not-a-real-secret-123456' });
 let health;
 for (let i=0;i<20;i++) { try { health=await client.health();break; } catch { await new Promise(r=>setTimeout(r,250)); } }
 assert.equal(health?.ready,true);
 const files=starter('workspace','Installed worker');
 const result=await client.run({files,target:'counter',operation:'compile'});
 assert.equal(result.ok,true,result.logs);
 assert.equal(result.artifacts.length,2);
 const tested=await client.run({files,target:'service',operation:'test'});
 assert.equal(tested.ok,true,tested.logs);
 console.log('PASS documented installer, dedicated systemd worker, authenticated HTTP compile/test and verified artifacts');
})().catch(error=>{console.error(error);process.exitCode=1;});
JS
