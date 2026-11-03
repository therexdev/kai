# Isolated Koinos build/test worker

The web process sends source to a separate loopback service. Each job runs in a
new gVisor (`runsc`) container with a fixed toolchain, no network, no host mounts,
no credentials, a read-only image, bounded scratch storage and a 120-second
deadline. The worker refuses ordinary Docker as a fallback. Its image is
recorded by immutable Docker image ID in every result. The web server has no
Docker socket access and never runs project code, npm scripts or compiler hooks.

The worker host service controls Docker and must be treated as privileged.
Its code and environment are root-owned; the `koinos` web user must not join the
Docker group. Use a separate worker VM for stronger host separation. The
installer below is for the existing single Vultr VM and binds only to loopback.
For a separate VM, keep the worker bound to loopback, use a private authenticated
TLS reverse proxy, and set `KAI_BUILD_RUNNER_URL` to its HTTPS origin. Do not expose
port 8092 or an unauthenticated Docker API publicly.

## Existing Vultr server setup

Requirements: Ubuntu/Debian, system Node 22, Docker, Linux supported by gVisor,
and enough RAM/disk for one 1-GiB job plus the existing website. The installer
does not change the wallet signer. Run after updating the website checkout:

```bash
sudo -u koinos git -C /opt/koinos/kai pull --ff-only
# Skip this package installation if Docker is already installed.
sudo apt-get update
sudo apt-get install -y docker.io curl ca-certificates bzip2 openssl python3
sudo systemctl enable --now docker
sudo bash /opt/koinos/kai/runner/install-gvisor.sh
sudo bash /opt/koinos/kai/runner/install.sh
sudo systemctl is-active koinos kai-build-runner kai-build-signer
```

The gVisor installer uses release 20261026.0, verifies its published SHA-512,
installs the full runtime with sidecars, and reloads Docker. See the official
[installation documentation](https://gvisor.dev/docs/user_guide/install/).
The worker installer builds the locked toolchain, creates a dedicated service
account, writes a separate random transport token to a root-only environment
file, adds only that token and worker URL to the existing web environment, and
restarts the web service. It does not print the token. No WIF or API key is needed.

Open `/build`, create a **Full application workspace**, choose **Builds & tests**,
and **Check worker**. Compile `counter`, then run its MockVM tests and the
`service` Node tests. Download the resulting WASM and ABI if needed. Failed
compiler/test logs can be sent back to KAI with **Ask KAI to inspect this run**.

If setup fails, inspect `journalctl -u kai-build-runner -n 80 --no-pager`.
Do not paste environment files or credentials into chat. A worker without its
image or gVisor runtime reports unavailable; source editing still works.

Updates to runner code or the toolchain require rerunning `runner/install.sh`
after updating the repository. Website auto-deploy intentionally cannot replace
this privileged worker. To disable execution, stop `kai-build-runner`, remove
`KAI_BUILD_RUNNER_URL` and `KAI_BUILD_RUNNER_TOKEN` from the web environment, and
restart `koinos`. Saved source and run history are preserved.

## Supported operations and limits

See [build-workflow.md](../docs/builder-reference/build-workflow.md) for targets,
ABI declarations, pinned SDK references and constraints. Source projects support
512 text files / 8 MB / 1 MB per file. Unchanged source blobs are deduplicated in
revision history, with a 200-MB unique-source allowance per account. Existing
raw snapshots remain readable. There are 60 runs per account per day and at most
two runs in one AI request. The latest eight artifact-producing runs per account
retain downloads; logs retain at least the latest 30 per project.

Compile creates real WASM and ABI. Koinos tests execute through as-pect/MockVM;
Node tests execute declared service tests. A passing result is not an audit,
wallet test, live-chain test or deployment. Generated code cannot reach the
platform wallet signer. Custom contract deployment, frontend bundling/hosting,
indexer hosting and custom wallet methods remain separate work; managed Publish
still supports only the unchanged bundled App v1 contract.

## Validation

`node scripts/probe-builder-runner.js` checks configuration, ownership, job
binding, result verification, limits and AI repair tools without running user
code. `node runner/probe-integration.cjs` requires Docker + runsc and
`KAI_RUNNER_IMAGE=sha256:...`; CI builds the actual image and checks compiled
artifacts, passing/failing tests, compiler errors, isolation and timeout cleanup.
