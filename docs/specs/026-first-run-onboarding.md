# Spec-026: First-Run Three-Way-Choice Onboarding

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `026` |
| **Slug** | `first-run-onboarding` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Depends On** | [ADR-020: V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md), [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md), [Spec-008: Control-Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md), [Spec-023: Desktop Shell And Renderer](./023-desktop-shell-and-renderer.md), [Spec-025: Self-Hostable Node Relay](./025-self-hostable-node-relay.md), [Spec-006: Session Event Taxonomy And Audit Log](./006-session-event-taxonomy-and-audit-log.md) |
| **Implementation Plan** | [Plan-026: First-Run Onboarding](../plans/026-first-run-onboarding.md) |

> **Amendment (2026-08-25, first-run provider-authentication surfacing — the provider step a fresh install previously never met; user-ratified, closes [BL-154](../archive/backlog-archive.md), §6 node NS-77).** Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule, since it adds normative §Required Behavior, §Persistence, §Default Behavior, §Fallback Behavior, §Interfaces And Contracts, §State And Data Implications, and §Acceptance Criteria text, and **restores `approved` in the same diff** through the targeted readiness-audit delta riding it — the same-PR flip-and-restore shape [Spec-029](029-provider-accounts-and-credential-homes.md), [Plan-026](../plans/026-first-run-onboarding.md), and [Plan-029](../plans/029-provider-accounts-and-credential-homes.md) take in this swap; Plan-026's paired-spec Preconditions box carries the scoped Re-opened/Delivered record. **The growth.** §Required Behavior is restated as **two independently-triggered step groups**: the three-way deployment choice and the telemetry opt-in already specified here (**Group A**, unchanged in every particular), and the new §Provider Authentication (Group B), which settles whether the node can run an agent at all. Group B is **offered, never demanded** — onboarding may complete with zero registered accounts, and the completion summary says so — is triggered on exactly three conditions including **after** an account-plane refusal, and never runs ahead of a provider run that would otherwise have been admitted. It composes the registry and readiness surfaces [Spec-029](029-provider-accounts-and-credential-homes.md) defines rather than minting a second registry, reports a provider as set up **only** on the authenticated readiness arm, and offers no field, flag, or environment variable anywhere into which a provider credential could be supplied — sign-in completes through the provider's own first-party flow, which the vendor's published policy requires. Group B deliberately **holds no state of its own**: the registry is the single source of provider truth, so nothing about the step is persisted and nothing can drift from it. **Mints nothing**: no `onboarding.*` method (the five are unchanged in name, count, and shape), no config key, no event type (the `onboarding_lifecycle` category is deliberately unwidened — the account registry is node-local, non-evented configuration), no error code (the headless arm reuses `onboarding.headless_required`), no table, and no column; no census moves.

## Purpose

Define the one-time, client-daemon first-run onboarding flow that presents the three-way deployment choice committed in [ADR-020 §First-Run UX](../decisions/020-v1-deployment-model-and-oss-license.md#first-run-ux): (1) Free public relay (default), (2) Self-host your own relay, (3) Sign up for hosted SaaS.

This spec covers the **client-daemon** first-run experience across both V1 clients (CLI and desktop). It does not define the self-hosted _operator_ first-run — that is `docker-compose up` using the package defined in [Spec-025](./025-self-hostable-node-relay.md) and is not subject to the three-way choice. [Spec-023](./023-desktop-shell-and-renderer.md) remains authoritative for keystore access, WebAuthn orchestration, and the preload bridge; this spec composes those surfaces, it does not restate them.

## Scope

In scope:

- The trigger conditions that activate the onboarding flow (first outbound invite or explicit `sidekicks onboarding start`).
- The CLI interaction flow: prompts, validation, confirmations, copy intent per choice, help text.
- The desktop interaction flow: modal or step-through placement, preload-bridge capability additions, accessibility baseline.
- Persistence of the resolved choice in daemon config at a specified path.
- Reset semantics: the CLI reset command, the daemon-side state transition, and the next-onboarding trigger shape.
- Telemetry opt-in flow: presented as a _separate_ step after the three-way choice resolves.
- Fallback handling for the structural branches: keystore unavailable, self-host TLS trust-on-first-use (TOFU) mismatch, no-network, conflicting daemon already configured, headless-no-TTY environments, resume of a partially-completed first-run.
- Event taxonomy additions (`onboarding.choice_made`, `onboarding.choice_reset`) registered in [Spec-006](./006-session-event-taxonomy-and-audit-log.md) under the `onboarding_lifecycle` category (BL-086, completed 2026-04-18).

Out of scope (see Non-Goals):

- Installer or package-manager bootstrap (brew, apt, npm, release binary).
- Self-hosted _operator_ first-run — that is `docker-compose up` per Spec-025.
- Hosted SaaS sign-up page UX, pricing surface, billing, or account dashboard (hosted product concerns).
- Relay protocol design or endpoint validation contract beyond calling the Spec-008 / Spec-025 endpoints that already exist.
- Enterprise SSO onboarding (OIDC / SAML) — deferred to V1.1+ alongside the rest of the enterprise track in [BL-060](../archive/backlog-archive.md).

## Non-Goals

- Re-deriving the three-way-choice semantics. `ADR-020 §First-Run UX` is authoritative; this spec implements it.
- Re-specifying OS-keystore mechanics, WebAuthn orchestration, or the preload bridge. Spec-023 is authoritative; this spec composes those capabilities through the bridge.
- Prompting on initial install, first daemon start, or first local session creation. Single-user local-daemon mode must reach a working session without ever hitting this flow. **This holds for both step groups**: the three-way choice is keyed to the first outbound invite, and the provider-authentication step is keyed to an account-plane refusal that has already happened — neither runs ahead of work that would otherwise have succeeded.
- Owning provider sign-in, or specifying the provider-account registry. The flow hands the operator to each provider's own first-party sign-in and never collects, stores, or intermediates provider credentials; [Spec-029](029-provider-accounts-and-credential-homes.md) is authoritative for the registry, the credential homes, the readiness derivation, and the vendor authentication-policy constraints, and this spec composes those surfaces rather than re-specifying them.
- Shipping a full telemetry-consent framework. The flow surfaces opt-in at onboarding; broader telemetry policy and UX is tracked separately.
- Designing the hosted-SaaS sign-up web surface. This spec defines the daemon-side callback contract; the web surface is a hosted product concern.

## Domain Dependencies

- [Session Model](../domain/session-model.md) — onboarding resolves before the first outbound _invite_ is issued on a session; session creation itself is not gated.
- [Participant And Membership Model](../domain/participant-and-membership-model.md) — `onboarding.choice_made` is attributed to a `ParticipantId`.

## Architectural Dependencies

- [ADR-020: V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) — authoritative three-way-choice semantics (§First-Run UX).
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) — the transport the CLI and desktop preload both use to reach the daemon.
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — hosted-SaaS scoped token persistence target; credential ceremony the desktop orchestrates.
- [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) — `DaemonStatusRead` and the typed config surface both clients consume.
- [Spec-008: Control-Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) — endpoint the chosen relay URL must satisfy for invite issuance.
- [Spec-023: Desktop Shell And Renderer](./023-desktop-shell-and-renderer.md) — desktop-side surface composes the preload bridge for keystore, WebAuthn, deep-link, and OS dialogs; this spec does not restate Spec-023's mechanisms.
- [Spec-025: Self-Hostable Node Relay](./025-self-hostable-node-relay.md) — the Node.js relay that Option 2 validates against via its observability endpoints.
- [Spec-006: Session Event Taxonomy And Audit Log](./006-session-event-taxonomy-and-audit-log.md) — destination for the two new `onboarding.*` events introduced by this spec.

## Required Behavior

The flow comprises **two independently-triggered step groups**. **Group A** — §Trigger, §Three-Way Choice Semantics, §Persistence, §Reset, and §Telemetry Opt-In below — settles where this node relays. **Group B** — §Provider Authentication (Group B) — settles whether this node can run an agent at all. They are independent: Group A has no provider dependency, Group B has no relay dependency, each has its own trigger set, and either may be settled without the other. Unqualified references to "the flow", "the choice", and "the three-way choice" throughout this spec mean Group A.

### Trigger

The daemon must present the three-way choice on exactly one of the following conditions, whichever happens first:

1. The first outbound _invite_ is attempted on any session (via CLI `sidekicks invite create` or desktop invite action).
2. An operator or user explicitly runs `sidekicks onboarding start` (CLI) or selects _Set up collaboration_ (desktop menu) to pre-stage the choice.

The flow must not trigger on:

- Daemon install, first launch, or health check.
- First session creation, first local run, first local artifact write, or any other purely single-user interaction.
- Incoming invite acceptance (the inviter's relay carries the join; the invitee's choice is deferred to their own first outbound invite).

Once the choice is persisted (see §State And Data Implications), the daemon must not re-prompt unless the user explicitly resets via `sidekicks onboarding reset`.

### Three-Way Choice Semantics

The flow must present three and only three options. Their identifiers, copy intent, and required prompts follow.

| # | Choice ID (config) | Display name | One-line framing the UI must convey |
| --- | --- | --- | --- |
| 1 | `free-public-relay` | Free public relay (default) | _Use the project-operated relay — zero config, fastest path to inviting a collaborator. Session payloads are end-to-end encrypted; the relay never sees plaintext._ |
| 2 | `self-host` | Self-host your own relay | _Point at a relay you operate (Spec-025). You own the infrastructure and the audit surface. Requires a relay URL, an admin-issued join token, and a first-connection fingerprint trust decision._ |
| 3 | `hosted-saas` | Sign up for hosted SaaS | _Open a browser to sign up for the hosted managed service. Same feature set as the free option with vendor support on the paid tier. Returns a scoped token to this daemon via deep-link or loopback callback._ |

Copy may be tightened or localized; the framing (zero-config vs. own-it vs. managed; what the user has to provide; where tokens live) must not be lost.

Option-specific required prompts:

- **Option 1 (`free-public-relay`).** The UI must display the current published relay URL from daemon config (the URL is not operator-editable from this flow). No further prompts. Token: the free tier uses the daemon's existing per-machine identity key; no network call is made until the first invite is actually issued.
- **Option 2 (`self-host`).** The UI must prompt for: the relay URL (`https://…`); the admin-issued join token (paste, never echoed on CLI); a TLS-fingerprint-trust confirmation step after the daemon's first reachability probe against `GET /readyz` at the URL. The daemon must pin the certificate's SubjectPublicKeyInfo hash on confirmation (TOFU). The admin token must be written to the OS keystore via the same keystore surface Spec-023 defines; never to a plaintext config field.
- **Option 3 (`hosted-saas`).** The UI must open the system browser to the hosted sign-up URL (a configurable constant in daemon config) with a one-shot PKCE state parameter. The daemon must listen on a `127.0.0.1:<ephemeral>/callback` loopback endpoint (desktop may alternatively register a `ai-sidekicks://` deep-link handler per Spec-023) and accept exactly one inbound callback bearing the scoped token and the matching PKCE state. The scoped token must be written to the OS keystore. The loopback listener must bind only to `127.0.0.1` and must close within 5 minutes or on first use, whichever comes first.

### Persistence

The daemon must persist the resolved choice and timestamp in a typed config section named `onboarding`:

```toml
[onboarding]
choice_id         = "free-public-relay" | "self-host" | "hosted-saas"
resolved_at       = "<RFC 3339 UTC>"
relay_url         = "<https URL — populated for all three choices>"
self_host_spki_pin = "<base64 SHA-256 — only for self-host>"
telemetry_opt_in  = true | false
```

**The block records Group A only.** The provider-authentication step group persists nothing here — see §Provider Authentication (Group B).

Config file path:

- Linux / macOS: `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (or `$HOME/.config/ai-sidekicks/config.toml` if `XDG_CONFIG_HOME` is unset, per [XDG Base Directory Specification v0.8](https://specifications.freedesktop.org/basedir-spec/latest/)).
- Windows: `%APPDATA%\ai-sidekicks\config.toml`.

Secrets (`self-host` admin token; `hosted-saas` scoped token) are never written to `config.toml`. They go through the Spec-023 keystore surface (`safeStorage` on desktop, `@napi-rs/keyring` with try/catch existence-check for CLI).

### Reset

`sidekicks onboarding reset` must:

1. Require confirmation (`--yes` bypass in non-interactive environments).
2. Delete the `[onboarding]` block from `config.toml`.
3. Delete the associated keystore entry (self-host admin token or hosted scoped token) if present. Failure to delete must not block the reset, but must be surfaced in stderr so the user can clean up manually.
4. Emit `onboarding.choice_reset` (see §State And Data Implications).
5. Not re-prompt automatically; the next first-outbound-invite re-triggers the flow.

### Telemetry Opt-In

Telemetry opt-in must be presented as a _separate step_ after the three-way choice resolves, in the same session. Default must be **off**. Copy must state: what is collected (error-class counts, version strings, choice-ID without relay URL), what is _not_ collected (session payloads, file contents, participant identifiers, relay traffic), the retention window, and how to change the setting later (`sidekicks telemetry set {on,off}`). The flow must not proceed past telemetry opt-in without an explicit choice; no silent default.

[EU ePrivacy Directive Article 5(3)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219) requires explicit consent for non-essential client-side storage; legitimate-interest is not an accepted basis. This flow's default-off posture is global (not EU-only) for uniform behavior.

### Provider Authentication (Group B)

A node that finished Group A and never met Group B can invite collaborators and cannot start a run. That was the state a fresh install was previously left in — the gap discovered only when the first provider run refused. This step group closes it by surfacing the state and handing the operator to the provider's own sign-in; it does not authenticate anyone.

**Trigger.** Group B is offered on exactly three conditions and on nothing else:

1. Inside a running onboarding flow, after the three-way choice resolves — presented as a further step, never bundled into the choice itself.
2. After a provider run has been refused on the account plane ([Spec-029 §Fallback Behavior](029-provider-accounts-and-credential-homes.md#fallback-behavior)). The refusal is the trigger, so the operator meets the step at the moment it is relevant, carrying the refusal's own remedy.
3. On explicit activation: `sidekicks onboarding start --providers` (CLI) or _Set up providers_ (desktop).

It must not trigger on install, on first daemon launch, on a health check, on session creation, or **ahead of a provider run that would otherwise have been admitted**. Group B never pre-empts admission: the daemon does not test readiness in front of a run in order to prompt, because a step that fires ahead of a run that would have succeeded is the install-time prompt this spec already forbids, relocated.

**The step.** For each provider the node supports, the step displays that provider's readiness **as the daemon derives it** ([Spec-029 §Node provider readiness and the sign-in handoff](029-provider-accounts-and-credential-homes.md#node-provider-readiness-and-the-sign-in-handoff)) — never a re-derivation from account fields — and offers, per provider:

- **Register an account**, where the provider has none. The operator supplies a display label and declares a billing mode; the daemon mints the account identity and its isolated credential home. Registration goes through the node-local `providerAccount.*` namespace under node-operator authority: this flow mints no second registry, no second credential store, and no shared home.
- **Sign in.** The operator is handed the provider's own first-party sign-in flow against that account's credential home, with the remedy named — which provider, which account, the invocation, and the home. The flow **displays** the invocation and never runs it on the operator's behalf. There is no field, flag, or environment variable anywhere in this flow into which a provider token could be supplied, and that absence is deliberate: [Spec-029 §Vendor authentication-policy constraints](029-provider-accounts-and-credential-homes.md#vendor-authentication-policy-constraints) records the vendor's published requirement that sign-in complete through the vendor's own flow.
- **Re-check.** Re-take that account's authentication probe deliberately and re-display. Re-checking is an explicit act, not a poll: the step reads the daemon's stored readiness and probes only when the operator asks.
- **Skip this provider**, at any point and without consequence to the rest of the flow.

**Ordering.** Registration precedes sign-in, because the account's isolated credential home is what the provider signs into. The probe follows sign-in, because **the probe defines success — not the sign-in process's exit code**. An abandoned or failed sign-in leaves the registration in place with its readiness honestly reported; the operator's remedy is to sign in or to remove the account, and no path leaves a half-registered row.

**What "set up" means.** A provider is reported as set up **only** on the authenticated readiness arm. An undetermined probe is displayed as undetermined, with the remedy still offered, and never as either success or a sign-in failure. Registration alone is never success: an account exists and is not signed in until the probe says otherwise. The flow never manufactures an authenticated claim from a plan label, a subscription echo, a declared billing mode, or the existence of a home directory.

**Completion posture — stated explicitly.** Onboarding **may** complete with zero registered accounts. Group B is offered, never demanded; nothing in the flow blocks on it, and a node whose operator skips it is a fully onboarded node that cannot yet start a provider run. What it displays when it completes that way is not silence: the completion summary names exactly which providers are not ready and what the first provider run will do — refuse with a typed refusal naming the remedy — so the operator leaves the flow knowing the state they chose.

**No state of its own — deliberately.** Group B persists nothing: no config key, no partial-state entry, no keystore entry, and no event. Every fact it establishes already has exactly one home in the account registry ([Spec-029 §State And Data Implications](029-provider-accounts-and-credential-homes.md#state-and-data-implications)), and a second record of a step whose truth lives elsewhere is a drift source, not a feature — a "provider setup completed" marker on a node whose accounts were later signed out would be a record that is simultaneously accurate about history and wrong about the node. None of the three triggers needs one: two are events (a running flow, a refusal that just happened) and the third is an explicit request. Re-entering the flow after `sidekicks onboarding reset` re-offers Group B, which is what a reset means. The five `onboarding.*` daemon methods are therefore unchanged in name, count, and shape; Group B composes the node-local `providerAccount.*` surface instead.

**No credential material crosses this surface.** The step reads and displays wire values from the node-local registry and readiness surfaces; it never reads, stores, or displays credential material, and it never surfaces a provider sign-in process's output, which may carry OAuth state, PKCE values, or credential fields. On desktop this is why Group B needs no new preload-bridge method for secret input: **Group B has no secret input.**

## Default Behavior

- When the UI presents the three choices, Option 1 (`free-public-relay`) is the default. The user can accept by pressing Enter (CLI) or clicking the default button (desktop).
- Telemetry opt-in default is off.
- Non-invite interactions (session creation, local runs, local artifacts) proceed without any onboarding prompt. The daemon treats the `[onboarding]` config block's absence as "not yet required."
- The provider-authentication step is offered, never demanded: onboarding completes with zero registered accounts, and a node with none is a fully onboarded node that cannot yet start a provider run.

## Fallback Behavior

- **No network at first-invite time (Option 1).** The daemon must offer a deferred-choice mode: store the resolved choice; defer network validation until the next invite attempt; log `onboarding.choice_made` with `deferred_validation: true`. The onboarding flow itself completes offline.
- **Self-host TLS fingerprint mismatch on subsequent connect (Option 2).** The daemon must refuse the connection and surface a CLI / desktop dialog asking the user to either re-run `sidekicks onboarding reset` or explicitly re-pin with `sidekicks relay repin --force` (which itself requires the user to paste the new SPKI hash to prove out-of-band verification). Silent re-trust is forbidden. (Spec-008 may later introduce a named event for this refusal path; that registration is out of scope here.)
- **Hosted-SaaS sign-up canceled or loopback callback never fires (Option 3).** The flow must time out after 5 minutes, discard the PKCE state, leave `onboarding` unset, and return the user to the three-way choice screen. No partial state persists.
- **OS keystore unavailable (Option 2, Option 3, or telemetry-choice persistence on platforms that require keystore-backed daemon tokens).** Per `Spec-023 §Fallback Behavior`: refuse to persist long-lived auth material; the session proceeds memory-only with the degradation surfaced; the flow records `onboarding.choice_made` with `keystore_available: false` so ops can diagnose. On Linux, the daemon must distinguish `basic_text` (plaintext fallback) from `gnome_libsecret` / `kwallet*` via `safeStorage.getSelectedStorageBackend()` ([Electron safeStorage docs](https://www.electronjs.org/docs/latest/api/safe-storage)) and refuse the plaintext backend for hosted / self-host tokens.
- **Conflicting daemon already configured (`config.toml` present but no `[onboarding]`, or `[onboarding]` present on a daemon installation version that predates this spec).** The daemon must migrate at first trigger: if a legacy config field maps to a current choice ID, carry it forward with `resolved_at = now()` and emit `onboarding.choice_made` with `migrated: true`; otherwise treat it as a fresh onboarding.
- **Headless / no-TTY environments (CI, SSH without pty, containers).** The CLI must detect `!process.stdin.isTTY` and refuse interactive prompting; it must print a machine-readable instruction pointing at the four env-var / flag overrides (`SIDEKICKS_ONBOARDING_CHOICE=free-public-relay`, `--relay-url=…`, `--hosted-token-stdin`, `SIDEKICKS_TELEMETRY_OPT_IN=false`) plus exit 2. The env-var path must produce the same persisted state as the interactive path — telemetry included, which is why the fourth override exists: the telemetry step admits no silent default in headless environments either.
- **Headless / no-TTY, or no reachable browser, at the provider step (Group B).** The CLI does not prompt. It prints the per-provider readiness and the out-of-band remedy — which provider, which account, the provider's own first-party sign-in invocation, and that account's credential home — and exits `2` with `onboarding.headless_required`, exactly as the Group-A headless path does. **The provider step has no environment-variable override and will not be given one:** the four Group-A overrides exist because a deployment choice is data a caller may legitimately supply, whereas a provider credential is not — accepting one through the daemon's own inputs is precisely the credential intermediation [Spec-029 §Vendor authentication-policy constraints](029-provider-accounts-and-credential-homes.md#vendor-authentication-policy-constraints) bars. The operator completes the vendor's sign-in where a browser exists, and the node re-probes.
- **The provider's sign-in does not complete (Group B).** The step reports that sign-in did not complete and re-displays readiness. It does not record success on a zero exit code — the probe defines success — and it does not surface the provider process's output in a message, an event, or a log.
- **Resume of a partially-completed first-run.** If the daemon restarts mid-onboarding (crash, SIGTERM, power), the next trigger must resume at the step the user left (choice not yet made vs. choice made but token not yet persisted vs. token persisted but telemetry-opt-in not yet resolved). A partial state file at `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (or `$HOME/.local/state/ai-sidekicks/onboarding.partial.json` if `XDG_STATE_HOME` is unset, per [XDG Base Directory Specification v0.8](https://specifications.freedesktop.org/basedir-spec/latest/)) must carry just enough to resume without re-presenting resolved steps.

## Interfaces And Contracts

### CLI Surface

```
sidekicks onboarding start           # force-trigger the flow (manual activation)
sidekicks onboarding start --providers   # activate the provider-authentication step group directly (Group B)
sidekicks onboarding reset           # clear choice + associated token; next invite re-triggers
sidekicks onboarding status          # print resolved choice, relay URL, opt-in, fingerprint (if self-host),
                                     #   and per-provider readiness with the remedy for any provider not ready
sidekicks telemetry set {on,off}     # toggle telemetry post-onboarding
```

Interactive prompts are served via [`@inquirer/prompts` v8.x](https://github.com/SBoudrias/Inquirer.js) (the 2026 TTY-prompt standard for Node.js CLIs). Non-interactive mode is selected via flags or env vars as above.

### Desktop Surface

Desktop composes the flow through two bridges exposed by the Spec-023 preload contract:

- `onboarding.presentChoice(): Promise<{choice_id, relay_url, self_host_spki_pin?, hosted_token_handle?}>` — main-process-orchestrated modal that drives the three-way choice plus any follow-on input. The renderer never handles token paste directly; all secret input flows through main-process dialogs so renderer code never sees the plaintext.
- `onboarding.telemetryPrompt(): Promise<boolean>` — second-step modal, same return-pattern.

- The Group-B entry point is _Set up providers_. The provider step is hosted in the same walkthrough as Group A when it runs inside the flow, and opens as its own walkthrough when an account-plane refusal or the menu activates it. It composes the node-local `providerAccount.*` surface directly and adds **no** preload-bridge method for provider credentials — there is no credential input for a bridge to carry, so nothing here relaxes the renderer's no-secrets posture.

Desktop follows the [VS Code walkthrough pattern](https://code.visualstudio.com/api/ux-guidelines/walkthroughs) for step-through visual layout (left-rail progress, right-pane copy and inputs, explicit primary CTA per step). The modal is non-dismissible until a choice is made or the user explicitly cancels the outbound invite that triggered it.

### Daemon JSON-RPC Additions

Per Spec-007's typed control surface, the following request/response methods must be added:

- `OnboardingStart` → returns current state (`unresolved` | `resolved` | `partial`).
- `OnboardingSubmitChoice(choice_id, options)` → persists choice + options, writes keystore entry, returns resolved state.
- `OnboardingSubmitTelemetry(opt_in: boolean)` → persists opt-in.
- `OnboardingReset(confirm: true)` → clears choice, token, partial state.
- `OnboardingRead()` → returns the public subset of `[onboarding]` (never the plaintext token).

Request/response schemas belong in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) (added by Plan-026); the shape follows the Spec-007 authenticated-principal model.

### Event Taxonomy Additions

This spec's two onboarding events are registered in [Spec-006](./006-session-event-taxonomy-and-audit-log.md) under the `onboarding_lifecycle` category (BL-086, completed 2026-04-18):

| Event (dotted form) | Payload |
| --- | --- |
| `onboarding.choice_made` | `{participantId, choiceId, relayUrl, migrated: boolean, deferredValidation: boolean, keystoreAvailable: boolean, timestamp}` |
| `onboarding.choice_reset` | `{participantId, previousChoiceId, reason: 'cli-reset' \| 'operator-reset', timestamp}` |

Payloads must not contain secret material (no tokens, no SPKI pin raw bytes — the pin is stored in config, not events).

**The provider-authentication step group emits no event, and this spec's `onboarding_lifecycle` category does not grow.** The provider-account registry is node-local, non-evented daemon configuration ([Spec-029 §State And Data Implications](029-provider-accounts-and-credential-homes.md#state-and-data-implications)), and the seen-and-settled marker is config. Emitting a provider-setup event would place node-local account facts into a session-scoped, relayed, durable log they are deliberately excluded from. The two existing `onboarding.*` events are unchanged in name, payload, and category.

## State And Data Implications

- **Config persistence.** `[onboarding]` block in `config.toml` is the single source of truth for the resolved choice. Secrets are keystore-resident; only public state (choice ID, relay URL, SPKI pin, opt-in flag) lives in the config file.
- **Partial state.** `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (or `$HOME/.local/state/ai-sidekicks/onboarding.partial.json` if `XDG_STATE_HOME` is unset) holds in-progress state until the choice resolves. It is cleared on success, on reset, or after a 24-hour staleness window.
- **Keystore writes.** Option 2 writes one entry keyed `ai-sidekicks:self-host-admin-token:<relay_url_host>`. Option 3 writes one entry keyed `ai-sidekicks:hosted-saas-scoped-token`. Both use the platform-appropriate backend per Spec-023.
- **Audit.** Both new events (`onboarding.choice_made`, `onboarding.choice_reset`) append to the daemon's local event log per [Spec-015](./015-persistence-recovery-and-replay.md); registration in Spec-006 under `onboarding_lifecycle` landed via BL-086 (completed 2026-04-18).
- **The provider step adds no persisted state.** Group B writes nothing to `config.toml`, nothing to the partial-state file, and no keystore entry: the account registry ([Spec-029](029-provider-accounts-and-credential-homes.md)) holds every fact it establishes. No credential material, credential-home path, or account identifier is written to `config.toml`.
- **Multi-daemon coexistence.** A single OS user may run multiple daemon versions during upgrade overlap. The onboarding block is keyed to the daemon binary's config-schema version; the running daemon ignores `[onboarding]` blocks with incompatible schema versions and re-triggers the flow under the current schema (`migrated: true` path).

## Example Flows

### Example: CLI first-invite on a fresh install (happy path, Option 1)

1. Alice runs `sidekicks invite create --session my-sprint`.
2. Daemon reads `config.toml`; no `[onboarding]` block. It returns `OnboardingRequired` to the CLI.
3. CLI renders the three-way choice with `@inquirer/prompts`; Alice presses Enter (default = Option 1).
4. CLI shows telemetry opt-in prompt; Alice chooses "off" (explicit default).
5. CLI submits `OnboardingSubmitChoice('free-public-relay', ...)` + `OnboardingSubmitTelemetry(false)`.
6. Daemon writes `[onboarding]` block with `resolved_at`, emits `onboarding.choice_made`, and proceeds with the original `invite create` request.
7. Total added latency: single digit seconds on happy path; network only touched when the invite issues.

### Example: Desktop first-invite, Option 2 (self-host)

1. Bob clicks _Invite collaborator_ in the desktop UI.
2. Main process checks daemon `OnboardingRead()`; returns `unresolved`.
3. Main process opens a modal through the `onboarding.presentChoice` preload bridge (renderer never sees the token).
4. Bob selects _Self-host your own_; main process prompts for relay URL and admin token (native dialog, not renderer DOM).
5. Main process probes `GET <relay_url>/readyz`; captures the certificate SPKI; shows Bob the fingerprint.
6. Bob confirms the fingerprint (out-of-band verification against what his relay operator posted).
7. Main process writes the admin token to the OS keystore via Spec-023's `safeStorage`; writes `[onboarding]` with the pinned SPKI; emits `onboarding.choice_made` with `keystoreAvailable: true`.
8. Telemetry-opt-in modal appears; Bob picks off.
9. Original invite flow resumes against the now-configured self-host relay.

### Example: CI environment (headless, Option 1 via env var)

1. CI job runs `sidekicks invite create` non-interactively.
2. Daemon triggers onboarding; CLI detects `!process.stdin.isTTY`.
3. CLI prints the four override env-vars and exits 2.
4. CI job re-runs with `SIDEKICKS_ONBOARDING_CHOICE=free-public-relay SIDEKICKS_TELEMETRY_OPT_IN=false`.
5. Daemon resolves onboarding from the env vars, writes `[onboarding]`, emits `onboarding.choice_made` with the `deferred_validation` flag set only if network is also unreachable.

### Example: Reset then re-trigger (operator recovery)

1. User: `sidekicks onboarding reset --yes`.
2. Daemon deletes `[onboarding]` block and keystore entry; emits `onboarding.choice_reset` with `reason: 'cli-reset'`.
3. Next `sidekicks invite create` re-triggers the three-way choice as for a fresh install.

## Implementation Notes

- **CLI prompt library.** Use [`@inquirer/prompts` v8.x](https://github.com/SBoudrias/Inquirer.js) — the 2026 standard, successor to `inquirer` v9, ESM-native, tree-shakable. Avoid `prompts` (maintenance-slow) and avoid hand-rolling readline for secret input (bypasses TTY echo-suppression pitfalls).
- **Desktop walkthrough pattern.** Follow the [VS Code walkthroughs UX guideline](https://code.visualstudio.com/api/ux-guidelines/walkthroughs): left-rail progress, right-pane step content, explicit primary CTA, no hidden "advanced" state. Users are making a load-bearing choice; clarity beats density.
- **Deep-link security (Option 3).** Option 3 MUST prefer the loopback-callback path over a private-use URI (custom-scheme) deep-link handler for the hosted sign-up callback, per RFC 8252 (OAuth 2.0 for Native Apps): the two mechanisms are defined in [§7.1 Private-Use URI Scheme Redirection](https://datatracker.ietf.org/doc/html/rfc8252#section-7.1) and [§7.3 Loopback Interface Redirection](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3), and [§8.8 Malicious External User-Agents](https://datatracker.ietf.org/doc/html/rfc8252#section-8.8) establishes the threat model — private-use URI scheme handlers are OS-wide and may be claimed by any other installed app that registers the same scheme (hijackable), while loopback redirection is scoped to the local process. This preference holds independent of any single CVE. The supported-Electron floor (see [ADR-016 §Decision](../decisions/016-electron-desktop-shell.md#decision)) subsumes the [CVE-2026-34776](https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885) fix — an out-of-bounds heap read in the `requestSingleInstanceLock()` second-instance IPC parser on macOS and Linux — so implementations at or above that floor are not exposed to that specific defect, but loopback is still the preferred redirect path regardless.
- **PKCE for hosted sign-up.** Per [RFC 7636 §4](https://datatracker.ietf.org/doc/html/rfc7636), PKCE code-verifier is 43–128 chars of `[A-Z0-9-._~]`; SHA-256 is the only `code_challenge_method` this spec accepts. Reject `plain` method.
- **TOFU pin format (Option 2).** Pin the SPKI SHA-256 (not the leaf cert fingerprint) so operators can rotate certificates without re-prompting. SPKI pinning is the [OWASP Certificate and Public Key Pinning](https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning) recommendation.
- **Keystore probing.** Per Spec-023's keystore surface, Desktop uses Electron `safeStorage.isEncryptionAvailable()` + `safeStorage.getSelectedStorageBackend()` ([docs](https://www.electronjs.org/docs/latest/api/safe-storage)). CLI (Node-only) uses [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) v1.2.0, which lacks an existence-check API — wrap reads in try/catch and treat `not-found` as the unresolved-partial-state signal.
- **Config schema version.** Bump the `config.toml` top-level `schema_version` when adding `[onboarding]` so older daemon binaries do not misread it; follows the Spec-007 version-negotiation posture.
- **Copy work with a writer.** The three choice one-liners are load-bearing; get copy review before V1 launch. Spec names the _framing_ required, not the final strings.

## Pitfalls To Avoid

- **Prompting on initial install or first session create.** The flow is keyed to first-invite (or explicit activation), not first-launch. Prompting earlier breaks single-user and offline modes and conflicts with `ADR-020 §First-Run UX`. Implementations that put the prompt on install-time must be rejected in review.
- **Silent defaulting to Option 1 on non-interactive invoke.** Headless environments must fail loudly with the env-var instruction. Silent selection of Option 1 in CI is a privacy footgun: a caller who intended to use self-host will leak connection attempts to the public relay.
- **Writing secrets to `config.toml`.** The admin token (Option 2) and scoped token (Option 3) must never land in the config file. Keystore-only; surface degradation if the keystore is unavailable.
- **Hidden telemetry default.** Telemetry must be an explicit second step. Bundling it into the three-way choice UI makes it easy to miss and violates the EU ePrivacy Directive §5(3) consent baseline that this product applies globally.
- **Treating the three options as two plus an escape hatch.** Some implementations may be tempted to hide Option 3 behind "Advanced" or inline it with Option 2. Don't. ADR-020 committed to three equal options; collapsing the UI redraws the commitment.
- **Re-trusting a new TLS fingerprint without operator action (Option 2).** On SPKI mismatch, refuse. Offer `sidekicks relay repin --force` with out-of-band hash paste. Silent re-trust removes the security benefit of TOFU.
- **Leaking secrets into renderer (Desktop Option 2 / Option 3).** The renderer must never handle the paste-box or the callback token directly. All secret input flows through main-process dialogs per `Spec-023 §Trust Stance`. An implementation that renders the admin-token input via `<input type="password">` in React has already leaked the secret into the renderer address space.
- **Reporting a provider as authenticated on anything but the probe.** A plan label, a subscription echo, a stored billing mode, or the existence of a home directory is not evidence of a usable credential. A surface that clears its own warning on one of those tells the operator everything is fine while every run refuses — the disagreement that arises whenever a client re-derives a predicate the daemon already computes.
- **Prompting for a provider token.** There must be no field, flag, or environment variable anywhere in this flow into which a provider credential can be supplied. Sign-in completes through the provider's own first-party flow; anything else is the credential intermediation the vendor's published policy bars.
- **Blocking onboarding on the provider step.** Group B is offered, never demanded. Making it mandatory turns a node whose operator only wants to invite collaborators into a node that cannot finish setup, and re-creates the install-time prompt this spec forbids at a different point in the flow.
- **Emitting secret payload fields in `onboarding.choice_made`.** The event must stay public-safe; no tokens, no SPKI raw bytes beyond what's already in `config.toml`. Audit-log privacy is the intent.

## Acceptance Criteria

- [ ] Onboarding flow triggers on first outbound invite or on `sidekicks onboarding start`, and never on install, first launch, or local-only session creation.
- [ ] CLI flow presents exactly three options, default = `free-public-relay`, uses `@inquirer/prompts`, and supports non-interactive env-var override (`SIDEKICKS_ONBOARDING_CHOICE`, `--relay-url`, `--hosted-token-stdin`, `SIDEKICKS_TELEMETRY_OPT_IN`) with exit code 2 on headless detection.
- [ ] Desktop flow presents the three options via the `onboarding.presentChoice` preload bridge; secret input (Option 2 token paste, Option 3 callback) never crosses into the renderer address space.
- [ ] Resolved choice persists at `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (or `%APPDATA%\ai-sidekicks\config.toml` on Windows) in the `[onboarding]` block with `choice_id`, `resolved_at`, `relay_url`, `telemetry_opt_in`, and (Option 2 only) `self_host_spki_pin`.
- [ ] Secrets (Option 2 admin token, Option 3 scoped token) are persisted via the Spec-023 keystore surface only; `config.toml` never contains them.
- [ ] `sidekicks onboarding reset` clears the `[onboarding]` block, deletes the associated keystore entry, emits `onboarding.choice_reset`, and does not re-prompt until the next trigger.
- [ ] Telemetry opt-in is a separate step after the three-way choice, default-off, with explicit copy on what is and is not collected.
- [ ] Self-host TLS fingerprint mismatch on reconnect refuses the connection and surfaces the recovery paths (reset or explicit `relay repin --force`) without silent re-trust.
- [ ] Headless-no-TTY detection fails loud with the env-var instruction and exit 2; the env-var path produces byte-identical persisted state to the interactive path.
- [ ] Partial state at `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (fallback `$HOME/.local/state/ai-sidekicks/onboarding.partial.json`) allows resume across daemon restart and clears on success, reset, or 24-hour staleness.
- [ ] `onboarding.choice_made` and `onboarding.choice_reset` events are emitted with the payload shapes defined here; registration in Spec-006 under `onboarding_lifecycle` landed via BL-086 (completed 2026-04-18).
- [ ] The provider-authentication step group is offered on exactly its three triggers — inside a running onboarding flow after the three-way choice resolves, after a provider run is refused on the account plane, or on explicit activation (`sidekicks onboarding start --providers` / desktop _Set up providers_) — and never on install, first launch, session creation, or ahead of a provider run that would otherwise have been admitted.
- [ ] A node with no accounts is offered registration for each provider; registration goes through the node-local `providerAccount.*` namespace under node-operator authority, each account receives its own credential home, and no account shares a home with another.
- [ ] The step reports a provider as set up only on the authenticated readiness arm, displays an undetermined probe as undetermined rather than as success or as a sign-in failure, and does not prompt for a provider that already has an authenticated account.
- [ ] Onboarding completes with zero registered accounts and the completion summary names which providers are not ready and what the first provider run will do; the provider step writes nothing to `config.toml`, the partial-state file, or the keystore, and the five `onboarding.*` methods are unchanged in name, count, and shape.
- [ ] The onboarding surface never reads, stores, or displays credential material and never runs a sign-in on the operator's behalf: it offers no field, flag, or environment variable for a provider token, the headless provider path prints the out-of-band remedy and exits 2, and no provider sign-in output reaches a message, an event, or a log.

## ADR Triggers

- If the hosted-SaaS sign-up flow grows to include enterprise SSO (OIDC / SAML) redirects or federated identity, file an ADR — that is an architectural extension, not a V1 UX change.
- If WebAuthn-first replaces password-based hosted sign-up across the board, update ADR-010 and revise this spec's Option 3 prompt accordingly.
- If a fourth deployment option emerges (e.g., regional hosted pop, enterprise on-prem appliance), file an ADR amending ADR-020 before this spec grows.
- If the free-default-relay is deprecated per ADR-020 Tripwire 2, file an ADR and revise this spec to present a two-way choice (self-host / hosted) with explicit migration guidance for existing `free-public-relay` users.

## Open Questions

- Linux-specific keystore degradation UX: `basic_text` fallback is known plaintext. This spec currently requires refusal of plaintext for hosted / self-host tokens, but the practical effect is that users on a barebones Linux with no Secret Service running cannot use Options 2 or 3. Do we offer a "degrade to encrypted-file-at-rest" fallback (out-of-tree keyring library), or keep the current refuse-and-surface posture and document the requirement to install `gnome-keyring` / `kwallet*`? Tentative: document, keep refusing; re-evaluate on field feedback.
- Hosted-SaaS sign-up redirect URL: hard-coded constant in daemon config, or fetched dynamically via well-known discovery at `<hosted-saas-base>/.well-known/onboarding`? Tentative: hard-coded for V1 (build-time constant); discovery when we have multiple regions.
- Telemetry opt-in copy: exact wording needs product + legal review. Current spec names _framing_ required (what is / isn't collected, retention, change-later path); final strings are a follow-up.
- Should `onboarding.choice_made` carry a hashed `machine_id` to support deployment-shape analytics? Potential useful signal, but adds a correlation axis that the default telemetry posture would otherwise not expose. Tentative: no, unless opt-in telemetry is `on`.

## References

### Primary sources

| Source | Relevance |
| --- | --- |
| [ADR-020: V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) | Authoritative three-way-choice semantics (§First-Run UX); choice ID naming. |
| [Spec-023: Desktop Shell And Renderer](./023-desktop-shell-and-renderer.md) | Keystore surface, `safeStorage` usage, WebAuthn orchestration, preload-bridge pattern, deep-link handler registration. This spec composes those mechanisms; it does not re-specify them. |
| [Spec-025: Self-Hostable Node Relay](./025-self-hostable-node-relay.md) | Option 2 validation target (`GET /readyz`, SPKI probe); admin-token issuance flow. |
| [Spec-008: Control-Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) | v2 relay protocol every chosen relay URL must satisfy. |
| [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) | Typed control surface the onboarding RPCs extend; `DaemonStatusRead` semantics. |
| [Spec-006: Session Event Taxonomy And Audit Log](./006-session-event-taxonomy-and-audit-log.md) | Destination for the two new `onboarding.*` events. |

### External references (cited inline above)

| Source | URL | Accessed |
| --- | --- | --- |
| XDG Base Directory Specification v0.8 | <https://specifications.freedesktop.org/basedir-spec/latest/> | 2026-04-17 |
| EU ePrivacy Directive (Directive 2002/58/EC, Art. 5(3), consolidated) | <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219> | 2026-04-17 |
| Electron `safeStorage` API | <https://www.electronjs.org/docs/latest/api/safe-storage> | 2026-04-17 |
| GHSA-3c8v-cfp5-9885 — CVE-2026-34776 `requestSingleInstanceLock()` second-instance IPC parser | <https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885> | 2026-04-17 |
| RFC 8252 — OAuth 2.0 for Native Apps (§7.1 private-use URI scheme / §7.3 loopback interface / §8.8 malicious external user-agents) | <https://datatracker.ietf.org/doc/html/rfc8252> | 2026-04-17 |
| `@inquirer/prompts` (v8.x, 2026 CLI prompt standard) | <https://github.com/SBoudrias/Inquirer.js> | 2026-04-17 |
| VS Code walkthroughs UX guideline | <https://code.visualstudio.com/api/ux-guidelines/walkthroughs> | 2026-04-17 |
| RFC 7636 — Proof Key for Code Exchange (PKCE) | <https://datatracker.ietf.org/doc/html/rfc7636> | 2026-04-17 |
| OWASP Certificate and Public Key Pinning | <https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning> | 2026-04-17 |
| `@napi-rs/keyring` (v1.2.0, Node-native OS keystore) | <https://github.com/Brooooooklyn/keyring-node> | 2026-04-17 |

### Related BLs (completed)

- BL-082 — Plan-026 implementation plan (this spec's plan counterpart).
- BL-084 — `arbitration.paused` / `arbitration.resumed` events registered in Spec-006 `channel_arbitration` category (completed 2026-04-18).
- BL-086 — `onboarding.choice_made` / `onboarding.choice_reset` registered in Spec-006 `onboarding_lifecycle` category (completed 2026-04-18).
