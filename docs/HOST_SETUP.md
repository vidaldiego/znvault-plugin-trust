# Host setup — znvault-plugin-trust

One-time setup on every trust node (`trust-api-*`, `trust-worker-*`) before
the plugin can do anything: directory layout, the app user, the scoped
sudoers grant, and the systemd drop-in that lets `sudo` run at all under the
agent's hardened unit. Mirrors `znvault-plugin-archon`'s node-enablement
pattern (`archon-node/docs/superpowers/plans/2026-07-06-archon-deploy-5-cutover.md`
Task 1/2/4). See [Sudo-only write boundary](#sudo-only-write-boundary-optrust)
and [Deployment journal](#deployment-journal) below for how `/opt/trust`'s
permission model and the journal's own storage location are kept separate.

## Layout

```
/opt/trust/
├── releases/
│   ├── 0.1.0/
│   │   ├── api/            # dist/ + prisma/generated/ + prod deps (pnpm --prod deploy)
│   │   ├── web/             # apps/web/dist — static SPA
│   │   ├── systemd/          # trust-api.service, trust-worker.service (reference copies — see below)
│   │   └── manifest.json     # {version, gitSha, builtAt, files: {relPath: sha256}}
│   └── 0.2.0/
│       └── …
└── current -> releases/0.2.0        # RELATIVE symlink, atomic ln -sfn flip
```

The deployment journal (crash evidence for `POST /activate`) is NOT stored
under `/opt/trust` — it lives at
`/var/lib/zn-vault-agent/trust-deploy-journal.json` by default, present only
while an activation is open. See [Deployment journal](#deployment-journal)
below for why, and `TrustPluginConfig.journalPath` to override the path.

`releases/<version>/` and `current` are the ENTIRETY of what lives under
`/opt/trust`, and both are created and mutated exclusively via
`sudo -u trust <tool>` from the agent process — never plain `fs` writes,
never as root, no exceptions — see the [sudoers](#sudoers) section.

The `systemd/` directory inside each release is **not** auto-installed by
this plugin. `trust-api.service` / `trust-worker.service` ship there as
reference copies from the trust repo's `deploy/systemd/` (see
`scripts/build-release.sh`); an operator installs them into
`/etc/systemd/system/` **once, at commissioning** (new node), not on every
deploy. Both units declare `Requires=zn-vault-agent.service`,
`WorkingDirectory=/opt/trust/current/api`, `ExecStart=/usr/bin/node
dist/main.js`, `User=trust`/`Group=trust`, and `PORT=3000`
(`NODE_ROLE=api`/`worker` selects behavior in-process — same compiled
`dist/main.js` on both classes).

## The app user

```bash
sudo groupadd --system trust
sudo useradd --system --gid trust --home-dir /opt/trust --no-create-home \
  --shell /usr/sbin/nologin trust
sudo mkdir -p /opt/trust/releases
sudo chown -R trust:trust /opt/trust
sudo chmod 755 /opt/trust
```

Plain `755` is enough — see the next section for why: `/opt/trust` has
exactly one writer (`sudo -u trust`, which runs as the `trust` user's own
UID regardless of group bits), so no group-write bit or `zn-vault-agent`
group membership is needed here.

## Sudo-only write boundary: `/opt/trust`

Every mutation of `/opt/trust` — `releases/<version>/` and the `current`
symlink alike — goes through `sudo -u trust <tool>` (`mkdir`, `tar`, `ln`,
`rm`, `readlink`, `ls` — see the [sudoers](#sudoers) audit table below). The
`zn-vault-agent` OS user never writes into `/opt/trust` directly, and needs
no group membership or extra permission on it at all — this claim is now
literally true, with no exception. (It wasn't always: this doc used to carve
out an exception for the deployment journal, which lived under `/opt/trust`
and was written directly by the agent process. It has since moved — see
[Deployment journal](#deployment-journal) below — so `/opt/trust`'s
sudo-only boundary is no longer split.)

## Deployment journal

Unlike the release tree, the deployment journal
(`src/deployment-journal.ts`) is read and written directly by the **agent
process itself** — as the `zn-vault-agent` OS user, via plain `node:fs`
(`readFileSync`/`writeFileSync`/`mkdirSync`/`rmSync`/`existsSync`), never
`sudo`. It defaults to `/var/lib/zn-vault-agent/trust-deploy-journal.json`
(`TrustPluginConfig.journalPath` overrides it) — deliberately OUTSIDE
`/opt/trust`, which is reserved exclusively for `sudo -u trust` writes (see
above).

`/var/lib/zn-vault-agent` needs **no extra permission grant on this host**:
it's already in the stock `zn-vault-agent.service` unit's own
`ReadWritePaths=` list (`@zincapp/zn-vault-agent`'s
`deploy/systemd/zn-vault-agent.service`), and it's the agent's own
`WorkingDirectory=`/`HOME=`, owned by the `zn-vault-agent` user that runs the
process — so the agent can create/read/delete the journal file there with
zero additional setup. This is why the old `usermod -aG trust zn-vault-agent`
+ `chmod 2775` (setgid) dance this doc used to document for granting
`zn-vault-agent` direct write access into `/opt/trust` is gone: once the
journal moved out of `/opt/trust`, there was nothing left for that grant to
protect.

**Verify:** `sudo -u zn-vault-agent touch
/var/lib/zn-vault-agent/journal-write-test && sudo -u zn-vault-agent rm
/var/lib/zn-vault-agent/journal-write-test` should succeed with no `sudo`
rule needed for it (the directory is already owned by `zn-vault-agent`).

## Sudoers

### Call-site audit

Every `sudo` invocation the plugin's agent-side code makes, audited against
`src/trust-manager.ts` and `src/release-store.ts` (grepped for every
`this.run('sudo', …)` / `this.sudo([…])` call site — see
`task-6-report.md` for the raw grep). `detect-service.ts`'s
`systemctl list-units` query is deliberately **not** in this table — it runs
without `sudo` (read-only; see that file's own header comment).

| # | Source | Actual invocation | Sudoers coverage |
|---|--------|--------------------|-------------------|
| 1 | `trust-manager.ts:89` (`restart()`) | `sudo systemctl restart <service>` | root rule: `systemctl restart trust-*` |
| 2 | `trust-manager.ts:89` (`start()`) | `sudo systemctl start <service>` | root rule: `systemctl start trust-*` |
| 3 | `trust-manager.ts:89` (`stop()`) | `sudo systemctl stop <service>` | root rule: `systemctl stop trust-*` |
| 4 | `trust-manager.ts:98` (`status()`) | `sudo systemctl is-active <service>` | root rule: `systemctl is-active trust-*` |
| 5 | `release-store.ts:257` (`commitUpload` mkdir) | `sudo -u trust mkdir -p <appRoot>/releases/<version>` | trust rule: `mkdir -p /opt/trust/releases/*` |
| 6 | `release-store.ts:266` (`commitUpload` tar) | `sudo -u trust tar -xzf /tmp/trust-release-<version>.tgz -C <appRoot>/releases/<version>` | trust rule: `tar -xzf /tmp/trust-release-*.tgz -C /opt/trust/releases/*` |
| 7 | `release-store.ts:268` (`commitUpload` post-extract check) | `sudo -u trust ls -1 <appRoot>/releases/<version>` | trust rule: `ls -1 /opt/trust/releases/*` |
| 8 | `release-store.ts:280` (`commitUpload` cleanup on failure) | `sudo -u trust rm -rf <appRoot>/releases/<version>` | trust rule: `rm -rf /opt/trust/releases/*` |
| 9 | `release-store.ts:318` (`activate`) | `sudo -u trust ln -sfn releases/<version> <appRoot>/current` | trust rule: `ln -sfn releases/* /opt/trust/current` |
| 10 | `release-store.ts:330` (`currentVersion`) | `sudo -u trust readlink <appRoot>/current` | trust rule: `readlink /opt/trust/current` |
| 11 | `release-store.ts:345` (`listReleases`) | `sudo -u trust ls -1 <appRoot>/releases` | trust rule: `ls -1 /opt/trust/releases` |
| 12 | `release-store.ts:387` (`prune`) | `sudo -u trust rm -rf <appRoot>/releases/<version>` | trust rule: `rm -rf /opt/trust/releases/*` (same as #8) |

Distinct tools: `systemctl` (root), `mkdir`, `tar`, `ls` (two argument
shapes), `rm`, `ln`, `readlink` (as `trust`) — 7 tools, matching
`release-store.ts`'s own header comment ("mkdir, tar, ln, rm, readlink …
plus ls"), plus `systemctl` for service lifecycle. Every line below maps 1:1
to a row above — **do not trim a line without re-running the grep audit**
(`grep -rn "this\.sudo\|this\.run(" src/`).

### The file

`/etc/sudoers.d/zn-vault-agent-trust` (paths assume Ubuntu's coreutils
layout — verify with `which mkdir tar ls rm ln readlink systemctl` on the
actual host and adjust if it differs, e.g. `/bin` vs `/usr/bin`):

```
# Scoped privileges for the trust deploy plugin (znvault-plugin-trust),
# executed by the zn-vault-agent service user. Mirrors the scoping pattern
# of /etc/sudoers.d/zn-vault-agent-archon (znvault-plugin-archon) — root-only
# systemctl verbs on the trust-* unit glob, and app-user-scoped release-tree
# file operations. Every line maps 1:1 to a sudo call site in
# src/trust-manager.ts / src/release-store.ts — see the audit table in
# docs/HOST_SETUP.md before trimming or adding a line.
#
# Note on the '*' globs below: sudoers matches Cmnd arguments with fnmatch(3)
# WITHOUT FNM_PATHNAME, so '*' matches '/' too (this is standard sudoers
# behavior, not a mistake) — e.g. /opt/trust/releases/* also matches a
# deeper path. Traversal ('..') is guarded at the application layer, not
# here: ReleaseStore's VERSION_RE (^[A-Za-z0-9][A-Za-z0-9._-]*$) rejects any
# version string containing '/' or a leading '.' before it ever reaches a
# sudo call, so the args these rules see are already sanitized upstream.

# Service lifecycle (trust-manager.ts) — root, glob covers trust-api.service
# and trust-worker.service without a per-node override.
zn-vault-agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart trust-*, /usr/bin/systemctl start trust-*, /usr/bin/systemctl stop trust-*, /usr/bin/systemctl is-active trust-*

# Release-tree operations (release-store.ts) — run as the app user `trust`,
# scoped to /opt/trust/releases and /opt/trust/current only.
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/mkdir -p /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/tar -xzf /tmp/trust-release-*.tgz -C /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/ls -1 /opt/trust/releases, /usr/bin/ls -1 /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/rm -rf /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/ln -sfn releases/* /opt/trust/current
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/readlink /opt/trust/current
```

### Install + verify

```bash
sudo tee /etc/sudoers.d/zn-vault-agent-trust >/dev/null <<'EOF'
# Scoped privileges for the trust deploy plugin (znvault-plugin-trust).
# See docs/HOST_SETUP.md in @zincapp/znvault-plugin-trust for the audit
# table every line here maps to.
zn-vault-agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart trust-*, /usr/bin/systemctl start trust-*, /usr/bin/systemctl stop trust-*, /usr/bin/systemctl is-active trust-*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/mkdir -p /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/tar -xzf /tmp/trust-release-*.tgz -C /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/ls -1 /opt/trust/releases, /usr/bin/ls -1 /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/rm -rf /opt/trust/releases/*
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/ln -sfn releases/* /opt/trust/current
zn-vault-agent ALL=(trust) NOPASSWD: /usr/bin/readlink /opt/trust/current
EOF
sudo chmod 440 /etc/sudoers.d/zn-vault-agent-trust
sudo visudo -cf /etc/sudoers.d/zn-vault-agent-trust
```

Expected: `/etc/sudoers.d/zn-vault-agent-trust: parsed OK`. If it isn't,
`visudo` refuses the file and it is never installed — fix the reported line
and re-run before moving on; a syntactically broken sudoers.d file can lock
out sudo system-wide on some configurations, so never skip this check.

## The `NoNewPrivileges` drop-in

The stock `zn-vault-agent.service` unit
(`@zincapp/zn-vault-agent`'s `deploy/systemd/zn-vault-agent.service`) sets
`NoNewPrivileges=true` **and** `ProtectSystem=strict`. Both matter here,
for different reasons:

- `NoNewPrivileges=true` blocks `sudo` outright — the kernel refuses the
  privilege-escalating `execve` of the setuid `sudo` binary, full stop.
  Every sudo call in the [audit table](#call-site-audit) above silently
  fails until this is lifted for the unit.
- `ProtectSystem=strict` bind-mounts almost the entire filesystem read-only
  **inside the unit's mount namespace** — and that namespace is inherited by
  every process the agent spawns, including `sudo`'s children (`tar`,
  `mkdir`, …), since `sudo` itself does not create a new mount namespace.
  `/opt/trust` is not in the stock unit's `ReadWritePaths=`, so without an
  explicit grant every sudo'd write would fail with a read-only-filesystem
  error even though `NoNewPrivileges` is fixed and the sudoers rule matches.
  This grant is **solely** for the release-tree's own `sudo -u trust` writes
  (`mkdir`, `tar -xzf`, `ln -sfn`, `rm -rf` under `/opt/trust/releases`) — the
  deployment journal needs no such grant at all, since it lives under
  `/var/lib/zn-vault-agent`, already in the stock unit's `ReadWritePaths=`
  (see [Deployment journal](#deployment-journal) above).

One drop-in fixes both:

```bash
sudo mkdir -p /etc/systemd/system/zn-vault-agent.service.d
sudo tee /etc/systemd/system/zn-vault-agent.service.d/20-trust-sudo.conf >/dev/null <<'EOF'
[Service]
NoNewPrivileges=false
ReadWritePaths=/opt/trust
EOF
sudo systemctl daemon-reload
sudo systemctl restart zn-vault-agent
```

Verify against the archon precedent first if this is the first plugin
enabled on a given node/fleet generation (`znvault-plugin-archon`'s Task 1
Step 1: inspect a live archon node's unit for the same override, confirm
`NoNewPrivileges=false` — or an equivalent — is really what makes its sudo
work, rather than inventing a new mechanism). `ReadWritePaths=/opt/trust`
is additive to (does not replace) the stock unit's own `ReadWritePaths=`
list (`/etc/ssl/znvault`, `/var/lib/zn-vault-agent`,
`/var/log/zn-vault-agent`, `/etc/zn-vault-agent`) — systemd merges drop-in
directives with the base unit rather than overriding them for list-type
settings like this one.

`/tmp` needs no entry here: the stock unit already sets `PrivateTmp=true`,
which gives the whole unit (agent process **and** every sudo'd child in the
same mount namespace) its own private, writable `/tmp` regardless of
`ProtectSystem=strict`. The chunked-upload buffer
(`/tmp/trust-release-<version>.tgz{.part,}`, written by plain Node `fs` from
the agent process and later read by `sudo -u trust tar -xzf …`) works
correctly precisely because both the write and the sudo'd read happen inside
that same private namespace — don't be surprised that it's invisible from a
real host-level `ls /tmp`.

## RuntimeDirectory

Not a trust-specific concern — this is the same, already-known
`zn-vault-agent` gotcha every plugin hits: the stock installed unit has no
`RuntimeDirectory=`, so `/run/zn-vault-agent` (which the `trust-api.service`/
`trust-worker.service` units read their vault-rendered secrets from —
`VAULT_AGENT_SECRETS_DIR=/run/zn-vault-agent/secrets`) is never
auto-created. `@zincapp/znvault-plugin-vsphere`'s `enroll` command fixes
this automatically as part of node enrollment (its "Gotcha 3"); if a trust
node was enrolled some other way, apply the same fix by hand:

```bash
printf '[Service]\nRuntimeDirectory=zn-vault-agent\nRuntimeDirectoryMode=0755\n' \
  | sudo tee /etc/systemd/system/zn-vault-agent.service.d/runtime-dir.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart zn-vault-agent
```

This is unrelated to (and independent of) `20-trust-sudo.conf` above — both
drop-ins coexist as separate files under `zn-vault-agent.service.d/`.

## Host config: `plugins[]`

In the node's `/etc/zn-vault-agent/config.json` (or wherever
`CONFIG_SOURCE` resolves it from — vault-agent-files/config-from-vault, per
the node's actual provisioning mode):

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

`service` is omitted on purpose — see the main
[README's install section](../README.md#install) for why (auto-detection,
one shared `trust-fleet` host config for both api and worker nodes, same
pattern as archon in production). `appRoot`/`user` above are also the
plugin's own defaults (`/opt/trust`/`trust` — `src/trust-manager.ts`'s
`resolveConfig`), so this block is really just documenting the defaults
explicitly rather than relying on them silently; omitting `config` entirely
would behave identically as long as the layout matches this doc.
`journalPath` (default `/var/lib/zn-vault-agent/trust-deploy-journal.json`)
is a third overridable field on the same `resolveConfig` — see
[Deployment journal](#deployment-journal) above — omitted here for the same
reason.

## systemd units

`trust-api.service` and `trust-worker.service` are **not installed or
managed by this plugin**. They ship inside every release tarball under
`systemd/` (copied from the trust repo's `deploy/systemd/` by
`scripts/build-release.sh`) purely as reference/audit copies — a
`git blame`-able record of what's actually running, alongside the code that
produced it. Installing them into `/etc/systemd/system/` is a **one-time
commissioning step** for a new node (part of VM provisioning /
`znvault-plugin-vsphere`'s territory, or done by hand for now), not
something `deploy run` repeats on every release. If a unit file itself needs
to change (a new `Environment=` line, a resource limit), that's a manual
`sudo systemctl edit`/reinstall on affected nodes — the deploy plugin only
ever flips `current` and restarts the already-installed unit.

## Checklist

- [ ] `trust` system user + group created, `/opt/trust` owned `trust:trust`, mode `755`
- [ ] `/etc/sudoers.d/zn-vault-agent-trust` installed, `visudo -cf` reports "parsed OK"
- [ ] `/etc/systemd/system/zn-vault-agent.service.d/20-trust-sudo.conf` installed (`NoNewPrivileges=false` + `ReadWritePaths=/opt/trust`, for the release-tree's own sudo'd writes — the journal needs no grant, see [Deployment journal](#deployment-journal))
- [ ] `RuntimeDirectory=zn-vault-agent` drop-in present (verify: `ls /run/zn-vault-agent`)
- [ ] `trust-api.service` / `trust-worker.service` installed under `/etc/systemd/system/`, `Requires=zn-vault-agent.service`
- [ ] `zn-vault-agent` restarted after all of the above; `systemctl is-active zn-vault-agent` and `curl -fsS http://127.0.0.1:9100/health` both healthy, with `trust` listed under `plugins`
- [ ] `@zincapp/znvault-plugin-trust` declared in `plugins[]` in the node's agent config
