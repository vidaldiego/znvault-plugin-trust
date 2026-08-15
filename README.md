# @zincapp/znvault-plugin-trust

Trust portal deployment plugin for the **zn-vault-agent** (agent side) and the
**znvault CLI** (operator side). It deploys the [trust](https://github.com/vidaldiego/trust)
ISMS portal with a vault-native, key-less flow: release-directory upload +
atomic symlink activation, Prisma migrations through a short-lived
dynamic-secrets lease, a 1+R canary on the `api` class with HAProxy drain, and
a non-blocking sequential rollout of the `workers` class deployed **first**.

It also carries [`znvault trust incident`](#incident-capture-from-any-repository)
— the CLI half of ISMS incident capture, which talks to the running portal's own
API rather than to the agent.

Dual entry:

- **Agent** (`.` → `dist/index.js`) — `createTrustPlugin(config)` mounts the
  Fastify routes zn-vault-agent serves under `/plugins/trust/*` (status,
  chunked release upload, activate, rollback, restart/start/stop).
- **CLI** (`./cli` → `dist/cli.js`) — the `znvault trust …` command set.

## What this is, and why it differs from archon

`@zincapp/znvault-plugin-archon` deploys by diffing a local build tree against
each node's file hashes and writing only the changed files in place
(`sudo install -o archon -g archon ...` per file), then running `npm ci` /
`npx prisma generate` **on the node itself**. That works because
`archon-node` is a plain single-package npm repo — the node's own
`node_modules` is exactly what `npm ci` reproduces from `package-lock.json`.

Trust is a **pnpm workspace monorepo** (`apps/api`, `apps/web`, `sdk/…`,
`workspace:^` internal deps). Diffing and patching a pnpm-managed
`node_modules` tree in place is fragile — pnpm's `node_modules` is a maze of
symlinks into a shared content-addressable store that doesn't exist on a
freshly provisioned node, and diff-then-write semantics don't compose cleanly
with symlinks. So this plugin uses a **deliberately different** deploy shape:

1. `trust`'s own `pnpm build:release <version>` (`scripts/build-release.sh`)
   produces a **fully self-contained release directory** —
   `release/trust-<version>/{api,web,systemd,manifest.json}` — using pnpm's
   `--prod deploy`, which *materializes* the resolved workspace dependency
   tree into real files (no symlinks, no pnpm store reference). The API's
   compiled `dist/` and its custom-output Prisma client are copied back in
   explicitly (`build-release.sh` documents exactly which paths `pnpm deploy`
   drops and why).
2. The CLI tars that directory **once** and chunked-uploads the identical
   tarball to every host that isn't already at the target version
   (`POST /plugins/trust/release/chunk` — see [`deploy run`](#deploy-run)
   below).
3. Each agent extracts it to `<appRoot>/releases/<version>/` as the app user
   (`sudo -u trust tar -xzf … -C …`) and, on `POST /activate`, flips
   `<appRoot>/current` to `releases/<version>` with a single atomic
   `ln -sfn` — never a partial multi-file write.

**Why this is the right trade-off for trust specifically:**

- **No package manager needed on the node.** The release tarball already
  contains everything `node dist/main.js` needs to run — no `pnpm`/`npm`
  install step, no workspace root, no lockfile, on the production host at
  all. `pnpm` doesn't even need to be installed there.
- **Instant, safe rollback.** Every release is a complete, immutable
  directory. Rolling back is one `ln -sfn releases/<old> current` + a service
  restart (`POST /rollback` — see below) — never a re-diff, and there is no
  window where the app tree is a hybrid of two versions (a real risk with
  diff-apply if a deploy is interrupted mid-write).
- **pnpm-symlink-safe by construction.** Because the release directory is
  produced by `pnpm --prod deploy` (which resolves and copies, not
  symlinks) rather than shipped as a live pnpm workspace, there is no
  symlink-vs-diff mismatch to reconcile on the node.

The trade-off this accepts: a full release tarball ships on every deploy
(even a one-line change), not just the changed files. For trust's release
size this is a deliberate, accepted cost in exchange for the reliability
properties above.

## Install

```bash
# operator machine (CLI plugin):
znvault plugin install trust
# (equivalent to `znvault plugin install @zincapp/znvault-plugin-trust` —
#  `znvault plugin install <name>` resolves a short name against the
#  @zincapp/znvault-plugin- prefix)

# each trust node (agent-side; node agents run with auto-update disabled):
sudo npm install -g @zincapp/znvault-plugin-trust@<version>
sudo systemctl restart zn-vault-agent
```

The agent side also needs the plugin declared in the node's
`/etc/zn-vault-agent/config.json`:

```json
{
  "plugins": [
    {
      "package": "@zincapp/znvault-plugin-trust",
      "config": { "appRoot": "/opt/trust", "user": "trust" }
    }
  ]
}
```

`service` is **deliberately omitted** — a `trust-fleet` host config is shared
by every trust node (api and worker alike), and the plugin **auto-detects**
the single installed `trust-*.service` unit on each host at request time
(`detectTrustService`, `systemctl list-units --type=service --all trust-*`,
no sudo needed for this read-only query). Set `service` explicitly only on a
host that somehow runs more than one `trust-*.service` — detection throws
(never guesses) when it finds zero or more than one.

Full node-side directory layout, the complete sudoers grant, and the
`NoNewPrivileges` drop-in are in [`docs/HOST_SETUP.md`](docs/HOST_SETUP.md).
VM provisioning + agent enrollment for a brand-new trust node is
`@zincapp/znvault-plugin-vsphere`'s job, not this plugin's — see that
package's README.

Peer: `@zincapp/zn-vault-agent` (agent side) / `@zincapp/znvault-cli` (CLI
side), both optional peer dependencies — install whichever half you need.
Requires Node ≥ 20.

## Config: the `prod` deployment

`znvault trust config …` manages saved `TrustDeployConfig` documents at
`~/.znvault/trust/configs.json` (one JSON file per named config, authored as
a whole document — not built up field by field). Below is the full shape of a
production config, with every deployment-specific value replaced by a
placeholder: the addresses are RFC 5737 documentation ranges (`192.0.2.0/24`
for trust nodes, `198.51.100.0/24` for the HAProxy edge), and the paths, SSH
user, and role id are examples — substitute your own fleet's values.

```json
{
  "trustRepoPath": "/home/operator/src/trust",
  "releaseDir": "/home/operator/src/trust/release/trust-<version>",
  "port": 9100,
  "tunnel": true,
  "ssh": { "user": "ops" },
  "hostnames": {
    "192.0.2.35": "trust-worker-1",
    "192.0.2.36": "trust-worker-2",
    "192.0.2.30": "trust-api-1",
    "192.0.2.31": "trust-api-2"
  },
  "classes": [
    {
      "name": "workers",
      "hosts": ["192.0.2.35", "192.0.2.36"],
      "strategy": "sequential"
    },
    {
      "name": "api",
      "hosts": ["192.0.2.30", "192.0.2.31"],
      "strategy": "1+R",
      "haproxy": {
        "hosts": ["198.51.100.20", "198.51.100.21", "198.51.100.22"],
        "backend": "trust_backend",
        "serverMap": {
          "192.0.2.30": "trust-api-1",
          "192.0.2.31": "trust-api-2"
        }
      },
      "healthCheck": { "path": "/healthz", "port": 3000 }
    }
  ],
  "migration": {
    "roleId": "dbr_<pendiente>",
    "migrationsDir": "/home/operator/src/trust/apps/api/prisma/migrations"
  }
}
```

```bash
znvault trust config set prod --file trust-prod.json
znvault trust config show prod
znvault trust config list
```

Field-by-field notes:

- **`workers` is listed BEFORE `api`, deliberately.** This is a config
  *authoring* convention, not a flag: `executeMultiClassDeployment` runs
  classes strictly in the order the `classes` array is written.
  `validateTrustConfig` **warns** (does not error) if a class named
  `workers` appears after a class that actively drains on HAProxy — put
  workers first in the array to get the spec-mandated "workers, then api"
  order.
- **`hostnames` is REQUIRED** and must have an entry for every host across
  every class. It exists to close a gap `POST /activate`/`POST /rollback`
  otherwise couldn't close without touching the agent's HTTP contract: those
  routes require `confirm` to equal the target node's own OS hostname (see
  [Confirm semantics](#tokenjournalconfirm-semantics) below), but
  `GET /status` has no hostname field to read it back from. Rather than add
  one to the agent (out of scope for the divergence that shipped this
  plugin), the deploy config carries the operator-declared map instead —
  `deploy run` uses `config.hostnames[host]` automatically as each host's
  `confirm`; `config set`/`deploy run` both refuse to proceed if any
  configured host is missing an entry.
- **`migration.migrationsDir` is set but never read by trust's own runner.**
  `@zincapp/znvault-deploy-core`'s generic `validateDeployConfig` requires a
  non-empty `migrationsDir` on any `migration` block (it's generic across
  every deployer plugin). Trust's actual migration runner
  (`src/cli/migration-runner.ts`) ignores it entirely — it always runs
  `npx prisma migrate deploy` with `cwd = <trustRepoPath>/apps/api`, letting
  Prisma discover its own `prisma/schema.prisma` and migration history from
  there. Point it at trust's real migrations directory anyway (as above) so
  the field is truthful for anyone reading the saved config, even though the
  plugin doesn't consult it.
- **`migration.roleId`** is the dynamic-secrets write role for the Prisma
  migration lease — `dbr_<pendiente>` above is a literal placeholder: the
  role doesn't exist yet (trust's Postgres/PgBouncer infra from spec §6 is
  not provisioned as of this writing). Replace it with the real role id once
  `zn-vault` has a dynamic-secrets connection + role for trust's Patroni
  cluster.
- **`healthCheck` on the `api` class only.** Workers have no HTTP health
  endpoint gate — see [`deploy run`](#deploy-run) for how worker activation
  is confirmed instead (`GET /status` polling).
- **`tunnel: true` + `ssh.user`** — every agent call goes through an
  SSH-CA-authenticated local port-forward (`znvault ssh forward`) rather than
  connecting to `:9100` directly, so the agent can (and should) bind
  loopback-only, matching `zn-vault-agent`'s and archon's precedent.

## Commands

```bash
znvault trust config list
znvault trust config show prod
znvault trust config set prod --file trust-prod.json

znvault trust deploy run prod --version 0.2.0 [--dry-run|--class …|--skip-migrations|--pre-only|--post-only|--skip-drain]
znvault trust status prod
znvault trust rollback prod --host <ip> --to <version> --confirm <hostname>

znvault trust incident capture  --summary … [--type …] [--severity …] [--control A.5.24]… [--detail k=v]… [--file post-mortem.md] [--id <key>]
znvault trust incident list     [--status …] [--severity …] [--pending]
znvault trust incident show     <id>
znvault trust incident promote  <id> --severity … [--regime …] [--title …]
znvault trust incident timeline <id> --at <iso> --what …
znvault trust incident evidence <id> --file … [--control A.8.15]… [--note …]
znvault trust incident close    <id> --root-cause … [--action …]… [--action-priority …]
```

Every command takes `--json` (machine-readable, human lines suppressed) and
`--api-url` (default `$TRUST_API`, then `https://trust.zincapp.com`).

### `deploy run`

```bash
znvault trust deploy run prod --version 0.2.0 --dry-run   # plan only, no lease, no upload, no files
znvault trust deploy run prod --version 0.2.0              # the real thing
znvault trust deploy run prod --version 0.2.0 --class workers   # scoped — auto-skips post-deploy migrations
znvault trust deploy run prod --pre-only                        # run only the pre-deploy migration, then stop
znvault trust deploy run prod --post-only                       # run only the post-deploy migration — recovery
znvault trust deploy run prod --version 0.2.0 --skip-drain       # deploy api without HAProxy drain (emergency only)
```

`--version` is **required** when `releaseDir` contains the literal
`<version>` placeholder (as in the example above — there's no directory to
read a manifest from before the version is known). Without a placeholder,
`--version` is optional: omitted, the version is read from
`<releaseDir>/manifest.json`'s `"version"` field — the same manifest
`build-release.sh` writes and the same one the agent checks for
post-extraction (a tarball missing `manifest.json` is rejected as an
incomplete release).

Order of operations for a full `deploy run`:

1. **Pre-deploy migration** (unless `--skip-migrations`/`--pre-only`/
   `--post-only`) — mints a dynamic-secrets lease scoped to
   `migration.roleId`, runs `npx prisma migrate deploy` from the *operator
   machine* (`cwd = <trustRepoPath>/apps/api`), revokes the lease. Trust
   treats a missing `migration.roleId` as a **hard error** unless
   `--skip-migrations` is explicit — unlike archon/payara, which silently
   no-op an absent migration config.
2. Resolve the release version + tar `releaseDir` **once** (reused for every
   host — the tarball is never rebuilt per-host).
3. **`workers` class** (sequential, non-blocking): for each host — skip if
   already at the target version, else chunked-upload the tarball,
   `POST /activate {version, confirm: hostnames[host]}`, then poll
   `GET /status` (10 attempts × 3s) until `active: true` at the target
   version. A worker that never reaches active is logged as a **non-blocking**
   failure — it does not abort the rollout or fail the api class.
4. **`api` class** (1+R canary, HAProxy drain): status-check + upload happen
   **outside** any drain window (a host already current is never drained for
   nothing); then per host — drain on HAProxy → `POST /activate` → HTTP
   health-gate (`healthCheck`, 5 retries × 3s by default) → ready on HAProxy.
   A health-gate failure re-readies the node (via a `finally`) and aborts the
   canary — the remaining `api` hosts are skipped, no rollback is attempted
   (forward-compat invariant, same as archon).
5. **Post-deploy migration gate** — runs only if the rollout achieved full
   coverage with no failures and wasn't a `--class`-scoped subset; otherwise
   skipped with a reason-tagged log line (`--skip-migrations`,
   `scoped-subset`, or `partial-coverage`).

### `status`

```bash
znvault trust status prod
```

```
Class    Host            Service              Active  Version  Journal Open
workers  192.0.2.35   trust-worker.service  true    0.2.0    false
workers  192.0.2.36   trust-worker.service  true    0.2.0    false
api      192.0.2.30   trust-api.service     true    0.2.0    false
api      192.0.2.31   trust-api.service     true    0.2.0    false
```

`GET /plugins/trust/status` on each host, tunneled if `config.tunnel` is set.
`service`/`active` fall back to `(unknown)`/`false` on detection ambiguity
rather than erroring the whole row (see [Service auto-detection](#install)).

### `rollback`

```bash
znvault trust rollback prod --host 192.0.2.30 --to 0.1.0 --confirm trust-api-1
```

Single-host only, no HAProxy drain of its own (it's a short, already-known-
good flip back — pull the node out of rotation manually first if it's
serving live traffic and you want a clean cutover). `--host`, `--to`, and
`--confirm` are all `commander` `requiredOption`s — commander itself refuses
to run the action without them, before any network call.

## Incident capture from any repository

`znvault trust incident …` is the odd one out in this plugin: it does **not**
talk to the zn-vault-agent's `/plugins/trust/*` routes on a node. It talks to
the Trust **portal's** own API (`/api/v1/…`) as an authenticated ISMS user. It
lives here because that is where an operator looks for anything trust-shaped,
not because it shares a transport with `deploy`.

It exists because of a measurable gap: the portal's incident register is at
**zero** while a sweep of this workspace's 57 repositories finds **~40 real,
documented incidents**. The analysis is not missing — there are cronologies to
the millisecond and root causes proven with packet captures. It just never
leaves the repository where it happened, because the moment you hit an incident
is the worst possible moment to ask anyone to open a browser and fill in a form.
So capture has to cost seconds, from wherever you already are.

Design: [`trust/docs/2026-08-15-captura-de-incidentes-desde-cualquier-repo.md`](https://github.com/vidaldiego/trust)
(§4.2 is this command family; §4.1 the API it calls; §4.3 the MCP tools).

### Authentication — vault, never a flag

The portal has no long-lived service key: the only non-interactive way in is a
local account with a password and TOTP (internal humans sign in with Google SSO
and have no password at all). The CLI authenticates as the dedicated
**`import-bot`** account, whose credential lives in vault at
**`trust/import-manager`** as `{ "email": …, "password": …, "totpSecret": … }`.

It is read **in-process through the CLI's own authenticated vault client** — the
same session `znvault secret decrypt` would use — so there is nothing to
configure and nothing to pass. **There is deliberately no `--password` /
`--totp` flag:** a credential on a command line lands in `~/.zsh_history`
verbatim, which is both factors of an ISMS account leaked into a file nobody
ever rotates.

For CI, three env vars override vault, in this order of precedence:

| Variable | Purpose |
|---|---|
| `TRUST_EMAIL` / `TRUST_PASSWORD` / `TRUST_TOTP_SECRET` | Explicit credential (base32 **seed**, not a code) |
| `TRUST_TOTP` | A pre-generated 6-digit code, instead of the seed |
| `TRUST_CREDENTIALS_JSON` | Captured output of `znvault secret decrypt trust/import-manager --json` |
| `TRUST_CREDENTIAL_ALIAS` | Read the credential from a different vault alias |

`TRUST_CREDENTIALS_JSON` is parsed **line by line**, not by seeking the first
`{`: `znvault … --json` prints a banner before the payload unless `-q` is
passed, and that banner itself starts with `[` (`[znvault v4.19.0] [profile:
prod]`), so a naive bracket scan lands *inside it*. The same two failure modes
that trust's own import scripts hit are handled with an instruction rather than
a diagnosis — an unsubstituted `…` placeholder, and a 6-digit code put where the
base32 seed belongs.

### `incident capture`

```bash
# a candidate, captured in seconds from the repo where it happened
znvault trust incident capture \
  --summary "etcd filled to 2GB and took Patroni down" \
  --type outage --severity CRITICAL \
  --control A.8.16 --detail host=etcd-1

# an already-written post-mortem, loaded whole
znvault trust incident capture --file docs/POSTMORTEM-2026-06-13-etcd.md --severity HIGH
```

A capture creates a **candidate** (`SecurityEvent`), not an incident. That is
the portal's charter — "AI-augmented, human-decided" — and it is also what keeps
false positives out of the register an auditor reads. A person confirms severity
and regime at `promote`.

**The id is derived, deterministic, and printed.** Without `--id` the
idempotency key is `<repo>/<slug-or-path>@<sha256[0:8]>`:

```
teltonika-gateway/etcd-filled-to-2gb-and-took-patroni-down@3f7a21c9
trust/docs/POSTMORTEM-2026-06-13-etcd.md@9b40e1d2
```

- the repository name comes from `git rev-parse --show-toplevel` (falling back
  to the working directory's basename outside a checkout — a capture from
  `/var/log` still beats no capture);
- a **candidate** is keyed on the summary, normalised for case, punctuation and
  whitespace, so the same finding retyped a week later maps to the same key;
- a **post-mortem** is keyed on its path relative to the repo root, so editing
  the document's wording updates the existing incident instead of minting a
  second one.

Never random, never seeded from the clock: the API is idempotent on this key, so
an unstable one would turn every re-run into a duplicate. The derived key is
always printed — reuse it verbatim with `--id`.

`--file` goes through **`POST /api/v1/incidents/ingest`**, which already exists,
is already idempotent, and already reports dropped control codes. It reads the
title from the first `# ` heading and the cronology from a `Timeline` /
`Cronología` section (list items or a markdown table). A bare wall-clock time is
anchored to the date in the filename and read as **UTC** — deliberately not the
machine's local zone, so the same document ingests identically from a Mac and
from the UTC dev VM — and the original reading is kept in the note text so
nothing is lost. A document with no recognisable cronology is still ingested,
with a warning.

`capture` also attaches the repository and the current short commit as `detail`
without being asked; `--detail k=v` adds anything else.

### A bad control code never costs a capture

The API answers an unknown control code with `droppedControlCodes` instead of
rejecting the request, and this CLI mirrors that exactly: the dropped codes come
out as a loud warning, the capture is still recorded, and the exit code is still
0. Losing an entire incident to a mistyped `A.5.24` is the worst outcome
available here.

Severities are translated rather than refused, too. A candidate takes
`INFO|WARNING|CRITICAL` and an incident `LOW|MEDIUM|HIGH|CRITICAL`; passing one
vocabulary where the other belongs maps it across and says so.

### `promote` and `close` are human commands

Both exist here and **neither has an MCP counterpart** (design §4.3 ships
`capture_incident`, `list_incidents`, `get_incident`, `add_incident_timeline`
and `attach_incident_evidence`, and stops there). That asymmetry is not an
oversight: confirming that a candidate is a real incident at a chosen severity,
and declaring an incident closed, are the two acts of judgement the portal's
founding act reserves to a person. **That an agent cannot close an incident is
not a technical limitation — it is the control.**

```bash
znvault trust incident promote evt-1 --severity HIGH [--regime GDPR_BREACH]
znvault trust incident close inc-7 --root-cause "etcd never auto-compacted" \
  --action "enable auto-compaction on every etcd" --action "alert on db size"
```

`close` records the root cause on the timeline and opens the corrective actions
**before** touching the state, then walks the incident forward through the
server's own forward-only machine (`OPEN → RESOLVED → CLOSED`) rather than
failing with "illegal incident transition OPEN → CLOSED" and leaving you to
guess the ladder.

### `list`, `show`, `timeline`, `evidence`

```bash
znvault trust incident list --pending          # candidates awaiting a human decision
znvault trust incident list --status OPEN
znvault trust incident show <id>               # accepts an incident id OR a candidate id
znvault trust incident timeline inc-7 --at 2026-06-13T09:41:02Z --what "first alert"
znvault trust incident evidence inc-7 --file capture.pcap --control A.8.15 --note "the capture"
```

`evidence` uploads the file as immutable, hashed evidence and links it to the
incident, printing a locally computed SHA-256 so you can see that what the
portal stored is byte-identical to what left the machine.

## Deploy runbook

The full sequence for shipping a new trust release to production, start to
finish:

```bash
# 1. Build the release (in the trust repo — NOT this plugin's repo):
cd /home/operator/src/trust
pnpm build:release 0.2.0
# → release/trust-0.2.0/{api,web,systemd,manifest.json}, verified boot-critical
#   (prisma client, linux query engine, both systemd units) before it exits 0.

# 2. Point the saved config at the new build (only needed once per config —
#    the <version> placeholder in releaseDir means the SAME saved config
#    works for every future release; no edit needed between deploys):
znvault trust config set prod --file trust-prod.json
znvault trust config show prod

# 3. Dry-run — no lease minted, no upload, no files touched on any host:
znvault trust deploy run prod --version 0.2.0 --dry-run

# 4. The real deploy — pre-deploy migration, workers (sequential), api
#    (1+R canary + HAProxy drain), post-deploy migration gate:
znvault trust deploy run prod --version 0.2.0

# 5. Verify:
znvault trust status prod

# 6. Only if step 4/5 surfaced a problem on one host — roll it back:
znvault trust rollback prod --host 192.0.2.30 --to 0.1.0 --confirm trust-api-1
```

A few things worth calling out about this sequence:

- **Step 1 runs in the `trust` repo, not here.** This plugin never builds
  trust — it only ships and activates an already-built release directory.
  `pnpm build:release <version>` is `trust`'s own `scripts/build-release.sh`
  (see [What this is](#what-this-is-and-why-it-differs-from-archon) above
  for what it produces and why).
- **Step 3 is genuinely side-effect-free.** `--dry-run` prints the resolved
  class plan (`printMultiClassDryRun`) and the migration dry-run line
  (`[deploy] [dry-run] would run pre-deploy schema migrations (role
  '<roleId>')`) without minting a lease, tarring anything, or opening a
  connection to any host — safe to run repeatedly while iterating on a
  config.
- **Step 4 is idempotent per host.** A host already at the target version is
  detected via `GET /status` and skipped (no drain, no re-upload) — running
  `deploy run` twice with the same `--version` is not an error, it's a no-op
  on every host that already converged.
- **There is no automatic rollback on failure.** A health-gate or activate
  failure aborts the `api` canary and re-readies the affected node on
  HAProxy, but does **not** revert it to the previous version — step 6
  (`rollback`) is how you actually go backward, and it targets one host at a
  time by design (see [`rollback`](#rollback) above).

## Token/journal/confirm semantics

**Lease (`token`).** The migration runner mints a dynamic-secrets lease
(`ttlSeconds: 14400`, a generous 4h ceiling for a `migrate deploy` that's
revoked immediately after anyway) and never logs the credential — only the
opaque `leaseId`. Revoke ordering is structural, not a check: the lease stays
valid until the `prisma migrate deploy` child process's own `close`/`error`
event fires, then a 1500ms settle (lets Prisma's connection pool finish
closing) precedes the revoke, which itself retries transient failures
(`[200, 600]ms` backoff, 3 attempts total) and gives up — logging, never
throwing — rather than hang the CLI on a stuck revoke (bounded to 5s via
`withTimeout`). This holds on SIGINT/SIGTERM too: the signal handler kills
the child, not the lease, so the same settle-then-revoke path always runs.

**Journal.** Each agent persists a deployment journal at
`/var/lib/zn-vault-agent/trust-deploy-journal.json` by default
(`TrustPluginConfig.journalPath` overrides it — mode `0600`, deliberately
NOT under `<appRoot>`; see [`docs/HOST_SETUP.md`](docs/HOST_SETUP.md#deployment-journal)
for why). `POST /activate` first checks the target version is actually
present (`store.listReleases()`) — an unknown/never-uploaded version is
rejected **400** with **no journal mutation at all**, since that's a caller
mistake, not a mid-flight failure. Only once that passes does it open the
journal **before** `store.activate()` + `mgr.restart()`, closing it only
after **both** succeed. If either throws, the journal is **deliberately
left open** — this is not a bug, it's crash evidence: a half-activated node
(release flipped but the service not yet restarted, or vice versa) must be
detectable, not silently cleared. `GET /status`'s `journalOpen` field
surfaces this — `znvault trust status prod` is the first thing to check
after any deploy that didn't cleanly finish. While a journal is open, both
`POST /activate` and `POST /rollback` refuse with **409** ("Activation in
progress") — this also means a genuinely stuck journal from a past crash
blocks all future activity on that node until an operator clears it: SSH in,
confirm the release that's actually live matches what you expect
(`readlink /opt/trust/current`, `systemctl status trust-*`), then remove the
journal file (`sudo rm /var/lib/zn-vault-agent/trust-deploy-journal.json`)
before retrying. There is no auto-recovery endpoint for this by design — the
crash-evidence model. `POST /rollback` runs the same unknown-version
pre-check (400, no journal to protect either way — it never opens one) so a
typo'd `--to` version gets the same clean mapping instead of falling through
to a generic 500. **Note:** the journal is read/written by the **agent
process itself** (plain `node:fs`, no `sudo`) — its default location under
`/var/lib/zn-vault-agent` needs no extra host permission grant, unlike
`<appRoot>` (`/opt/trust`), which is written exclusively via `sudo -u trust`
— see [`docs/HOST_SETUP.md`](docs/HOST_SETUP.md#deployment-journal).

**Confirm.** Both `POST /activate` and `POST /rollback` require a `confirm`
field equal to the target node's own OS hostname
(`os.hostname()`, read once at journal construction and never re-resolved).
A missing or mismatched `confirm` is a **400**, before anything is touched —
this is the guard against a fat-fingered fleet-wide command hitting the
wrong node. `deploy run` supplies it automatically from `config.hostnames`
(see [Config](#config-the-prod-deployment) above); the standalone
`rollback` command requires the operator to type it explicitly
(`--confirm <hostname>`) as its own extra positive acknowledgement — a typo
here is refused by the node, not silently misapplied.

## Prune: exists, not wired up yet

`ReleaseStore.prune(keep)` deletes old release directories under
`<appRoot>/releases/`, protecting the currently-active release and the
`previous` release from the most recent `activate()` call even if it would
otherwise fall outside the newest-`keep` window. **It is not called from any
HTTP route or any CLI command today** — there is no `POST /prune` and no
`znvault trust … prune` verb. Old releases accumulate under
`/opt/trust/releases/` indefinitely; disk usage on trust nodes should be
monitored, and cleanup today is manual:

```bash
ssh <ssh-user>@<trust-node>
sudo -u trust ls -1 /opt/trust/releases          # see what's there
sudo -u trust readlink /opt/trust/current         # don't delete this one
sudo -u trust rm -rf /opt/trust/releases/<old-version>
```

(The exact commands above are all pre-authorized by the sudoers grant in
`docs/HOST_SETUP.md` — no additional access needed.) Wiring `prune()` to a
route + CLI verb is a natural follow-up, not implemented in this plugin yet.

## Development

```bash
npm install
npm run build           # tsc
npm test                # vitest run (129 tests)
npm run typecheck       # tsc --noEmit
npm run lint             # eslint
npm run build:prod      # clean production build (what `prepublishOnly` runs)
```

Every command handler is wired through injectable deps (`RunFn` for
process-spawn, `DeployCommandDeps` for the CLI's tar/upload/migration-lease
primitives) so the whole suite runs without ever shelling out to `sudo`,
`tar`, `npx prisma`, or touching a real network — see `test/` for the
fakes/mocks each layer uses.

## Release process

Publishing is **tag-triggered, OIDC-based** (no long-lived npm token in
CI): pushing a `v*` tag runs `.github/workflows/publish.yml`, which builds,
tests, then `npm publish --provenance` using npm's Trusted Publishing (npm
picks up the GitHub Actions OIDC token automatically — no `NODE_AUTH_TOKEN`
involved).

**Prerequisite (one-time, manual, done on npmjs.com):** the package's
Trusted Publisher must be registered against this repo + workflow before the
first tagged release can publish — npm rejects the OIDC token otherwise.
This is an owner-level action outside this plugin's own tooling (the same
registration every sibling `znvault-plugin-*` package needed once). Until
it's registered, `v*` tags should not be pushed — the publish job would fail
at the `npm publish` step.

```bash
# Bump the version (edits package.json, no git action):
npm version patch --no-git-tag-version   # or minor/major
git add package.json package-lock.json
git commit -m "chore(release): v0.1.1"

# Tag and push — this is what actually triggers publish.yml:
git tag v0.1.1
git push origin main
git push origin v0.1.1
# → publish.yml builds, tests, and publishes @zincapp/znvault-plugin-trust@0.1.1
```

**Version history note.** `0.1.1` is the first version published through this
workflow, and the first with provenance. `0.1.0` was published manually and
unpublished the same day; that version number is permanently retired and can
never be republished, since npm refuses to reuse an unpublished version.
Every release goes through the tag-triggered workflow above — publishing by
hand from an operator machine is not part of this package's release process.

## License

MIT
