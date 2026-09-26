# Self-hosting (Node.js + SQLite)

The same app can run on your own machine instead of Cloudflare. Nothing about
the Cloudflare deployment changes; this is an additional way to run it.

## How it works

```
                 src/index.js  (the Worker, unchanged)
                  /                         \
   Cloudflare: workerd + D1         Node: server/ + SQLite file
   static files: assets binding     static files: served from public/
```

- `server/d1-sqlite.js` implements the small part of Cloudflare's D1 API that
  the Worker uses, on top of Node's built-in `node:sqlite`. The Worker cannot
  tell the difference.
- `server/server.js` is a plain `node:http` server: `/healthz`, static files
  from `public/`, and everything else handed to the Worker's `fetch()`.
- `server/database.js` opens the SQLite file and manages schema versions.
- `server/cli.js` is for admin tasks: users, CSV export, backups.

There are no runtime npm dependencies. `npm install` only fetches `wrangler`,
which is needed for Cloudflare development and for the test suite.

Requires **Node.js 24** (current LTS) or newer.

## Local development

```bash
npm install
npm run dev:node        # http://127.0.0.1:8080, restarts on code changes
npm test
```

`dev:node` enables registration so you can create an account in the browser.
The development database is `data/weight-log.sqlite`, which is git-ignored.
`npm run dev` still runs the Cloudflare version under wrangler.

No Node 24 on your machine? Run the tests in a throwaway container instead,
after `npm install` (or use `docker run`):

```bash
podman run --rm -v "$PWD":/app:Z -w /app docker.io/library/node:24-slim npm test
```

One test that needs a non-root user skips itself there.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` in a container, or a specific IP. |
| `PORT` | `8080` | Port to listen on. |
| `DATABASE_PATH` | `data/weight-log.sqlite` (in the repo) | SQLite file. Created if missing, along with its directory. |
| `ALLOW_REGISTRATION` | `false` | Allow "Create account" in the browser. Off by default. |
| `COOKIE_SECURE` | `false` | Keep the `Secure` flag on the session cookie. Set `true` only if users reach the app over HTTPS. |
| `ALLOWED_HOSTS` | *(any)* | Comma-separated host names the server answers to. Others get 403. |

## Authentication

Sign-in behaves exactly as on Cloudflare:
PBKDF2-hashed passwords, 180-day sessions, and an Origin check on writes. Two
differences, both deliberate:

- **Registration is off.** Create accounts from the command line:
  `node server/cli.js create-user you@example.com`. Alternatively, start once
  with `ALLOW_REGISTRATION=true`.
- **The cookie's `Secure` flag is dropped** unless `COOKIE_SECURE=true`.
  Browsers refuse `Secure` cookies on plain `http://` pages other than
  localhost, so sign-in at `http://nas:8080` would otherwise silently fail.
  Tailscale already encrypts traffic between your devices. If you put HTTPS in
  front (for example `tailscale serve`), set `COOKIE_SECURE=true`.

## Admin CLI

Run these with the same `DATABASE_PATH` as the server. They are safe to run
while the server is running.

```bash
node server/cli.js create-user EMAIL [lb|kg]   # prompts for a password
node server/cli.js reset-password EMAIL        # also signs out all sessions
node server/cli.js list-users
node server/cli.js export-csv EMAIL > weight-log.csv
node server/cli.js backup DIR                  # see Backups
```

`npm run user -- <command> ...` is the same thing.

Password reset by email is Cloudflare-only: it needs a Resend API key
(`RESEND_API_KEY`, `MAIL_FROM`), which the Node server doesn't use, so the
sign-in page doesn't offer it. Use `reset-password` instead.

## Your data

### Where it is

There is one SQLite file (`DATABASE_PATH`). While the server runs, SQLite also
keeps `-wal` and `-shm` files next to it; they are part of the database, so
never delete them while the server is running. The directory must be on a
local filesystem, not NFS or SMB.

SQLite runs with WAL journaling, `synchronous=FULL`, foreign keys enforced and
a 5-second busy timeout.

### CSV export and import (portable, app-independent)

- **Export CSV** in the web app, or `cli.js export-csv EMAIL`, produces
  `Date,Weight (lb),Trend (lb),Rung,Flag,Comment`. It's plain CSV that any
  spreadsheet can open, with one row per logged day, blank weight for days
  with only a comment, rung or flag, and RFC 4180 quoting.
- **Import CSV** accepts that format and the **Hacker's Diet Online** CSV
  export (`Date,Weight,Rung,Flag,Comment`), including rung, flag and the diet
  plan. Imported dates overwrite existing ones. (The importer reads line by
  line, so a comment containing a line break comes back truncated at the
  break.)

You never need this app, or even SQLite, to get your history back: a CSV
export is enough. With any `sqlite3` binary you can also run
`sqlite3 -csv -header weight-log.sqlite "SELECT u.email, w.date, w.weight, w.rung, w.flag, w.comment FROM weights w JOIN users u ON u.id = w.user_id ORDER BY 1, 2"`.

### Backups

```bash
node server/cli.js backup /path/to/backups
```

This creates `/path/to/backups/<timestamp>/`, containing:

- `weight-log.sqlite`: a consistent snapshot made with SQLite's `VACUUM INTO`,
  which is safe while the server is running (unlike copying the live file),
  and then checked with `PRAGMA integrity_check`.
- `<email>.csv`: a CSV export for every account.

Keep copies somewhere other than the machine running the app.

### Restore

From a SQLite snapshot:

1. Stop the server.
2. Move the old `weight-log.sqlite`, `weight-log.sqlite-wal` and
   `weight-log.sqlite-shm` aside (don't delete them until you're happy).
3. Copy the snapshot to `DATABASE_PATH`.
4. Start the server.

From CSV: sign in to a fresh or existing instance and use **Import CSV**.
Accounts and passwords are not in the CSV; create the account first.

### Schema versions and migrations

The database stores its schema version in SQLite's `PRAGMA user_version`. The
self-hosted server reuses upstream's files, so there is no second copy of the
schema to maintain:

- A **new, empty** database gets `schema.sql` and the current version, which
  is the highest `NNN` in `migrations/NNN-*.sql`.
- An **older** database gets each newer `migrations/NNN-*.sql` applied in
  order at startup, in a single transaction, with foreign keys off and checked
  before commit. Just before that, a snapshot is written next to the database
  as `weight-log.sqlite.pre-vN-<timestamp>.bak`. If anything fails, the
  transaction rolls back and the server refuses to start.
- A database with a **newer** version than the code knows about is refused;
  the app does not guess.
- A **non-empty database without a version** (one this app didn't create) is
  refused rather than modified.

This relies on upstream's convention that `schema.sql` always equals "all
migrations applied": a fresh database therefore starts at the latest version
and runs no migrations.

**Rollback:** after a migration, older app versions refuse to open the
database, by design. To go back, stop the app, restore the
`.pre-vN-*.bak` snapshot (as in Restore), and run the old version. Anything
logged after the upgrade is only in the newer database, so export CSV first
and re-import it afterwards.

## Troubleshooting

- **Sign-in "works" but you land back on the sign-in screen:** the browser
  dropped the cookie. Use `COOKIE_SECURE=false` over plain http.
- **403 "Host … is not in ALLOWED_HOSTS":** add the name from the browser's
  address bar (without the port) to `ALLOWED_HOSTS`.
- **403 "Registration is disabled":** expected. Use `cli.js create-user`.
- **Startup refuses the database:** read the message. The app never
  overwrites or "fixes" a database it doesn't understand; point
  `DATABASE_PATH` at the right file, or restore a backup.
- **`Could not enable WAL mode`:** the data directory is on a network
  filesystem; use local storage.
