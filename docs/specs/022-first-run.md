# Spec-022: First Run

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `022` |
| **Slug** | `first-run` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Depends On** | [ADR-019: V1 Deployment Model and OSS License](../decisions/019-v1-deployment-model-and-oss-license.md), [Spec-006: Local IPC And Daemon Control](./006-local-ipc-and-daemon-control.md), [Spec-021: Desktop App And Renderer](./021-desktop-app-and-renderer.md), [Spec-025: Provider Accounts And Credential Homes](./025-provider-accounts-and-credential-homes.md), [Spec-027: Remote Control](./027-remote-control.md) |
| **Implementation Plan** | Built by the plans that own its pieces: [Plan-005](../plans/005-local-ipc-and-daemon-control.md) (the background service's start and its place on WSL 2, `sidekicks relay repin`), [Plan-020](../plans/020-desktop-app-and-renderer.md) (the first-launch cover, the sessions list's empty state, `Keep crash reports`), [Plan-023](../plans/023-provider-accounts-and-credential-homes.md) (Settings › Providers), [Plan-015](../plans/015-hosted-account-and-identity.md) (`sidekicks sign-in`) and [Plan-025](../plans/025-remote-control.md) Phase 3 (the relay key pin) |

## Purpose

Define what a person meets the first time they open the desktop app or run the `sidekicks` command line: nothing to answer. The app opens on the sessions list, and every setup act lives where it is used — a provider's install and sign-in on Settings › Providers, the hosted account on the command line, the relay on the machine's link to it — so the app is learned where the person already is.

It also defines the one trust decision first contact with a relay can involve: when the daemon pins a relay's TLS key, and what happens when a pinned key changes.

## Scope

In scope:

- The desktop app's first launch: the cover while the background service starts, where the service runs on a computer with more than one place for it, and the sessions list's empty state.
- The first use of the command line.
- Where each setup act lives, as a pointer to the spec that owns its mechanism.
- The relay's TLS key pin: which relays are pinned, the refusal when a pinned key changes, and its recovery.

Out of scope (see Non-Goals):

- Installers and package managers.
- The provider-account registry, readiness, sign-in and install ([Spec-025](./025-provider-accounts-and-credential-homes.md)).
- The hosted account's sign-in ([Spec-016](./016-hosted-account-and-identity.md)).
- Deploying a relay ([ADR-019](../decisions/019-v1-deployment-model-and-oss-license.md), [Spec-023](./023-self-host-secure-defaults.md)) and linking devices to it ([Spec-027](./027-remote-control.md)).

## Non-Goals

- A welcome wizard, a tour, a checklist, a dismissible tip, or any step in front of the first session.
- A deployment choice. The relay is the person's own — the Workers relay in their own Cloudflare account or the self-hosted Compose relay — and a machine without one works fully on its own; there is no project-operated public relay and no service run by the project to sign up for.
- A sign-in gate. The console holds no identity of its own: no organization or workspace step, no avatar, and no sign-in before the first session.
- A consent step. The app collects no usage analytics and sends nothing to the project, so there is nothing to consent to.
- Enterprise sign-on. The product has one user.

## Domain Dependencies

- [Session Model](../domain/session-model.md) — creating a session is never gated on setup.

## Architectural Dependencies

- [ADR-019: V1 Deployment Model and OSS License](../decisions/019-v1-deployment-model-and-oss-license.md) — the person's own relay, on Workers in their own Cloudflare account or under Compose on their own server, and the relay key pin (§First-Run UX).
- [Spec-005: Session Event Taxonomy And Audit Log](./005-session-event-taxonomy-and-audit-log.md) — where the relay's refusal event is registered.
- [Spec-006: Local IPC And Daemon Control](./006-local-ipc-and-daemon-control.md) — the background service's start, `sidekicks daemon status`, and the command-line verbs.
- [Spec-016: Hosted Account And Identity](./016-hosted-account-and-identity.md) — the hosted account's device-code sign-in.
- [Spec-021: Desktop App And Renderer](./021-desktop-app-and-renderer.md) — the desktop app's first-launch cover and the sessions list.
- [Spec-025: Provider Accounts And Credential Homes](./025-provider-accounts-and-credential-homes.md) — provider install, registration, readiness and sign-in, all drawn on Settings › Providers.
- [Spec-027: Remote Control](./027-remote-control.md) — linking devices through the relay, and the relay's refusals.

## Required Behavior

### First launch

- **Nothing is asked.** Opening the desktop app draws one quiet cover over the window until the background service answers, then fades it and never draws it again while the app runs. The cover carries the working indicator and one line: `Starting the background service…` when the app started the service itself, `Connecting to the background service…` when it found one already running. Nothing behind it is drawn half-painted.
- **The service's place is chosen without a question.** On a Windows computer with at least one WSL 2 distribution, the service starts where both Claude Code and Codex are found, else where one of them is, else on Windows. Where the place it lands on has neither provider, the row a session that cannot start already draws reads `Choose where Claude Code and Codex are installed` and opens the `Where Claude Code and Codex are installed` row on Settings › Providers.
- **The sessions list says it is empty in its own words.** With no sessions at all it reads `No sessions yet. Press New session to start with a chat or a project.` and names nothing else.
- **No first-run furniture, anywhere.** There is no welcome wizard, tour, checklist or dismissible tip on any surface. A surface with nothing in it says so in its own words and offers exactly one next act, named against what the session is bound to.
- **No identity step.** No sign-in stands in front of the first session. The only sign-in on any screen is a provider account's, on Settings › Providers.
- **Nothing leaves the machine for the project.** Crash reports are built on the machine that crashed, stripped of personal data there and kept there; `Keep crash reports` on Settings › General turns keeping them off, and nothing sends them anywhere.

### Where setup lives

- **Providers.** A provider is installed, its accounts registered and signed in on Settings › Providers, and nowhere else: a provider whose command is not installed reads `Not installed.` with `Install`, which runs the provider's own documented installer, and an account that is not signed in names the one remedy that applies to it. The mechanism — the registry, readiness, the sign-in — is [Spec-025](./025-provider-accounts-and-credential-homes.md)'s; this spec adds no step in front of it. A run a provider cannot start is refused with its remedy ([Spec-025 §Fallback Behavior](./025-provider-accounts-and-credential-homes.md#fallback-behavior)); the session itself is always created.
- **The hosted account.** Only Remote Control needs it, and nothing asks for it at first run. The command line signs the machine in with `sidekicks sign-in`, a device-code flow ([Spec-016 §Required Behavior](./016-hosted-account-and-identity.md#required-behavior)).
- **The relay.** The machine reaches the person's own relay once they have deployed one and linked it ([Spec-027](./027-remote-control.md)); until then every session runs on the machine alone.
- **The command line.** Every `sidekicks` command works on first use, with no setup command before it.

### The relay's key

- **Pinned only without a publicly trusted certificate.** When the machine is linked to a relay whose certificate does not chain to a root the operating system trusts — a self-signed relay, or one on a private certificate authority — the daemon pins the SHA-256 hash of the relay's SubjectPublicKeyInfo. A relay with a publicly trusted certificate is not pinned: the platform's own certificate validation and the host name check it, so a certificate renewal that makes a new key never trips a refusal.
- **A changed key is refused and recorded.** When a pinned relay presents a different key, the daemon refuses the connection and records `relay.pin_refused` on its sentinel session. `sidekicks daemon status` prints `refused: the relay's key does not match the one pinned when it was linked`. Nothing re-trusts the new key silently: the machine stays off that relay until the person accepts the new key.
- **The recovery.** `sidekicks relay repin --force`, with the new key's hash pasted and sent to the daemon as `relay.repin {spkiHash}`, accepts the new key once the person has checked it out of band. The pasted hash must match the key the relay presents.
- **Not built.** The pin and its refusal are built in [Plan-025](../plans/025-remote-control.md) Phase 3; `sidekicks relay repin` in [Plan-005 §Phase R3 — Client Delivery](../plans/005-local-ipc-and-daemon-control.md#phase-r3--client-delivery).

## Default Behavior

- The first launch asks nothing, and ordinary work — a session, a run, a file — proceeds with no setup prompt.
- `Keep crash reports` is on.
- A relay with a publicly trusted certificate is checked by the platform and never pinned.

## Fallback Behavior

- **A pinned relay presents a different key.** The connection is refused and recorded as above; the refusal never falls back to connecting, and it names its one recovery.
- **The pasted hash does not match the key the relay presents.** `sidekicks relay repin --force` refuses, changes nothing, and the pin stays as it was.
- **The first place chosen for the service has neither provider.** Sessions cannot start, and the one next act is the row that opens `Where Claude Code and Codex are installed` on Settings › Providers.

## Interfaces And Contracts

### CLI Surface

```
sidekicks relay repin --force        # accept a pinned relay's new key; prompts for the new hash
sidekicks daemon status              # prints the refusal line while a pinned relay is refused
```

`sidekicks sign-in` and `sidekicks daemon status` are [Spec-006](./006-local-ipc-and-daemon-control.md)'s; there is no first-run command.

### Event Taxonomy Additions

| Event or error | Shape |
| --- | --- |
| `relay.pin_refused` (event, on the daemon's sentinel session) | `{relayHost, pinnedSpkiPrefix, presentedSpkiPrefix}` — each prefix the first 8 bytes of its hash, never a token |
| `relay.spki_mismatch` (error, 412) | the refusal a pinned relay's changed key raises |

Both are listed with the relay's other refusals in [Spec-027 §Interfaces And Contracts](./027-remote-control.md#interfaces-and-contracts); the event is registered in [Spec-005 §Event Type Enumeration](./005-session-event-taxonomy-and-audit-log.md#event-type-enumeration) and the error in [error-contracts.md](../architecture/contracts/error-contracts.md).

First run adds no daemon method and no desktop bridge method.

## State And Data Implications

- **First run writes nothing of its own.** No configuration block, no partial-state file, no keychain entry and no event record that first run happened.
- **The relay pin.** The pinned hash is kept with the relay's link, and only for a relay without a publicly trusted certificate. `sidekicks relay repin --force` replaces it.

## Example Flows

- `Example: A person installs the app on a Mac where Claude Code is installed and signed in. The app opens under "Starting the background service…", the cover fades, and the sessions list reads "No sessions yet. Press New session to start with a chat or a project." They press New session, pick a chat, and send a message. Nothing asked them anything first.`
- `Example: A person runs the Compose relay on a home server with a self-signed certificate, so the daemon pinned its key when the machine was linked. They rebuild the server and it makes a new key. The machine's next connection is refused, relay.pin_refused lands on the sentinel session, and "sidekicks daemon status" prints "refused: the relay's key does not match the one pinned when it was linked". They read the new hash on the server, run "sidekicks relay repin --force", paste it, and the machine reconnects.`
- `Example: A person's Compose relay gets its certificate from Let's Encrypt, and Caddy makes a new key at every renewal. The certificate chains to a publicly trusted root, so nothing is pinned, and every renewal connects without a refusal.`

## Implementation Notes

- **Why a publicly trusted relay is never pinned.** Caddy, which fronts the Compose relay, creates a new key for every new certificate by default and calls key pinning "against industry best practices" ([Caddy `tls` directive](https://caddyserver.com/docs/caddyfile/directives/tls)). A pin on such a relay would refuse it at every renewal. The relay's frames are end-to-end encrypted between devices ([Spec-027](./027-remote-control.md)), so TLS here guards the relay token, and the platform's own validation is what every browser does for it.
- **Pin format.** The pin is the SHA-256 of the SubjectPublicKeyInfo, not of the leaf certificate, following [OWASP Certificate and Public Key Pinning](https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning).
- **Two pins, two layers.** This pin is the transport's. The machine-key pin of the encrypted channel ([Spec-027](./027-remote-control.md)) holds on both relays whatever their certificate.

## Pitfalls To Avoid

- **Adding a step in front of the first session.** A wizard, a tour, a tip, a consent screen or a sign-in gate each puts a question where the person expected work.
- **Pinning a publicly trusted relay's key.** Caddy's default key rotation makes that pin refuse the relay at every renewal.
- **Re-trusting a changed key without the person.** The refusal is the whole protection; a silent re-pin removes it.
- **Putting more than the prefixes in the refusal event.** `relay.pin_refused` carries the first 8 bytes of each hash and never a token.

## Acceptance Criteria

- [ ] The first launch asks no question: the cover reads `Starting the background service…` or `Connecting to the background service…`, fades once the service answers, and is not drawn again while the app runs.
- [ ] With no sessions the list reads `No sessions yet. Press New session to start with a chat or a project.` and names nothing else.
- [ ] No surface draws a welcome wizard, tour, checklist, dismissible tip or sign-in gate, and a session can be created before any provider account, hosted account or relay exists.
- [ ] A relay whose certificate chains to a root the operating system trusts is never pinned, and a renewal that changes its key connects.
- [ ] A pinned relay that presents a different key is refused, `relay.pin_refused` is recorded with 8-byte prefixes and no token, `sidekicks daemon status` prints the refusal line, and the machine does not reconnect to it until `sidekicks relay repin --force` is run with a hash matching the presented key.
- [ ] `sidekicks relay repin --force` with a hash that does not match the presented key changes nothing.

## Open Questions

None.

## References

### Primary sources

| Source | Relevance |
| --- | --- |
| [ADR-019: V1 Deployment Model and OSS License](../decisions/019-v1-deployment-model-and-oss-license.md) | The person's own relay and the relay key pin. |
| [Spec-006: Local IPC And Daemon Control](./006-local-ipc-and-daemon-control.md) | The service's start and the command-line verbs. |
| [Spec-016: Hosted Account And Identity](./016-hosted-account-and-identity.md) | The hosted account's device-code sign-in. |
| [Spec-021: Desktop App And Renderer](./021-desktop-app-and-renderer.md) | The first-launch cover and the sessions list. |
| [Spec-025: Provider Accounts And Credential Homes](./025-provider-accounts-and-credential-homes.md) | Provider install, registration, readiness and sign-in. |
| [Spec-027: Remote Control](./027-remote-control.md) | Linking through the relay; the relay's refusals; the machine-key pin. |

### External references (cited inline above)

| Source | URL | Accessed |
| --- | --- | --- |
| Caddy `tls` directive (key rotation at renewal; key pinning against best practice) | <https://caddyserver.com/docs/caddyfile/directives/tls> | 2026-09-24 |
| OWASP Certificate and Public Key Pinning | <https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning> | 2026-04-17 |
