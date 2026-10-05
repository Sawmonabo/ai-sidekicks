# Spec-023: Self-Host Secure Defaults

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `023` |
| **Slug** | `self-host-secure-defaults` |
| **Date** | `2026-04-19` |
| **Author(s)** | `Sawmon (Principal Engineer)` |
| **Depends On** | Spec-006, Spec-021, Spec-027; ADR-010, ADR-019; `docs/architecture/deployment-topology.md`, `docs/architecture/security-architecture.md` |
| **Implementation Plan** | Multiple — see Plan Ownership column in §Required Behavior |

## Purpose

A person who `git clone`s the repository and runs the product MUST get a secure deployment without reading a hardening guide. This spec defines the secure-default rows that ship in V1 — each on by default except backups (row 6), which the person turns on — enumerates the override path for each, and names the plan that owns the implementation of each. It exists so the behaviors ship in the app, with a one-page companion naming what is default and how to opt out, rather than as an enterprise-grade requirements document.

How each default is implemented is owned by the plans and ADRs listed in the Plan Ownership column and by the specs that govern adjacent surfaces (most notably [Spec-013 §Backup Policy](./013-persistence-and-recovery.md#backup-policy) for backup internals).

## Scope

- Cross-cutting secure-default behaviors that span the daemon, the self-hostable relay, the CLI, and first-run UX.
- The ten behavior rows enumerated in §Required Behavior.
- Bind-address reconciliation between the relay's container internals (owned by [Spec-027](./027-remote-control.md)) and this spec (daemon host posture).
- Backup internals are [Spec-013 §Backup Policy](./013-persistence-and-recovery.md#backup-policy)'s, and secret custody internals are [Spec-021 §Native Keystore](./021-desktop-app-and-renderer.md#native-keystore)'s.
- The first-run banner's content and format.
- Acceptance criteria that demonstrate each default is active and each active override shows on the start banner.

## Non-Goals

- Backup internals — the backup set, the daily copy and its retention, the mirror, the run timing and restore are owned by [Spec-013 §Backup Policy](./013-persistence-and-recovery.md#backup-policy). This spec only states _that_ backup is off until the person turns it on, and where it goes.
- Secret custody internals — how the service keeps each secret as its own item in the operating system's credential store is owned by [Spec-021 §Native Keystore](./021-desktop-app-and-renderer.md#native-keystore) and [ADR-020](../decisions/020-cli-identity-key-storage-custody.md). This spec only states _that_ secrets are generated on first run, and that the service keeps none of them in the relay's data folder.
- Enterprise items, out of scope for one user: compliance-framework mapping (SOC 2, ISO 27001, HIPAA, FedRAMP), enterprise sign-on (IdP / OIDC / SAML), WAF recommendations, HSM custody, Helm charts, an SLA, offline-root signing infrastructure, multi-region sign-up discovery and server-side telemetry. Each exists to sell to or govern an organization of other people.
- Hardened-image SBOM signing.
- An ACME client of the relay's own. Row 1's issuance and renewal are Caddy's; this spec states the _requirement_ (RFC 9773 ARI).

## Domain Dependencies

- `docs/domain/session-model.md` — the kept sessions whose files a backup holds, and `Delete old data`, after which a backup runs (behavior 6).
- `docs/domain/trust-and-identity.md` — first-run secret generation (behavior 3) and fingerprint-display (behaviors 1, 10) feed the trust ceremony (identity-material provisioning, fingerprint verification ceremony, and the trust-state lifecycle).

## Architectural Dependencies

- `docs/architecture/deployment-topology.md` — self-host topology (relay + Caddy + Postgres, with the daemon on each of the person's machines) is the surface this spec configures.
- `docs/architecture/security-architecture.md` — trust boundaries and secret custody.
- `docs/decisions/010-tokens-passkeys-and-the-remote-channel.md` — the token primitives whose keys the first run generates (behavior 3).
- `docs/decisions/019-v1-deployment-model-and-oss-license.md` — establishes that the relay is the person's own, deployed for themself, which is the deployment these defaults configure.

## Required Behavior

The product MUST implement all ten rows below. Each row has a default that is active with no configuration from the person, an override path (where one exists), the reason the default is what it is, and the plan that owns the implementation.

| # | Behavior | Default (on with no action from the person) | Override | Reason | Plan Ownership |
| --- | --- | --- | --- | --- | --- |
| 1 | **Auto-TLS for the self-hostable relay** | Caddy v2 fronts the relay on `:443`. The person declares `DEPLOY_MODE` at config time; default is `public`. In `DEPLOY_MODE=public`, ACME issuance uses DNS-01 when a DNS provider plugin is configured (wildcard / public hosts via the plugin); HTTP-01 otherwise. Renewals MUST use RFC 9773 ACME Renewal Information (ARI) windows and MUST NOT be rate-limited by fixed thresholds. In `DEPLOY_MODE=lan`, Caddy uses `tls internal` (internal CA) directly — no public-ACME attempt is made, no fallback logic is invoked. The relay MUST refuse at config-parse time if `DEPLOY_MODE=public` is set AND the configured hostname ends in `.localhost`, `.local`, `.home.arpa`, `.internal`, or resolves to an RFC1918 address (public ACME cannot issue for these; Caddy does NOT silently fall back from a failed public-ACME issuance to an internal CA — feature declined upstream, caddyserver/caddy#4735). The relay MUST refuse at config-parse time if `DEPLOY_MODE=lan` is set AND the configured hostname is a publicly-resolvable DNS name not in the LAN-suffix list above (prevents deploying a publicly-reachable admin console under an internal CA that no client trusts). In `DEPLOY_MODE=lan` (internal-CA path), the SPKI-SHA256 pin (RFC 7469, base64) and SSH-style `SHA256:<hex>` whole-cert hash are both printed to stdout and persisted at `./data/trust/fingerprint.txt`. | `--relay-no-tls` permitted only when `RELAY_BIND` is a loopback address (local development on the relay's own host). Any non-loopback bind without TLS MUST be rejected at config-parse time (behavior 2 interaction; for the relay's container-internal bind behind a trusted TLS-terminating front proxy, TLS at the proxy edge satisfies this — see §Bind-Address Reconciliation). | DNS-01 reaches private hosts HTTP-01 cannot. ARI-coordinated renewals are explicitly exempt from Let's Encrypt rate limits (RFC 9773, LE policy 2026). A `DEPLOY_MODE` the person declares replaces runtime auto-detect on a security-critical branch — the person knows whether the deployment is LAN or public; encoding that at parse time is auditable and testable, while auto-detect would put "did Caddy's ACME attempt fail?" on the trust-ceremony hot path. The SPKI pin survives cert rotation on the same keypair; the whole-cert hash matches what browsers display. | Plan-025 (self-host deployment phase); this spec + `docs/operations/self-host-secure-defaults.md` (fingerprint display contract) |
| 2 | **Refuse to start without encryption on non-loopback bind** | The relay, in the Compose deployment, validates `<bind> + <TLS mode>` for every network listener at config-parse time. A non-loopback bind without TLS MUST exit non-zero with a clear error naming the offending option (for the relay's container-internal bind behind a trusted TLS-terminating front proxy, TLS termination at that proxy satisfies this requirement — see §Bind-Address Reconciliation). | `--insecure` flag (or `INSECURE=1` env) starts the relay anyway, and the start banner (row 9) carries its `WARNING:` line on every startup naming (a) that insecure mode is active, (b) the bind address, (c) what traffic is unencrypted. | Supabase's most-reported self-host footgun is placeholder secrets committed in `.env.example` with a docs-only "don't boot with this" warning. A spec that only _documents_ the risk has been shown to fail in the field. Parse-time refusal converts a docs problem into an executable guarantee. | Plan-025 (self-host deployment phase) |
| 3 | **Auto-generated strong secrets on first run** | The relay's first run in the Compose deployment is a one-shot step that Postgres and the relay each wait on, and it generates every secret the deployment makes for itself: the control plane's two token keys via `crypto.randomBytes` (N ≥ 32), the Ed25519 key that signs PASETO v4.public access tokens and the symmetric key that seals v4.local refresh tokens; the Web Push VAPID key pair, an ECDSA P-256 pair the application server makes itself (RFC 8292), whose public key the relay serves to the web client for its push subscription; and the password of the relay's Postgres role via `crypto.randomBytes` (N ≥ 32), written before Postgres first starts and handed to Postgres and to the relay as the same secret file, never through an env var. The APNs and FCM credentials are issued by Apple and Google, so the person supplies them and the relay keeps them ([Plan-025](../plans/025-remote-control.md) Phase 5). Its TLS key is Caddy's, not the relay's. Its persisted files MUST be `0600` (Unix) / appropriate ACL (Windows). Public material — fingerprints, public keys — is printed to **both** stdout AND a header comment in the on-disk file, mirroring `age-keygen`'s UX pattern; private material is only in the file body. Each machine's service mints its identity key at its first start and keeps it, and its channel key, each as its own item in the operating system's credential store ([Spec-021 §Native Keystore](./021-desktop-app-and-renderer.md#native-keystore)), never in the daemon's database. | N/A. Secrets cannot be pre-seeded via env vars or `.env.example`. A sentinel file `./data/trust/first-run.complete` records that the relay's first-run ceremony finished; its absence while the relay's secrets are present MUST block relay start with a clear message naming the sentinel and the secrets found, so that regenerating them is the person's explicit act (§State And Data Implications). The service needs no sentinel: its identity key is an item in the credential store, made at its first start. | The Supabase `.env.example`-placeholder anti-pattern (#42562 covers `generate-keys.sh` writing a non-existent env var) shows that a ship-with-placeholders model leaks into production. `age-keygen`'s public-key-in-header-comment + stderr pattern is the cleanest first-run-key UX. | Plan-025 (self-host deployment phase: the relay's secrets and sentinel; Phase 1: the machine's identity key, minted at the service's first start); Plan-005 (the `DaemonKeyStore` interface the key is kept through); Plan-019 (the daemon's credential store the key is minted into); [Spec-021 §Native Keystore](./021-desktop-app-and-renderer.md#native-keystore) (the credential store) |
| 4 | **Loopback bind by default** | On each machine, the daemon's local IPC is a Unix domain socket or a named pipe with no network address ([Spec-006](./006-local-ipc-and-daemon-control.md)). The Compose deployment runs the relay alone, and its `RELAY_BIND` defaults to `0.0.0.0:8787` _inside the relay container_; see §Bind-Address Reconciliation. | The daemon has no bind setting of its own. The relay's `RELAY_BIND` stays container-internal (§Bind-Address Reconciliation). | Localhost-first blocks the entire class of "daemon accidentally on public Wi-Fi" incidents. External exposure MUST require two explicit actions (bind change AND TLS enablement), not one. | Plan-005 (daemon); Plan-025 (self-host deployment phase) |
| 5 | **Postgres `sslmode=verify-full` + SCRAM sign-in** | The relay's Postgres client MUST default to `sslmode=verify-full`. The relay MUST ship a cert-generation helper that produces a server cert with SAN=`<compose-service-name>` and documents that the relay's connection string must use the same host identifier. The relay's Postgres role signs in with `scram-sha-256` (RFC 7677) over that TLS, with the password row 3's first run generates. The Compose file names the Postgres image it runs. | `sslmode=verify-ca` accepted, shown as the start banner's `WARNING:` line, for a person whose infrastructure genuinely cannot guarantee SAN matching. `disable`, `allow`, `prefer`, `require` MUST be refused at config-parse time. | The default is `verify-full` rather than `require` because `require` is MITM-exploitable (CVE-2024-10977, 2024-11-14 — libpq error-message injection) and `verify-full` is the MITM-defeating posture. | Plan-025 (self-host deployment phase) |
| 6 | **Backups, off until the person turns them on** | Off: nothing is backed up until the person turns on `Back up automatically` under Runtime's `Backups`. The folder is `<home>/.ai-sidekicks/backups` by default, at mode `0700`; on a Windows computer whose service runs in WSL it is the Windows home's `.ai-sidekicks\backups`, so the backups outlive the distribution. Once on, the service copies its database whole once a day and after every `Delete old data`, keeps 7 daily and 4 weekly copies, and keeps the machine's settings file, the conversation files, chat workspaces, checkpoint copies and the agent memory folder as one mirror. The service never uploads a backup. | `Back up automatically` and `Back up to` with `Choose…` (any folder, an external drive or a synced folder included) on Runtime, carried in the machine's settings file; `Back up now`; `Restore…`, and `sidekicks db restore <backup>` on a machine with no app. Off is the default, not an override, so the banner shows no `WARNING:` line for it. | Whether and where copies of the person's sessions are kept is the person's choice, and a folder on another drive is what protects against losing the disk. While the folder is on the service's own disk, Runtime says so: `Backups on this disk undo a bad update or a mistaken delete. Only a folder on another drive protects against losing the disk.` [Spec-013 §Backup Policy](./013-persistence-and-recovery.md#backup-policy) owns how a backup runs (see §How A Backup Runs). | Plan-005 (the service's backup job and `sidekicks db restore`) + Plan-020 (Runtime's backup rows); Spec-013 (backup internals) |
| 7a | **Auto-update — checked from the app and the CLI (daemon)** | The service runs no update check of its own and has no setting for one. Its update is checked by the desktop's main process, which Settings › Runtime's `Update the background service` draws, and by `sidekicks self-update --check`, which only reports. The daemon MUST NOT self-swap its binary while IPC is live. | N/A — the service has no check of its own to turn off; `sidekicks self-update --check` runs only when the person asks. | A long-running daemon with open IPC sockets and file locks cannot safely self-replace mid-session. Replacement is behavior 7b, invoked out-of-session. | Plan-020 (main's check) + Plan-005 (`sidekicks self-update --check`) |
| 7b | **Auto-update — opt-in self-update (CLI)** | `sidekicks self-update` (explicit CLI invocation) fetches the release's manifest and the target binary, and checks the binary against the SHA-256 the manifest lists for its platform; it checks nothing more. A binary whose checksum does not match is refused and nothing is swapped. After the check, it waits for running work to finish, naming it, never stopping it, and then swaps the service's program atomically and restarts it. It updates the service alone and says that the app updates from Settings › General. Platform-specific swap rules apply (see Implementation Notes). | N/A — behavior 7b is always opt-in by being CLI-invoked. | A long-running service is replaced only when the person asks, out of session, and only with the bytes the release published for it. | Plan-005 (daemon-side self-update) |
| 8 | **TLS 1.3 minimum** | All TLS surfaces (Caddy front, Postgres TLS, any WebSocket Secure) MUST negotiate TLS 1.3 only. On Node, this is `minVersion: 'TLSv1.3'` AND `maxVersion: 'TLSv1.3'` on `tls.createServer` / `https.createServer` (NOT `secureProtocol`, which is legacy and cannot enforce 1.3-only). On Caddy, `tls { protocols tls1.3 }`. TLS ≤ 1.1 MUST be rejected outright (RFC 8996). | `--legacy-tls12` or `LEGACY_TLS12=1` permits 1.2, shown as the start banner's `WARNING:` line. | TLS 1.2 is not formally deprecated by IETF — only ≤1.1 is, by RFC 8996 — and NIST SP 800-52 Rev 2 permits it. But >92% cross-browser support for 1.3 is present, Node and Caddy both support 1.3-only, and refusing 1.2 by default closes the downgrade-attack surface without breaking any V1-supported client. | Plan-025 (self-host deployment phase) |
| 9 | **Loud first-run banner** | On every relay process start, a single-screen banner MUST be printed to stdout listing: (a) TLS mode + fingerprint (SPKI-SHA256 and whole-cert hash) if self-signed/internal-CA; (b) all effective bind addresses; (c) every active override. This spec owns the banner's content and its format: plain text, one `<label>: <value>` line per item (Example 1), each active override on its own line beginning `WARNING:`, no longer than one screen. | N/A — the banner is always on. Environments that must suppress banner output for log-formatting reasons MAY set `BANNER_FORMAT=json` to emit the same payload as a single JSON line. | A person who runs `docker compose up` on a borrowed laptop without ever reading docs must still be told what security posture they got. Caddy and Syncthing establish this as a standard pattern for self-host OSS. | Plan-025 (self-host deployment phase: the relay's banner) |

The ten rows are grouped for authoring convenience only; each row is independently normative. Nothing in this spec implies that a product missing one row but shipping the other nine is compliant — all ten MUST ship in V1.

## Default Behavior

The product MUST boot into the default posture described in §Required Behavior without input from the person or config-file edits. A fresh clone of the repository followed by `docker compose up` MUST produce a running relay deployment — the relay behind its Caddy front, with its Postgres — with rows 1, 2, 3, 4, 5, 8 and 9 active as they apply to the relay, and the relay's first-run banner (row 9) enumerating each one. No daemon runs in the Compose deployment: the daemon is the person's own background service on each machine ([Spec-006](./006-local-ipc-and-daemon-control.md)), installed and started by one command, and the rows that govern it hold there.

Nothing leaves the machine for the project. The app collects no usage analytics, and there is no telemetry to consent to: Crashpad writes each crash to the machine only, and reports stay there under `Keep crash reports`, on by default, read from any linked device through Remote Control and from the command line with `sidekicks crash list`. The providers send telemetry of their own, so the service reads the person's own provider privacy settings from their own files — Claude Code's `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_FEEDBACK_COMMAND` and `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`; Codex's `analytics.enabled` and `feedback.enabled` — and passes them into every account it manages at each start, through `--settings` and `-c` as every provider setting is passed, never writing them into an account's home.

## Fallback Behavior

An override the person sets shows on the start banner (row 9) as its own `WARNING:` line, naming the override that is active, on every process start.

When a required dependency is not reachable (e.g., ACME issuer unreachable for row 1), the product MUST fall back to the fallback path named in the row and emit a warning — it MUST NOT silently proceed without the default posture AND without telling the person.

## Bind-Address Reconciliation

Three distinct bind addresses exist in the self-host topology and MUST NOT be confused:

- **The daemon's local IPC and listeners** (governed by row 4): on each of the person's machines, never in the Compose deployment. Local IPC is a Unix domain socket or a named pipe with no network address.
- **Relay container internal port** (governed by [Spec-027](./027-remote-control.md)): `RELAY_BIND=0.0.0.0:8787` is bound _inside the relay container_. The `0.0.0.0` is not externally reachable — the Compose network isolates it and only Caddy (in the same Compose file) routes to it.
- **Caddy host-exposed ports**: `:443` (TLS termination — where every client's TLS terminates) and `:80` (the Row 1 ACME HTTP-01 challenge + the HTTP→HTTPS redirect) on the host. Caddy's automatic-HTTPS mechanism (row 1) manages the cert for `:443`; `:80` carries no plaintext application traffic.

Row 4's localhost-first posture applies to the daemon. The relay's container-internal `0.0.0.0` is not a contradiction — container-internal binds have no external surface unless Compose port-forwards them (and the self-host Compose file in Plan-025 MUST NOT port-forward `8787` directly). On the host, only Caddy is exposed: `:443` for TLS termination plus `:80` for the Row 1 ACME HTTP-01 challenge and the HTTP→HTTPS redirect (HTTP-01 is served on port 80 per RFC 8555 §8.3, so a Row 1 `DEPLOY_MODE=public` deploy without a DNS-01 plugin requires `:80`); the relay's `8787` is never port-forwarded. **Relay bind-TLS validator carve-out (relay scope).** Rows 1 and 2 refuse, at config-parse time, any non-loopback bind without TLS. For the relay's container-internal bind this requirement is satisfied **at the trusted front-proxy edge**: when a trusted TLS-terminating reverse proxy is declared in front of the relay (the Caddy hop the relay configures `trustProxy` for), TLS terminates at that proxy and the relay's plaintext `0.0.0.0:8787` has no external surface (Compose network isolation + the no-`8787`-port-forward posture above). The relay's parse-time bind-TLS validator therefore treats a declared trusted TLS-terminating front proxy as satisfying the Rows 1/2 encryption requirement, so the container-internal `RELAY_BIND=0.0.0.0:8787` behind Caddy is the **secure default and passes parse-time without `INSECURE=1`**. `INSECURE=1` (Row 2's override) is reserved for the genuinely-exposed case — a non-loopback relay bind with neither listener-TLS nor a trusted TLS-terminating front proxy. This is the standard TLS-termination-proxy topology; the encryption guarantee Rows 1/2 protect holds at the proxy edge and is not weakened. The daemon (no front proxy) is unaffected — its non-loopback-without-TLS rejection stands.

## How A Backup Runs

Row 6 of §Required Behavior states _that_ backups are off until the person turns them on, and where they go. It does NOT state _how backup works_. [Spec-013 §Backup Policy](./013-persistence-and-recovery.md#backup-policy) owns:

- The backup set: the service's database, the machine's settings file, each chat session's workspace, each kept session's checkpoint copies and its conversation files, and the agent memory folder.
- The daily database copy and its retention (7 daily and 4 weekly copies).
- The mirror and what `Delete old data` removes from it.
- The run timing.
- Restore, on the machine that wrote the backup and on another.

Spec-013 says how a backup runs; this spec states the defaults. The chosen folder is the only place a backup goes; there is no storage plug-in.

## Interfaces And Contracts

The following interfaces are normative for this spec:

- **Self-signed / internal-CA fingerprint format** (row 1 + row 9):
  - RFC 7469 SPKI-SHA256, base64-encoded. Extraction command: `openssl x509 -in cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64`.
  - SSH-style whole-cert hash: `SHA256:<uppercase-hex-with-colons>`.
  - Both printed to stdout AND persisted at `./data/trust/fingerprint.txt`.
- **Release manifest schema** (row 7b) — JSON:

  ```
  {
    "version": 127,                       // monotonic integer
    "released_at": "2026-04-19T00:00:00Z",
    "artifacts": {
      "linux-x64":   { "url": "...", "sha256": "..." },
      "darwin-arm64":{ "url": "...", "sha256": "..." },
      "win32-x64":   { "url": "...", "sha256": "..." }
    }
  }
  ```

## State And Data Implications

- **First-run state transition**: absence of `./data/trust/first-run.complete` → generate all secrets → write files with `0600` → write sentinel → emit banner. The sentinel is the only on-disk signal that first-run ceremony happened; deleting it re-runs generation only when no secrets are present, and MUST NOT overwrite existing secrets (the relay MUST refuse to start if sentinel is absent AND secrets are present, so the person must act explicitly).
- **Fingerprint persistence**: `./data/trust/fingerprint.txt` is stable across relay restarts. Rotating the underlying keypair MUST rewrite this file AND emit a banner warning on the next startup that pins have changed.
- **Override state ephemerality**: an override is read at each start and shown on that start's banner; it is NOT persisted to the DB, so a person who sets `INSECURE=1` in a systemd unit sees its `WARNING:` line on every restart.
- **Spec-021 interaction**: the identity key each machine's service makes at its first start, and its channel key (row 3), are items in the operating system's credential store, kept as [Spec-021 §Native Keystore](./021-desktop-app-and-renderer.md#native-keystore) describes; Spec-023 only asserts _that_ the identity key is generated at first start. The sentinel and the files above are the relay's.

## Example Flows

- `Example 1: Fresh clone, DEPLOY_MODE=lan for local testing` — the person runs `git clone && cd ai-sidekicks && DEPLOY_MODE=lan HOSTNAME=ai-sidekicks.localhost docker compose up`, which starts the relay behind Caddy with its Postgres; no daemon runs in the deployment. First-run banner on stdout lists: `TLS: Caddy internal CA on :443 (DEPLOY_MODE=lan)`, `Fingerprint: SPKI=<base64>; SSH=SHA256:<hex>`, `Relay bind: 0.0.0.0:8787 (container-internal)`, `Postgres: sslmode=verify-full`. Every relay-side default (rows 1, 2, 3, 4, 5, 8 and 9) is active; the deployment is usable with `DEPLOY_MODE` + `HOSTNAME` as the only configuration the person sets.

- `Example 3: CLI self-update with a corrupted download` — the person runs `sidekicks self-update`. The CLI fetches the manifest and the artifact, and the artifact's SHA-256 does not match the one the manifest lists for its platform. The CLI exits non-zero and names the mismatch. No swap is performed, the running daemon is untouched.

- `Example 4: The service's update, checked from the CLI` — a newer release of the service is on the release feed, and the person runs `sidekicks self-update --check`. It reports that an update is waiting and exits `100`; nothing is downloaded or swapped. Settings › Runtime's `Update the background service` checks the same release feed from the app.

## Implementation Notes

These are non-normative planning hints; they do not add or weaken requirements.

- **ACME client (row 1)**: Caddy is the ACME client. Its automatic HTTPS has renewed on RFC 9773 ARI windows since Caddy 2.8.0 ([release notes](https://github.com/caddyserver/caddy/releases/tag/v2.8.0)), so the relay carries no ACME client of its own and needs no Node library for row 1. The `acme-client` npm package (publishlab/node-acme-client, latest 5.4.0) documents no ARI support and is not used.
- **Let's Encrypt 45-day certificates** (row 1): Let's Encrypt's published schedule ([From 90 to 45](https://letsencrypt.org/2025/12/02/from-90-to-45)) gives the opt-in `tlsserver` profile 45-day certs from 2026-05-13, and moves the default `classic` profile to 64-day certs on 2027-02-10 and to 45-day certs on 2028-02-16. ARI-driven renewal logic handles 90-, 64- and 45-day certificates alike without code changes. The companion doc notes the shorter lifetimes so the person is not surprised by them.
- **Short-lived cert profile (row 1)**: the Compose relay's Caddy takes `ACME_PROFILE`, empty by default, which leaves Caddy's own profile; `shortlived` requests Let's Encrypt's 160-hour certificates through `tls { issuer acme { profile shortlived } }`. Let's Encrypt: "Short-lived certificates are opt-in and we have no plan to make them the default at this time" ([announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)). The relay's key is pinned only when its certificate is not publicly trusted ([ADR-019 §First-Run UX](../decisions/019-v1-deployment-model-and-oss-license.md#first-run-ux)), so a short-lived certificate never trips the pin.
- **Platform-specific self-update swap rules (row 7b)**: `sidekicks self-update` replaces the service's program only. The app has its own updater, `electron-updater` with its stock GitHub provider, which checks each download's SHA-512 and the operating system's code signature ([ADR-022 §Axis 3](../decisions/022-v1-ci-cd-and-release-automation.md#axis-3--release-automation)).
  - **Windows**: cannot overwrite a running `.exe`; the CLI downloads to a sibling path and renames it when the service next starts.
  - **macOS**: the app ships as a `.dmg` to install and a `.zip` for updates, signed with the project's self-signed identity until the Apple Developer certificate exists and notarized after it ([ADR-022 §Axis 5](../decisions/022-v1-ci-cd-and-release-automation.md#axis-5--code-signing-custody)); until then the first launch asks the person to open the app from Finder's menu, and nothing else in the update path waits on the certificate.
  - **Linux**: on an install a package manager owns (`.deb` or `.rpm`, which records its kind at build), `self-update` replaces no file behind the package manager and names its command: `sudo apt update && sudo apt upgrade` or `sudo dnf upgrade`. In-place self-update is reserved for installs the package manager does not own.
- **Default-ACL framing (row 4-adjacent)**: Tailscale's shipped default ACL is allow-all, tuned for VPN onboarding UX. For a security-sensitive self-host admin console, V1 MUST NOT ship an allow-all default. Spec-010 governs approval policy; Spec-023 only names this as a pitfall for the plan that owns first-run onboarding.
- **Identifier = fingerprint pattern (row 1 + row 9)**: Syncthing derives its `device-id` from the SHA-256 of the DER-encoded cert, making the identifier and the fingerprint the same artifact. V1 does not adopt this identifier pattern (PASETO KIDs are the identifier surface per ADR-010), but the display convention — show fingerprints where the person expects identifiers — is copied.

## Pitfalls To Avoid

- **Supabase `.env.example` anti-pattern**: do NOT ship `.env.example` with placeholder secrets and rely on documentation to tell the person not to boot with them. Enforcement MUST be parse-time refusal (row 2 + row 3). Supabase issue #42562 covers `generate-keys.sh` writing a non-existent env var — an experimental helper does not substitute for refuse-to-start enforcement.
- **Tailscale allow-all default ACL**: do NOT adopt an allow-all default ACL for a self-host admin console. Default-deny is correct for a security product even at first-run friction cost.
- **Syncthing mutual-ID paste for client-server**: do NOT require the person to paste IDs bidirectionally for a single-server admin flow. Reserve mutual-auth for true peer-to-peer topologies.
- **Caddy random-challenge picking**: do NOT adopt Caddy's "try a random ACME challenge type and learn over time" heuristic for auditable deployments. Deterministically prefer DNS-01 when credentials are configured, else HTTP-01.
- **Whole-cert fingerprint mislabeled as "public-key fingerprint"**: the SPKI pin (RFC 7469) survives keypair-preserving cert rotation; the whole-cert hash rotates with every re-issue. What the person sees MUST clearly distinguish the two.
- **`sslmode=require` framed as "TLS enforcement"**: `require` provides eavesdropping protection only, not MITM protection (libpq docs: "I trust that the network will make sure I always connect to the server I want"). CVE-2024-10977 is the concrete exploitable path. Any doc written for the person that frames `require` as "TLS enforcement" without the MITM caveat MUST be corrected.
- **`secureProtocol` on Node for TLS-1.3-only**: `secureProtocol` is legacy and cannot enforce 1.3-only. The spec-correct path is `minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3'`.
- **Self-update while daemon has open IPC**: row 7a forbids self-swap while IPC is live. Plan-005 MUST NOT give the daemon a "download + swap" path even behind a flag; row 7b's CLI-invoked path is the only sanctioned swap flow.

## Acceptance Criteria

- [ ] A fresh clone followed by `docker compose up` produces a running relay deployment, with no daemon in it, with rows 1, 2, 3, 4, 5, 8 and 9 active as they apply to the relay AND the relay's first-run banner (row 9) enumerates each active row with its effective value.
- [ ] Every active override shows on the start banner as its own `WARNING:` line, on every process start.
- [ ] The relay's Postgres role signs in with `scram-sha-256` over `verify-full` TLS, and the Compose file names the Postgres image it runs.
- [ ] `sslmode IN ('disable','allow','prefer','require')` is rejected at config-parse time. `sslmode=verify-ca` is accepted and shows its `WARNING:` line.
- [ ] A Postgres MITM proxy interposed between relay and DB is rejected under the default `sslmode=verify-full` posture (CVE-2024-10977 repro).
- [ ] `DEPLOY_MODE=lan` (internal-CA mode) produces a `./data/trust/fingerprint.txt` containing both the RFC 7469 SPKI-SHA256 base64 pin AND the `SHA256:<hex>` whole-cert hash; both are also printed to stdout during first run.
- [ ] Relay refuses at config-parse time when `DEPLOY_MODE=public` is set AND the configured hostname ends in `.localhost`, `.local`, `.home.arpa`, `.internal`, or resolves to an RFC1918 address. Error message names the hostname and the offending LAN suffix / range.
- [ ] Relay refuses at config-parse time when `DEPLOY_MODE=lan` is set AND the configured hostname is a publicly-resolvable DNS name not in the LAN-suffix list. Error message names the hostname and the `DEPLOY_MODE=lan` constraint.
- [ ] `sidekicks self-update` refuses a downloaded binary whose SHA-256 does not match the one the release's manifest lists for its platform, and swaps nothing.
- [ ] The daemon NEVER swaps its own binary while IPC is live.
- [ ] All TLS surfaces reject connections from TLS 1.2 clients by default. `--legacy-tls12` mode shows its `WARNING:` line and accepts TLS 1.2.
- [ ] First-run banner (row 9) lists TLS mode + fingerprint, bind addresses, and any active overrides — all on a single screen.
- [ ] `docs/operations/self-host-secure-defaults.md` exists, contains one entry per row with verify commands the person runs, and is cross-linked from `deployment-topology.md` and ADR-019.

## Open Questions

None.

## References

- Specs: 006, 020, 021, 025, 026.
- ADRs: 010 (tokens, passkeys and the remote channel), 020 (V1 deployment model).
- Architecture: `docs/architecture/deployment-topology.md`, `docs/architecture/security-architecture.md`.
- Operations: `docs/operations/self-host-secure-defaults.md` (companion, written for the person).

### External / Research Sources (accessed 2026-04-19)

- **TLS / ACME / TOFU**
  - NIST SP 800-52 Rev 2 (final): <https://csrc.nist.gov/pubs/sp/800/52/r2/final>
  - RFC 8996 (TLS ≤1.1 deprecation): <https://datatracker.ietf.org/doc/html/rfc8996>
  - RFC 8555 §8.3 (ACME HTTP-01 challenge served on port 80): <https://datatracker.ietf.org/doc/html/rfc8555#section-8.3>
  - RFC 9773 (ACME Renewal Information): <https://datatracker.ietf.org/doc/html/rfc9773>
  - RFC 7469 (SPKI pin format): <https://datatracker.ietf.org/doc/html/rfc7469>
  - Node.js `tls` module: <https://nodejs.org/api/tls.html>
  - Caddy automatic HTTPS: <https://caddyserver.com/docs/automatic-https>
  - Caddy 2.8.0 release notes (ACME Renewal Information support): <https://github.com/caddyserver/caddy/releases/tag/v2.8.0>
  - Caddy `tls` directive: <https://caddyserver.com/docs/caddyfile/directives/tls>
  - Let's Encrypt 6-day + IP certs GA (2026-01-15): <https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability>
  - Let's Encrypt ARI (RFC 9773) (2026-03-17): <https://letsencrypt.org/2026/03/17/acme-renewal-information-ari.html>
  - Let's Encrypt 45-day roadmap (2025-12-02 + 2026-02-24): <https://letsencrypt.org/2025/12/02/from-90-to-45> ; <https://letsencrypt.org/2026/02/24/rate-limits-45-day-certs>
  - Let's Encrypt rate limits: <https://letsencrypt.org/docs/rate-limits/>
- **Postgres**
  - libpq SSL / sslmode: <https://www.postgresql.org/docs/current/libpq-ssl.html>
  - CVE-2024-10977 (libpq MITM error injection, 2024-11-14): <https://www.postgresql.org/support/security/CVE-2024-10977/>
- **Secure-default exemplars**
  - Caddy releases: <https://github.com/caddyserver/caddy/releases> (v2.11.2 accessed 2026-04-19)
  - Tailscale encryption: <https://tailscale.com/docs/concepts/tailscale-encryption>
  - Tailscale ACLs: <https://tailscale.com/kb/1018/acls>
  - Syncthing security principles: <https://docs.syncthing.net/users/security.html>
  - Syncthing device IDs: <https://docs.syncthing.net/dev/device-ids.html>
  - Supabase self-host: <https://supabase.com/docs/guides/self-hosting/docker>
  - Supabase `generate-keys.sh` bug: <https://github.com/supabase/supabase/issues/42562>
- **Auto-update**
  - Doyensec Electron Safe Updater (2026-02-16): <https://blog.doyensec.com/2026/02/16/electron-safe-updater.html>
  - NIST PQC timeline: <https://postquantum.com/post-quantum/cryptography-pqc-nist/>
