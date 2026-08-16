# Auto-deploy for koinosai.com (Vultr VPS)

The live site is a plain git checkout at `/opt/koinos/kai` on the production
branch `claude/kai-production-website-fqx4pf`, run by `systemd` (`koinos.service`,
`Restart=always`) behind Caddy. Unlike Hostinger, nothing watches the branch by
default, so these files add a tiny poll-based deployer: a 1-minute `systemd`
timer runs `deploy.sh` as the unprivileged `koinos` user; when the production
branch has advanced it resets to it, reinstalls deps only if they changed, and
restarts the app.

No inbound webhook, no secret in CI, no exposed endpoint — it reuses the
checkout's existing pull credentials and the least-privilege sudoers rule below.

## Files

| Repo file                      | Installed to                          |
|--------------------------------|---------------------------------------|
| `deploy.sh`                    | `/opt/koinos/deploy.sh` (0755, koinos)|
| `koinos-deploy.service`        | `/etc/systemd/system/`                |
| `koinos-deploy.timer`          | `/etc/systemd/system/`                |
| `sudoers-koinos-deploy`        | `/etc/sudoers.d/koinos-deploy` (0440) |

## Install (run once, as root on the box)

See the one-paste block handed over at setup time. It writes the four files,
`chown`s the repo to `koinos`, validates the sudoers entry with `visudo -c`,
enables the timer, and runs a credential test + one deploy pass.

## Operating it

- **Ship a change**: push to `claude/kai-production-website-fqx4pf`. Live within ~1 min.
- **Watch a deploy**: `journalctl -u koinos-deploy.service -f`
- **Force one now**: `systemctl start koinos-deploy.service`
- **Timer status**: `systemctl status koinos-deploy.timer`
- **Pause auto-deploy**: `systemctl disable --now koinos-deploy.timer`
- **Manual deploy** (fallback): `cd /opt/koinos/kai && git pull && sudo systemctl restart koinos`

## Notes

- The deploy user only ever gets `systemctl restart koinos` via sudo — nothing else.
- `git reset --hard` means the box holds no local edits; every change comes via
  the branch. Don't hand-edit files under `/opt/koinos/kai` — they'll be reverted.
- Dependency reinstalls run `npm ci` (clean, lockfile-exact) only when
  `package.json`/`package-lock.json` moved between the old and new commit.
