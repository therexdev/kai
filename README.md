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

## Admin area (`/admin`)

A password-protected page listing both waitlists with per-list CSV/JSON downloads. The signup file stays on your server — no third-party service holds the addresses.

**Set it up (required — the area stays disabled until you do):**

1. Generate a password hash. The prompt keeps the password out of your shell history:
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

   Calling `node` directly is the reliable form on Windows: `npm run` wraps scripts in `cmd.exe`, which can break the hidden password prompt, and PowerShell's execution policy sometimes blocks `npm.ps1` outright (`running scripts is disabled on this system` — use `npm.cmd` or run `node` directly).

   To pipe a password instead of typing it at the prompt:
   ```powershell
   $p = Read-Host "Password" -AsSecureString
   [Runtime.InteropServices.Marshal]::PtrToStringAuto(
     [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p)
   ) | node scripts/hash-password.js
   ```
   </details>
2. Add two environment variables to the Node.js app in hPanel:

   | Variable | Value |
   |---|---|
   | `ADMIN_PASSWORD_HASH` | the `scrypt$…` string from step 1 |
   | `SESSION_SECRET` | a long random string (e.g. `openssl rand -base64 32`) |
3. Restart the app and open `https://yourdomain.tld/admin`.

`ADMIN_PASSWORD` (plaintext) also works if you can't run the hash script, but the app logs a warning at boot — prefer the hash. If neither is set, `/admin` returns 503 and every data endpoint returns 401: **it fails closed, never open.** If `SESSION_SECRET` is unset the app generates a random one at boot, which works fine but signs you out on every restart.

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
   - `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` — see [Admin area](#admin-area-admin). Required to use `/admin`.
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

### Waitlist data

Signups live in `<application root>/data/waitlist.jsonl` on the server. The file is **gitignored** and append-only — download it periodically (File Manager or `scp`) and back it up before any deploy that wipes the application directory. Git-based deploys that only sync tracked files leave it alone.

### Notes

- `trust proxy` is enabled in `server.js` so the per-IP rate limit sees real client IPs behind Hostinger's proxy.
- The waitlist store is a flat JSONL file by design: zero external services, safe on shared hosting. Dedupe by email at export time if needed.
