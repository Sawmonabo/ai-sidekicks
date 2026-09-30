# Spec-024: Self-Host Secure Defaults

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `024` |
| **Slug** | `self-host-secure-defaults` |
| **Date** | `2026-04-19` |
| **Author(s)** | `Sawmon (Principal Engineer)` |
| **Depends On** | Spec-006, Spec-018, Spec-019, Spec-020, Spec-028; ADR-010, ADR-012, ADR-020; `docs/architecture/deployment-topology.md`, `docs/architecture/security-architecture.md` |
| **Implementation Plan** | Multiple — see Plan Ownership column in §Required Behavior |

## Purpose

A person who `git clone`s the repository and runs the product MUST get a secure deployment without reading a hardening guide. This spec defines the secure-default rows that ship in V1 — each on by default except backups (row 6), which the person turns on — enumerates the override path for each, and names the plan that owns the implementation of each. It exists so the behaviors ship in the app, with a one-page companion naming what is default and how to opt out, rather than as an enterprise-grade requirements document.

How each default is implemented is owned by the plans and ADRs listed in the Plan Ownership column and by the specs that govern adjacent surfaces (most notably [Spec-013 §Backup Policy](./013-persistence-recovery-and-replay.md#backup-policy) for backup internals).

## Scope

- Cross-cutting secure-default behaviors that span the daemon, the self-hostable relay, the CLI, and first-run UX.
- The twelve behavior rows enumerated in §Required Behavior.
- Bind-address reconciliation between the relay's container internals (owned by [Spec-028](./028-remote-control.md)) and this spec (daemon host posture).
- Backup internals are [Spec-013 §Backup Policy](./013-persistence-recovery-and-replay.md#backup-policy)'s, and secret custody internals are Spec-020's.
- The first-run banner's content and format.
- Acceptance criteria that demonstrate each default is active and each override path is audit-visible.

## Non-Goals

- Backup internals — the backup set, the daily copy and its retention, the mirror, the run timing and restore are owned by [Spec-013 §Backup Policy](./013-persistence-recovery-and-replay.md#backup-policy). This spec only states _that_ backup is off until the person turns it on, and where it goes.
- Secret custody internals — master-key custody, envelope formats and the custody tiers are owned by [Spec-020 §Daemon Master Key](./020-data-retention-and-gdpr.md#daemon-master-key) and [ADR-021 §Custody Tiers](../decisions/021-cli-identity-key-storage-custody.md#custody-tiers). This spec only states _that_ secrets are generated on first run, and that the master key is never a plaintext file.
- Policy chain-of-custody internals — signing, rotation, and verification of Cedar policy bundles are owned by ADR-012 and `docs/operations/cedar-policy-signing-and-rotation.md`. This spec only states _that_ `/metrics` exports a Cedar-deny counter.
- Enterprise items, out of scope for one user: compliance-framework mapping (SOC 2, ISO 27001, HIPAA, FedRAMP), enterprise sign-on (IdP / OIDC / SAML), WAF recommendations, HSM custody, Helm charts, an SLA, offline-root signing infrastructure, multi-region sign-up discovery and server-side telemetry. Each exists to sell to or govern an organization of other people.
- Hardened-image SBOM signing.
- An ACME client of the relay's own. Row 1's issuance and renewal are Caddy's; this spec states the _requirement_ (RFC 9773 ARI).
- The exact on-by-default polling cadence for behavior 7a (notify-only auto-update). Owned by Plan-006.

## Domain Dependencies

- `docs/domain/session-model.md` — the kept sessions whose files a backup holds, and `Delete old data`, after which a backup runs (behavior 6).
- `docs/domain/trust-and-identity.md` — first-run secret generation (behavior 3) and fingerprint-display (behaviors 1, 10) feed the trust ceremony (identity-material provisioning, fingerprint verification ceremony, and the trust-state lifecycle).

## Architectural Dependencies

- `docs/architecture/deployment-topology.md` — self-host topology (relay + Caddy + Postgres, with the daemon on each of the person's machines) is the surface this spec configures.
- `docs/architecture/security-architecture.md` — trust boundaries, secret custody, and `/metrics` surface.
- `docs/decisions/010-tokens-passkeys-and-the-remote-channel.md` — auth primitives whose failures feed `/metrics` (behavior 9).
- `docs/decisions/012-cedar-approval-policy-engine.md` — Cedar-deny counter source (behavior 9).
- `docs/decisions/020-v1-deployment-model-and-oss-license.md` — establishes that the relay is the person's own, deployed for themself, which is the deployment these defaults configure.

## Required Behavior

The product MUST implement all twelve rows below. Each row has a default that is active with no configuration from the person, an override path (where one exists), the reason the default is what it is, and the plan that owns the implementation.

| # | Behavior | Default (on with no action from the person) | Override | Reason | Plan Ownership |
| --- | --- | --- | --- | --- | --- |
| 1 | **Auto-TLS for the self-hostable relay** | Caddy v2 fronts the relay on `:443`. The person declares `DEPLOY_MODE` at config time; default is `public`. In `DEPLOY_MODE=public`, ACME issuance uses DNS-01 when a DNS provider plugin is configured (wildcard / public hosts via the plugin); HTTP-01 otherwise. Renewals MUST use RFC 9773 ACME Renewal Information (ARI) windows and MUST NOT be rate-limited by fixed thresholds. In `DEPLOY_MODE=lan`, Caddy uses `tls internal` (internal CA) directly — no public-ACME attempt is made, no fallback logic is invoked. The relay MUST refuse at config-parse time if `DEPLOY_MODE=public` is set AND the configured hostname ends in `.localhost`, `.local`, `.home.arpa`, `.internal`, or resolves to an RFC1918 address (public ACME cannot issue for these; Caddy does NOT silently fall back from a failed public-ACME issuance to an internal CA — feature declined upstream, caddyserver/caddy#4735). The relay MUST refuse at config-parse time if `DEPLOY_MODE=lan` is set AND the configured hostname is a publicly-resolvable DNS name not in the LAN-suffix list above (prevents deploying a publicly-reachable admin console under an internal CA that no client trusts). In `DEPLOY_MODE=lan` (internal-CA path), the SPKI-SHA256 pin (RFC 7469, base64) and SSH-style `SHA256:<hex>` whole-cert hash are both printed to stdout and persisted at `./data/trust/fingerprint.txt`. | `--relay-no-tls` permitted only when `RELAY_BIND` is a loopback address (local development on the relay's own host). Any non-loopback bind without TLS MUST be rejected at config-parse time (behavior 2 interaction; for the relay's container-internal bind behind a trusted TLS-terminating front proxy, TLS at the proxy edge satisfies this — see §Bind-Address Reconciliation). | DNS-01 reaches private hosts HTTP-01 cannot. ARI-coordinated renewals are explicitly exempt from Let's Encrypt rate limits (RFC 9773, LE policy 2026). A `DEPLOY_MODE` the person declares replaces runtime auto-detect on a security-critical branch — the person knows whether the deployment is LAN or public; encoding that at parse time is auditable and testable, while auto-detect would put "did Caddy's ACME attempt fail?" on the trust-ceremony hot path. The SPKI pin survives cert rotation on the same keypair; the whole-cert hash matches what browsers display. | Plan-028 (self-host deployment phase); this spec + `docs/operations/self-host-secure-defaults.md` (fingerprint display contract) |
| 2 | **Refuse to start without encryption on non-loopback bind** | The relay, in the Compose deployment, and the daemon, on each of the person's machines, each validate `<bind> + <TLS mode>` for every network listener at config-parse time. A non-loopback bind without TLS MUST exit non-zero with a clear error naming the offending option (for the relay's container-internal bind behind a trusted TLS-terminating front proxy, TLS termination at that proxy satisfies this requirement — see §Bind-Address Reconciliation). | `--insecure` flag (or `INSECURE=1` env) starts the relay anyway (the daemon has no insecure mode: its one listener that can leave loopback, `/metrics`, takes a non-loopback bind only with TLS and `METRICS_AUTH`, row 9a) but emits a one-screen loud banner on every startup naming (a) that insecure mode is active, (b) the bind address, (c) what traffic is unencrypted. A `security.default.override=insecure_bind` log event MUST be emitted once per startup. | Supabase's most-reported self-host footgun is placeholder secrets committed in `.env.example` with a docs-only "don't boot with this" warning. A spec that only _documents_ the risk has been shown to fail in the field. Parse-time refusal converts a docs problem into an executable guarantee. | Plan-006 (daemon); Plan-028 (self-host deployment phase) |
| 3 | **Auto-generated strong secrets on first run** | The relay's first run in the Compose deployment is a one-shot step that Postgres and the relay each wait on, and it generates every secret the deployment makes for itself: the control plane's two token keys via `crypto.randomBytes` (N ≥ 32), the Ed25519 key that signs PASETO v4.public access tokens and the symmetric key that seals v4.local refresh tokens; the Web Push VAPID key pair, an ECDSA P-256 pair the application server makes itself (RFC 8292), whose public key the relay serves to the web client for its push subscription; and the password of the relay's Postgres role via `crypto.randomBytes` (N ≥ 32), written before Postgres first starts and handed to Postgres and to the relay as the same secret file, never through an env var. The APNs and FCM credentials are issued by Apple and Google, so the person supplies them and the relay keeps them ([Plan-028](../plans/028-remote-control.md) Phase 5). Its TLS key is Caddy's, not the relay's. Its persisted files MUST be `0600` (Unix) / appropriate ACL (Windows). Public material — fingerprints, public keys — is printed to **both** stdout AND a header comment in the on-disk file, mirroring `age-keygen`'s UX pattern; private material is only in the file body. Each machine's service generates its master key via `crypto.randomBytes` (N ≥ 32) at its first start and keeps it on the custody ladder of [Spec-020 §Daemon Master Key](./020-data-retention-and-gdpr.md#daemon-master-key) and [ADR-021 §Custody Tiers](../decisions/021-cli-identity-key-storage-custody.md#custody-tiers): a hardware wrap, then the OS keychain, then an Argon2id passphrase file, and a refusal to start when none works. The master key is never written anywhere in the clear. The machine's identity key, minted at the same first start, is sealed under it in the daemon's database, never kept as a key file. | N/A. Secrets cannot be pre-seeded via env vars or `.env.example`. A sentinel file `./data/trust/first-run.complete` records that the relay's first-run ceremony finished; its absence while the relay's secrets are present MUST block relay start with a clear message naming the sentinel and the secrets found, so that regenerating them is the person's explicit act (§State And Data Implications). The service needs no sentinel: at every start it opens its master key from the tier that holds it, or makes one at its first start. | The Supabase `.env.example`-placeholder anti-pattern (#42562 covers `generate-keys.sh` writing a non-existent env var) shows that a ship-with-placeholders model leaks into production. `age-keygen`'s public-key-in-header-comment + stderr pattern is the cleanest first-run-key UX. A service that starts unattended at login needs a master key that opens with no one present, and a key held by a security chip or the keychain is not readable from a copied disk. | Plan-028 (self-host deployment phase: the relay's secrets and sentinel; Phase 1: the machine's identity key); Plan-006 (the service's first start); Plan-020 (the master key's custody ladder); [Spec-020 §Daemon Master Key](./020-data-retention-and-gdpr.md#daemon-master-key) owns the envelope format |
| 4 | **Loopback bind by default** | On each machine, the daemon's local IPC is a Unix domain socket or a named pipe with no network address ([Spec-006](./006-local-ipc-and-daemon-control.md)), and its one listener that can leave loopback, the `/metrics` endpoint (row 9a), MUST default to `127.0.0.1`. The Compose deployment runs the relay alone, and its `RELAY_BIND` defaults to `0.0.0.0:8787` _inside the relay container_; see §Bind-Address Reconciliation. | The daemon has no bind setting of its own: its one listener that can leave loopback, `/metrics`, leaves loopback only through `METRICS_BIND`, and a non-loopback `METRICS_BIND` requires TLS (behavior 2) and `METRICS_AUTH` (row 9a). The relay's `RELAY_BIND` stays container-internal (§Bind-Address Reconciliation). | Localhost-first blocks the entire class of "daemon accidentally on public Wi-Fi" incidents. External exposure MUST require two explicit actions (bind change AND TLS enablement), not one. | Plan-006 (daemon); Plan-028 (self-host deployment phase) |
| 5 | **Postgres `sslmode=verify-full` + weak-auth rejection + version probe** | The relay's Postgres client MUST default to `sslmode=verify-full`. The relay MUST ship a cert-generation helper that produces a server cert with SAN=`<compose-service-name>` and documents that the relay's connection string must use the same host identifier. The relay's Postgres role signs in with `scram-sha-256` over that TLS, with the password row 3's first run generates. On startup the relay MUST: (a) probe `pg_hba_file_rules` and refuse to start if any enabled row has `auth_method IN ('trust','password','md5')`; (b) probe `SELECT current_setting('server_version_num')::int` and refuse to start if `< 170000` (Postgres 17 minimum); (c) log a non-fatal advisory if `< 180000` recommending Postgres 18 for OAuth / md5-deprecation surface. | `sslmode=verify-ca` accepted with a loud startup warning (`security.default.override=postgres_sslmode=verify-ca`) for a person whose infrastructure genuinely cannot guarantee SAN matching. `disable`, `allow`, `prefer`, `require` MUST be refused at config-parse time. `md5_password_warnings` advisory is non-fatal on PG 17. | The default is `verify-full` rather than `require` because `require` is MITM-exploitable (CVE-2024-10977, 2024-11-14 — libpq error-message injection) and `verify-full` is the MITM-defeating posture. `trust`/`password` are weaker than `md5`; rejecting all three yields `scram-sha-256` as the floor (RFC 7677). Postgres 14 reaches EOL 2026-11-12; requiring PG 17 avoids shipping on EOL'd databases. | Plan-028 (self-host deployment phase) |
| 6 | **Backups, off until the person turns them on** | Off: nothing is backed up until the person turns on `Back up automatically` under Runtime's `Backups`. The folder is `<home>/.ai-sidekicks/backups` by default, at mode `0700`; on a Windows computer whose service runs in WSL it is the Windows home's `.ai-sidekicks\backups`, so the backups outlive the distribution. Once on, the service copies its database whole once a day and after every `Delete old data`, keeps 7 daily and 4 weekly copies, and keeps the machine's settings file, the conversation files, chat workspaces, checkpoint copies and the agent memory folder as one mirror. The service never uploads a backup. | `Back up automatically` and `Back up to` with `Choose…` (any folder, an external drive or a synced folder included) on Runtime, carried in the machine's settings file; `Back up now`; `Restore…`, and `sidekicks db restore <backup>` on a machine with no app. Off is the default, not an override, so it emits no banner and no `security.default.override` event. | Whether and where copies of the person's sessions are kept is the person's choice, and a folder on another drive is what protects against losing the disk. While the folder is on the service's own disk, Runtime says so: `Backups on this disk undo a bad update or a mistaken delete. Only a folder on another drive protects against losing the disk.` [Spec-013 §Backup Policy](./013-persistence-recovery-and-replay.md#backup-policy) owns how a backup runs (see §How A Backup Runs). | Plan-006 (the service's backup job and `sidekicks db restore`) + Plan-021 (Runtime's backup rows); Spec-013 (backup internals) |
| 7a | **Auto-update — notify-by-default (daemon)** | The daemon MUST poll GitHub Releases (or a release feed the person configures) on a cadence owned by Plan-006. When a newer release is detected, the daemon MUST surface a prompt on the next CLI invocation, in the first-run banner of subsequent boots, and as a `security.update.available` log event. The daemon MUST NOT self-swap its binary while IPC is live. | `AUTO_UPDATE_CHECK=off` disables polling. The person remains responsible for keeping the release channel tracked. | A long-running daemon with open IPC sockets and file locks cannot safely self-replace mid-session. Notify is the safe floor; actual replacement is behavior 7b, invoked out-of-session. | Plan-006 |
| 7b | **Auto-update — opt-in self-update (CLI)** | `sidekicks self-update` (explicit CLI invocation) fetches the release manifest AND a GitHub Artifact Attestation (Sigstore bundle) for the target binary. It MUST verify **both**: (a) the Ed25519 signature on the manifest AND (b) the Sigstore bundle (via `gh attestation verify` semantics or a `@sigstore/verify` equivalent embedded in the CLI). Verification passing EITHER check alone MUST NOT be accepted. The manifest MUST include `version` (monotonic), `released_at`, `expires_at`, `previous_manifest_hash`, and `next_signing_keys`. Manifests with `version <= last_seen_version` OR `now > expires_at` MUST be rejected. After verification, it waits for running work to finish, naming it, never stopping it, and then swaps the service's program atomically and restarts it. It updates the service alone and says that the app updates from Settings › General. Platform-specific swap rules apply (see Implementation Notes). | N/A — behavior 7b is always opt-in by being CLI-invoked. | Post–Shai-Hulud (2025-09/11, 25k+ npm repos) and post-Axios (2026-03-31, direct-publish from hijacked maintainer) incidents established that single-trust-path update distribution is insufficient. Dual-path (release key + transparency-log-backed Sigstore bundle) forces an attacker to compromise two independent systems. Anti-rollback/freeze fields close the freeze-and-downgrade attack paths that bare manifest-signing leaves open. TUF is not adopted: the manifest already rejects rollback (monotonic `version`), freeze (`expires_at`) and a broken chain (`previous_manifest_hash`) and announces keys ahead (`next_signing_keys`), and TUF's online timestamp role, whose key must re-sign on a schedule, buys no separation with one maintainer. | Plan-006 (daemon-side self-update) |
| 8 | **TLS 1.3 minimum** | All TLS surfaces (daemon HTTPS, Caddy front, Postgres TLS, any WebSocket Secure) MUST negotiate TLS 1.3 only. On Node, this is `minVersion: 'TLSv1.3'` AND `maxVersion: 'TLSv1.3'` on `tls.createServer` / `https.createServer` (NOT `secureProtocol`, which is legacy and cannot enforce 1.3-only). On Caddy, `tls { protocols tls1.3 }`. TLS ≤ 1.1 MUST be rejected outright (RFC 8996). | `--legacy-tls12` or `LEGACY_TLS12=1` permits 1.2 with a loud startup banner and `security.default.override=legacy_tls12` log event. | TLS 1.2 is not formally deprecated by IETF — only ≤1.1 is, by RFC 8996 — and NIST SP 800-52 Rev 2 permits it. But >92% cross-browser support for 1.3 is present, Node and Caddy both support 1.3-only, and refusing 1.2 by default closes the downgrade-attack surface without breaking any V1-supported client. | Plan-006 (daemon TLS) + Plan-028 (self-host deployment phase) |
| 9a | **Security `/metrics` exports — daemon scope** | Daemon exposes a Prometheus v0.0.4 exposition `/metrics` endpoint binding to `127.0.0.1` by default. Metric families that MUST be exposed (counters unless marked otherwise): (a) `token_auth_failure_total`, (b) `cedar_deny_total` (ADR-012 source), (c) `relay_connection_churn_total`, (d) `backup_success_total`, (e) `auto_update_check_status` (gauge: `0=ok`, `1=behind`, `2=poll_failed`). Rate-limit families are deliberately absent from the daemon set: the daemon has no rate-limit enforcer ([Spec-019 §Scope](./019-rate-limiting-policy.md#scope) excludes the local IPC path); the canonical `rate_limit_*` families are control-plane-side per row 9b (Plan-019). Labels MUST be bounded and PII-free per Plan-018 §Prometheus `/metrics` Exposition invariants; cardinality ceiling < 200 series per daemon instance. Companion doc documents the semantics of each family so the person knows what to scrape. | `METRICS_BIND=off` disables the endpoint + emits banner + `security.default.override=metrics_disabled` log event. Non-loopback `METRICS_BIND` MUST require auth (bearer-token OR mTLS); missing auth on non-loopback bind is a config-parse-time error. | Observability is a security property — a person running blind cannot detect credential-stuffing, rate-limit ceiling breaches, or update-check flatlines. Loopback-only default avoids making metrics an attack surface. | Plan-018 (daemon endpoint + contract shape + label allow-list + cardinality ceiling) |
| 9b | **Security `/metrics` exports — relay scope** | Relay exposes an equivalent Prometheus v0.0.4 `/metrics` endpoint consuming Plan-018's bind/auth secure-default contract. Relay-specific counter families added to the daemon set: `relay_ws_connections_active`, `relay_ws_frames_total{direction}`, `relay_http_requests_total{method,route,status}`, `relay_http_request_duration_seconds` (histogram), plus Plan-019's canonical rate-limit families `rate_limit_trip_total{endpoint,tier}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}` (snake spelling canonical here; label schema owned by Plan-019). Same PII-free label invariant and bounded-cardinality rule apply. | Same `METRICS_BIND=off` disable path and `METRICS_AUTH=bearer\|mtls` gate as row 9a. | Relay observability is a distinct process but shares the security boundary. Keeping the bind/auth contract shape in Plan-018 (not fragmented across daemon and relay) yields one auditable secure-default posture across both surfaces. | Plan-028 (self-host deployment phase), consuming the Plan-018 contract |
| 10 | **Loud first-run banner** | On every daemon or relay process start, a single-screen banner MUST be printed to stdout listing: (a) TLS mode + fingerprint (SPKI-SHA256 and whole-cert hash) if self-signed/internal-CA; (b) all effective bind addresses; (c) backup state (off, or the folder and the last run); (d) update channel + mode (notify-only / off); (e) any active `security.default.override=*` rows. Each process prints the items that apply to it: the backup state is the daemon's alone. This spec owns the banner's content and its format: plain text, one `<label>: <value>` line per item (Example 1), each active override on its own line beginning `WARNING:`, no longer than one screen. | N/A — the banner is always on. Environments that must suppress banner output for log-formatting reasons MAY set `BANNER_FORMAT=json` to emit the same payload as a single JSON line. | A person who runs `docker compose up` on a borrowed laptop without ever reading docs must still be told what security posture they got. Caddy and Syncthing establish this as a standard pattern for self-host OSS. | Plan-006 (the daemon's banner) + Plan-028 (self-host deployment phase: the relay's banner) |

The twelve rows are grouped for authoring convenience only; each row is independently normative. Nothing in this spec implies that a product missing one row but shipping the other eleven is compliant — all twelve MUST ship in V1.

## Default Behavior

The product MUST boot into the default posture described in §Required Behavior without input from the person or config-file edits. A fresh clone of the repository followed by `docker compose up` MUST produce a running relay deployment — the relay behind its Caddy front, with its Postgres — with rows 1, 2, 3, 4, 5, 8, 9b and 10 active as they apply to the relay, and the relay's first-run banner (row 10) enumerating each one. No daemon runs in the Compose deployment: the daemon is the person's own background service on each machine ([Spec-006](./006-local-ipc-and-daemon-control.md)), installed and started by one command, and the rows that govern it hold there.

Nothing leaves the machine for the project. The app collects no usage analytics, and there is no telemetry to consent to: Crashpad writes each crash to the machine only, and reports stay there under `Keep crash reports`, on by default, read from any linked device through Remote Control and from the command line with `sidekicks crash list`. The providers send telemetry of their own, so the service reads the person's own provider privacy settings from their own files — Claude Code's `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_FEEDBACK_COMMAND` and `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`; Codex's `analytics.enabled`, `feedback.enabled` and `otel.metrics_exporter` — and passes them into every account it manages at each start, through `--settings` and `-c` as every provider setting is passed, never writing them into an account's home.

## Fallback Behavior

Every row with an override path MUST:

- Emit a loud one-screen banner at process start naming the override that is active.
- Emit exactly one `security.default.override=<behavior>` log event per startup, structured so it is greppable in self-host logs and countable via `/metrics`.
- Be audit-visible — the override SHOULD NOT be silently retained in the process without a recurring signal the person can see.

When a required dependency is not reachable (e.g., ACME issuer unreachable for row 1, GitHub Releases unreachable for row 7a), the product MUST fall back to the fallback path named in the row and emit a warning — it MUST NOT silently proceed without the default posture AND without telling the person.

## Bind-Address Reconciliation

Three distinct bind addresses exist in the self-host topology and MUST NOT be confused:

- **The daemon's local IPC and listeners** (governed by row 4): on each of the person's machines, never in the Compose deployment. Local IPC is a Unix domain socket or a named pipe with no network address; its one listener that can leave loopback, `/metrics`, defaults to `127.0.0.1:*` and is never exposed to the network unless `METRICS_BIND` is explicitly changed AND TLS and `METRICS_AUTH` are configured (rows 2 and 9a).
- **Relay container internal port** (governed by [Spec-028](./028-remote-control.md)): `RELAY_BIND=0.0.0.0:8787` is bound _inside the relay container_. The `0.0.0.0` is not externally reachable — the Compose network isolates it and only Caddy (in the same Compose file) routes to it.
- **Caddy host-exposed ports**: `:443` (TLS termination — where every client's TLS terminates) and `:80` (the Row 1 ACME HTTP-01 challenge + the HTTP→HTTPS redirect) on the host. Caddy's automatic-HTTPS mechanism (row 1) manages the cert for `:443`; `:80` carries no plaintext application traffic.

Row 4's localhost-first posture applies to the daemon. The relay's container-internal `0.0.0.0` is not a contradiction — container-internal binds have no external surface unless Compose port-forwards them (and the self-host Compose file in Plan-028 MUST NOT port-forward `8787` directly). On the host, only Caddy is exposed: `:443` for TLS termination plus `:80` for the Row 1 ACME HTTP-01 challenge and the HTTP→HTTPS redirect (HTTP-01 is served on port 80 per RFC 8555 §8.3, so a Row 1 `DEPLOY_MODE=public` deploy without a DNS-01 plugin requires `:80`); the relay's `8787` is never port-forwarded. **Relay bind-TLS validator carve-out (relay scope).** Rows 1 and 2 refuse, at config-parse time, any non-loopback bind without TLS. For the relay's container-internal bind this requirement is satisfied **at the trusted front-proxy edge**: when a trusted TLS-terminating reverse proxy is declared in front of the relay (the Caddy hop the relay configures `trustProxy` for), TLS terminates at that proxy and the relay's plaintext `0.0.0.0:8787` has no external surface (Compose network isolation + the no-`8787`-port-forward posture above). The relay's parse-time bind-TLS validator therefore treats a declared trusted TLS-terminating front proxy as satisfying the Rows 1/2 encryption requirement, so the container-internal `RELAY_BIND=0.0.0.0:8787` behind Caddy is the **secure default and passes parse-time without `INSECURE=1`**. `INSECURE=1` (Row 2's override) is reserved for the genuinely-exposed case — a non-loopback relay bind with neither listener-TLS nor a trusted TLS-terminating front proxy. This is the standard TLS-termination-proxy topology; the encryption guarantee Rows 1/2 protect holds at the proxy edge and is not weakened. The daemon (no front proxy) is unaffected — its non-loopback-without-TLS rejection stands.

## How A Backup Runs

Row 6 of §Required Behavior states _that_ backups are off until the person turns them on, and where they go. It does NOT state _how backup works_. [Spec-013 §Backup Policy](./013-persistence-recovery-and-replay.md#backup-policy) owns:

- The backup set: the service's database, the machine's settings file, each chat session's workspace, each kept session's checkpoint copies and its conversation files, and the agent memory folder.
- The daily database copy and its retention (7 daily and 4 weekly copies).
- The mirror and what `Delete old data` removes from it.
- The run timing.
- Restore, on the machine that wrote the backup and on another.

Spec-013 says how a backup runs; this spec states the defaults. The chosen folder is the only place a backup goes; there is no storage plug-in.

## Interfaces And Contracts

The following interfaces are normative for this spec:

- **Relay Postgres startup probes** (row 5):
  - Auth probe: `SELECT auth_method FROM pg_hba_file_rules WHERE NOT error IS DISTINCT FROM NULL` — fail-fast if any row matches `('trust', 'password', 'md5')`.
  - Version probe: `SELECT current_setting('server_version_num')::int AS v` — fail-fast if `v < 170000`; log advisory if `v < 180000`.
  - `SHOW password_encryption = 'scram-sha-256'` assertion.
- **Self-signed / internal-CA fingerprint format** (row 1 + row 10):
  - RFC 7469 SPKI-SHA256, base64-encoded. Extraction command: `openssl x509 -in cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64`.
  - SSH-style whole-cert hash: `SHA256:<uppercase-hex-with-colons>`.
  - Both printed to stdout AND persisted at `./data/trust/fingerprint.txt`.
- **Release manifest schema** (row 7b) — JSON, detached `.sig`:

  ```
  {
    "version": 127,                       // monotonic integer
    "released_at": "2026-04-19T00:00:00Z",
    "expires_at": "2026-05-19T00:00:00Z", // ≤30 days after released_at
    "previous_manifest_hash": "sha256:...",
    "next_signing_keys": ["ed25519:..."], // rotation pre-commit
    "artifacts": {
      "linux-x64":   { "url": "...", "sha256": "..." },
      "darwin-arm64":{ "url": "...", "sha256": "..." },
      "win32-x64":   { "url": "...", "sha256": "..." }
    },
    "sidecar_sha256": {                   // the PTY sidecar binary per platform, checked before its first spawn
      "win32-x64":   "...",
      "win32-arm64": "...",
      "darwin-arm64":"...",
      "darwin-x64":  "...",
      "linux-x64":   "...",
      "linux-arm64": "..."
    }
  }
  ```

- **Sigstore bundle verification** (row 7b): `gh attestation verify <artifact> --owner <gh-owner>` semantics OR direct `@sigstore/verify` against the bundle published alongside the release binary via `actions/attest@v4`.
- **`security.default.override` log event schema** (rows 2, 5, 8, 9): structured log with fields `behavior` (integer 1–10), `effective_value` (string), `banner_printed_at` (ISO-8601), and an OPTIONAL `row` (`7a`/`7b` as string). The `row` field is the `7a`/`7b` sub-row discriminator and is **omitted** for the single-integer `behavior` overrides — rows 2/5/8/9 carry no `7a`/`7b` sub-row, so they emit no `row`. Row 9's `9a` (daemon, Plan-018) / `9b` (relay, Plan-028) split is a process-scope distinction — each process emits its own `metrics_disabled` override under `behavior: 9` — not a `7a`/`7b`-style payload discriminator, so it too omits `row`.
- **`/metrics` endpoint** (rows 9a daemon / 9b relay): Prometheus v0.0.4 exposition format. Counter names and semantics listed in the companion doc. Bind/auth contract shape owned by Plan-018; relay wiring owned by Plan-028.

## State And Data Implications

- **First-run state transition**: absence of `./data/trust/first-run.complete` → generate all secrets → write files with `0600` → write sentinel → emit banner. The sentinel is the only on-disk signal that first-run ceremony happened; deleting it re-runs generation only when no secrets are present, and MUST NOT overwrite existing secrets (the relay MUST refuse to start if sentinel is absent AND secrets are present, so the person must act explicitly).
- **Fingerprint persistence**: `./data/trust/fingerprint.txt` is stable across relay restarts. Rotating the underlying keypair MUST rewrite this file AND emit a banner warning on the next startup that pins have changed.
- **Override state ephemerality**: override banners emit once per startup; override state is NOT persisted to the DB. This is intentional — a person who sets `INSECURE=1` in a systemd unit sees the banner on every restart.
- **Audit impact**: every override path contributes a `security.default.override=*` log event that feeds `/metrics` (rows 9a daemon / 9b relay) and is visible to Spec-005 event taxonomy.
- **Spec-020 interaction**: the master key each machine's service makes at its first start (row 3) is the custody domain of [Spec-020 §Daemon Master Key](./020-data-retention-and-gdpr.md#daemon-master-key), kept on the custody tiers of [ADR-021 §Custody Tiers](../decisions/021-cli-identity-key-storage-custody.md#custody-tiers). Envelope format and the tiers are owned there; Spec-024 only asserts _that_ it is generated at first start and never written in the clear. The sentinel and the files above are the relay's.

## Example Flows

- `Example 1: Fresh clone, DEPLOY_MODE=lan for local testing` — the person runs `git clone && cd ai-sidekicks && DEPLOY_MODE=lan HOSTNAME=ai-sidekicks.localhost docker compose up`, which starts the relay behind Caddy with its Postgres; no daemon runs in the deployment. First-run banner on stdout lists: `TLS: Caddy internal CA on :443 (DEPLOY_MODE=lan)`, `Fingerprint: SPKI=<base64>; SSH=SHA256:<hex>`, `Relay bind: 0.0.0.0:8787 (container-internal)`, `Update channel: stable (notify-only)`, `Postgres: sslmode=verify-full, version 18.3`. Every relay-side default (rows 1, 2, 3, 4, 5, 8, 9b and 10) is active; the deployment is usable with `DEPLOY_MODE` + `HOSTNAME` as the only configuration the person sets.

- `Example 2: Postgres `pg_hba.conf`lists`trust` for a dev user` — the person pre-configured `pg_hba.conf` permissively. Relay startup probe reads `pg_hba_file_rules`, finds a row with `auth_method='trust'`, exits non-zero with `FATAL: pg_hba.conf line N uses auth_method='trust' — relay refuses to start. Set scram-sha-256 or remove the entry.` No override is offered for this — `trust` / `password` / `md5` are not acceptable in any production posture.

- `Example 3: CLI self-update with tampered Sigstore bundle` — the person runs `sidekicks self-update`. CLI fetches manifest + artifact + Sigstore bundle. Ed25519 signature on manifest verifies. Sigstore bundle verification fails because an attacker modified the bundle in transit. CLI exits non-zero with `FATAL: Sigstore bundle verification failed — refusing update.` No swap is performed, the running daemon is untouched.

- `Example 4: Daemon notify-only auto-update` — daemon polls release feed daily (cadence owned by Plan-006). A newer `version=128` release is detected. Daemon emits `security.update.available` log event, updates `auto_update_check_status` gauge, and appends one line to the next startup banner: ``Update available: v0.4.2 (run `sidekicks self-update` to apply)``. The daemon does NOT download, verify, or swap the binary while it is running.

- `Example 5: /metrics on a non-loopback bind without auth` — the person starts the service with `METRICS_BIND=0.0.0.0:<port>` and no `METRICS_AUTH`. The daemon exits non-zero at config-parse time with an error naming `METRICS_AUTH` and the listener keypair it also needs; `INSECURE=1` does not change this, because the daemon has no insecure mode. With `METRICS_AUTH=bearer`, `METRICS_AUTH_TOKEN_FILE` and the listener keypair set, it starts and serves `/metrics` over TLS to authenticated scrapers only.

- `Example 6: Rollback / freeze attack on self-update` — the person's local `last_seen_version=127`. Attacker serves an older manifest `version=120` with a validly-signed Ed25519 signature (mirror-serves-stale). CLI rejects with `FATAL: Manifest version 120 < last_seen_version 127 — refusing downgrade.` A fresh manifest with `now > expires_at` would similarly be rejected on the freeze path.

## Implementation Notes

These are non-normative planning hints; they do not add or weaken requirements.

- **ACME client (row 1)**: Caddy is the ACME client. Its automatic HTTPS has renewed on RFC 9773 ARI windows since Caddy 2.8.0 ([release notes](https://github.com/caddyserver/caddy/releases/tag/v2.8.0)), so the relay carries no ACME client of its own and needs no Node library for row 1. The `acme-client` npm package (publishlab/node-acme-client, latest 5.4.0) documents no ARI support and is not used.
- **Let's Encrypt 45-day certificates** (row 1): Let's Encrypt's published schedule ([From 90 to 45](https://letsencrypt.org/2025/12/02/from-90-to-45)) gives the opt-in `tlsserver` profile 45-day certs from 2026-05-13, and moves the default `classic` profile to 64-day certs on 2027-02-10 and to 45-day certs on 2028-02-16. ARI-driven renewal logic handles 90-, 64- and 45-day certificates alike without code changes. The companion doc notes the shorter lifetimes so the person is not surprised by them.
- **Short-lived cert profile (row 1)**: the Compose relay's Caddy takes `ACME_PROFILE`, empty by default, which leaves Caddy's own profile; `shortlived` requests Let's Encrypt's 160-hour certificates through `tls { issuer acme { profile shortlived } }`. Let's Encrypt: "Short-lived certificates are opt-in and we have no plan to make them the default at this time" ([announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)). The relay's key is pinned only when its certificate is not publicly trusted ([ADR-020 §First-Run UX](../decisions/020-v1-deployment-model-and-oss-license.md#first-run-ux)), so a short-lived certificate never trips the pin.
- **Platform-specific self-update swap rules (row 7b)**: `sidekicks self-update` replaces the service's program only. The app has its own updater, which verifies the same manifest before it takes any file ([ADR-023 §Axis 3](../decisions/023-v1-ci-cd-and-release-automation.md#axis-3--release-automation)).
  - **Windows**: cannot overwrite a running `.exe`; the CLI downloads to a sibling path and renames it when the service next starts.
  - **macOS**: the app ships as a `.dmg` to install and a `.zip` for updates, signed with the project's self-signed identity until the Apple Developer certificate exists and notarized after it ([ADR-023 §Axis 5](../decisions/023-v1-ci-cd-and-release-automation.md#axis-5--code-signing-custody)); until then the first launch asks the person to open the app from Finder's menu, and nothing else in the update path waits on the certificate.
  - **Linux**: on an install a package manager owns (`.deb` or `.rpm`, which records its kind at build), `self-update` replaces no file behind the package manager and names its command: `sudo apt update && sudo apt upgrade` or `sudo dnf upgrade`. In-place self-update is reserved for installs the package manager does not own.
- **Default-ACL framing (row 4-adjacent)**: Tailscale's shipped default ACL is allow-all, tuned for VPN onboarding UX. For a security-sensitive self-host admin console, V1 MUST NOT ship an allow-all default. Spec-010 governs approval policy; Spec-024 only names this as a pitfall for the plan that owns first-run onboarding.
- **Identifier = fingerprint pattern (row 1 + row 10)**: Syncthing derives its `device-id` from the SHA-256 of the DER-encoded cert, making the identifier and the fingerprint the same artifact. V1 does not adopt this identifier pattern (PASETO KIDs are the identifier surface per ADR-010), but the display convention — show fingerprints where the person expects identifiers — is copied.

## Pitfalls To Avoid

- **Supabase `.env.example` anti-pattern**: do NOT ship `.env.example` with placeholder secrets and rely on documentation to tell the person not to boot with them. Enforcement MUST be parse-time refusal (row 2 + row 3). Supabase issue #42562 covers `generate-keys.sh` writing a non-existent env var — an experimental helper does not substitute for refuse-to-start enforcement.
- **Tailscale allow-all default ACL**: do NOT adopt an allow-all default ACL for a self-host admin console. Default-deny is correct for a security product even at first-run friction cost.
- **Syncthing mutual-ID paste for client-server**: do NOT require the person to paste IDs bidirectionally for a single-server admin flow. Reserve mutual-auth for true peer-to-peer topologies.
- **Caddy random-challenge picking**: do NOT adopt Caddy's "try a random ACME challenge type and learn over time" heuristic for auditable deployments. Deterministically prefer DNS-01 when credentials are configured, else HTTP-01.
- **Single-trust-path update distribution**: do NOT ship Ed25519-manifest-signing as the _only_ trust path for `self-update`. Post–Shai-Hulud and post-Axios 2025–2026 incidents establish that dual-path (release key + transparency-log-backed Sigstore bundle) is table stakes.
- **Whole-cert fingerprint mislabeled as "public-key fingerprint"**: the SPKI pin (RFC 7469) survives keypair-preserving cert rotation; the whole-cert hash rotates with every re-issue. What the person sees MUST clearly distinguish the two.
- **`sslmode=require` framed as "TLS enforcement"**: `require` provides eavesdropping protection only, not MITM protection (libpq docs: "I trust that the network will make sure I always connect to the server I want"). CVE-2024-10977 is the concrete exploitable path. Any doc written for the person that frames `require` as "TLS enforcement" without the MITM caveat MUST be corrected.
- **`secureProtocol` on Node for TLS-1.3-only**: `secureProtocol` is legacy and cannot enforce 1.3-only. The spec-correct path is `minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3'`.
- **Self-update while daemon has open IPC**: row 7a forbids self-swap while IPC is live. Plan-006 MUST NOT implement notify-by-default as "download + swap" even behind a flag; row 7b's CLI-invoked path is the only sanctioned swap flow.

## Acceptance Criteria

- [ ] A fresh clone followed by `docker compose up` produces a running relay deployment, with no daemon in it, with rows 1, 2, 3, 4, 5, 8, 9b and 10 active as they apply to the relay AND the relay's first-run banner (row 10) enumerates each active row with its effective value.
- [ ] Every override path emits a one-screen banner on stdout AND exactly one `security.default.override=<behavior>` structured log event per process start.
- [ ] Relay startup probe refuses to start when `pg_hba.conf` contains any enabled row with `auth_method IN ('trust','password','md5')`. Error message names the offending line number.
- [ ] Relay startup probe refuses to start against Postgres `server_version_num < 170000`. Error message names the detected version.
- [ ] Relay startup logs a non-fatal advisory when Postgres `server_version_num < 180000`, recommending PG 18.
- [ ] `sslmode IN ('disable','allow','prefer','require')` is rejected at config-parse time. `sslmode=verify-ca` is accepted with a loud banner.
- [ ] A Postgres MITM proxy interposed between relay and DB is rejected under the default `sslmode=verify-full` posture (CVE-2024-10977 repro).
- [ ] `DEPLOY_MODE=lan` (internal-CA mode) produces a `./data/trust/fingerprint.txt` containing both the RFC 7469 SPKI-SHA256 base64 pin AND the `SHA256:<hex>` whole-cert hash; both are also printed to stdout during first run.
- [ ] Relay refuses at config-parse time when `DEPLOY_MODE=public` is set AND the configured hostname ends in `.localhost`, `.local`, `.home.arpa`, `.internal`, or resolves to an RFC1918 address. Error message names the hostname and the offending LAN suffix / range.
- [ ] Relay refuses at config-parse time when `DEPLOY_MODE=lan` is set AND the configured hostname is a publicly-resolvable DNS name not in the LAN-suffix list. Error message names the hostname and the `DEPLOY_MODE=lan` constraint.
- [ ] `sidekicks self-update` verifies BOTH the Ed25519 manifest signature AND the Sigstore bundle before swap. Tampering with either alone causes refusal with a clear error naming which check failed.
- [ ] A release manifest with `version <= last_seen_version` is rejected (rollback attack).
- [ ] A release manifest with `now > expires_at` is rejected (freeze attack).
- [ ] A release manifest where `previous_manifest_hash` does not match the client's last-seen manifest hash is rejected OR the CLI fetches intermediate manifests to bridge the gap (Plan-006 decides which path; spec requires one).
- [ ] Daemon notify-only auto-update NEVER swaps the daemon binary while IPC is live. The `auto_update_check_status` gauge reflects poll state.
- [ ] All TLS surfaces reject connections from TLS 1.2 clients by default. `--legacy-tls12` mode emits the override banner and accepts TLS 1.2.
- [ ] `/metrics` endpoint exposes all the documented row-9a daemon families in Prometheus v0.0.4 format when scraped on loopback. Scraping on a non-loopback bind without the configured auth credential — bearer token or client certificate — is rejected.
- [ ] First-run banner (row 10) lists TLS mode + fingerprint, bind addresses, backup state (off, or the folder and the last run), update channel + mode, and any active overrides — all on a single screen.
- [ ] `docs/operations/self-host-secure-defaults.md` exists, contains one entry per row with verify commands the person runs, and is cross-linked from `deployment-topology.md` and ADR-020.

## Open Questions

- **Behavior 7a polling cadence**: daily? every daemon restart? on-demand? Owned by Plan-006; spec defers.
- **OAuth auth method on Postgres 18**: not explicitly required by row 5 (which allows scram-sha-256). If the person runs PG 18 with `oauth` configured, does that count as "weak"? Spec currently treats it as acceptable; Plan-028 may revisit.

## References

- Specs: 006, 020, 021, 025, 026.
- ADRs: 010 (tokens, passkeys and the remote channel), 012 (Cedar policy engine + `/metrics` source), 020 (V1 deployment model).
- Architecture: `docs/architecture/deployment-topology.md`, `docs/architecture/security-architecture.md`.
- Operations: `docs/operations/self-host-secure-defaults.md` (companion, written for the person), `docs/operations/cedar-policy-signing-and-rotation.md` (referenced for row 9a Cedar-deny counter source).

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
  - Postgres 18 release (2025-09-25): <https://www.postgresql.org/about/news/postgresql-18-released-3142/>
  - Postgres 18 release notes: <https://www.postgresql.org/docs/current/release-18.html>
  - CVE-2024-10977 (libpq MITM error injection, 2024-11-14): <https://www.postgresql.org/support/security/CVE-2024-10977/>
  - `pg_hba.conf` auth methods: <https://www.postgresql.org/docs/current/auth-pg-hba-conf.html>
  - Postgres versioning policy: <https://www.postgresql.org/support/versioning/>
- **Secure-default exemplars**
  - Caddy releases: <https://github.com/caddyserver/caddy/releases> (v2.11.2 accessed 2026-04-19)
  - Tailscale encryption: <https://tailscale.com/docs/concepts/tailscale-encryption>
  - Tailscale ACLs: <https://tailscale.com/kb/1018/acls>
  - Syncthing security principles: <https://docs.syncthing.net/users/security.html>
  - Syncthing device IDs: <https://docs.syncthing.net/dev/device-ids.html>
  - Supabase self-host: <https://supabase.com/docs/guides/self-hosting/docker>
  - Supabase `generate-keys.sh` bug: <https://github.com/supabase/supabase/issues/42562>
- **Auto-update signing**
  - TUF specification v1.0.34 (2026-01-22): <https://theupdateframework.github.io/specification/latest/>
  - Cosign v3.0.6 (2026-04-06): <https://github.com/sigstore/cosign/releases>
  - GitHub Artifact Attestations: <https://cli.github.com/manual/gh_attestation_verify> ; <https://github.com/actions/attest-build-provenance>
  - npm Trusted Publishing (GA July 2025): <https://docs.npmjs.com/generating-provenance-statements/>
  - CISA Shai-Hulud alert (2025-09-23): <https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem>
  - Unit 42 Shai-Hulud analysis: <https://unit42.paloaltonetworks.com/npm-supply-chain-attack/>
  - Vectra Axios incident (2026-03-31): <https://www.vectra.ai/blog/breaking-down-the-axios-supply-chain-incident>
  - Doyensec Electron Safe Updater (2026-02-16): <https://blog.doyensec.com/2026/02/16/electron-safe-updater.html>
  - NIST PQC timeline: <https://postquantum.com/post-quantum/cryptography-pqc-nist/>
