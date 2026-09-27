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
| `AUTH` | `accounts` | `accounts`: normal email and password sign-in, like Cloudflare. `none`: single-user, no sign-in (see below). |
| `ALLOW_REGISTRATION` | `false` | Allow "Create account" in the browser. Off by default. |
| `COOKIE_SECURE` | `false` | Keep the `Secure` flag on the session cookie. Set `true` only if users reach the app over HTTPS. |
| `ALLOWED_HOSTS` | *(any)*; with `AUTH=none`: `localhost,127.0.0.1,[::1]` | Comma-separated host names the server answers to. Others get 403. |
| `OWNER_EMAIL` | `owner@weight-log.local` | With `AUTH=none`: the email given to the single account when it is first created. |

## Authentication

**`AUTH=accounts` (default).** This behaves exactly as on Cloudflare:
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

**`AUTH=none` (single user).** There is no sign-in screen. Every request acts
as the one account in the database, which is created automatically if the
database is empty. Use this only where the network itself is the access
control, such as a Tailscale tailnet or a trusted LAN:

- Anyone who can reach the port can read, change, delete and export
  everything.
- `ALLOWED_HOSTS` must list the names you use in the browser, for example
  `nas.your-tailnet.ts.net,100.101.102.103`. Without it, a malicious web page
  could use DNS rebinding to reach the server from your own browser.
- "Sign out" does nothing useful; reload the page.
- The server refuses to start in this mode if the database has more than one
  account.

**Switching from `AUTH=none` to accounts later** needs no data migration. The
single account is an ordinary account with no password yet:

```bash
node server/cli.js reset-password owner@weight-log.local   # set a password
# then run with AUTH=accounts; add people with create-user
```

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

## Running in a container

`Dockerfile` and `compose.yaml` work with Docker Compose (v2.24+) and with
rootless Podman via `podman-compose`. Everything below was run with Podman
5.4 and podman-compose 1.3; with Docker Compose 2.26 the file was only
validated (`docker compose config`), not run.

```bash
docker compose up --build        # or: podman-compose up --build
# open http://127.0.0.1:8080
```

(`podman compose` without the hyphen runs the Docker compose plugin if it is
installed, which needs a Docker-compatible socket; call `podman-compose`
directly.)

### Trying it out locally (Podman)

From the repository root:

```bash
printf 'AUTH=none\n' > .env     # single user, no sign-in; omit for accounts mode
podman-compose up --build -d    # then open http://127.0.0.1:8080
podman-compose logs -f          # Ctrl-C stops following, not the app
```

Things to try:

- **Import CSV**, using a Hacker's Diet Online export, then page back
  through the months (◀) and compare the trend line, floaters and sinkers.
- **Export CSV**.
- A backup:
  `podman exec weight-log_weight-log_1 node server/cli.js backup /data/backups`
- Persistence: `podman-compose down`, then `podman-compose up -d`. The data
  is still there, because it lives in the named volume, not the container.
- Accounts mode: `rm .env`, then `podman-compose down && podman-compose up -d`.
  The single-user account becomes an ordinary account without a password;
  give it one with
  `podman exec -it weight-log_weight-log_1 node server/cli.js reset-password <email>`.

Clean up:

```bash
podman-compose down
podman volume rm weight-log_weight-log-data   # deletes the test data
rm -f .env
```

The image contains only Node 24 (Alpine) and the app's source files. There is
no `npm install`. It runs as the unprivileged `node` user, has a healthcheck
on `/healthz` (in both the Dockerfile and `compose.yaml`, since Podman ignores
the Dockerfile one), and shuts down cleanly on SIGTERM.

**Data.** Everything persistent is in `/data` inside the container
(`/data/weight-log.sqlite`), and `/data` is always a volume. Removing,
recreating or upgrading the container, or rebuilding the image, doesn't touch
it. Only removing the volume itself (`docker compose down -v`,
`podman volume rm`) deletes a named volume, so don't use `-v`.

**Settings: one env file.** Compose reads `.env` next to `compose.yaml`
(git-ignored), or the file named by `WEIGHT_LOG_ENV_FILE`. With no file, the
defaults apply. The same file holds:

- the container settings below, and
- app settings, which are passed into the container: `AUTH`,
  `ALLOW_REGISTRATION`, `COOKIE_SECURE`, `ALLOWED_HOSTS`, `OWNER_EMAIL`.
  Leave `HOST`, `PORT` and `DATABASE_PATH` alone; the image sets them.

For example, to try single-user mode locally:

```bash
printf 'AUTH=none\n' > .env && docker compose up -d
```

| Variable | Default | Meaning |
|---|---|---|
| `WEIGHT_LOG_BIND` | `127.0.0.1` | Host address the port is published on. |
| `WEIGHT_LOG_PORT` | `8080` | Host port. |
| `WEIGHT_LOG_DATA` | named volume `weight-log_weight-log-data` | Host directory to bind-mount as `/data` instead. |
| `WEIGHT_LOG_UID` / `WEIGHT_LOG_GID` | `1000` | User the app runs as inside the container. See below. |
| `WEIGHT_LOG_IMAGE` | `weight-log:local` | Image name and tag to build or run. |
| `WEIGHT_LOG_ENV_FILE` | `.env` | Env file passed to the container. Set it (in the shell, or in the file given to `--env-file`) when the file isn't `.env`. |

**Bind-mount ownership.** The data directory must be writable by the
container's user:

- **Docker, or rootful Podman:** `chown 1000:1000` the directory, or set
  `WEIGHT_LOG_UID/GID` to its owner.
- **Rootless Podman:** container user 1000 maps to an unrelated host ID, so
  it can't write to your directory, and the app refuses to start ("unable to
  open database file"). Set `WEIGHT_LOG_UID=0` and `WEIGHT_LOG_GID=0`. In
  rootless Podman, the container's root *is* your own unprivileged host user,
  so files are owned by you.

**Admin commands** run inside the container:

```bash
docker compose exec weight-log node server/cli.js create-user you@example.com
docker compose exec weight-log node server/cli.js backup /data/backups
docker compose exec -T weight-log node server/cli.js export-csv you@example.com > weight-log.csv
```

With Podman, use `podman exec -it weight-log_weight-log_1 ...`, or
`podman-compose exec`.

### Release bundles (deploying without a registry)

```bash
npm run image      # builds from the committed HEAD
```

This writes `dist/weight-log-<commit>/`, which contains everything a server
needs. No source tree or registry is required:

- `image.tar.gz`: the image, `localhost/weight-log:<commit>`
- `compose.yaml`: the same file as in the repo
- `release.env`: `WEIGHT_LOG_VERSION` and `WEIGHT_LOG_IMAGE`

To run it on a server by hand (a deployment tool such as Ansible does the
same steps):

```bash
docker load -i image.tar.gz
# settings.env: WEIGHT_LOG_IMAGE from release.env, WEIGHT_LOG_ENV_FILE pointing
# at settings.env itself, plus WEIGHT_LOG_BIND/PORT/DATA and app settings
docker compose -f compose.yaml --env-file settings.env up -d --no-build --force-recreate
```

`--no-build` matters, because the server has no source to build from.
`--force-recreate` matters for podman-compose, which otherwise never
replaces a running container. This was tested with Docker CLI 26.1 and Docker
Compose 2.26, and with podman-compose 1.3.

**Using a registry later.** The image is self-contained, so you can build it
anywhere (a workstation, CI), push it, and set `WEIGHT_LOG_IMAGE` to the
registry name. Then use `pull` and `up -d` instead of loading a bundle.
Nothing else changes.

**Tailscale / LAN access.** Tailscale runs on the host, not in the container.
Publish the port on the host's Tailscale IP (`WEIGHT_LOG_BIND=100.x.y.z`) so
only your tailnet can reach it, or on `0.0.0.0` for the LAN too. Binding to
the Tailscale IP fails if the container starts before Tailscale is up at
boot. If that happens, restart the container once Tailscale is running, or
bind to `0.0.0.0` and firewall the port.

**Starting at boot.** Docker restarts the container itself
(`restart: always`). Rootless Podman has no daemon, so enable the
user's restart service and lingering once:
`systemctl --user enable podman-restart.service` and
`sudo loginctl enable-linger $USER`.

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

In a container, write backups under `/data` (for example `/data/backups`) so
they land on the host, then copy them off the machine. Keep copies somewhere
other than the machine running the app.

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
