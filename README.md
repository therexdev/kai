# kai — Koinos AI website

Production website for **Koinos AI**: a fully self-contained landing page (inline CSS/JS, no external assets) served by a small Express app, plus a waitlist API that stores signups on disk. Built for Hostinger's Node.js hosting — no build step, no database.

```
public/index.html     the landing page (self-contained; do not split into assets)
public/whitepaper.pdf the Koinos AI white paper, served at /whitepaper.pdf
server.js             Express server + waitlist API + admin area
lib/auth.js           password hashing (scrypt) and signed session cookies
lib/store.js          reads the signup file; dedupe + CSV/JSON export
views/                admin pages — served only to a signed-in session, never static
scripts/hash-password.js  generates ADMIN_PASSWORD_HASH
data/waitlist.jsonl   signups, one JSON object per line (created at runtime, gitignored)
```

## White paper

The paper is served straight from `public/` at the stable path **`/whitepaper.pdf`**, linked from the top ribbon, the nav, the mobile menu, and the footer. To publish a new revision, overwrite `public/whitepaper.pdf` and update the version wording in the ribbon (search `Working Draft v0.2` in `public/index.html`) — keep the filename unchanged so shared links keep working.

## Run locally

```bash
npm install
npm start
# → http://localhost:3000
```

`PORT` overrides the default 3000 (`PORT=8080 npm start`). Signups append to `data/waitlist.jsonl`:

```json
{"ts":"2026-08-13T12:34:56.789Z","email":"you@domain.com","segment":"people"}
```

## API

### `POST /api/waitlist`

Body: `{"email": "you@domain.com", "segment": "people" | "dev"}`

- `200 {"ok":true}` — recorded (append to `data/waitlist.jsonl` with an ISO timestamp)
- `400 {"ok":false,"error":…}` — invalid email or segment
- `429 {"ok":false,"error":…}` — rate limited: **5 requests / 10 minutes / IP** (in-memory, resets on restart)
- Spam guard: the form includes a hidden honeypot field named `website`. If it arrives non-empty the API answers `{"ok":true}` but records nothing.

### `GET /api/health`

Returns `{"ok":true}` — use it to confirm the Node app (not a cached page) is answering.

### `GET /scheduler/network/roster`

The **payout roster**: full Koinos addresses of every provider serving the AI
compute network right now.

```json
{ "ok": true, "count": 2, "workers": ["1FullAddressOne", "1FullAddressTwo"] }
```

No auth, `Cache-Control: no-store`, de-duplicated, capped at 5000 addresses.
"Serving right now" is the same rule `/network/status` uses — seen within 90s,
**or** busy mid-job — shared in code (`_liveWorkers`) so the two surfaces can
never disagree about who was online during a snapshot.

Consumed by [Free Koinos Node](https://github.com/therexdev/free-koinos-node),
which redistributes block-reward profit to eligible nodes and pays these
addresses directly on chain.

**These addresses are deliberately public and deliberately NOT truncated.**
`/network/status` shortens addresses to `1AbCdE…wXyZ` because a display surface
needs no full key; a shortened address fails a checksum and cannot be paid, so
this endpoint does not shorten. The trade-off was taken knowingly: anyone can
enumerate the active provider set and follow its on-chain earnings. Do not
"fix" one endpoint to match the other — they answer different questions.

## Admin area (`/admin`)

A password-protected page listing both waitlists with per-list CSV/JSON downloads. The signup file stays on your server — no third-party service holds the addresses.

**Set it up — two environment variables, no tooling:**

| Variable | Value |
|---|---|
| `ADMIN_EMAIL` | the email you want to sign in with |
| `ADMIN_PASSWORD` | the password you want to sign in with |
| `SESSION_SECRET` | any long random string (keeps you signed in across restarts) |

Add them to the Node.js app in hPanel, restart, and open `https://yourdomain.tld/admin`.

Two things make problems obvious: the boot log prints `admin credentials: email "…" + password`, and the login form only shows an email field when `ADMIN_EMAIL` actually loaded — **if you set it and still see just a password box, the app didn't restart.**

`ADMIN_EMAIL` is optional; without it the form asks for the password alone. Use a password without `$` or quotes to avoid any chance of the panel or a shell rewriting it.

<details>
<summary>Optional: store a hash instead of the password</summary>

Stronger, because the password itself never sits in the panel — if someone reads your environment variables they still can't sign in. Costs a setup step:

1. Generate the hash. The prompt keeps the password out of your shell history:
   ```bash
   npm run hash-password
   ```
   It prints a line like `ADMIN_PASSWORD_HASH=scrypt$16384$8$1$…`.

   <details>
   <summary>Windows / PowerShell</summary>

   Needs [Node.js](https://nodejs.org) (`node --version` to check) but **not** `npm install` — the script uses only built-in modules. From the project folder:

   ```powershell
   node scripts/hash-password.js
   ```

   Call `node` directly rather than `npm run` on Windows: npm wraps scripts in `cmd.exe`, which hands the script an empty stdin (`No password given — nothing to hash.`), and PowerShell's execution policy sometimes blocks `npm.ps1` outright (`running scripts is disabled on this system`).

   If the prompt still doesn't appear — Git Bash/MinTTY reports stdin as a pipe, so Node can't detect the terminal — pass the password another way:

   ```powershell
   $env:KAI_ADMIN_PW="your password"; node scripts/hash-password.js; Remove-Item Env:\KAI_ADMIN_PW
   node scripts/hash-password.js "your password"    # simplest, but lands in shell history
   ```

   PowerShell records commands in `ConsoleHost_history.txt`, so prefer the env-var form, or clear that file afterwards.
   </details>
2. Set `ADMIN_PASSWORD_HASH` in hPanel to the whole `scrypt$…` string, and remove `ADMIN_PASSWORD`.
3. Restart the app.

A valid hash takes precedence over `ADMIN_PASSWORD`. A malformed one is ignored with a logged reason and the plaintext password is used instead, so a bad paste can't lock you out.
</details>

If no credentials are set, `/admin` returns 503 and every data endpoint returns 401: **it fails closed, never open.** If `SESSION_SECRET` is unset the app generates a random one at boot, which works fine but signs you out on every restart.

**What it does**

- `GET /admin` — login form, or the dashboard once signed in
- `GET /admin/export.csv?segment=people|dev|all` — CSV download
- `GET /admin/export.json?segment=people|dev|all` — JSON download
- Repeat signups are collapsed by email (earliest kept); exports carry the full list, the table shows the 200 most recent

**How it's protected**

- Password hashed with scrypt + per-password random salt; verified in constant time
- Session is an HMAC-signed cookie — `HttpOnly`, `SameSite=Strict`, and `Secure` automatically once served over HTTPS — expiring after 12 hours
- Login is rate limited to 8 attempts / 15 min / IP; failures are logged with the IP
- `/admin` responses are `no-store`, `noindex`, and `X-Frame-Options: DENY`; `/admin` is disallowed in `robots.txt`
- Admin HTML lives in `views/`, outside the static directory, so it can't be fetched without a session
- CSV exports neutralize cells starting with `=`, `+`, `-`, or `@`, so a crafted address can't execute as a formula in Excel or Sheets

**"Incorrect password" when the hash looks right**

Run the checker locally against the value stored in the panel — it verifies the pair without touching the server:

```bash
npm run check-password              # prompts for hash, then password
node scripts/check-password.js 'scrypt$16384$8$1$…' 'my password'
```

It reports whether the hash is intact and whether that password matches it. Common causes:

- **The shell rewrote the password before hashing.** Double quotes expand `$` in PowerShell and bash, so `"Kai$2026"` is hashed as `Kai026`. Use single quotes.
- **The panel mangled the hash.** If `$` signs were expanded or the value was truncated on paste, no password can match. The app now detects this at boot, logs the reason, and returns 503 at `/admin` instead of silently rejecting logins — so check the app log first.
- **The app wasn't restarted** after the variable changed.

**Sending email to these lists:** this area is for storing and exporting, not sending. When you're ready to email people, download the CSV and import it into a service built for bulk mail (deliverability, one-click unsubscribe, and the opt-out records GDPR/CAN-SPAM expect). Keep this app as the source of truth and treat the export as a one-way sync.

## Deploy on Hostinger (Node.js hosting)

1. Push this repository to GitHub (already done if you're reading this there).
2. In **hPanel → Websites → [your site] → Manage**, open the **Node.js** application setup for the domain (plans with Node.js support).
3. Configure the application:
   - **Application root**: the directory containing this repo (e.g. `/home/USER/domains/yourdomain.tld/kai`)
   - **Entry point / startup file**: `server.js`
   - **Start command**: `npm start` (equivalent to `node server.js`)
   - **Node.js version**: **22** (LTS — matches `engines.node` in `package.json`; if your panel offers a newer LTS it works too)
4. Get the code onto the server — either:
   - **Git deploy**: hPanel → Advanced → **GIT**, attach this repository + branch and deploy into the application root, or
   - upload the files via **File Manager** / SFTP (everything except `node_modules/` and `data/`).
5. Install dependencies: use the panel's **npm install** action, or over SSH:
   ```bash
   cd <application root> && npm install --omit=dev
   ```
6. **Environment variables** (Node.js app → Environment variables):
   - `PORT` — **injected by Hostinger automatically; don't set it yourself.** The app reads `process.env.PORT` and falls back to 3000 locally.
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET` — see [Admin area](#admin-area-admin). Required to use `/admin`.
   - Optional signup-notification emails (off by default — the site runs fine with none of these set; enabling requires `SMTP_HOST` **and** `SMTP_TO`):

     | Variable | Meaning |
     |---|---|
     | `SMTP_HOST` | SMTP server hostname |
     | `SMTP_PORT` | SMTP port (default `587`) |
     | `SMTP_USER` / `SMTP_PASS` | SMTP credentials (omit for unauthenticated relays) |
     | `SMTP_SECURE` | `true`/`false` — implicit TLS (defaults to `true` only when port is `465`) |
     | `SMTP_FROM` | From address (defaults to `SMTP_USER`) |
     | `SMTP_TO` | Where signup notifications are sent — required to enable |
7. **Restart** the application from the panel, then verify:
   - `https://yourdomain.tld/` renders the site
   - `https://yourdomain.tld/api/health` returns `{"ok":true}`

### Persistent data (waitlist + scheduler)

All persistent state lives in `~/.koinos-ai/` in the hosting account's **home directory** — outside the application root, so hPanel Git redeploys (which replace the application directory's contents) cannot touch it:

- `~/.koinos-ai/website/waitlist.jsonl` — append-only signup log
- `~/.koinos-ai/scheduler/` — epoch records, deposit-credit ledger, oracle state

Override the base directory with `KAI_STATE_DIR` (or just the scheduler's with `SCHEDULER_DATA`). On first boot after updating, the server automatically migrates anything still present in the legacy in-root locations (`<application root>/data/`, `<application root>/.data/scheduler/`), merging rather than overwriting.

Earlier versions kept this data inside the application root, where **every hPanel Git redeploy deleted it**. If signups were lost to a redeploy and signup-notification emails were configured (`SMTP_TO`), each lost signup still exists as a "KAI waitlist signup" notification in that inbox.

Download `waitlist.jsonl` periodically as a backup (admin → export, File Manager, or `scp`).

### Notes

- `trust proxy` is enabled in `server.js` so the per-IP rate limit sees real client IPs behind Hostinger's proxy.
- The waitlist store is a flat JSONL file by design: zero external services, safe on shared hosting. Dedupe by email at export time if needed.
