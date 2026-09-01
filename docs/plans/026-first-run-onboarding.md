# Plan-026: First-Run Onboarding

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `026` |
| **Slug** | `first-run-onboarding` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-026: First-Run Three-Way-Choice Onboarding](../specs/026-first-run-onboarding.md) |
| **Required ADRs** | [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md); [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md); [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md); [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md); [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) |
| **Dependencies** | Plan-007 (local daemon JSON-RPC transport and typed config surface — this plan adds the five `onboarding.*` methods to it; `Onboarding*` are the request/response type names); Plan-023 (desktop shell — this plan extends the preload bridge with an `onboarding.*` namespace, consumes the Spec-023 keystore surface and the `safeStorage` backend probe, and runs inside the main-process modal orchestration pattern); Plan-025 (self-hostable relay — Option 2's TOFU reachability probe targets its `GET /readyz` endpoint); Plan-008 (control-plane surface — Option 3's hosted-SaaS redirect URL is served by the project-operated deployment of this relay); Plan-006 (session event taxonomy — `onboarding.choice_made` / `onboarding.choice_reset` are registered here under BL-086, completed 2026-04-18; this plan consumes that registration); Plan-029 (node-local provider-account registry and the per-provider readiness projection — the provider-authentication step group consumes both and mints neither, CP-026-6) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

> **Amendment (2026-08-25, first-run provider-authentication surfacing — the provider step group a fresh install previously never met; user-ratified, closes [BL-154](../archive/backlog-archive.md), §6 node NS-77).** Flips the previously-`approved` plan to `review` per the audit runbook's plan behavior-change row — it adds **I-026-11**, **I-026-12**, **I-026-13**, **CP-026-6**, Implementation Steps 23-25, and a new **Phase 7** — and **restores `approved` in the same diff** through the targeted readiness-audit delta riding it, the in-swap flip-and-restore shape the NS-63 / NS-65..NS-74 cohort established. [Spec-026](../specs/026-first-run-onboarding.md), [Spec-029](../specs/029-provider-accounts-and-credential-homes.md), and [Plan-029](./029-provider-accounts-and-credential-homes.md) flip and restore in the same swap; the §Preconditions boxes below carry the scoped Re-opened/Delivered record. **The growth.** `Spec-026 §Provider Authentication (Group B)` is implemented as one terminal supplement phase rather than threaded through the existing six, so no shipped phase's gate moves: Phase 7 carries all four Group-B tasks behind an `external_plan_phase_merged` entry on [Plan-029](./029-provider-accounts-and-credential-homes.md) **Phase 3**, which resolves against that plan's own shipment manifest instead of a human-ticked carrier box (the NS-64 "check the box by making the carrier unnecessary" outcome) — Phase 3 rather than the Phase 2 that produces the registry, because T7.4 asserts a provider run **starts** and the spawn path is Phase-3 machinery (Codex round 1; Phase 3's own gate names Phase 2, so nothing is dropped). **Two closed-set quantifiers are re-derived by counting the post-edit body**: the §Implementation Phase Sequence preamble six → **seven** phases over twenty-two → **twenty-five** Implementation Steps, and the §Done Checklist task count 22 → **26**. **The §Touched But Not Owned set moves eight → ten**, re-derived by counting the post-edit block: the Codex round-2 fold adds `apps/cli/src/exit-codes.ts` (Plan-007-owned) for the one call that routes an account-plane refusal into Group B, and the round-3 fold adds `packages/client-sdk/src/index.ts` (Plan-001-owned) for the barrel line that makes the relocated coordinator importable at all. Group B still adds no clipanion command (the CLI entry point is a flag on the existing `onboarding start`), no preload-bridge method (it has no secret input to carry, so the walkthrough host passes the projection into a view-only renderer and performs the actions itself), and no registry re-export. **Mints nothing on any census**: no `onboarding.*` method (the five are unchanged in name, count, and shape), no config key, no event type, no error code (the headless arm reuses `onboarding.headless_required`), and no table. The one column pair this bundle mints is Plan-029's, on that plan's unshipped `provider_accounts` CREATE statement, and it moves no census (SQLite stays at 56).

## Goal

Ship the Spec-026 three-way first-run-choice onboarding flow across both V1 clients (CLI via `@inquirer/prompts` v8.x; desktop via the Plan-023 preload bridge + a VS-Code-walkthrough-patterned renderer) with: single-trigger discipline (first outbound invite OR explicit `sidekicks onboarding start`), typed `[onboarding]` TOML persistence at `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` via `smol-toml` v1.6.1, keystore-only secret persistence via Spec-023's surface (never `config.toml`), RFC 8252 §7.3 loopback-preferred + RFC 7636 PKCE S256 callback for hosted SaaS (Option 3), OWASP-recommended SPKI SHA-256 TOFU pin for self-host (Option 2), explicit-second-step telemetry opt-in default-off per EU ePrivacy Directive Art. 5(3), headless env-var path producing byte-identical persisted state to the interactive path, and partial-state resume across daemon restart with a 24-hour staleness window. Event emission wires `onboarding.choice_made` / `onboarding.choice_reset` into the daemon event log; Spec-006 registration landed under BL-086 (completed 2026-04-18) per the same follow-up pattern BL-084 used, and this plan consumes the registered `EventType` union directly.

## Scope

- `packages/runtime-daemon/src/onboarding/` — **new module in the daemon.** Owns the orchestration service, the TOML config store, the partial-state store, the SPKI TLS probe, the loopback HTTP server for the PKCE callback, the keystore-client wrapper, the telemetry-opt-in store, and the event emitters.
- `packages/contracts/src/onboarding.ts` — **new contract file.** Exports the typed surface shared across daemon, CLI, and desktop: `OnboardingChoiceId`, `OnboardingState`, `OnboardingConfig`, `OnboardingPartialState`, and the five JSON-RPC request/response shapes.
- `apps/cli/src/commands/onboarding/` — **new CLI subcommand tree.** `start.ts`, `reset.ts`, `status.ts`, plus a top-level `telemetry/set.ts` command. Interactive prompts via `@inquirer/prompts` v8.x (successor to `inquirer` v9 — ESM-native, tree-shakable, active maintenance; see §Risks And Blockers for the ESM constraint).
- `apps/desktop/src/preload/onboarding.ts` — **new preload-bridge namespace.** Extends the `window.sidekicks` surface authored by Plan-023 with `onboarding.presentChoice()` and `onboarding.telemetryPrompt()` — both return promises whose resolution flows from main-process modals, not renderer DOM.
- `apps/desktop/src/main/onboarding/` — **new main-process orchestration.** `modal.ts` (native dialog for token paste — renderer never sees plaintext), `spki-confirm-dialog.ts` (Option 2 fingerprint confirmation), `hosted-browser.ts` (`shell.openExternal()` + loopback wait), `walkthrough-host.ts` (mounts the renderer walkthrough when the modal is non-native).
- `apps/desktop/src/renderer/src/onboarding/` — **new renderer walkthrough.** VS-Code-walkthrough-patterned step-through UI with left-rail progress + right-pane content per [VS Code walkthroughs UX guideline](https://code.visualstudio.com/api/ux-guidelines/walkthroughs). Three steps, explicit primary CTA per step, non-dismissible until a choice is made.
- Five new JSON-RPC methods authored on the daemon side — wire names `onboarding.start` / `onboarding.submitChoice` / `onboarding.submitTelemetry` / `onboarding.reset` / `onboarding.read` per §API And Transport Changes. `Spec-026 §Interfaces And Contracts` names these operations abstractly (`OnboardingStart` …); the PascalCase symbols are this plan's request/response **type** names, never wire names.
- Config schema: `[onboarding]` block written to `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (or `%APPDATA%\ai-sidekicks\config.toml` on Windows) via `smol-toml` v1.6.1 per `Spec-026 §Persistence`.
- Partial-state file: `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (fallback `$HOME/.local/state/ai-sidekicks/onboarding.partial.json`) with 24-hour staleness window and clear-on-success / clear-on-reset semantics.
- Keystore writes via the Spec-023 surface: Option 2 writes `ai-sidekicks:self-host-admin-token:<relay_host>`; Option 3 writes `ai-sidekicks:hosted-saas-scoped-token`. Both are keystore-only — never `config.toml`.
- Option 2 TOFU: a one-shot TLS probe (`tls.connect()` + `getPeerCertificate()`) extracting the SPKI SHA-256 hash base64-encoded for pinning per [OWASP Certificate and Public Key Pinning](https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning).
- Option 3 callback: a loopback HTTP server bound to **`'127.0.0.1'`** (not `'localhost'` — see §Risks And Blockers), ephemeral port, one-shot callback, 5-minute `AbortSignal.timeout(300_000)` ceiling, PKCE S256 via [`oauth4webapi`](https://github.com/panva/oauth4webapi) v3.8.5 (panva's minimal-surface-area primitives — `openid-client` v6.8.3 would also work but carries full OIDC machinery we do not need).
- Headless environment detection via `!process.stdin.isTTY` (CLI only) + four env-var overrides (`SIDEKICKS_ONBOARDING_CHOICE`, `SIDEKICKS_RELAY_URL`, `SIDEKICKS_HOSTED_TOKEN_STDIN`, `SIDEKICKS_TELEMETRY_OPT_IN`) producing byte-identical persisted state to the interactive path.
- **Provider-authentication step group (Group B)** per `Spec-026 §Provider Authentication (Group B)`: a daemon-side step model in `packages/runtime-daemon/src/onboarding/provider-step.ts`, a `--providers` flag on the existing `sidekicks onboarding start` command plus per-provider readiness in `sidekicks onboarding status`, and a renderer step hosted by the existing walkthrough. It **consumes** [Plan-029](./029-provider-accounts-and-credential-homes.md)'s node-local `providerAccount.*` registry and its per-provider readiness projection (CP-026-6) and mints neither; it adds no `onboarding.*` method, no `[onboarding]` key, no partial-state entry, no keystore entry, and no event.
- Event emission for `onboarding.choice_made` / `onboarding.choice_reset` wired into the daemon event bus (already owned by Plan-006); payload shapes per `Spec-026 §Event Taxonomy Additions`. Spec-006 registration landed under BL-086 (completed 2026-04-18) in the `onboarding_lifecycle` category — this plan now consumes that registration rather than forward-declaring it.

## Non-Goals

- **Re-specifying Spec-023 mechanisms.** Keystore access, `safeStorage` backend-probe, WebAuthn orchestration, preload-bridge invariants, deep-link protocol registration — all owned by Spec-023 / Plan-023. This plan consumes them. An edit to `safeStorage.ts` or to `preload/index.ts` main surface is a review rejection unless it is strictly additive (exposing a new `onboarding.*` method).
- **Installer / package-manager bootstrap.** This plan does not ship brew / apt / npm post-install hooks or a `setup.exe` wizard. `Spec-026 §Scope` excludes this; first-run onboarding starts when the daemon does, not when the installer runs.
- **Self-hosted operator first-run.** `docker-compose up` for the Spec-025 relay is a separate operator-facing flow owned by Plan-025. This plan is the _client_-side onboarding.
- **Hosted-SaaS sign-up web UX.** This plan authors only the daemon-side loopback callback contract; the sign-up page + pricing + billing UI lives in the hosted-product track. No new routes land here; the redirect URL is a build-time constant.
- **Spec-006 event registration.** The two new `onboarding.*` events are emitted here but were registered under the Spec-006 §Event Taxonomy table by BL-086 (completed 2026-04-18), matching the post-land follow-up pattern BL-084 used for `arbitration.paused` / `arbitration.resumed`.
- **Device Authorization Grant (RFC 8628), DPoP sender-constraining, and refresh-token rotation for the Option-3 hosted-SaaS token.** [ADR-010 §Decision](../decisions/010-paseto-webauthn-mls-auth.md#decision) item 2 names all three for control-plane tokens; the onboarding scoped token is a one-shot bootstrap credential obtained through the RFC 8252 §7.3 loopback path that [ADR-020 §First-Run UX](../decisions/020-v1-deployment-model-and-oss-license.md#first-run-ux) permits, and is exchanged for a control-plane session by Plan-008's join path — which is where the three mechanisms bind. This plan neither implements nor weakens them.
- **Enterprise SSO onboarding (OIDC / SAML).** Deferred to V1.1+ per `Spec-026 §Scope`'s out-of-scope list and BL-060.
- **Control-plane API for telemetry collection.** `sidekicks telemetry set {on,off}` flips the local flag; the server-side telemetry ingestion surface is tracked in a separate, unscheduled track.
- **Prompting on initial install, first daemon start, or first local session.** Single-user local-daemon mode reaches a working session without ever hitting this flow. Implementations that prompt earlier than the first-outbound-invite trigger are a review rejection (`Spec-026 §Pitfalls To Avoid`). This holds for both step groups: the provider step is keyed to an account-plane refusal that has already happened, and a readiness test placed **ahead** of a provider run in order to prompt is the same rejection at a different point in the flow (I-026-11).
- **No provider-account registry, credential home, readiness derivation, or sign-in mechanism.** All four are [Spec-029](../specs/029-provider-accounts-and-credential-homes.md) / [Plan-029](./029-provider-accounts-and-credential-homes.md) surfaces that this plan consumes through CP-026-6. This plan authors no account store, re-derives no readiness predicate from account fields, composes no keychain entry name, and runs no provider sign-in command; a Group-B surface that computes readiness locally is a review rejection.

## Preconditions

- [x] Spec-026 is approved (this plan is paired with it). **Re-opened 2026-08-25, scoped to the first-run provider-authentication amendment:** Spec-026 gained normative §Required Behavior, §Persistence, §Default Behavior, §Fallback Behavior, §Interfaces And Contracts, §State And Data Implications, and §Acceptance Criteria text (the §Provider Authentication (Group B) step group), so the spec flipped `approved → review` per the audit runbook's spec-amendment rule and this plan flips with it under the runbook's plan behavior-change row. **Delivered 2026-08-25** by the targeted readiness-audit delta riding the same diff (§6 node NS-77), which audits the amendment, re-checks this box, and restores both to `approved`. **Re-opened 2026-08-25** a second time, scoped to the CLI executable-name canonicalization: Spec-026's §Three-Way Choice Semantics Option-3 sentence — normative §Required Behavior — carried an `ai-`-prefixed spelling of the deep-link scheme [Spec-023 §Deep-Link Invite Flow](../specs/023-desktop-shell-and-renderer.md#deep-link-invite-flow) owns and that same sentence cites, so the spec flipped `approved → review` per the audit runbook's [§Spec-Status Promotion Gate](../operations/plan-implementation-readiness-audit-runbook.md#spec-status-promotion-gate). **This plan records a no-flip** — the correction moves no plan-side surface, mints no invariant, task, or obligation, and the scheme's canonical value has not moved — the NS-72 precedent where a spec flips and restores while its plan stays `approved` because no plan-side enumeration exists. **Delivered 2026-08-25** by the executable-name targeted readiness-audit delta riding that same diff (§6 node NS-79), which re-checks this box and restores Spec-026 to `approved`.
- [x] ADR-020 (V1 Deployment Model) is accepted — defines the three-way-choice semantics this plan implements.
- [x] ADR-009 (JSON-RPC IPC Wire Format) is accepted — the transport the five new methods ride.
- [x] ADR-010 (PASETO + WebAuthn + MLS Auth) is accepted — hosted-SaaS scoped-token persistence target.
- [x] ADR-015 (V1 Feature Scope Definition) is accepted — fixes onboarding inside V1 scope as the client-side surface of the ADR-020 deployment-model commitment; this plan adds no feature beyond that row.
- [x] ADR-016 (Electron Desktop Shell) is accepted — preload-bridge pattern this plan extends.
- [ ] Plan-007 ships the JSON-RPC transport and config-surface IPC the daemon side of this plan uses. Plan-026 is a downstream consumer. If Plan-007 lands without a config-write path, this plan cannot persist `[onboarding]`.
- [ ] Plan-023 ships the preload bridge (`window.sidekicks`), the keystore surface, the `safeStorage` backend probe, and the main-process modal pattern. Plan-026's desktop surface is a strictly-additive namespace extension (`window.sidekicks.onboarding`). Until Plan-023's main-process scaffold is in, only the CLI path of this plan can ship.
- [ ] Plan-025 exposes the self-hostable relay's `GET /readyz` endpoint with a TLS-terminated HTTPS listener; Option 2's TOFU probe needs a reachable HTTPS certificate chain to pin.
- [ ] Plan-029 ships the node-local provider-account registry and its per-provider readiness projection (Phase 2), **and** the account resolution, admission stamping, and fail-closed spawn validation that make a provider run start (Phase 3). The provider-authentication step group consumes the first pair and re-derives neither (CP-026-6); it needs the second because T7.4 asserts the first provider run **starts**. Enforcement is mechanical, not by tick: Phase 7's `external_plan_phase_merged` entry names Plan-029 Phase 3 — whose own gate names Phase 2 — and resolves against that plan's own shipment manifest, so this box is a legibility record rather than a second gate. Phases 1-6 are unaffected by it.
- [ ] Plan-008 serves the project-operated hosted relay so the hosted-sign-up redirect URL is a real, served URL. Without Plan-008's deployment, Option 3 can be code-complete but not end-to-end testable.
- [x] BL-086 `completed` (2026-04-18) registered `onboarding.choice_made` and `onboarding.choice_reset` under Spec-006's `onboarding_lifecycle` category with payload shapes matching this plan's emitter. This plan consumes the registered `EventType` union directly.
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — **Re-opened 2026-08-25, scoped to the first-run provider-authentication amendment's growth** (I-026-11..13, CP-026-6, Implementation Steps 23-25, Phase 7) and **Delivered 2026-08-25** by the targeted readiness-audit delta riding the same diff (§6 node NS-77), which re-checks this box and restores `approved`; that delta's gate walk and its two re-derived closed-set quantifiers are recorded in §Notes. Original record — Tier-9 audit (2026-08-12, §6 node NS-21, the tier-audit chain's final entry): 4 critical / 8 major / 6 minor findings adjudicated. Backfilled §Implementation Phase Sequence (6 phases over the 22 committed Implementation Steps), §Invariants (I-026-1..10), §Cross-Plan Obligations (CP-026-1..5), and per-phase `#### Tasks` (22 tasks), transcribing this plan's already-committed body and the counterparties' already-committed obligation text. Corrected twelve `packages/cli` path occurrences across ten lines to the Plan-007-owned `apps/cli`; registered the `apps/cli/src/main.ts` clipanion registration and the Plan-023 renderer-ESLint ban-list extension as §Touched But Not Owned entries seven and eight, then re-derived that section's closed-set quantifier six → eight by counting the post-repair block; minted CP-026-5 as the carrier for the `onboarding.spki_mismatch` crossing into Plan-008; corrected the ADR-016 Node-24 misattribution (ADR-022 owns the two-tier Node target, and the daemon `engines` bump instruction is withdrawn as both unnecessary and tier-breaking), the superseded daemon-auth framing in §API And Transport Changes (the per-restart 256-bit session token is required, and `Spec-021 §Scope` is a rate-limit exclusion rather than an authentication authority), the Plan-023 renderer-ESLint step number (17, not 19), the I-007-9 cite split (dotted-name conformance only; the mandatory schema pair is the `register<P, R>(…)` signature's), and the renderer `password-dialog/` path (struck — the surface is main-process-owned); extended the headless override set three → four so the telemetry step has a headless expression at all; scoped the Option-3 device-grant / DPoP / refresh-rotation gap out in §Non-Goals; and added the ADR-015 acceptance box. Backfill and correction only — no new design — so Plan-026 stays `approved` per the NS-19/NS-20 backfill precedent. Residual this box does not clear, each owned by a document this plan cannot author and none of them a Plan-026 dispatch gate: the ADR-010 Decision-Log row pairing the §Non-Goals Option-3 scope-out; the ADR-020 Decision-Log row recording the CA-bundle → OWASP SPKI-pinning refinement; the Spec-026 override-count re-derivation (three → four); the cross-plan-dependencies §2 rows registering this plan's CLI content ownership and its `apps/cli/src/main.ts` extender entry, plus the strike of its never-carried control-plane redirect-handler extender entry; and Plan-023's declaration of `createTier1Bridge()` as the factory whose per-namespace throwing stubs downstream plans replace — all of which land in this audit's own tier PR, not as open work.

## Target Areas

### New contracts

- `packages/contracts/src/onboarding.ts` — **created by this plan.** Exports:
  - `OnboardingChoiceId = 'free-public-relay' | 'self-host' | 'hosted-saas'`
  - `OnboardingState = 'unresolved' | 'partial' | 'resolved'`
  - `OnboardingConfig` (typed view of the `[onboarding]` TOML block)
  - `OnboardingPartialState` (typed view of the partial-state JSON)
  - `OnboardingStartRequest / Response`
  - `OnboardingSubmitChoiceRequest / Response`
  - `OnboardingSubmitTelemetryRequest / Response`
  - `OnboardingResetRequest / Response`
  - `OnboardingReadRequest / Response`

### New daemon module

- `packages/runtime-daemon/src/onboarding/` — **created by this plan.**
  - `service.ts` — `OnboardingService` orchestrator. Owns the state machine `unresolved → partial → resolved` plus `resolved → reset → unresolved` transitions.
  - `config-store.ts` — reads / writes `[onboarding]` block in `config.toml` via `smol-toml` v1.6.1. Preserves other TOML sections; merges not overwrites.
  - `partial-state-store.ts` — reads / writes `onboarding.partial.json`; enforces the 24-hour staleness window on read (stale reads delete the file and return `null`); also exposes a non-mutating `peek` that `onboarding.read`'s handler uses: `peek` applies the same 24-hour staleness check without deleting — a stale file reports as absent (`state: 'unresolved'`), so stale partial state is never observable through any method and Spec-026's clear-on-staleness semantics hold observably at the 24-hour boundary; physical deletion happens at the next mutating entry point (`onboarding.start` per step 19, or any submit / reset), keeping the read method side-effect-free.
  - `spki-probe.ts` — one-shot `tls.connect()` against the provided relay URL; extracts `PeerCertificate.pubkey` (Node's `getPeerCertificate()` documents this field only as "the public key"; it is empirically the SubjectPublicKeyInfo DER encoding via OpenSSL's `X509_PUBKEY_get0` path — integration test below validates by hashing against `openssl x509 -pubkey \| openssl pkey -pubin -outform DER \| sha256sum`); returns `base64(sha256(SPKI_DER))` for pin comparison.
  - `pkce-callback.ts` — Node-native `http.createServer()` bound to `'127.0.0.1'` at `port: 0` (OS-assigned ephemeral); one-shot listener; 5-minute `AbortSignal.timeout(300_000)` ceiling; state-parameter one-shot check.
  - `pkce-state.ts` — PKCE verifier / challenge generation via `oauth4webapi`'s `generateRandomCodeVerifier()` + `calculatePKCECodeChallenge()` (SHA-256 S256 only; `plain` is refused on the server side by design, but we refuse it on the client side too so downgrade attacks cannot succeed).
  - `keystore-client.ts` — thin wrapper around the Spec-023 keystore surface. CLI path uses `@napi-rs/keyring` v1.2.0 directly (with try/catch `not-found` idiom since the library lacks an existence-check API); desktop path forwards to main-process `safeStorage` via the IPC bridge Plan-023 authors. Linux: refuse writes when `safeStorage.getSelectedStorageBackend()` returns `'basic_text'` or `'unknown'` per Spec-023's Linux gotcha.
  - `events.ts` — emits `onboarding.choice_made` / `onboarding.choice_reset` into the daemon event bus; payload shapes per `Spec-026 §Event Taxonomy Additions`.
  - `rpc-handlers.ts` — registers the five `onboarding.*` methods against Plan-007's `MethodRegistry` via `register()` (Plan-007 transport).

### New CLI surface

- `apps/cli/src/commands/onboarding/` — **created by this plan.**
  - `start.ts` — force-trigger; presents three-way choice + telemetry-opt-in; resumes partial state if present.
  - `reset.ts` — clears `[onboarding]` + keystore + partial state; emits `onboarding.choice_reset`.
  - `status.ts` — prints resolved state (never the plaintext token).
- `apps/cli/src/commands/telemetry/` — **created by this plan.**
  - `set.ts` — handles `sidekicks telemetry set {on,off}` (post-onboarding flip).
- `apps/cli/src/prompts/` — **created by this plan.**
  - `three-way-choice.ts` — `@inquirer/prompts` `select` driving the three-way choice.
  - `self-host-inputs.ts` — relay URL + admin-token `password`-prompt (no echo on TTY) for Option 2.
  - `spki-confirm.ts` — presents the derived SPKI SHA-256 b64 for out-of-band verification.
  - `telemetry-opt-in.ts` — standalone second-step prompt, default-off.
- `apps/cli/src/env/` — **created by this plan.**
  - `headless-detect.ts` — detects `!process.stdin.isTTY`; returns the machine-readable instruction payload.
  - `env-override.ts` — reads `SIDEKICKS_ONBOARDING_CHOICE`, `SIDEKICKS_RELAY_URL` (equivalently `--relay-url`), `SIDEKICKS_HOSTED_TOKEN_STDIN` (equivalently `--hosted-token-stdin`), and `SIDEKICKS_TELEMETRY_OPT_IN` — the fourth being required for `Spec-026 §Telemetry Opt-In`'s no-silent-default rule to hold on the headless path, which `Spec-026 §Example Flows` already exercises; produces the same `OnboardingSubmitChoiceRequest` + `OnboardingSubmitTelemetryRequest` pair the interactive path produces.

### New desktop surface

- `apps/desktop/src/preload/onboarding.ts` — **created by this plan.** Extends `window.sidekicks` with the two `onboarding.*` methods from `Spec-026 §Desktop Surface`. Typed narrowly (no `any`) to remain inside Plan-023's narrow-preload-bridge contract.
- `apps/desktop/src/main/onboarding/modal.ts` — **created by this plan.** Native Electron `dialog.showMessageBox` (three-way choice buttons) + native password-dialog for Option 2 token paste. Renderer never handles token input.
- `apps/desktop/src/main/onboarding/spki-confirm-dialog.ts` — **created by this plan.** Shows the derived SPKI fingerprint (multi-line monospace) for out-of-band operator confirmation.
- `apps/desktop/src/main/onboarding/hosted-browser.ts` — **created by this plan.** Calls `shell.openExternal()` to the hosted sign-up URL; spins up the `pkce-callback.ts` loopback server; awaits callback or timeout.
- `apps/desktop/src/main/onboarding/walkthrough-host.ts` — **created by this plan.** When the modal flow is the VS-Code-walkthrough style (preferred over native dialog for the choice step), mounts the renderer walkthrough from `apps/desktop/src/renderer/src/onboarding/` into a dedicated `BrowserWindow` with the same hardened `webPreferences` Plan-023 authors.
- `apps/desktop/src/renderer/src/onboarding/Walkthrough.tsx` — **created by this plan.** VS-Code-walkthrough-patterned React component per [VS Code walkthroughs UX guideline](https://code.visualstudio.com/api/ux-guidelines/walkthroughs): left-rail progress, right-pane step content, explicit primary CTA per step. The renderer is a view-only projection; all decisions flow to `window.sidekicks.onboarding.*` which lives in main.

### Doc extensions

- `docs/architecture/contracts/api-payload-contracts.md` — **extended by this plan.** Adds the five new JSON-RPC request / response shapes under a new §Onboarding APIs section.
- `docs/architecture/contracts/error-contracts.md` — **extended by this plan.** Adds error codes `onboarding.already_resolved` (409), `onboarding.partial_stale` (410), `onboarding.spki_mismatch` (412), `onboarding.keystore_unavailable` (503), `onboarding.callback_timeout` (408), `onboarding.pkce_state_mismatch` (400), `onboarding.headless_required` (428).
- `docs/backlog.md` — **read-only verified by this plan.** BL-086 — "Register `onboarding.choice_made` / `onboarding.choice_reset` under Spec-006 §Event Taxonomy" completed 2026-04-18 (same pattern BL-084 uses); step 22 of this plan is a registration-landed + payload-shape cross-check against Spec-006, not a filing action.

### Group-B surfaces (all owned by this plan)

- `packages/runtime-daemon/src/onboarding/provider-step.ts` — **created by this plan.** The Group-B step model: reads Plan-029's readiness projection, applies the three-trigger discipline, and hands both the projection and the daemon-composed remedy to the surfaces unmodified.
- `apps/cli/src/commands/onboarding/start.ts` / `status.ts` — **extended by this plan** (both already created by it): the `--providers` activation flag and the per-provider readiness block. **No new command file and no new clipanion registration** — the §Touched But Not Owned `apps/cli/src/main.ts` entry stays at four `.register()` calls.
- `apps/desktop/src/renderer/src/onboarding/ProviderStep.tsx` — **created by this plan.** A view-only step in the existing walkthrough; the main-process host fetches the projection and passes it in, so **no preload-bridge method is added** and `packages/contracts/src/desktop-bridge.ts` is untouched by this amendment.

### Touched but not owned

- `apps/desktop/src/preload/index.ts` (owned by Plan-023) — add a single import + spread of the `onboarding.*` namespace. No other edits. If the edit grows past a one-line addition, it is a review rejection — that means the plan has spilled outside its scope.
- `packages/runtime-daemon/src/ipc/handlers/index.ts` (owned by Plan-007) — five side-effect-free re-export lines (`registerOnboardingStart` / `registerOnboardingSubmitChoice` / `registerOnboardingSubmitTelemetry` / `registerOnboardingReset` / `registerOnboardingRead` + their `*Deps` types), following the barrel's per-handler convention (its header: each handler is registered separately, no aggregated `registerAll`, so the bootstrap orchestrator keeps per-method control). The binder implementations live in this plan's `packages/runtime-daemon/src/onboarding/rpc-handlers.ts`; the registry substrate (`registry.ts`) is never touched.
- `packages/runtime-daemon/src/bootstrap/index.ts` (owned by Plan-007 — the documented wiring point, `Plan-007 §Daemon IPC + bootstrap (packages/runtime-daemon/src/)`'s EXTEND row: owned-namespace `register*` calls wire here after `SecureDefaults.load`) — five `registerOnboarding*(registry, deps)` calls, per the Plan-002 `presence.*` precedent (NS-26): the shipped `session.*`/`presence.*` binders under `src/ipc/handlers/` are the on-disk pattern.
- `packages/contracts/src/desktop-bridge.ts` (owned by Plan-023) — add the `onboarding` member to the `SidekicksBridge` interface (the ambient type the renderer compiles against; without it `window.sidekicks.onboarding.presentChoice()` cannot typecheck) **and the matching throwing `onboarding` stub block in `createTier1Bridge()`** — the factory returns `SidekicksBridge` with an every-method-throws contract, so adding the member without the stub stops the contracts package typechecking. Lands together with the preload spread.
- `apps/desktop/src/main/bridge/onboarding.ts` (owned by Plan-023 — `Plan-023 §Main process`: Plan-023 authors the surface and registers the stubs; Plan-026 implements the flow logic) — replace the stub bodies of `onboarding.presentChoice` / `onboarding.telemetryPrompt` with delegation into this plan's `apps/desktop/src/main/onboarding/` modules. The `bridge/index.ts` handler registration is Plan-023's and is not touched.
- `packages/contracts/src/index.ts` (owned by Plan-001) — one `export * from "./onboarding.js";` barrel line: the anti-leakage suite pins `index.ts` as the contracts package's only public re-export surface, so daemon/CLI/desktop imports of the new `onboarding.ts` contract file require it (deep imports are unsupported).
- `apps/cli/src/main.ts` (owned by Plan-007 — Phase R3, T-007r-3-2) — four `.register()` calls binding this plan's `onboarding start|reset|status` and `telemetry set` commands into the clipanion `Cli` instance. clipanion has no auto-discovery, so an unregistered command file is unreachable; the registration follows the Plan-004 / Plan-016 / Plan-017 / Plan-028 extender precedent recorded in [Cross-Plan Dependency Graph §2](../architecture/cross-plan-dependencies.md). No other edit to the entry point.
- `apps/desktop/eslint.config.mjs` (owned by Plan-023 — step 17, T-023p-1-6; already extended once by T-023r-2-6) — extend the existing renderer `no-restricted-imports` ban list with this plan's token- and SPKI-pin-carrying contract types, so I-026-4 is CI-enforced rather than review-enforced. List entries only; the rule's shape, its `apps/desktop/src/renderer/src/**` scope, and its CI wiring stay Plan-023's.
- `packages/client-sdk/src/index.ts` (owned by Plan-001 — Phase 1 T1.1 created the barrel; Phase 5 T5.1 added its first real export) — **one** `export * from "./onboarding/provider-step.js";` line for the Group-B coordinator T7.1 authors in this package. This is the single-import-surface convention the client-SDK ownership row states for every extending plan: each adds its own file and appends its own barrel line, deep imports being unsupported. Without it the CLI and desktop cannot import the coordinator at all. List entry only; no other edit to the barrel.
- `apps/cli/src/exit-codes.ts` (owned by Plan-007 — Phase R3, T-007r-3-3) — **one call** into this plan's `account-plane-refusal-hint.ts` from the `error.data.type` discrimination that file already performs, so a run refused on the account plane invites the operator into Group B (T7.2). **No exit code is added, removed, or remapped** and the mapping stays total per I-007-14: the hint prints beside the existing rendering and changes no exit path. If the edit grows past the call, it is a review rejection — the recognition logic belongs in this plan's own file.

## Data And Storage Changes

### `[onboarding]` TOML block (typed)

Path:

- Linux / macOS: `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (fallback `$HOME/.config/ai-sidekicks/config.toml` per [XDG Base Directory Specification v0.8](https://specifications.freedesktop.org/basedir-spec/latest/))
- Windows: `%APPDATA%\ai-sidekicks\config.toml`

Block (schema identical to `Spec-026 §Persistence`):

```toml
[onboarding]
choice_id         = "free-public-relay" | "self-host" | "hosted-saas"
resolved_at       = "<RFC 3339 UTC>"
relay_url         = "<https URL — populated for all three choices>"
self_host_spki_pin = "<base64 SHA-256 — only for self-host>"
telemetry_opt_in  = true | false
```

- Writer uses `smol-toml` v1.6.1 per [smol-toml README](https://github.com/squirrelchat/smol-toml) (TOML 1.1.0 / TOML 1.0.0 compliant, actively maintained). **Not** `@iarna/toml` (the previously-popular alternative; last published 2021; no TOML 1.0.0 conformance claim; see §Risks And Blockers).
- Writer is additive: it reads the whole file, merges the `[onboarding]` block, writes the whole file back. Other sections are preserved byte-for-byte unless `smol-toml`'s round-trip is lossy (it is, modulo comments — see §Risks And Blockers for the "comment preservation" gap and the workaround).
- Schema version: the top-level `schema_version` field (owned by Plan-007's config surface) bumps by 1 when this plan ships, so older daemons can detect and refuse (per `Spec-026 §Fallback Behavior` §Conflicting daemon).

### `onboarding.partial.json` partial-state file

Path:

- Linux / macOS: `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (fallback `$HOME/.local/state/ai-sidekicks/onboarding.partial.json` per [XDG Base Directory Specification v0.8](https://specifications.freedesktop.org/basedir-spec/latest/))
- Windows: `%LOCALAPPDATA%\ai-sidekicks\State\onboarding.partial.json` (Windows has no XDG_STATE_HOME; we use `LOCALAPPDATA\<app>\State\` by convention)

Shape:

```json
{
  "step": "choice-pending" | "choice-made-token-pending" | "token-persisted-telemetry-pending",
  "choice_id": "free-public-relay" | "self-host" | "hosted-saas" | null,
  "relay_url": "<https URL | null>",
  "pkce_state": "<128-char URL-safe string | null>",
  "pkce_verifier": "<43-128-char URL-safe string | null>",
  "started_at": "<RFC 3339 UTC>"
}
```

- `pkce_verifier` lives in the partial state across daemon-restart because the loopback callback must verify the same verifier the browser was redirected with. It is written to disk **only** for Option 3, **only** until the callback fires or the 5-minute timeout expires (whichever first), and the file is deleted immediately on either terminal event. This is a short-lived secret (5 min max); it never rides in a long-lived config or keystore entry.
- Staleness: on read, if `started_at` is older than 24 hours, the file is deleted and the service returns `OnboardingState.unresolved`. This prevents a stuck partial-state file from preventing a fresh onboarding after a long gap.
- File permissions: `0600` on POSIX; Windows ACL restricted to current user. Enforced on write via `fs.writeFile(..., { mode: 0o600 })` and `fs.chmod(0o600)` as belt-and-braces on append.

### Keystore entries (via Spec-023 surface)

- Option 2 writes one entry keyed `ai-sidekicks:self-host-admin-token:<relay_url_host>` (one per relay host; lets users re-onboard against a different relay without clobbering the first entry).
- Option 3 writes one entry keyed `ai-sidekicks:hosted-saas-scoped-token` (one per machine; there is only one hosted-SaaS endpoint in V1).
- `config.toml` is never a secret destination. The `[onboarding]` block only records the pin and choice metadata; secrets live in the keystore.

## API And Transport Changes

### Five new JSON-RPC methods (Plan-007 registry consumer)

```ts
// OnboardingStart
interface OnboardingStartRequest {}
interface OnboardingStartResponse {
  state: OnboardingState;
  partial?: OnboardingPartialState; // populated when state === 'partial'
  config?: OnboardingConfig; // populated when state === 'resolved' (secret-stripped)
}

// OnboardingSubmitChoice
interface OnboardingSubmitChoiceRequest {
  choice_id: OnboardingChoiceId;
  relay_url?: string; // required for 'self-host'; published URL used for 'free-public-relay'
  admin_token?: string; // required for 'self-host'; never logged; zeroed from memory post-persist
  hosted_token?: string; // required for 'hosted-saas' (comes from callback, not the prompt)
  spki_pin?: string; // required for 'self-host' (from the TOFU probe)
  deferred_validation?: boolean; // set true when offline at first-invite time per Spec-026 §Fallback Behavior
}
interface OnboardingSubmitChoiceResponse {
  state: "resolved";
  config: OnboardingConfig; // secret-stripped
}

// OnboardingSubmitTelemetry
interface OnboardingSubmitTelemetryRequest {
  opt_in: boolean;
}
interface OnboardingSubmitTelemetryResponse {
  state: "resolved";
  config: OnboardingConfig;
}

// OnboardingReset
interface OnboardingResetRequest {
  confirm: true; // explicit — no ambient "any truthy value" pass
  reason: "cli-reset" | "operator-reset";
}
interface OnboardingResetResponse {
  previous_choice_id: OnboardingChoiceId | null;
  keystore_cleared: boolean; // false if keystore delete failed; stderr surface already logged
  partial_cleared: boolean;
}

// OnboardingRead
interface OnboardingReadRequest {}
interface OnboardingReadResponse {
  state: OnboardingState;
  config: OnboardingConfig | null; // never plaintext tokens; SPKI pin is public
}
```

- All five methods ride the Plan-007 local IPC surface and introduce no new auth primitive: the caller presents the daemon's per-restart 256-bit session token alongside socket reachability, per [ADR-010 §Decision](../decisions/010-paseto-webauthn-mls-auth.md#decision) item 1 as amended 2026-04-18 and [Security Architecture §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication-task-51) (CLI token presentation is not optional). An earlier draft of this bullet framed daemon IPC as trusted by socket reachability alone and attributed that framing to `Spec-021 §Scope`; both are corrected here — the token is required, and `Spec-021 §Scope`'s daemon sentence is a rate-limiting exclusion, not an authentication authority.
- Secrets (`admin_token`, `hosted_token`) appear in request payloads exactly once and are zeroed from memory after the keystore write. Never logged; the service's logger strips these field names via a scrubber.
- **The provider-authentication step group adds no method and grows no payload.** The five names, their request/response pairs, and their mutating flags are unchanged; Group B composes Plan-029's node-local `providerAccount.*` namespace through the client SDK, and persists nothing of its own, so there is no state a sixth verb would write (`Spec-026 §Provider Authentication (Group B)`).
- The five wire method names are `onboarding.start` / `onboarding.submitChoice` / `onboarding.submitTelemetry` / `onboarding.reset` / `onboarding.read` — the I-007-9 dotted form (leading segment lowercase; camelCase permitted in later segments). `Spec-026 §Daemon JSON-RPC Additions` names these five operations in PascalCase (`OnboardingStart` …); those are operation names, and the wire names are the dotted-camelCase forms required by I-007-9 and the canonical `METHOD_NAME_FORMAT` in `packages/contracts/src/jsonrpc-registry.ts` — same five operations, canonical spelling, no divergence. The PascalCase `Onboarding*` names in the block above are the request/response **type** names, never wire names (registering a dotless PascalCase name throws `invalid_method_name` at bootstrap). Registration goes through Plan-007's `MethodRegistry.register(method, paramsSchema, resultSchema, handler, opts?)` (Zod-validated dispatch). The two cited properties come from two different places and must not be merged: I-007-9 carries the **dotted-name conformance** rule only, while the mandatory `paramsSchema` + `resultSchema` pair is carried by the `register<P, R>(…)` interface signature Plan-007 declares in its §Target Areas registry surface. `opts.mutating` defaults to `false` and the version-mismatch gate blocks only `mutating: true` methods for incompatible clients, so the four state-touching methods — `onboarding.start` (stale-partial deletion on resume, step 19), `onboarding.submitChoice`, `onboarding.submitTelemetry`, `onboarding.reset` (config/keystore/partial-state writes) — MUST register `mutating: true`; `onboarding.read` is the sole read-only method (its handler uses the partial-state store's non-mutating `peek`: stale partial state reports as `state: 'unresolved'` — observably cleared per Spec-026 — with physical deletion deferred to the next mutating entry point). Plan-026's binders call `register()` from `rpc-handlers.ts`; no registry internals are touched.

### Preload bridge additions (Plan-023 consumer)

```ts
// apps/desktop/src/preload/onboarding.ts
export const onboarding = {
  presentChoice(): Promise<{
    choice_id: OnboardingChoiceId
    relay_url: string
    self_host_spki_pin?: string
    hosted_token_persisted?: boolean
  }>,
  telemetryPrompt(): Promise<{ opt_in: boolean }>
}
```

- Exposed via `contextBridge.exposeInMainWorld('sidekicks', { ..., onboarding })`. Plan-023 owns the top-level `sidekicks` object; Plan-026's edit is a single-line spread addition in `apps/desktop/src/preload/index.ts`.
- `presentChoice()` resolves with **no plaintext tokens** — only a boolean indicating that the secret was persisted to the keystore. Renderer code never sees `admin_token` or `hosted_token`.

### Event payloads (Plan-006 event-bus consumer)

```ts
// onboarding.choice_made
interface OnboardingChoiceMadePayload {
  participantId: string;
  choiceId: OnboardingChoiceId;
  relayUrl: string;
  migrated: boolean;
  deferredValidation: boolean;
  keystoreAvailable: boolean;
  timestamp: string; // ISO 8601
}

// onboarding.choice_reset
interface OnboardingChoiceResetPayload {
  participantId: string;
  previousChoiceId: OnboardingChoiceId;
  reason: "cli-reset" | "operator-reset";
  timestamp: string;
}
```

- No secret material: no `admin_token`, no `hosted_token`, no raw SPKI bytes (the pin is in config, not events — a re-pin does not need to replay via event stream).
- Events are emitted into the daemon event bus owned by Plan-006; this plan does not author the bus. Registration under Spec-006's §Event Taxonomy table landed under BL-086 (completed 2026-04-18) in the `onboarding_lifecycle` category.

## Invariants

Load-bearing constraints every Plan-026 PR — and every downstream extension — must preserve. Weakening or removing one is a coordinated cross-plan amendment, not a local edit. Every entry below transcribes an already-ratified Spec-026 clause; none is authored here. Each names the governing clause it grounds in, why it is load-bearing, and the task that verifies it.

- **I-026-1 — The three-way choice and telemetry step (Group A) activate on exactly two triggers and on nothing else.** Group A runs on the first **outbound** invite or on explicit activation (`sidekicks onboarding start` / the desktop _Set up collaboration_ entry point). It never runs on install, on first daemon launch, on a health check, on first session creation, on a first local run, or on accepting an **incoming** invite. **Grounds in.** [Spec-026 §Trigger](../specs/026-first-run-onboarding.md#trigger) and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (prompting on install or first session create is a review rejection). **Why load-bearing.** Single-user local-daemon mode must reach a working session without ever meeting this flow; a trigger that fires earlier breaks the offline and single-user paths that ADR-020's deployment model exists to protect, and it does so silently — the flow looks correct to whoever added the extra trigger. **Verification.** T3.1, T3.2.
- **I-026-2 — Three options, presented as equals, with Option 1 as the default.** The choice surface presents exactly three deployment options; Option 3 is never hidden behind an _Advanced_ affordance and never inlined as a variant of Option 2; Option 1 (`free-public-relay`) is the preselected default. **Grounds in.** [Spec-026 §Three-Way Choice Semantics](../specs/026-first-run-onboarding.md#three-way-choice-semantics), [Spec-026 §Default Behavior](../specs/026-first-run-onboarding.md#default-behavior), and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (treating the three as two plus an escape hatch). **Why load-bearing.** ADR-020 committed to three equal options as a product commitment, not a UI preference; collapsing the presentation redraws that commitment without an ADR, and it does so in the one screen where a user's deployment posture is decided for the life of the install. **Verification.** T3.1, T4.1, T4.2, T5.2.
- **I-026-3 — Secrets never reach `config.toml`.** The Option-2 admin token and the Option-3 scoped token persist only through the Spec-023 keystore surface. The `[onboarding]` block carries choice metadata and the public SPKI pin and nothing else; a keystore outage refuses the write rather than downgrading to file persistence. **Grounds in.** [Spec-026 §Persistence](../specs/026-first-run-onboarding.md#persistence), [Spec-026 §Fallback Behavior](../specs/026-first-run-onboarding.md#fallback-behavior) (keystore-unavailable refusal), and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (writing secrets to `config.toml`). **Why load-bearing.** `config.toml` is user-readable, backed up, synced, and pasted into issue reports; a token that lands there is disclosed by every one of those ordinary acts, and no later fix retracts it. The refusal path matters as much as the rule — a silent downgrade to plaintext is the failure mode that looks like success. **Verification.** T1.2, T2.4, T6.1, T6.2.
- **I-026-4 — Secret material never reaches the application renderer.** No token or SPKI-pin-carrying value crosses into `apps/desktop/src/renderer/src/**`. All secret input is orchestrated from the main process; the application renderer is a view-only projection that receives a persisted-or-not boolean, never plaintext. The sole Chromium surface that touches a plaintext token is the dedicated, single-purpose password-input window step 15 authors — main-process-owned assets, locked `webPreferences`, `default-src 'none'` CSP, one `password-entered` channel — which is not the application renderer and shares no address space with it. Enforcement is the renderer `no-restricted-imports` ban-list extension T5.1 lands, not review vigilance. **Grounds in.** [Spec-026 §Desktop Surface](../specs/026-first-run-onboarding.md#desktop-surface) and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid), which names the forbidden implementation precisely — rendering the admin-token input via `<input type="password">` in React. **Why load-bearing.** The renderer is the untrusted tier of the Spec-023 trust stance; a secret that enters its address space is exposed to every bundled dependency and every XSS path at once, and the leak is invisible in behaviour. **Residual this invariant deliberately does not claim.** It is scoped to the application renderer rather than to every Chromium process, because this plan's own step 15 keeps one isolated window that renders plaintext by design. Whether that window should be replaced by an OS-native credential prompt is an open design question step 15 records as considered-and-rejected; it is not resolved here. **Verification.** T5.1, T5.2, T5.3.
- **I-026-5 — Telemetry opt-in is a separate, explicit, default-off second step.** It is presented after the three-way choice resolves, never bundled into it; the default is off; and the flow does not proceed past it without an explicit answer, on the interactive path or the headless one. **Grounds in.** [Spec-026 §Telemetry Opt-In](../specs/026-first-run-onboarding.md#telemetry-opt-in) and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (hidden telemetry default), serving the EU ePrivacy Directive Art. 5(3) consent baseline this product applies globally. **Why load-bearing.** Consent bundled into an unrelated choice is not consent; a default-on flag that nobody was shown is the exact pattern the directive prohibits, and the remedy after shipping is retroactive deletion rather than a config change. This invariant is why the headless path needs a fourth override — see §Implementation Steps step 13. **Verification.** T3.1, T4.1.
- **I-026-6 — Headless refuses to prompt, instructs, and exits 2 — and the Group-A override path is state-equivalent.** With `!process.stdin.isTTY` the CLI never prompts: it prints instruction and exits with code 2. **Both halves of the instruction clause and the whole of the state clause are scoped to Group A**, whose four overrides carry deployment-choice data a caller may legitimately supply: there the instruction is the machine-readable override and the env-var path produces byte-identical persisted state to the interactive path, `telemetry_opt_in` included. Group B has no override to instruct and no persisted state to compare — a provider credential is not caller-suppliable data (I-026-12) — so its headless arm prints the sign-in **remedy** instead and asserts byte-identical `[onboarding]`, which is what "persists nothing" looks like from the outside. Refusing to prompt, exit code 2, and `onboarding.headless_required` are the parts both groups share. **Grounds in.** [Spec-026 §Fallback Behavior](../specs/026-first-run-onboarding.md#fallback-behavior) and [Spec-026 §Acceptance Criteria](../specs/026-first-run-onboarding.md#acceptance-criteria). **Why load-bearing.** A silent Option-1 selection in CI is a privacy footgun — a caller who intended self-host leaks connection attempts to the public relay and never learns it. Byte-identity is what makes the headless path a real path rather than a second, drifting implementation: without it the two paths diverge one field at a time and only the interactive one is ever tested. **Verification.** T4.3.
- **I-026-7 — An SPKI mismatch on reconnect refuses, and re-trust requires out-of-band proof.** A subsequent connection whose SPKI differs from the pinned value refuses the connection and surfaces the two recovery paths (`sidekicks onboarding reset`, or explicit `sidekicks relay repin --force` with the new hash pasted). Silent re-trust is forbidden, and so is a re-pin that does not require the operator to supply the hash. **Grounds in.** [Spec-026 §Fallback Behavior](../specs/026-first-run-onboarding.md#fallback-behavior) and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (re-trusting a new fingerprint without operator action). **Why load-bearing.** TOFU's entire security value is the refusal on change; an implementation that re-pins automatically has the ceremony of pinning and none of its protection, and it is indistinguishable from the secure version until the day it matters. **Verification.** T2.1, T6.1.
- **I-026-8 — Onboarding event payloads carry no secret material and match the registered shapes.** `onboarding.choice_made` and `onboarding.choice_reset` carry no tokens and no raw SPKI bytes, and their fields match the shapes registered under Spec-006's `onboarding_lifecycle` category. Drift between the registered payload and this plan's emitter is resolved before merge on whichever side is wrong — never by emitting an unregistered shape. **Grounds in.** [Spec-026 §Event Taxonomy Additions](../specs/026-first-run-onboarding.md#event-taxonomy-additions) and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (emitting secret payload fields). **Why load-bearing.** The event log is append-only, replicated, and retained; a secret emitted once is a secret retained forever across every replica, and unlike a config write it cannot be deleted in place. **Verification.** T3.3, T3.5.
- **I-026-9 — Partial state is `0600`, resumes precisely, and clears on every terminal path.** The partial-state file is written mode `0600` on POSIX (current-user ACL on Windows), resumes the flow at the step the user actually left, and is cleared on success, on reset, and on crossing the 24-hour staleness window. A stale file is never observable as live state through any method. **Grounds in.** [Spec-026 §Fallback Behavior](../specs/026-first-run-onboarding.md#fallback-behavior) (resume of a partially-completed first-run) and [Spec-026 §State And Data Implications](../specs/026-first-run-onboarding.md#state-and-data-implications). **Why load-bearing.** The file holds a short-lived PKCE verifier, so lax permissions make it a local-secret disclosure; and a partial-state file that outlives its flow is worse than none, because it silently blocks a fresh onboarding the user is actively asking for. **Verification.** T1.3, T3.1, T6.3.
- **I-026-10 — Option-3 PKCE is `S256`-only, single-use, and loopback-scoped.** The client sets `code_challenge_method` to `S256` and exposes no code path that can set `plain`; the `state` parameter is one-shot; and the callback listener binds the `'127.0.0.1'` literal only and closes on first use or at the 5-minute `AbortSignal.timeout(300_000)` ceiling, whichever comes first. **Grounds in.** [Spec-026 §Three-Way Choice Semantics](../specs/026-first-run-onboarding.md#three-way-choice-semantics), [Spec-026 §Implementation Notes](../specs/026-first-run-onboarding.md#implementation-notes) (PKCE for hosted sign-up; reject `plain`), and [Spec-026 §Fallback Behavior](../specs/026-first-run-onboarding.md#fallback-behavior) (5-minute ceiling). **Why load-bearing.** Refusing `plain` client-side is what makes a server-side downgrade attack unreachable rather than merely unlikely; a reusable `state` reopens the CSRF hole PKCE was added to close; and binding a name rather than the IPv4 literal reintroduces the dual-stack resolution split §Risks And Blockers documents, which fails intermittently and therefore survives testing. **Verification.** T2.2, T2.3, T6.2.
- **I-026-11 — The provider step activates on exactly three triggers, and never ahead of an admissible run.** Group B is offered inside a running onboarding flow after the three-way choice resolves, after a provider run has been refused on the account plane, or on explicit activation (`sidekicks onboarding start --providers` / the desktop _Set up providers_ entry point) — and on nothing else. It never runs on install, on first daemon launch, on a health check, on session creation, or ahead of a provider run that would otherwise have been admitted, and it never blocks the rest of the flow: onboarding completes with zero registered accounts, with the completion summary naming which providers are not ready and what the first provider run will do. **Grounds in.** [Spec-026 §Provider Authentication (Group B)](../specs/026-first-run-onboarding.md#provider-authentication-group-b) and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (blocking onboarding on the provider step is a review rejection). **Why load-bearing.** A readiness test placed in front of a run in order to prompt is I-026-1's forbidden install-time prompt relocated — it fires ahead of work that would have succeeded, and it looks correct to whoever added it. Making the step mandatory breaks the single-user and invite-only paths that ADR-020's deployment model exists to protect. **Verification.** T7.1, T7.4.
- **I-026-12 — The onboarding surface never touches credential material and never authenticates on the operator's behalf.** No surface in this plan reads, stores, or displays credential material; none offers a field, flag, or environment variable into which a provider token could be supplied; none runs a provider sign-in command; and none surfaces a provider sign-in process's output in a message, an event, or a log. The flow displays the sign-in invocation and hands the operator to the provider's own first-party flow. **Grounds in.** [Spec-026 §Provider Authentication (Group B)](../specs/026-first-run-onboarding.md#provider-authentication-group-b) and [Spec-026 §Pitfalls To Avoid](../specs/026-first-run-onboarding.md#pitfalls-to-avoid) (prompting for a provider token is a review rejection). **Why load-bearing.** Collecting, storing, or intermediating a provider credential is barred by the vendor's published policy (`Spec-029 §Vendor authentication-policy constraints`), and provider sign-in output may carry OAuth state, PKCE values, or credential fields. Both failures are silent: the flow keeps working while the product is out of policy. This is also why Group B needs no preload-bridge method — it has no secret input for a bridge to carry, so I-026-4 is discharged by construction rather than by enforcement. **Verification.** T7.2, T7.3.
- **I-026-13 — The provider step renders readiness, never re-derives it, and adds no state.** Every readiness value the CLI or the renderer displays comes from Plan-029's daemon-side projection unmodified; no surface recomputes readiness from account fields, and none probes in order to display. Group B persists nothing: no `[onboarding]` key, no partial-state entry, no keystore entry, no event. **Grounds in.** [Spec-026 §Provider Authentication (Group B)](../specs/026-first-run-onboarding.md#provider-authentication-group-b) and [Spec-026 §State And Data Implications](../specs/026-first-run-onboarding.md#state-and-data-implications). **Why load-bearing.** Two derivations of one predicate eventually disagree, and the copy the operator is looking at is the one enforcing nothing — the surface then reports success while every run refuses. A second persisted record of a step whose truth lives in the registry drifts the same way, one restart later. **Verification.** T7.1, T7.3.

## Cross-Plan Obligations

Each entry transcribes an obligation already committed in the named counterparty's text, or records a crossing the ratified corpus already sanctions; none is authored here. See [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) for the graph-level view.

### CP-026-1 — Five `onboarding.*` binders registered through Plan-007's `MethodRegistry`

**Obligation.** This plan consumes [Plan-007 §Cross-Plan Obligations](./007-local-ipc-and-daemon-control.md#cross-plan-obligations) CP-007-3, which names Plan-026 as a registry consumer by name: the `MethodRegistry.register(method, paramsSchema, resultSchema, handler, opts?)` surface, the `ipc/handlers/index.ts` per-handler barrel, and the `bootstrap/index.ts` wiring point where owned-namespace `register*` calls land. Method names conform to I-007-9.

**Resolution.** Live and reciprocal. Plan-026 authors its five binders in its own `onboarding/rpc-handlers.ts`, adds five re-export lines to the barrel and five wiring calls at the bootstrap point (both recorded in §Touched But Not Owned), and touches no registry internals. **Direction:** Consume from [Plan-007](./007-local-ipc-and-daemon-control.md). **Tasks:** T3.2.

### CP-026-2 — `apps/cli/src/main.ts` clipanion registration

**Obligation.** clipanion has no auto-discovery, so this plan's four command files are unreachable without explicit `.register()` calls at Plan-007's CLI entry point (`apps/cli/src/main.ts`, Plan-007 Phase R3 T-007r-3-2). The extender pattern is already established there by Plan-004, Plan-016, Plan-017, and Plan-028.

**Resolution.** Live. Plan-026 joins that extender list with four registrations and no other edit to the entry point; the ownership row and this plan's §Touched But Not Owned entry are the durable record. Without this row the plan promises a working `sidekicks onboarding start` and ships no path by which the binary reaches it. **Direction:** Extend [Plan-007](./007-local-ipc-and-daemon-control.md)'s `apps/cli/src/main.ts`. **Tasks:** T4.2.

### CP-026-3 — Desktop bridge surface consumed from Plan-023

**Obligation.** [Plan-023 §Main process](./023-desktop-shell-and-renderer.md#main-process) authors `apps/desktop/src/main/bridge/onboarding.ts` and registers its stubs; its Tier-8 remainder task T-023r-2-5 states the split explicitly — Plan-023 authors the surface, Plan-026 implements the flow logic.

**Resolution.** Live and reciprocal. Plan-026 replaces the stub bodies, adds the `onboarding` member to `SidekicksBridge` together with its matching throwing stub in `createTier1Bridge()` (the factory's every-method-throws contract means the member and the stub must land together or the contracts package stops typechecking), and spreads the preload namespace — the four bridge-side entries in §Touched But Not Owned. The `bridge/index.ts` handler registration stays Plan-023's. **Direction:** Consume from [Plan-023](./023-desktop-shell-and-renderer.md). **Tasks:** T5.1, T5.2.

### CP-026-4 — `onboarding_lifecycle` event registration consumed from Spec-006 / Plan-006

**Obligation.** Both event types and their payload shapes are already registered under Spec-006's `onboarding_lifecycle` category — BL-086, completed 2026-04-18. Plan-006 owns the event bus, the taxonomy, and the registration; Plan-026 emits.

**Resolution.** Live and one-directional by design. This plan consumes the registered `EventType` union directly and never forward-declares or re-registers; step 22 is the payload-shape cross-check that keeps emitter and registration in agreement, and any drift is resolved on whichever side is wrong before merge (I-026-8). **Direction:** Consume from [Plan-006](./006-session-event-taxonomy-and-audit-log.md). **Tasks:** T3.3, T3.5.

### CP-026-5 — `onboarding.spki_mismatch` (412) minted here, raised by Plan-008

**Obligation.** This plan registers `onboarding.spki_mismatch` in [error-contracts.md](../architecture/contracts/error-contracts.md) but never raises it: the raiser is Plan-008's hosted-relay TOFU verification path. [Spec-026 §Fallback Behavior](../specs/026-first-run-onboarding.md#fallback-behavior) explicitly defers the Spec-008-side event registration for that refusal path rather than omitting it by oversight, so the corpus intends the code to cross the plan boundary — what has been missing is a durable carrier making the crossing auditable at Plan-008's own dispatch. This row is that carrier.

**Resolution.** Registration-only on this side; the return-cite is owed at Plan-008's dispatch, not at this audit. Plan-008 is Tier 5 and already `approved`; nothing here re-opens it and no Tier-5 amendment is requested. A wire-visible error code with a named downstream consumer and no obligation row is invisible to consumer-side dependency checks — the consumer is precisely the party that does not know — which is why the row exists rather than a prose note. **Direction:** Provide to [Plan-008](./008-control-plane-relay-and-session-join.md). **Tasks:** T3.4 (registration only).

### CP-026-6 — Provider registry and readiness consumed from Plan-029

**Obligation.** [Plan-029 §Cross-Plan Obligations](./029-provider-accounts-and-credential-homes.md#cross-plan-obligations) CP-029-7 names this plan by name as the consumer of the node-local `providerAccount.*` registry and the per-provider readiness projection Plan-029 T2.5 derives, and commits Plan-029 to authoring no onboarding surface. `Spec-029 §Non-Goals` carries the same split on the spec side.

**Resolution.** Live and reciprocal, consumer on this side. This plan's Phase 7 registers accounts through Plan-029's namespace rather than minting a second registry, renders Plan-029's readiness projection rather than re-deriving it (I-026-13), and displays the remedy Plan-029 discloses rather than composing its own (I-026-12). The dependency is enforced mechanically rather than by a human tick: Phase 7's `external_plan_phase_merged` entry names Plan-029 **Phase 3** and resolves against that plan's shipment manifest, so Group B cannot dispatch before the surface it consumes ships. It names Phase 3 rather than the Phase 2 that produces the registry and readiness because T7.4 asserts a provider run **starts**, which is Phase-3 machinery; Phase 3's own gate names Phase 2, so the Phase-2 dependency this obligation is about is subsumed, not dropped. **Direction:** consume from Plan-029.

## Implementation Steps

1. **Author contracts.** Create `packages/contracts/src/onboarding.ts` with every type from §API And Transport Changes. Export type-only; no runtime. The CLI, daemon, and desktop all import from here.
2. **Author TOML config store.** In `packages/runtime-daemon/src/onboarding/config-store.ts`, use `smol-toml` v1.6.1 `parse()` + `stringify()`. Preserve non-`[onboarding]` sections by round-tripping the full document. File lock: acquire `proper-lockfile` v4 advisory lock (declared as an explicit dependency in `packages/runtime-daemon/package.json` — transitive-dep assumption must not be relied on; the repo has no lockfile yet at plan-authoring time) before read-modify-write. On read-not-found (`ENOENT`), return `null`. On parse error, surface the line number via `smol-toml`'s `TomlError.line`; do not silently fall back to "empty config" because that would hide user-visible corruption.
3. **Author partial-state store.** In `packages/runtime-daemon/src/onboarding/partial-state-store.ts`, write JSON with `{ mode: 0o600 }`. Read path: check `started_at`; if > 24h, delete the file and return `null` ("staleness enforcement"). Write path: atomic write via `write-to-tmp-then-rename` so the file is never observed half-written by a concurrent reader.
4. **Author SPKI probe.** In `packages/runtime-daemon/src/onboarding/spki-probe.ts`:
   ```ts
   import { connect } from "tls";
   import { createHash } from "crypto";
   export async function probeSPKI(url: URL): Promise<string> {
     return new Promise((resolve, reject) => {
       const socket = connect(
         { host: url.hostname, port: Number(url.port) || 443, servername: url.hostname },
         () => {
           const cert = socket.getPeerCertificate(true);
           socket.destroy();
           if (!cert || !cert.pubkey) return reject(new Error("no peer certificate"));
           // cert.pubkey is empirically SubjectPublicKeyInfo DER (Node exposes it via OpenSSL's
           // X509_PUBKEY_get0 path); integration test `spki-probe.int.test.ts` validates parity
           // against `openssl x509 -pubkey | openssl pkey -pubin -outform DER | sha256sum`.
           const pin = createHash("sha256").update(cert.pubkey).digest("base64");
           resolve(pin);
         },
       );
       socket.once("error", reject);
       socket.setTimeout(10_000, () => {
         socket.destroy();
         reject(new Error("probe timeout"));
       });
     });
   }
   ```
   The result feeds the §Option 2 TOFU flow's user-visible confirmation dialog. This is SPKI SHA-256 base64 — OWASP's recommended pinning format ([OWASP Certificate and Public Key Pinning](https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning)).
5. **Author PKCE state + challenge.** In `packages/runtime-daemon/src/onboarding/pkce-state.ts`:
   ```ts
   import * as oauth from "oauth4webapi";
   export async function generatePKCE() {
     const verifier = oauth.generateRandomCodeVerifier(); // 43-128 char URL-safe per RFC 7636 §4.1
     const challenge = await oauth.calculatePKCECodeChallenge(verifier); // SHA-256 S256 only
     const state = oauth.generateRandomState(); // CSRF guard
     return { verifier, challenge, state };
   }
   ```
   `oauth4webapi` v3.8.5 (panva) — minimal-surface-area OAuth primitives per [panva/oauth4webapi README](https://github.com/panva/oauth4webapi). Refuse `plain` by never exposing a code path that sets `code_challenge_method` to anything other than `S256`. S256-only is both RFC 7636's strong recommendation and our enforceable baseline.
6. **Author PKCE callback server.** In `packages/runtime-daemon/src/onboarding/pkce-callback.ts`:
   ```ts
   import { createServer } from "node:http";
   export async function awaitCallback(
     expectedState: string,
     verifier: string,
   ): Promise<{ code: string; verifier: string }> {
     return new Promise((resolve, reject) => {
       const server = createServer((req, res) => {
         const url = new URL(req.url!, "http://127.0.0.1");
         if (url.pathname !== "/callback") {
           res.statusCode = 404;
           return res.end();
         }
         const code = url.searchParams.get("code");
         const state = url.searchParams.get("state");
         if (state !== expectedState) {
           res.statusCode = 400;
           res.end("pkce_state_mismatch");
           server.close();
           return reject(new Error("pkce_state_mismatch"));
         }
         if (!code) {
           res.statusCode = 400;
           res.end("missing_code");
           server.close();
           return reject(new Error("missing_code"));
         }
         res.statusCode = 200;
         res.end("You may close this window.");
         server.close();
         resolve({ code, verifier });
       });
       server.listen(0, "127.0.0.1"); // '127.0.0.1' literal, NOT 'localhost' — see §Risks And Blockers
       const abortSignal = AbortSignal.timeout(300_000); // 5-min ceiling per Spec-026 §Fallback Behavior
       abortSignal.addEventListener("abort", () => {
         server.close();
         reject(new Error("callback_timeout"));
       });
     });
   }
   ```
   The ephemeral port is requested via `listen(0, ...)` and surfaced from `server.address()` for the sign-up-URL redirect_uri construction. Binding to `'127.0.0.1'` (IPv4 literal) avoids the `'localhost'` DNS-resolution ambiguity documented in `go-oauth2`'s issues and referenced by RFC 8252 §7.3 — `'localhost'` can resolve to `::1` or `127.0.0.1` depending on system configuration, which produces intermittent `ECONNREFUSED` when the browser and the listener resolve differently (see §Risks And Blockers).
7. **Author keystore-client wrapper.** In `packages/runtime-daemon/src/onboarding/keystore-client.ts`:
   - CLI path (daemon runs as a Node process): use `@napi-rs/keyring` v1.2.0 directly. `@napi-rs/keyring` has no `exists()` API, so existence-check is done via try/catch on `getPassword()` treating the thrown `not-found` as "absent" per [Brooooooklyn/keyring-node README](https://github.com/Brooooooklyn/keyring-node).
   - Desktop path (daemon runs as an Electron `utilityProcess` fork per Plan-023): forward to main-process `safeStorage` via the IPC bridge Plan-023 authors. Main-process `safeStorage.isEncryptionAvailable()` is checked at daemon boot; Linux-only `safeStorage.getSelectedStorageBackend()` must return something other than `'basic_text'` / `'unknown'` for us to persist secrets; otherwise refuse and log per `Spec-023 §Fallback Behavior`.
   - Both paths emit `keystore_available: false` in the event payload when the backend is unavailable, letting ops diagnose the degraded posture.
8. **Author service orchestrator.** In `packages/runtime-daemon/src/onboarding/service.ts`, expose `OnboardingService` with a pure state machine `unresolved → partial → resolved` and the inverse `resolved → reset → unresolved`. Methods:
   ```ts
   class OnboardingService {
     async readState(): Promise<OnboardingState>;
     async startOrResume(): Promise<OnboardingStartResponse>;
     async submitChoice(
       req: OnboardingSubmitChoiceRequest,
     ): Promise<OnboardingSubmitChoiceResponse>;
     async submitTelemetry(
       req: OnboardingSubmitTelemetryRequest,
     ): Promise<OnboardingSubmitTelemetryResponse>;
     async reset(req: OnboardingResetRequest): Promise<OnboardingResetResponse>;
   }
   ```
   Each method persists the partial-state delta **before** any network or keystore side effect, so a crash mid-operation resumes cleanly on next call. Ordering: (a) write partial state, (b) run side effect (network / keystore), (c) update partial state / promote to `[onboarding]`, (d) delete partial state on full resolution.
9. **Wire JSON-RPC handlers.** In `packages/runtime-daemon/src/onboarding/rpc-handlers.ts`, implement five per-method binders (`registerOnboardingStart(registry, deps)` … `registerOnboardingRead(registry, deps)`) registering the `onboarding.*` methods from §API And Transport Changes against Plan-007's `register()` surface (all but `onboarding.read` with `mutating: true`); re-export them through `ipc/handlers/index.ts` and wire the five calls in `bootstrap/index.ts` (per §Touched But Not Owned). Each handler delegates to the service; no business logic in the handler layer.
10. **Emit events.** In `packages/runtime-daemon/src/onboarding/events.ts`, emit `onboarding.choice_made` on final resolve and `onboarding.choice_reset` on reset into the event bus owned by Plan-006. Payload shapes per `Spec-026 §Event Taxonomy Additions` and §API And Transport Changes above. No secret fields.
11. **Author CLI prompts.** In `apps/cli/src/prompts/`:
    - `three-way-choice.ts` uses `@inquirer/prompts` v8.x `select({ message: 'Choose your relay deployment', default: 'free-public-relay', choices: [...] })` per [@inquirer/prompts README](https://github.com/SBoudrias/Inquirer.js). Default is Option 1 per `Spec-026 §Default Behavior`.
    - `self-host-inputs.ts` uses `input({ message: 'Relay URL', validate: (v) => v.startsWith('https://') || 'must start with https://' })` then `password({ message: 'Admin token', mask: '*' })` — `@inquirer/prompts` `password` suppresses TTY echo without us having to touch readline.
    - `spki-confirm.ts` prints the derived SPKI SHA-256 b64 in a fixed-width monospace block, then `confirm({ message: 'Does this fingerprint match what your relay operator posted out-of-band?' })`. Negative answer aborts onboarding cleanly (no partial state written).
    - `telemetry-opt-in.ts` uses `confirm({ message: '...', default: false })` with full disclosure copy. Default-off is load-bearing per EU ePrivacy Directive Art. 5(3) ([EU ePrivacy Directive (consolidated)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219)); the prompt cannot be skipped, only answered.
12. **Author CLI commands.** `apps/cli/src/commands/onboarding/start.ts|reset.ts|status.ts` + `apps/cli/src/commands/telemetry/set.ts`. Each command:
    - Calls the daemon JSON-RPC via Plan-007's transport.
    - Drives the appropriate prompt sequence from step 11.
    - Translates daemon error codes (`onboarding.already_resolved`, `onboarding.spki_mismatch`, etc.) to CLI exit codes per the table in §Error Codes below.
    - **Registers itself into the clipanion `Cli` instance.** clipanion has **no auto-discovery**, so an unregistered command file is unreachable no matter how well it is authored: this step also adds four `.register()` calls to `apps/cli/src/main.ts` (owned by Plan-007 — see §Touched But Not Owned), one per command class, following the Plan-004 / Plan-016 / Plan-017 / Plan-028 extender precedent recorded in [Cross-Plan Dependency Graph §2](../architecture/cross-plan-dependencies.md). Without them `sidekicks onboarding start` does not exist at the binary, and `Spec-026 §Acceptance Criteria`'s CLI criteria cannot pass.
13. **Author headless detection + env-var path.** In `apps/cli/src/env/headless-detect.ts`, test `process.stdin.isTTY`. If false, print a machine-readable instruction listing the four override env-vars — `SIDEKICKS_ONBOARDING_CHOICE`, `SIDEKICKS_RELAY_URL` (equivalently `--relay-url`), `SIDEKICKS_HOSTED_TOKEN_STDIN` (equivalently `--hosted-token-stdin`), and `SIDEKICKS_TELEMETRY_OPT_IN` — and exit with code 2 per `Spec-026 §Fallback Behavior`. In `apps/cli/src/env/env-override.ts`, read the four env-vars, validate shape, and produce the same `OnboardingSubmitChoiceRequest` + `OnboardingSubmitTelemetryRequest` pair the interactive path produces. Byte-identical persisted state is an acceptance criterion; integration test verifies it by diffing the `[onboarding]` block between an interactive-path run and an env-var-path run.
    - **Why four, not three.** `Spec-026 §Fallback Behavior` and `Spec-026 §Acceptance Criteria` name three overrides and mix env-var with flag spellings; that set cannot express the telemetry choice, so a headless run would either block forever or silently default — both forbidden, the first by `Spec-026 §Fallback Behavior`'s exit-2 rule and the second by `Spec-026 §Telemetry Opt-In`'s "no silent default". `Spec-026 §Example Flows` already reaches for `SIDEKICKS_TELEMETRY_OPT_IN` in its CI example, and `Spec-026 §Acceptance Criteria`'s byte-identical-persisted-state criterion covers `telemetry_opt_in`, so the fourth override is what makes the ratified text self-consistent. This plan implements four and names both spellings for the two that have flag forms; the spec-side count re-derivation (three → four) is routed as an upstream amendment and is not made here.
14. **Author desktop preload bridge.** In `apps/desktop/src/preload/onboarding.ts`, define `onboarding.presentChoice|telemetryPrompt` — the two `Spec-026 §Desktop Surface` methods (`reset`/`read` are CLI/daemon surfaces with no desktop consumer and are deliberately not exposed on the preload). Each method `ipcRenderer.invoke('onboarding.<method>', args)`; the corresponding main-process handler lives in Plan-023's `apps/desktop/src/main/bridge/onboarding.ts` (per §Touched But Not Owned) and delegates to step 15's orchestration modules for the native-dialog work. Spread into the existing `window.sidekicks` object via a single-line addition in `apps/desktop/src/preload/index.ts` (the file Plan-023 authors) — the sanctioned edits outside this plan's directories are exactly the ten §Touched But Not Owned entries — the eight enumerated here plus the Codex round-2 `apps/cli/src/exit-codes.ts` call that routes an account-plane refusal into Group B (T7.2) and the round-3 `packages/client-sdk/src/index.ts` barrel line that exports the Group-B coordinator (T7.1): this spread, the `SidekicksBridge` member + `createTier1Bridge` stub, the `bridge/onboarding.ts` flow bodies, the `handlers/index.ts` re-exports, the `bootstrap/index.ts` wiring calls, the contracts `index.ts` barrel line, the `apps/cli/src/main.ts` command registrations, and the renderer ESLint token-import ban-list entries.
15. **Author desktop main-process modal orchestration.** In `apps/desktop/src/main/onboarding/modal.ts`, implement the `presentChoice` orchestration invoked by the `bridge/onboarding.ts` handler (no `ipcMain.handle` outside Plan-023's bridge module — the bridge registry owns channel registration) which:
    - Opens a dedicated `BrowserWindow` hosting the renderer walkthrough (step 16) via `apps/desktop/src/main/onboarding/walkthrough-host.ts`. The walkthrough window carries the same locked `webPreferences` as Plan-023's main window.
    - For Option 2 token paste, uses Electron `dialog.showMessageBoxSync` with a custom input field — actually, since Electron's native `dialog` does not have a password-input variant, we use a **hidden `BrowserWindow` with a dedicated `password-input.html` preload page** whose single purpose is collecting the token via a `<input type="password">` — the page is loaded with CSP `'default-src none'` and runs no JS beyond the preload's `ipcRenderer.send('password-entered', value)` handler. Its HTML and preload assets are authored **under `apps/desktop/src/main/onboarding/`**, alongside the orchestration that owns them — never under `apps/desktop/src/renderer/src/`, which is the application-renderer tree `Spec-026 §Pitfalls To Avoid` names and I-026-4 governs. This dedicated window is a distinct, single-purpose, main-process-owned surface: it is isolated by process and by window, shares no address space with the application renderer, and the application renderer never sees the value. (Alternative considered: OS-native credential-prompt libraries like `node-mac-password-prompt` — rejected because Windows and Linux have no equivalent and shipping three-platform-different secret-entry surfaces has a cost exceeding the isolation we already get from the dedicated-window pattern.)
    - For Option 3, delegates to `hosted-browser.ts` which runs the PKCE flow (step 6, 18).
16. **Author renderer walkthrough.** In `apps/desktop/src/renderer/src/onboarding/Walkthrough.tsx`, implement a VS-Code-walkthrough-patterned React component per [VS Code walkthroughs UX guideline](https://code.visualstudio.com/api/ux-guidelines/walkthroughs): left rail lists (1) Choose your relay, (2) Connect, (3) Telemetry with progress checkmarks; right pane shows step content + primary CTA. Component calls `window.sidekicks.onboarding.presentChoice()` (step 14) — the component is a view-only projection; the decision data flows through the preload bridge, not via local React state.
17. **Wire Option 2 TOFU end-to-end.** Service method `submitChoice({ choice_id: 'self-host', relay_url, admin_token })`:
    1. Probes SPKI (step 4).
    2. Surfaces the derived pin to the UI (CLI prompt or main-process dialog) for out-of-band confirmation.
    3. On user confirm, writes the admin token to keystore (step 7), writes `[onboarding]` with the pin (step 2), emits `onboarding.choice_made` (step 10), deletes partial state.
    4. On user reject, aborts cleanly: no keystore write, no `[onboarding]` write, no event emission. Partial state is cleared too — we do not persist a rejected probe.
18. **Wire Option 3 PKCE end-to-end.** Service method `submitChoice({ choice_id: 'hosted-saas' })`:
    1. Generates PKCE verifier + challenge + state (step 5).
    2. Writes partial state with `{ step: 'choice-made-token-pending', pkce_verifier, pkce_state }`.
    3. Starts loopback callback server (step 6) on `127.0.0.1:<ephemeral>`; records the resolved port.
    4. Opens the system browser to `<hosted-sign-up-url>?client_id=...&response_type=code&code_challenge=<challenge>&code_challenge_method=S256&state=<state>&redirect_uri=http://127.0.0.1:<port>/callback`.
    5. Awaits callback (5-min ceiling); on success, exchanges code + verifier for the scoped token against the hosted token endpoint.
    6. Writes scoped token to keystore, writes `[onboarding]`, emits event, clears partial state.
    7. On timeout: clears partial state (including the short-lived verifier), logs `onboarding.callback_timeout`, surfaces a user-visible retry prompt.
19. **Wire partial-state resume.** On `onboarding.start`, the service reads partial state (step 3); if non-null and fresh (< 24h), it returns `OnboardingStartResponse { state: 'partial', partial: ... }` and the CLI / desktop resumes at the indicated step. If stale, the partial-state file is deleted and the service returns `state: 'unresolved'`.
20. **Wire config-schema-version migration.** When the daemon starts and reads `config.toml` with a `schema_version` older than the version shipped by this plan, it treats the `[onboarding]` block as absent (or as legacy `[onboarding-legacy]` if such a block is found on the explicit migration path) and emits `onboarding.choice_made` with `migrated: true` when the user next resolves. The legacy-block mapping is a no-op today because there is no legacy onboarding config; the infrastructure is wired so that future migrations have a hook.
21. **Reconcile contracts docs.** Extend `docs/architecture/contracts/api-payload-contracts.md` with the five request / response shapes from §API And Transport Changes under a new §Onboarding APIs section (positioned before §GDPR And Rate Limiting to match the spec's rough alphabetic-by-domain ordering). Extend `docs/architecture/contracts/error-contracts.md` with the seven new error codes (see §Error Codes below).
22. **Verify BL-086 registration landed.** Confirm Spec-006 §Event Taxonomy now carries the `onboarding.choice_made` / `onboarding.choice_reset` entries registered under BL-086 (completed 2026-04-18, `onboarding_lifecycle` category). Cross-check the registered payload shapes against this plan's `events.ts` emitter output — any drift between the Spec-006-registered payload and what this plan emits is a review-blocking mismatch and must be resolved by editing whichever side is wrong _before_ merge.
23. **Author the Group-B step model in the daemon service.** In `packages/runtime-daemon/src/onboarding/provider-step.ts`, read the per-provider readiness projection from Plan-029's `providerAccount.list` reply through the client SDK and pass it through unmodified; compose nothing from account fields. Implement the three-trigger discipline of `Spec-026 §Provider Authentication (Group B)` — inside a running flow after the choice resolves, on an account-plane refusal, or on explicit activation — with no readiness test placed ahead of a run. Surface, per provider: register (label + billing mode, through `providerAccount.register`), the disclosed sign-in remedy, choose-a-default from the candidate list the `no_default` arm carries (through `providerAccount.setDefault`, on an operator selection and never an automatic one), an explicit re-check (`providerAccount.probe`, never a poll), and skip. Export the coordinator through the package's root barrel — deep imports are unsupported, so the barrel line is what makes the CLI and desktop imports ordinary. Report a provider as set up only on the authenticated arm. Write no config key, no partial state, no keystore entry, and emit no event.
24. **Author the CLI and desktop provider surfaces.** CLI: a `--providers` flag on the existing `sidekicks onboarding start` (no new command file, so no new clipanion registration) that runs Group B alone, and a per-provider readiness block in `sidekicks onboarding status` naming the remedy for any provider that is not ready. Headless (`!process.stdin.isTTY`) or no reachable browser prints the readiness and the out-of-band remedy and exits 2 with `onboarding.headless_required`, with **no** credential env-var override. Desktop: `apps/desktop/src/renderer/src/onboarding/ProviderStep.tsx` as a view-only step in the existing walkthrough, with `walkthrough-host.ts` fetching the projection in the main process, passing it in, and performing every action the renderer requests over that walkthrough's own channel — no preload-bridge method is added, because Group B has no secret input and the renderer calls no registry verb itself. Both surfaces also **route the account-plane refusal into the step**: the CLI's error renderer prints the invitation on any of the five typed refusal codes (never auto-launching), and the shell's run-failure surface calls the desktop activation entry point on the same codes.
25. **Prove the first-run path end to end.** A fresh node with no accounts is offered registration for each provider; a registration whose probe has not returned the authenticated arm is never reported as set up; a node that already has an authenticated account for a provider is not prompted for it; and the first provider run on a node that completed the step **starts** rather than meeting the account-plane refusal. Assert the negative surface too: no field accepts a provider token, no provider sign-in output reaches a message, an event, or a log, and no credential-home path reaches an event payload or a log line.

### Error Codes

Added to `docs/architecture/contracts/error-contracts.md` in step 21.

| Code | HTTP-equivalent | Meaning |
| --- | --- | --- |
| `onboarding.already_resolved` | 409 | `onboarding.submitChoice` called when state is already `resolved`. Client should call `onboarding.read` or `onboarding.reset`. |
| `onboarding.partial_stale` | 410 | Partial state older than 24h; caller should invoke `onboarding.start` fresh. |
| `onboarding.spki_mismatch` | 412 | Subsequent connection's SPKI differs from pinned value. Registered here, raised by Plan-008 — see **CP-026-5**, the obligation row that carries this crossing; the Spec-008-side event registration is explicitly deferred by `Spec-026 §Fallback Behavior`, so the Plan-008 return-cite is owed at that plan's own dispatch, not at this audit. |
| `onboarding.keystore_unavailable` | 503 | Keystore probe failed; Option 2 / Option 3 cannot persist. |
| `onboarding.callback_timeout` | 408 | 5-min loopback callback ceiling elapsed. |
| `onboarding.pkce_state_mismatch` | 400 | Callback state parameter did not match the one generated at flow start. |
| `onboarding.headless_required` | 428 | CLI detected `!process.stdin.isTTY` and no env-var override was provided; prompts for the override. Also the Group-B arm for a headless or no-reachable-browser host, where the message names the out-of-band remedy (provider, account, the provider's own sign-in invocation, and that account's credential home) instead — **there is deliberately no credential env-var override to prompt for**, since accepting credential material through the daemon's inputs is the intermediation `Spec-029 §Vendor authentication-policy constraints` bars. |

## Implementation Phase Sequence

Seven phases decompose the twenty-five §Implementation Steps above; nothing here is new design. Phase 1 covers Steps 1-3; Phase 2 covers Steps 4-7; Phase 3 covers Steps 8-10 plus the two doc-verification Steps 21-22; Phase 4 covers Steps 11-13; Phase 5 covers Steps 14-16; Phase 6 covers Steps 17-20; Phase 7 covers Steps 23-25. The ordering follows §Rollout Order — the CLI surface is shippable one phase ahead of the desktop surface, so a Plan-023 slip delays Phase 5 without stalling Phase 4. Phase-level `**Precondition:**` lines are reviewer-checkable merge gates; the provider-plan gates they name are the same ones §Preconditions carries, restated per phase so a phase is never dispatched against a substrate that has not landed.

Every phase declares `audit_status: complete` against the Tier-9 readiness audit recorded in §Preconditions; the evidence PR is that audit's own tier PR.

### Phase 1 — Contracts and daemon state substrate

**Precondition:** Tier-9 plan-readiness audit complete (§Preconditions). Plan-007 has landed the typed config surface this plan's store writes through. Implementation Steps 1-3; gates every later phase, all of which type against these shapes.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 331, baseline_tag: "plan-readiness-audit-tier-9-complete" }
```

#### Tasks

- **T1.1 — Onboarding contract surface.**
  - **Files:** `packages/contracts/src/onboarding.ts` (CREATE), `packages/contracts/src/index.ts` (EXTEND — barrel re-export per the existing convention)
  - Every type from §API And Transport Changes: `OnboardingChoiceId`, `OnboardingState`, `OnboardingConfig`, `OnboardingPartialState`, and the five request/response pairs. Type-only surface with the Zod schemas the registry's mandatory `paramsSchema` / `resultSchema` pair consumes; no runtime behaviour. The barrel line is required because the anti-leakage suite pins `index.ts` as the contracts package's only public re-export surface (deep imports are unsupported), and it is one of the ten §Touched But Not Owned edits.
  - **Tests:** `packages/contracts/src/__tests__/onboarding.test.ts` (CREATE) — parse-accept one fixture per shape; parse-reject a `choice_id` outside the three arms and a `state` outside the three arms; assert the package-root barrel resolves the module.
  - **Acceptance:** daemon, CLI, and desktop can all name every onboarding shape from the contracts package alone, with no cross-package deep import.
  - **Spec coverage:** Spec-026 §Interfaces And Contracts, Spec-026 §Daemon JSON-RPC Additions
  - **Verifies invariant:** none (contracts-only type surface; the invariants bind at their consuming service seams)
  - **Consumes:** none (leaf contract module)

- **T1.2 — `[onboarding]` TOML config store.**
  - **Files:** `packages/runtime-daemon/src/onboarding/config-store.ts` (CREATE), `packages/runtime-daemon/package.json` (EXTEND — explicit `proper-lockfile` v4 dependency; the transitive-dep assumption must not be relied on)
  - `smol-toml` v1.6.1 `parse()` / `stringify()` over the whole document so non-`[onboarding]` sections survive, behind a `proper-lockfile` advisory lock across the read-modify-write. `ENOENT` returns `null`; a parse error surfaces `TomlError.line` and never falls back to an empty config, because a silent fallback hides user-visible corruption. The block carries choice metadata and the public SPKI pin only — no token field exists in the shape, which is what makes I-026-3 structural rather than procedural.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/config-store.test.ts` (CREATE) — round-trip a fixture carrying three non-`[onboarding]` sections and assert byte preservation (comment-free fixtures, per the `smol-toml` round-trip gap in §Risks And Blockers); assert file mode `0600`; assert a malformed document surfaces the line number rather than an empty config.
  - **Acceptance:** no code path can write a token into `config.toml`, and a concurrent writer cannot interleave a partial document.
  - **Spec coverage:** Spec-026 §Persistence, Spec-026 §State And Data Implications
  - **Verifies invariant:** I-026-3
  - **Consumes:** `OnboardingConfig` ← T1.1 (same phase)

- **T1.3 — Partial-state store with the 24-hour staleness window.**
  - **Files:** `packages/runtime-daemon/src/onboarding/partial-state-store.ts` (CREATE)
  - Atomic write-to-tmp-then-rename at mode `0600` so a concurrent reader never observes a half-written file. The mutating read deletes a file older than 24 hours and returns `null`; the non-mutating `peek` applies the same staleness check without deleting, so `onboarding.read` stays side-effect-free while stale state still reports as absent. Physical deletion is deferred to the next mutating entry point — the observable clear-on-staleness semantics hold at the 24-hour boundary either way.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/partial-state-store.test.ts` (CREATE) — fake-timer at 23.5 h returns the state, at 24.5 h returns `null` and unlinks; `peek` at 24.5 h reports absent without unlinking; assert `0600`; assert a concurrent reader never observes partial content.
  - **Acceptance:** a stuck partial-state file cannot block a fresh onboarding, and no read path can surface stale state as live.
  - **Spec coverage:** Spec-026 §Fallback Behavior, Spec-026 §State And Data Implications
  - **Verifies invariant:** I-026-9
  - **Consumes:** `OnboardingPartialState` ← T1.1 (same phase)

### Phase 2 — Trust and credential primitives

**Precondition:** Phase 1 merged. Plan-023 has landed the keystore surface and the `safeStorage` backend probe (T2.4's desktop path); Plan-025 exposes a TLS-terminated `GET /readyz` so T2.1's integration test has a real certificate chain to pin. Implementation Steps 4-7. These four modules are mutually independent and can be built in parallel once contracts land.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 331, baseline_tag: "plan-readiness-audit-tier-9-complete" }
  - { type: plan_phase, plan: 26, phase: 1, status: merged }
```

#### Tasks

- **T2.1 — One-shot SPKI TLS probe.**
  - **Files:** `packages/runtime-daemon/src/onboarding/spki-probe.ts` (CREATE)
  - `tls.connect()` against the operator-supplied relay URL, `getPeerCertificate(true)`, `base64(sha256(cert.pubkey))` as the pin, 10-second socket timeout, socket destroyed on both paths. The pin format is the leaf SPKI SHA-256 the OWASP recommendation calls for — deliberately not the CA-bundle fingerprint ADR-020's prose names; see §Risks And Blockers for the recorded refinement and its rotation consequences.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/spki-probe.test.ts` (CREATE) plus `spki-probe.int.test.ts` (CREATE) — unit: known-SPKI test HTTPS server returns the expected base64, and the timeout path rejects; integration: parity against the `openssl` SPKI-DER pipeline, which is what validates the undocumented `PeerCertificate.pubkey` field is in fact the SubjectPublicKeyInfo DER encoding.
  - **Acceptance:** the derived pin is reproducible outside Node, so an operator can verify it out of band with standard tooling.
  - **Spec coverage:** Spec-026 §Implementation Notes, Spec-026 §Fallback Behavior
  - **Verifies invariant:** I-026-7
  - **Consumes:** none (Node `tls` / `crypto` built-ins only)

- **T2.2 — PKCE verifier, challenge, and state generation.**
  - **Files:** `packages/runtime-daemon/src/onboarding/pkce-state.ts` (CREATE)
  - `oauth4webapi` v3.8.5 `generateRandomCodeVerifier()` + `calculatePKCECodeChallenge()` + `generateRandomState()`. `S256` is the only reachable `code_challenge_method`: the module exposes no parameter and no branch that can produce `plain`, so a server-side downgrade attempt has nothing to negotiate with.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/pkce-state.test.ts` (CREATE) — verifier matches the RFC 7636 §4.1 character set and 43-128 length bounds; challenge equals `base64url(sha256(verifier))`; state is 128-char URL-safe; assert by inspection of the exported surface that no `plain` path exists.
  - **Acceptance:** no caller, and no server response, can cause this module to emit a `plain` challenge.
  - **Spec coverage:** Spec-026 §Implementation Notes, Spec-026 §Three-Way Choice Semantics
  - **Verifies invariant:** I-026-10
  - **Consumes:** none (`oauth4webapi` primitives only)

- **T2.3 — Loopback PKCE callback server.**
  - **Files:** `packages/runtime-daemon/src/onboarding/pkce-callback.ts` (CREATE)
  - `http.createServer()` bound to the `'127.0.0.1'` literal at `port: 0`, one-shot, with the resolved ephemeral port surfaced from `server.address()` for `redirect_uri` construction. State-parameter equality is checked before the code is read; a mismatch closes the server and rejects `pkce_state_mismatch`. A 5-minute `AbortSignal.timeout(300_000)` closes and rejects `callback_timeout`. Binding the IPv4 literal rather than `'localhost'` is load-bearing, not stylistic — see §Risks And Blockers for the dual-stack resolution split.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/pkce-callback.test.ts` (CREATE) — matching state and code resolves; mismatching state rejects `pkce_state_mismatch`; the abort path rejects `callback_timeout`; `server.address().address === '127.0.0.1'` (not `::1`); a second callback after resolution finds no listener.
  - **Acceptance:** the listener is unreachable from off-host, single-use, and always torn down on every terminal path.
  - **Spec coverage:** Spec-026 §Implementation Notes, Spec-026 §Fallback Behavior
  - **Verifies invariant:** I-026-10
  - **Consumes:** the expected `state` + `verifier` ← T2.2 (same phase)

- **T2.4 — Keystore-client wrapper over the Spec-023 surface.**
  - **Files:** `packages/runtime-daemon/src/onboarding/keystore-client.ts` (CREATE)
  - CLI path uses `@napi-rs/keyring` v1.2.0 directly, with the try/catch-on-`getPassword()` existence idiom the library forces (it exposes no `exists()`); desktop path forwards to main-process `safeStorage` through the Plan-023 IPC bridge. On Linux a `getSelectedStorageBackend()` of `basic_text` or `unknown` **refuses** the write rather than downgrading — those backends are plaintext files wearing a keystore's interface. Both paths surface `keystore_available: false` for the event payload so ops can see the degraded posture.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/keystore-client.test.ts` (CREATE) — a thrown `not-found` on `getPassword()` yields `null`; `setPassword` / `getPassword` round-trip; a mocked `basic_text` backend refuses the write and emits the degraded flag; assert no refusal path falls through to a file write.
  - **Acceptance:** there is no code path from a token value to any destination other than the keystore.
  - **Spec coverage:** Spec-026 §Persistence, Spec-026 §Fallback Behavior
  - **Verifies invariant:** I-026-3
  - **Consumes:** the keystore surface + `safeStorage` backend probe ← [Plan-023](./023-desktop-shell-and-renderer.md) (CP-026-3)

### Phase 3 — Daemon service, IPC, and events

**Precondition:** Phase 2 merged. Plan-007 has landed `MethodRegistry.register()`, the `ipc/handlers/index.ts` per-handler barrel, and the `bootstrap/index.ts` wiring point (CP-026-1). Implementation Steps 8-10, 21-22.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 331, baseline_tag: "plan-readiness-audit-tier-9-complete" }
  - { type: plan_phase, plan: 26, phase: 2, status: merged }
```

#### Tasks

- **T3.1 — `OnboardingService` orchestrator and state machine.**
  - **Files:** `packages/runtime-daemon/src/onboarding/service.ts` (CREATE)
  - The `unresolved → partial → resolved` machine plus `resolved → reset → unresolved`, exposing `readState` / `startOrResume` / `submitChoice` / `submitTelemetry` / `reset`. Persistence ordering is fixed: write partial state, run the side effect, update or promote, delete partial state on full resolution — so a crash mid-operation resumes cleanly. The service is the single place the trigger discipline lives (first outbound invite or explicit activation, never install / first launch / incoming invite), the place the three options are presented as equals with Option 1 preselected, and the place telemetry is gated as a separate step that cannot be skipped. Single-flight is enforced by an `activeFlow` promise so two concurrent invites await one flow rather than starting two.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/service.test.ts` (CREATE) — transitions with persistence ordering verified via spies; crash-resume mid-`submitChoice` yields `state: 'partial'` at the correct step; every non-trigger entry point (install, first launch, health check, session create, local run, incoming-invite accept) leaves the flow dormant; telemetry cannot resolve without an explicit answer; two concurrent triggers produce one flow.
  - **Acceptance:** no ordering of crashes, restarts, or concurrent invites produces a resolved config the user did not explicitly choose.
  - **Spec coverage:** Spec-026 §Trigger, Spec-026 §Three-Way Choice Semantics, Spec-026 §Telemetry Opt-In, Spec-026 §Fallback Behavior
  - **Verifies invariant:** I-026-1, I-026-2, I-026-5, I-026-9
  - **Consumes:** the config store ← T1.2, the partial-state store ← T1.3, the trust and credential primitives ← T2.1-T2.4

- **T3.2 — Five `onboarding.*` JSON-RPC binders.**
  - **Files:** `packages/runtime-daemon/src/onboarding/rpc-handlers.ts` (CREATE), `packages/runtime-daemon/src/ipc/handlers/index.ts` (EXTEND — five side-effect-free re-export lines), `packages/runtime-daemon/src/bootstrap/index.ts` (EXTEND — five `registerOnboarding*(registry, deps)` calls)
  - Per-method binders registering the five dotted-camelCase wire names against `MethodRegistry.register()` with both schemas supplied. The four state-touching methods register `mutating: true`; `onboarding.read` is the sole read-only method and uses the store's non-mutating `peek`. Handlers delegate to the service and hold no business logic. The barrel and bootstrap edits follow the shipped `session.*` / `presence.*` per-handler convention and are two of the ten §Touched But Not Owned edits; the registry substrate is never touched.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/rpc-handlers.test.ts` (CREATE) — each of the five names matches the canonical `METHOD_NAME_FORMAT`; registering a PascalCase name throws `invalid_method_name`; the four mutating methods carry `mutating: true` and `onboarding.read` does not; a request reaching a handler is Zod-validated on both request and response.
  - **Acceptance:** the daemon's registered method table names exactly these five onboarding wire methods and no others, and the flow is unreachable from any non-trigger entry point.
  - **Spec coverage:** Spec-026 §Daemon JSON-RPC Additions, Spec-026 §Interfaces And Contracts
  - **Verifies invariant:** I-026-1
  - **Consumes:** `MethodRegistry.register(...)`, the handler barrel, and the bootstrap wiring point ← [Plan-007](./007-local-ipc-and-daemon-control.md) (CP-026-1)

- **T3.3 — `onboarding_lifecycle` event emitters.**
  - **Files:** `packages/runtime-daemon/src/onboarding/events.ts` (CREATE)
  - Emit `onboarding.choice_made` on final resolve and `onboarding.choice_reset` on reset into the Plan-006-owned event bus, with the payload shapes §API And Transport Changes fixes. The emitter consumes the registered `EventType` union directly rather than forward-declaring; no secret field exists in either payload shape, so exclusion is structural rather than a scrubbing step.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/events.test.ts` (CREATE) — both payloads round-trip against the registered shapes; a payload carrying a token or raw SPKI bytes fails to typecheck (negative type test) and is rejected at emission; `keystoreAvailable: false` propagates from the degraded keystore path.
  - **Acceptance:** nothing a user typed during onboarding can reach the append-only event log.
  - **Spec coverage:** Spec-026 §Event Taxonomy Additions
  - **Verifies invariant:** I-026-8
  - **Consumes:** the registered `EventType` union and the event bus ← [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (CP-026-4)

- **T3.4 — Contract-doc reconciliation: onboarding payloads and error codes.**
  - **Files:** `docs/architecture/contracts/api-payload-contracts.md` (EXTEND — new §Onboarding APIs section, positioned before §GDPR And Rate Limiting to match the file's rough alphabetic-by-domain ordering), `docs/architecture/contracts/error-contracts.md` (EXTEND — the seven codes from §Error Codes)
  - Doc-only reconciliation of the shipped shapes. `onboarding.spki_mismatch` is registered here and raised by Plan-008, never by this plan's service — the crossing is carried by CP-026-5, and the Spec-008-side event registration is deferred by `Spec-026 §Fallback Behavior`, so the return-cite is owed at Plan-008's dispatch rather than here.
  - **Tests:** none (doc-only). Verified by the docs-corpus gate and by review against the shipped contract module.
  - **Acceptance:** every shape and code this plan ships is discoverable from the contracts docs without reading the plan.
  - **Spec coverage:** Spec-026 §Interfaces And Contracts
  - **Verifies invariant:** none (contract-doc reconciliation; no runtime surface)
  - **Consumes:** the shipped shapes ← T1.1; the code list ← §Error Codes

- **T3.5 — BL-086 registration-landed and payload-shape cross-check.**
  - **Files:** read-only verification against `docs/specs/006-session-event-taxonomy-and-audit-log.md`; `packages/runtime-daemon/src/onboarding/events.ts` (EXTEND — only if the drift is on this plan's side)
  - Confirm Spec-006's `onboarding_lifecycle` category carries both event types with the payload shapes BL-086 registered (completed 2026-04-18), and diff those against this plan's emitter output field by field. Drift is review-blocking and is resolved by editing whichever side is wrong **before** merge — never by emitting an unregistered shape.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/events.test.ts` (EXTEND) — a fixture per registered payload, asserted field-for-field against the emitter output so future drift fails the suite rather than waiting for the next reader.
  - **Acceptance:** the registered taxonomy and the emitter agree on every field name and type, and the agreement is pinned by a test rather than by a one-time reading.
  - **Spec coverage:** Spec-026 §Event Taxonomy Additions
  - **Verifies invariant:** I-026-8
  - **Consumes:** the BL-086 registration ← [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (CP-026-4)

### Phase 4 — CLI surface

**Precondition:** Phase 3 merged. Plan-007 has landed the `apps/cli/` workspace scaffold and `apps/cli/src/main.ts` (its Phase R3), which T4.2 extends with four `.register()` calls (CP-026-2). Implementation Steps 11-13. At the end of this phase the CLI-only release is shippable — §Rollout Order tags a preview build here.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 331, baseline_tag: "plan-readiness-audit-tier-9-complete" }
  - { type: plan_phase, plan: 26, phase: 3, status: merged }
```

#### Tasks

- **T4.1 — CLI prompt modules.**
  - **Files:** `apps/cli/src/prompts/three-way-choice.ts` (CREATE), `apps/cli/src/prompts/self-host-inputs.ts` (CREATE), `apps/cli/src/prompts/spki-confirm.ts` (CREATE), `apps/cli/src/prompts/telemetry-opt-in.ts` (CREATE)
  - `@inquirer/prompts` v8.x: a `select` presenting the three options as three peers with `free-public-relay` as `default`; `input` + `password` for the Option-2 relay URL and admin token (the library suppresses TTY echo, so no hand-rolled readline touches secret input); a fixed-width monospace SPKI block followed by a `confirm` whose negative answer aborts cleanly with no partial state written; and a standalone default-off telemetry `confirm` that can be answered but not skipped.
  - **Tests:** `apps/cli/src/prompts/__tests__/` (CREATE) — the choice prompt renders three peers with no nesting or _Advanced_ grouping and defaults to Option 1; the telemetry prompt defaults to `false` and has no skip path; a rejected SPKI confirmation writes nothing.
  - **Acceptance:** a user reading the CLI transcript can see three equal options and one explicit, separate telemetry question.
  - **Spec coverage:** Spec-026 §CLI Surface, Spec-026 §Default Behavior, Spec-026 §Telemetry Opt-In
  - **Verifies invariant:** I-026-2, I-026-5
  - **Consumes:** the derived pin ← T2.1; the contract shapes ← T1.1

- **T4.2 — CLI commands and clipanion registration.**
  - **Files:** `apps/cli/src/commands/onboarding/start.ts` (CREATE), `apps/cli/src/commands/onboarding/reset.ts` (CREATE), `apps/cli/src/commands/onboarding/status.ts` (CREATE), `apps/cli/src/commands/telemetry/set.ts` (CREATE), `apps/cli/src/main.ts` (EXTEND — four `.register()` calls)
  - Each command calls the daemon over Plan-007's transport, drives the T4.1 prompt sequence, and maps daemon error codes to CLI exit codes per §Error Codes. `status` prints resolved state and never the plaintext token. The four `.register()` calls are what make the commands reachable at all — clipanion has no auto-discovery — and are one of the ten §Touched But Not Owned edits.
  - **Tests:** `apps/cli/src/commands/__tests__/` (CREATE) — each of the four commands resolves from the built `Cli` instance by its invocation string (the registration regression, which a unit test of the command class alone would miss); `status` output contains no token substring for any of the three options; each mapped error code produces its documented exit code.
  - **Acceptance:** `sidekicks onboarding start|reset|status` and `sidekicks telemetry set` exist at the binary, not merely in the source tree.
  - **Spec coverage:** Spec-026 §CLI Surface, Spec-026 §Reset
  - **Verifies invariant:** I-026-2
  - **Consumes:** the `apps/cli/` scaffold and `main.ts` entry point ← [Plan-007](./007-local-ipc-and-daemon-control.md) (CP-026-2); the prompts ← T4.1 (same phase)

- **T4.3 — Headless detection and the four-override env-var path.**
  - **Files:** `apps/cli/src/env/headless-detect.ts` (CREATE), `apps/cli/src/env/env-override.ts` (CREATE)
  - On `!process.stdin.isTTY` the CLI prints the machine-readable instruction naming all four overrides — including `SIDEKICKS_TELEMETRY_OPT_IN`, without which the telemetry step could only block or silently default — and exits 2. The override reader validates shape and produces the same request pair the interactive path produces, so persisted state is byte-identical rather than merely equivalent.
  - **Tests:** `apps/cli/integration/onboarding.test.ts` (CREATE) — a no-TTY `sidekicks invite create` exits 2 and prints the four-override instruction; a re-run under `SIDEKICKS_ONBOARDING_CHOICE` + `SIDEKICKS_TELEMETRY_OPT_IN` produces an `[onboarding]` block byte-identical to the PTY-driven interactive run; a headless run with the choice override but no telemetry override exits 2 rather than defaulting.
  - **Acceptance:** a CI job can complete onboarding non-interactively without any silent default, and its persisted state is indistinguishable from an interactive one.
  - **Spec coverage:** Spec-026 §Fallback Behavior, Spec-026 §Acceptance Criteria
  - **Verifies invariant:** I-026-6
  - **Consumes:** the request shapes ← T1.1; the interactive-path baseline ← T4.1, T4.2 (same phase)

### Phase 5 — Desktop surface

**Precondition:** Phase 3 merged. Plan-023 has landed the preload bridge, the `apps/desktop/src/main/bridge/onboarding.ts` stubs, the main-process modal pattern, and `apps/desktop/eslint.config.mjs` (CP-026-3). Implementation Steps 14-16. Independent of Phase 4 — a Plan-023 slip delays this phase without stalling the CLI track.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 331, baseline_tag: "plan-readiness-audit-tier-9-complete" }
  - { type: plan_phase, plan: 26, phase: 3, status: merged }
```

#### Tasks

- **T5.1 — Preload namespace, bridge type member, and the renderer import-ban extension.**
  - **Files:** `apps/desktop/src/preload/onboarding.ts` (CREATE), `apps/desktop/src/preload/index.ts` (EXTEND — one import + spread), `packages/contracts/src/desktop-bridge.ts` (EXTEND — `SidekicksBridge` member plus its matching throwing `createTier1Bridge()` stub), `apps/desktop/eslint.config.mjs` (EXTEND — ban-list entries only)
  - `presentChoice()` and `telemetryPrompt()` typed narrowly with no `any`, both resolving from main-process modals. `presentChoice()` returns a `hosted_token_persisted` boolean and never a token value, so the renderer has nothing plaintext to receive. The `SidekicksBridge` member and its throwing stub land together — the factory's every-method-throws contract means adding the member alone stops the contracts package typechecking. The ESLint edit extends Plan-023's existing renderer `no-restricted-imports` list with this plan's token- and SPKI-pin-carrying contract types, following the T-023r-2-6 extension precedent; it tightens the rule and exempts nothing.
  - **Tests:** `packages/contracts/src/desktop-bridge.test-d.ts` (EXTEND) — a negative type test asserting no onboarding bridge method can return a token-typed value; `apps/desktop/e2e/onboarding.spec.ts` (CREATE) — a renderer file importing a banned token type fails lint in CI.
  - **Acceptance:** the ban is a CI gate rather than review advice, and the bridge's return types make a plaintext leak unrepresentable.
  - **Spec coverage:** Spec-026 §Desktop Surface, Spec-026 §Pitfalls To Avoid
  - **Verifies invariant:** I-026-4
  - **Consumes:** the preload bridge and the ESLint config ← [Plan-023](./023-desktop-shell-and-renderer.md) (CP-026-3)

- **T5.2 — Main-process modal orchestration.**
  - **Files:** `apps/desktop/src/main/onboarding/modal.ts` (CREATE), `apps/desktop/src/main/onboarding/spki-confirm-dialog.ts` (CREATE), `apps/desktop/src/main/onboarding/hosted-browser.ts` (CREATE), `apps/desktop/src/main/onboarding/walkthrough-host.ts` (CREATE), `apps/desktop/src/main/bridge/onboarding.ts` (EXTEND — replace the Plan-023 stub bodies with delegation)
  - The `presentChoice` orchestration invoked by the Plan-023 bridge handler: it mounts the walkthrough window with the same locked `webPreferences` as the main window, presents the three options as peers, collects the Option-2 token through the dedicated single-purpose password-input window whose assets live in this directory (never in the renderer tree), and delegates Option 3 to `hosted-browser.ts`. No `ipcMain.handle` call is registered outside Plan-023's bridge module — channel registration stays the bridge registry's.
  - **Tests:** `apps/desktop/e2e/onboarding.spec.ts` (EXTEND) — Playwright `_electron`: the choice surface shows three peers with no _Advanced_ affordance; the Option-2 password window opens with `contextIsolation` / `sandbox` on and `nodeIntegration` off, and the application renderer observes no token; the SPKI-confirm dialog gates the keystore write.
  - **Acceptance:** every secret the desktop flow collects is collected outside the application renderer, and the three options reach the user as three.
  - **Spec coverage:** Spec-026 §Desktop Surface, Spec-026 §Three-Way Choice Semantics
  - **Verifies invariant:** I-026-2, I-026-4
  - **Consumes:** the bridge surface ← [Plan-023](./023-desktop-shell-and-renderer.md) (CP-026-3); the callback server ← T2.3; the probe ← T2.1

- **T5.3 — Renderer walkthrough component.**
  - **Files:** `apps/desktop/src/renderer/src/onboarding/Walkthrough.tsx` (CREATE)
  - The VS-Code-walkthrough-patterned component: left-rail progress over _Choose your relay_ / _Connect_ / _Telemetry_, right-pane step content, one explicit primary CTA per step, non-dismissible until a choice is made. The component is a view-only projection — every decision flows out through `window.sidekicks.onboarding.*` into main, and no branch of it receives or holds a secret. Minimal landmark roles and focus management ship with it; the full a11y audit is deferred per §Risks And Blockers.
  - **Tests:** `apps/desktop/e2e/onboarding.spec.ts` (EXTEND) — the walkthrough cannot be dismissed before a choice resolves; an `axe-core` pass under the `_electron` harness; a renderer-scope assertion that no component prop or state field is typed as token-carrying.
  - **Acceptance:** the richest surface of the flow holds no secret and can be operated from the keyboard.
  - **Spec coverage:** Spec-026 §Desktop Surface, Spec-026 §Implementation Notes
  - **Verifies invariant:** I-026-4
  - **Consumes:** the preload namespace ← T5.1 (same phase)

### Phase 6 — End-to-end option wiring

**Precondition:** Phase 4 and Phase 5 merged (the CLI legs of Steps 17-19 may land with Phase 4 per §Rollout Order steps 5-7; this phase is the point at which every option is wired on both surfaces). Implementation Steps 17-20.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 331, baseline_tag: "plan-readiness-audit-tier-9-complete" }
  - { type: plan_phase, plan: 26, phase: 4, status: merged }
  - { type: plan_phase, plan: 26, phase: 5, status: merged }
```

#### Tasks

- **T6.1 — Option-2 TOFU wired end to end.**
  - **Files:** `packages/runtime-daemon/src/onboarding/service.ts` (EXTEND — the `self-host` branch of `submitChoice`)
  - Probe, surface the pin for out-of-band confirmation, and only on confirm write the admin token to the keystore, write `[onboarding]` with the pin, emit `onboarding.choice_made`, and clear partial state. On reject, abort cleanly: no keystore write, no config write, no event, and partial state cleared too — a rejected probe is never persisted. A later mismatch refuses the connection and surfaces the reset and `relay repin --force` recovery paths rather than re-trusting.
  - **Tests:** `apps/cli/integration/onboarding.test.ts` (EXTEND) — against a testcontainer relay: the pin lands in `[onboarding]` and the token in the mocked keyring; a rejected confirmation leaves all three stores untouched; a rotated certificate on reconnect surfaces `onboarding.spki_mismatch` and does not re-pin.
  - **Acceptance:** no path re-trusts a changed SPKI without an operator pasting the new hash, and no path writes the admin token anywhere but the keystore.
  - **Spec coverage:** Spec-026 §Three-Way Choice Semantics, Spec-026 §Fallback Behavior
  - **Verifies invariant:** I-026-3, I-026-7
  - **Consumes:** the probe ← T2.1; the keystore client ← T2.4; the service machine ← T3.1

- **T6.2 — Option-3 PKCE wired end to end.**
  - **Files:** `packages/runtime-daemon/src/onboarding/service.ts` (EXTEND — the `hosted-saas` branch of `submitChoice`)
  - Generate the PKCE triple, persist `{ step: 'choice-made-token-pending', pkce_verifier, pkce_state }`, start the loopback listener and record its resolved port, open the system browser at the sign-up URL with `code_challenge_method=S256` and the `http://127.0.0.1:<port>/callback` redirect, await the callback under the 5-minute ceiling, exchange code plus verifier for the scoped token, write it to the keystore, write `[onboarding]`, emit, and clear. On timeout, clear partial state including the short-lived verifier, log `onboarding.callback_timeout`, and offer retry.
  - **Tests:** `apps/cli/integration/onboarding.test.ts` (EXTEND) — against a mock hosted endpoint with the browser open intercepted: a simulated callback yields a keystore-resident scoped token and a resolved `[onboarding]`; a timeout leaves no verifier on disk; a callback bearing a mismatched `state` is refused and leaves no persisted state.
  - **Acceptance:** the verifier exists on disk only between flow start and the first terminal event, and no `plain` challenge is ever emitted.
  - **Spec coverage:** Spec-026 §Three-Way Choice Semantics, Spec-026 §Implementation Notes
  - **Verifies invariant:** I-026-3, I-026-10
  - **Consumes:** the PKCE primitives ← T2.2, T2.3; the keystore client ← T2.4; the service machine ← T3.1

- **T6.3 — Partial-state resume wired into `onboarding.start`.**
  - **Files:** `packages/runtime-daemon/src/onboarding/service.ts` (EXTEND — `startOrResume`)
  - A fresh partial state returns `state: 'partial'` with the step the user left, and the CLI and desktop both re-enter there rather than replaying resolved steps. A stale file is deleted and the service returns `unresolved`. Resume reads both the partial-state file and the keystore for the expected entry and resolves to the further-along step when they disagree — the crash-after-keystore-write-before-promote case.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/service.test.ts` (EXTEND) — one crash-resume case per step transition; the disagreement case resolves to the further-along step; a stale file resumes as `unresolved` with the file gone.
  - **Acceptance:** no crash point in the flow leaves a user unable to finish onboarding or forced to re-answer a resolved step.
  - **Spec coverage:** Spec-026 §Fallback Behavior
  - **Verifies invariant:** I-026-9
  - **Consumes:** the partial-state store ← T1.3; the keystore client ← T2.4

- **T6.4 — Config-schema-version migration hook.**
  - **Files:** `packages/runtime-daemon/src/onboarding/config-store.ts` (EXTEND — `schema_version` read and bump), `packages/runtime-daemon/src/onboarding/service.ts` (EXTEND — the migration branch)
  - A `config.toml` whose `schema_version` predates this plan is treated as carrying no `[onboarding]` block (or as the explicit legacy-block path if one is found), and the next resolution emits `onboarding.choice_made` with `migrated: true`. The legacy mapping is a no-op today because no legacy onboarding config exists; the hook is wired so a future migration has somewhere to land, and older daemons can detect and refuse rather than misread.
  - **Tests:** `packages/runtime-daemon/src/onboarding/__tests__/config-store.test.ts` (EXTEND) — an older `schema_version` reads as absent rather than as garbage; the resolution that follows carries `migrated: true`; a newer `schema_version` than this daemon understands is refused rather than partially parsed.
  - **Acceptance:** a version skew between daemon binary and config file is always detected, never silently misread.
  - **Spec coverage:** Spec-026 §Fallback Behavior, Spec-026 §Implementation Notes
  - **Verifies invariant:** none (config-schema-version migration; behaviour re-enters via T3.1)
  - **Consumes:** the config store ← T1.2; the migration branch's re-entry ← T3.1

### Phase 7 — Provider authentication (Group B)

**Precondition:** Phase 4 and Phase 5 merged (Group B ships on both surfaces, the same gate Phase 6 takes), **and** Plan-029 **Phase 3** merged. Implementation Steps 23-25.

The external gate names Phase 3 rather than Phase 2 even though T7.1-T7.3 consume only Phase 2's registry and readiness projection, because **T7.4 asserts that the first provider run starts** — and account resolution, the `admittedProviderAccountId` stamp, and fail-closed spawn validation are Plan-029 T3.1/T3.2, not T2.5. A Phase-2 gate would have let this phase's own mandatory acceptance path dispatch against machinery that does not exist. Plan-029 Phase 3's precondition is `plan_phase 29/2 merged`, so naming Phase 3 subsumes Phase 2 rather than dropping it, and the cost is that T7.1-T7.3 wait on a strictly later merge than they strictly need — the conservative direction, and cheaper than splitting a four-task phase to save three of them a tier-ordered wait.

Homed as one terminal supplement phase rather than threaded through Phases 3-6, so the external dependency holds only the work that actually has it: adding `external_plan_phase_merged` to Phase 3 would have held every unrelated Phase-3 task behind Plan-029.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 331, baseline_tag: "plan-readiness-audit-tier-9-complete" }
  - { type: plan_phase, plan: 26, phase: 4, status: merged }
  - { type: plan_phase, plan: 26, phase: 5, status: merged }
  - { type: external_plan_phase_merged, plan: 29, phase: 3 }
```

#### Tasks

- **T7.1 — Group-B step model and trigger discipline, in the shared client layer.**
  - **Files:** `packages/client-sdk/src/onboarding/provider-step.ts` (CREATE), `packages/client-sdk/src/index.ts` (EXTEND — one barrel line; §Touched But Not Owned entry ten)
  - **Where this lives, and why it is not the daemon.** Group B is a **coordinator over the node-local `providerAccount.*` surface**, not a daemon-side service: it holds no state, owns no storage, and its every action is a call the CLI or the desktop main process is already authorized to make. Homing it in `packages/runtime-daemon` would have put it out of process from both of its consumers with no transport to reach it — and the only transports available were minting a sixth `onboarding.*` verb (which this amendment refuses: Group B persists nothing, so a verb whose job is relaying a UI step would be a second record of a step whose truth lives in the registry) or having the daemon consume the client SDK, which inverts that package's direction. In the client SDK, both consumers reach it by ordinary import: `apps/cli` and `apps/desktop`'s main process both already depend on `@ai-sidekicks/client-sdk` for their daemon calls, so the coordinator sits beside the `providerAccountClient` it drives and **no transport is added, no `onboarding.*` shape changes, and the five daemon methods stay unchanged in name, count, and shape**. That import is only ordinary if the symbol is exported: the package's public surface is its root `index.ts` barrel and deep imports are unsupported, so this task also appends **one** barrel line, the same single-import-surface convention every domain client in that directory follows.
  - The step model: read the per-provider readiness projection from Plan-029's `providerAccount.list` reply through `providerAccountClient` and pass it through **unmodified**; apply the three-trigger discipline, including the account-plane-refusal trigger — which **fetches readiness for the provider (or the overridden account) the typed refusal names** rather than reading a remedy off the refusal, since the disclosure rule keeps the remedy off every refusal envelope; and expose per-provider register / sign-in-remedy / **choose-default** / re-check / skip actions that delegate to `providerAccount.*`. The choose-default action exists because the `choose_default` remedy arm is otherwise renderable and unresolvable: it hands the operator a candidate list and, without a control, no way to act on it inside the flow. It passes the operator's chosen candidate to `providerAccount.setDefault` and re-reads readiness, so the arm the operator was shown is the arm the action clears. **The step never elects a candidate itself** — not on a single-candidate node either, where auto-electing would look helpful and would still be the daemon's refusal to choose (I-029-5) overridden by a client. Render whichever remedy union member the arm carries — register, choose-a-default, or sign-in — and never elect a default on the operator's behalf. Report a provider as set up only on the authenticated arm. Persist nothing and emit nothing.
  - **Tests:** `packages/client-sdk/src/onboarding/__tests__/provider-step.test.ts` (CREATE) — each of the three triggers fires and a fourth candidate (session creation, first launch, health check, and a pre-run readiness test) does not; the refusal trigger performs a readiness read for the account the refusal names and renders nothing taken from the refusal envelope itself; a readiness projection is rendered byte-identically to the daemon's reply with no local recomputation; each remedy union member renders its own action; the `choose_default` arm elects nothing on its own — including on a one-candidate node, the tempting auto-elect — and calls `setDefault` only with an operator-chosen candidate, after which a re-read shows the arm cleared; a re-check calls the probe exactly once and display alone calls it zero times; every non-authenticated arm reports not-set-up, `indeterminate` included; and no config, partial-state, keystore, or event write occurs on any path.
  - **Acceptance:** the step neither fires ahead of an admissible run nor computes a readiness value of its own, and both clients reach it without a new wire method.
  - **Spec coverage:** Spec-026 §Provider Authentication (Group B), Spec-026 §Default Behavior
  - **Verifies invariant:** I-026-11, I-026-13
  - **Consumes:** the readiness projection, its remedy, and the registry verbs ← Plan-029 T2.4, T2.5 (CP-026-6)

- **T7.2 — CLI provider step and readiness in `onboarding status`.**
  - **Files:** `apps/cli/src/commands/onboarding/start.ts` (EXTEND — the `--providers` flag), `apps/cli/src/commands/onboarding/status.ts` (EXTEND — the readiness block), `apps/cli/src/commands/onboarding/provider-step.ts` (CREATE — the interactive per-provider prompts), `apps/cli/src/account-plane-refusal-hint.ts` (CREATE — the refusal-code recognition and the invitation text), `apps/cli/src/exit-codes.ts` (EXTEND — Plan-007-owned, §Touched But Not Owned entry nine: call the hint from the existing `error.data.type` discrimination; **no exit code is added or remapped**)
  - `--providers` runs Group B alone; `status` prints per-provider readiness and, for any provider that is not ready, the remedy the daemon disclosed — including the `choose_default` candidate list, whose prompt sets a default through the coordinator rather than telling the operator to leave and run another command. Headless or no-reachable-browser prints readiness plus the out-of-band remedy and exits 2 with `onboarding.headless_required`. No new command file and no new clipanion registration, so `apps/cli/src/main.ts` keeps its four `.register()` calls.
  - **The post-refusal trigger's CLI consumer, owned as files rather than asserted as prose.** Exposing an entry point is not routing anything into it, so this task owns the routing surface itself. `account-plane-refusal-hint.ts` recognizes the five account-plane refusal codes (`provideraccount.not_registered`, `provideraccount.no_default`, `provideraccount.unknown`, `provideraccount.credential_home_unavailable`, `provideraccount.not_authenticated` — the closed set Plan-029 T3.1/T3.2 raise) and prints the one-line invitation to run `sidekicks onboarding start --providers`; `exit-codes.ts` calls it from the `error.data.type` discrimination it already performs, a one-call addition to a Plan-007-owned file recorded as §Touched But Not Owned entry nine, adding and remapping no exit code. It **prints an invitation and never auto-launches**: a non-interactive caller must not have an interactive flow started under it. The invitation carries no remedy of its own — the remedy is fetched from readiness when the operator accepts, because the disclosure rule keeps it off refusal envelopes and because a remedy read at accept time is current rather than a snapshot of the failure. Recognition keys on the typed code, never on message text.
  - **Tests:** `apps/cli/integration/onboarding.test.ts` (EXTEND) — `--providers` on a zero-account node offers registration per provider and leaves `[onboarding]` byte-identical; `status` prints the remedy for a husked home; the headless path exits 2 with the remedy and **no** credential override is accepted from any env var or flag; a token supplied on stdin is not consumed by any prompt; each of the five account-plane refusal codes prints the invitation while a sixth, unrelated refusal does not (the discriminating negative control); the invitation carries no credential-home path or sign-in invocation of its own, those arriving only from the readiness read the accepted flow performs; and no refusal path spawns the flow unprompted, headless included.
  - **Acceptance:** no CLI input path anywhere in this flow accepts provider credential material, and the post-refusal trigger is reachable from a refused run rather than only from an explicit flag.
  - **Spec coverage:** Spec-026 §Provider Authentication (Group B), Spec-026 §Fallback Behavior, Spec-026 §Interfaces And Contracts
  - **Verifies invariant:** I-026-12, I-026-13
  - **Consumes:** the step model ← T7.1 (an ordinary client-SDK import, no transport); the CLI command tree ← T4.1; the `error.data.type` discrimination ← [Plan-007](./007-local-ipc-and-daemon-control.md) T-007r-3-3

- **T7.3 — Desktop provider step in the existing walkthrough.**
  - **Files:** `apps/desktop/src/renderer/src/onboarding/ProviderStep.tsx` (CREATE), `apps/desktop/src/main/onboarding/walkthrough-host.ts` (EXTEND — fetch the projection, pass it in, perform the renderer's requested actions, and export the Group-B activation entry point beside the Group-A one it already exposes), `apps/desktop/src/renderer/src/onboarding/SetUpProvidersCommand.tsx` (CREATE — the renderer-side _Set up providers_ entry that makes the explicit trigger reachable), `apps/desktop/src/main/run-failure-notice.ts` (CREATE — recognizes the five typed account-plane refusal codes on a failed run and calls the activation entry point)
  - The host fetches the projection in the main process and passes it to a view-only renderer step. **The action path is the walkthrough's own main-process channel, and the host is the actor**: the renderer's Register / Sign-in / Choose-default / Re-check / Skip controls post a typed, credential-free step-action message back over the same channel this walkthrough already uses to carry Group A's step decisions (`apps/desktop/src/main/onboarding/walkthrough-host.ts`, created by T5.2), and the **host** — never the renderer — calls the corresponding `providerAccount.*` verb and pushes the refreshed projection back. That is why the renderer can act while making no `providerAccount.*` call of its own, and why **no preload-bridge method is added** and `packages/contracts/src/desktop-bridge.ts` stays untouched — the §Touched But Not Owned set gains no desktop entry (its one addition this round is the CLI-side `exit-codes.ts` call, entry nine). Group B has no secret input, so I-026-4 holds by construction here rather than by enforcement.
  - **Both non-flow triggers get owned callers, so all three of the spec's triggers are reachable on desktop.** `run-failure-notice.ts` recognizes the same five typed account-plane refusal codes on a failed run and calls the activation entry point, which opens the step as its own walkthrough and fetches readiness for the account the refusal names — it passes no remedy taken from the refusal. `SetUpProvidersCommand.tsx` is the explicit-activation entry: a renderer-side command surfaced in the shell's existing command surface, which is what makes _Set up providers_ reachable **without** an application menu. That is deliberate and is the whole reason this file exists — the menu module has no owning plan (see §Risks And Blockers), and a trigger the approved spec requires cannot be left waiting on a module nobody has committed to build. Recognition keys on the typed code, never on message text.
  - **Tests:** `apps/desktop/e2e/onboarding.spec.ts` (EXTEND) — the step renders each readiness arm from a fixture projection; each of the five controls drives its `providerAccount.*` verb **from the main process** and re-renders from the refreshed projection, the choose-default control carrying the operator's selected candidate and never a renderer-chosen one, while the renderer bundle contains no `providerAccount.*` call and no readiness computation; every step-action message the renderer posts is asserted credential-free by shape; the Group-B activation entry point runs Group B alone and leaves Group A untouched; an account-plane refusal opens the step and an unrelated refusal does not; the explicit _Set up providers_ entry opens it with no refusal and no running flow — the third trigger, exercised rather than assumed; and no rendered surface offers a token input.
  - **Acceptance:** the renderer is a projection of the daemon's readiness and never a second source of it, and every Group-B action it offers reaches the registry through the main process.
  - **Spec coverage:** Spec-026 §Provider Authentication (Group B), Spec-026 §Interfaces And Contracts
  - **Verifies invariant:** I-026-12, I-026-13
  - **Consumes:** the step model ← T7.1 (an ordinary client-SDK import in the main process, no transport); the walkthrough host ← T5.2; the renderer shell the command entry mounts into ← T5.3

- **T7.4 — End-to-end: a freshly onboarded node starts its first provider run.**
  - **Files:** `apps/cli/integration/onboarding.test.ts` (EXTEND), `apps/desktop/e2e/onboarding.spec.ts` (EXTEND)
  - The BL-154 exit path, both surfaces: a zero-account node is offered registration; a registration whose probe has not returned the authenticated arm is never reported as set up; a node that already has an authenticated account for a provider is not prompted for it; and **the first provider run on a node that completed the step starts** rather than meeting the account-plane refusal. The skip path is asserted too: onboarding completes with zero accounts, and the completion summary names which providers are not ready and what the first run will do.
  - **Tests:** the same two files — plus a negative sweep asserting that no event payload or log line emitted across the whole flow carries a credential-home path or provider sign-in output.
  - **Acceptance:** the first-run gap BL-154 recorded is closed on both surfaces, and closing it introduced no credential-disclosure path.
  - **Spec coverage:** Spec-026 §Provider Authentication (Group B), Spec-026 §Acceptance Criteria
  - **Verifies invariant:** I-026-11, I-026-12
  - **Consumes:** T7.1, T7.2, T7.3; a registered, authenticated account and the spawn path that admits it ← Plan-029 T3.1, T3.2 (the phase-level `external_plan_phase_merged` entry on Plan-029 Phase 3 is this task's gate, not a task-scoped hold)

## Parallelization Notes

- Step 1 (contracts) is strictly first. Everything else consumes it.
- Steps 2, 3, 4, 5, 6, 7 (stores, probes, callback, PKCE, keystore) are independent; can run fully parallel once contracts land.
- Step 8 (service) consumes steps 2-7.
- Step 9 (JSON-RPC wiring) consumes step 8.
- Steps 10 (event emission) can run alongside step 8 — it plugs into the service via a callback hook.
- Steps 11, 12, 13 (CLI) consume step 9.
- Steps 14, 15, 16 (desktop) consume step 9 **AND** Plan-023's preload-bridge scaffold. Until Plan-023 step 1-5 land, only the CLI path can ship.
- Steps 17, 18, 19, 20 (end-to-end flows + migration) consume the entire stack.
- Step 21 (contracts docs) is doc-only; can happen any time, ideally before merge.
- Step 22 (BL-086 registration-landed + payload-shape cross-check against Spec-006) is a read-only verification; any time before merge.
- Steps 23, 24, 25 (the provider-authentication step group) consume steps 8-16 **AND** Plan-029 Phase 3 (Phase 2 for the registry and readiness projection; Phase 3 for the spawn path step 25 asserts a run reaches). They are independent of steps 17-20: Group B has no relay dependency, so it neither blocks nor is blocked by the option-wiring work.

## Test And Verification Plan

### Unit tests (`packages/runtime-daemon/src/onboarding/*.test.ts`)

- `config-store.test.ts`: round-trip an existing `config.toml` with 3 non-`[onboarding]` sections; write an `[onboarding]` block; verify the other sections are byte-preserved (modulo the `smol-toml` comment-preservation gap — see §Risks And Blockers; test uses comment-free fixtures for strict byte-equality). Verify write permission is `0600`.
- `partial-state-store.test.ts`: write a partial state; read it back with fake-timer advanced 23.5h → returns the state; advance to 24.5h → returns `null` and deletes the file. Verify atomic write (concurrent-reader does not observe half-written content).
- `spki-probe.test.ts`: connect to a test HTTPS server with a known SPKI; assert `probeSPKI(url)` returns the expected base64 SHA-256. Test timeout path.
- `pkce-state.test.ts`: generated verifier matches RFC 7636 §4.1 character set + length bounds; challenge is `base64url(sha256(verifier))`; state is 128-char URL-safe.
- `pkce-callback.test.ts`: open server, issue a GET with matching state + code → resolves `{code, verifier}`; mismatching state → rejects with `pkce_state_mismatch`; AbortSignal fires → rejects with `callback_timeout`. Verify the server listens on `127.0.0.1` (not `::1`) by asserting `server.address().address === '127.0.0.1'`.
- `keystore-client.test.ts`: mock `@napi-rs/keyring` throwing a `not-found` error on `getPassword()` → wrapper returns `null`. Mock successful `setPassword` / `getPassword` round-trip. Test Linux `basic_text` refusal by mocking `safeStorage.getSelectedStorageBackend()`.
- `service.test.ts`: state machine transitions `unresolved → partial → resolved` with persistence ordering verified via spies (partial state written before side effect, deleted after promotion). Crash-resume: simulate an exception mid-`submitChoice` → verify next `onboarding.start` returns `state: 'partial'` with the correct step.

### Integration tests (`apps/cli/integration/onboarding.test.ts`, `apps/desktop/e2e/onboarding.spec.ts`)

- CLI interactive: spawn `sidekicks onboarding start` under a PTY (`node-pty` already in the stack per Plan-024); drive Option 1 → assert `[onboarding]` block written with `choice_id: 'free-public-relay'` and `telemetry_opt_in: false`.
- CLI headless: run `sidekicks invite create` without a TTY → assert exit code 2 and instruction printout. Re-run with `SIDEKICKS_ONBOARDING_CHOICE=free-public-relay SIDEKICKS_TELEMETRY_OPT_IN=false` → assert `[onboarding]` block is byte-identical to the interactive-path result (this is the Spec-026 acceptance criterion "env-var path produces byte-identical persisted state").
- CLI Option 2 against a test HTTPS self-host relay (testcontainer running Plan-025's Node relay): paste admin token → verify SPKI pin in `[onboarding]`; verify admin token in keystore (mock keyring backend for CI). Subsequent connect with cert rotation → assert `onboarding.spki_mismatch` error code surfaces.
- CLI Option 3 against a mock hosted endpoint: start flow → browser opens (intercepted via `SIDEKICKS_BROWSER_OPEN=echo`) → simulated callback to `http://127.0.0.1:<port>/callback?code=...&state=...` → scoped token in keystore; `[onboarding]` block resolved.
- Desktop E2E via Playwright `_electron` (per Plan-023's test harness): launch packaged app → click _Invite collaborator_ → walkthrough appears → select Option 1 → verify the preload bridge's `presentChoice()` promise resolves → verify the daemon JSON-RPC `onboarding.submitChoice` was called.
- Desktop E2E: Option 2 path → password-dialog BrowserWindow opens → type admin token → window closes → SPKI-confirm dialog → click confirm → keystore write observed (via the main-process keystore-client spy).
- Desktop E2E: Option 3 path → `shell.openExternal` intercepted → loopback server responds to simulated callback → keystore write observed.

### Group-B provider-step tests

- Trigger discipline: each of the three triggers fires; session creation, first launch, health check, and a pre-run readiness test do not.
- Projection fidelity: every displayed readiness value equals the daemon's reply value; a mutated fixture arm moves the display with no local recomputation; display alone takes zero probes.
- Honesty: every non-authenticated arm reports not-set-up, `indeterminate` included; a registration with no authenticated probe is never reported as set up.
- Non-disclosure: no event payload, relayed payload, or log line emitted across the flow carries a credential-home path or provider sign-in output; no input path accepts provider credential material.
- Exit path: a freshly onboarded node's first provider run starts; a skipped node completes onboarding and its completion summary names the not-ready providers and the refusal the first run will meet.

### Contract tests

- CLI and desktop both call `onboarding.submitChoice` and produce the same `[onboarding]` block for a given `choice_id + relay_url + admin_token` input. This shared test suite is the primary guarantee that "the CLI and desktop surfaces produce identical persisted state" (`Spec-026 §Required Behavior` §Persistence).

### Security tests

- Fuzz the PKCE callback handler with arbitrary query strings → never persists partial state, never writes to keystore.
- Fuzz the `smol-toml` parser against malformed `config.toml` → never silently falls back to empty config; always surfaces the parse error with line number.
- Static check via the renderer `no-restricted-imports` ESLint rule Plan-023 authors at its **step 17** (`apps/desktop/eslint.config.mjs`, T-023p-1-6; already extended once at T-023r-2-6) — **not** step 19, which is the CI-gate-scripts step. Plan-023's declared ban list carries no token- or SPKI-typed entry, so this plan extends it with its own token- and SPKI-pin-carrying contract types (T5.1, following the T-023r-2-6 extension precedent): no `import` of them from `apps/desktop/src/renderer/src/**`. CI fails on violation, which is what makes I-026-4 mechanically enforced rather than review-enforced.

## Rollout Order

1. Contracts (step 1).
2. Stores + probes + PKCE primitives (steps 2-7).
3. Service + JSON-RPC + event emission (steps 8-10).
4. CLI prompts + commands + headless path (steps 11-13). At this point, the CLI-only release is shippable. Tag a preview build.
5. End-to-end flow wiring for CLI Options 1/2/3 (steps 17-19, CLI side).
6. Desktop preload + main-process modal + renderer walkthrough (steps 14-16). Gate on Plan-023 preload scaffold being green.
7. End-to-end flow wiring for desktop Options 1/2/3 (steps 17-19, desktop side).
8. Config-schema-version migration wiring (step 20).
9. Contracts-doc reconciliation (step 21).
10. BL-086 registration-landed + payload-shape cross-check against Spec-006 (step 22).
11. Provider-authentication step group on both surfaces (steps 23-25). Gate on Plan-029 Phase 3 merged (which itself gates on that plan's Phase 2).
12. Staging: drive all six test scenarios (CLI × 3 options, desktop × 3 options); monitor event log for correct `onboarding.choice_made` payloads.
13. Production: flip on via feature-flag gate; revert plan = flip gate off (flow reverts to "no onboarding, default = free-public-relay silent" which is acceptable for a few days while the team investigates).

## Rollback Or Fallback

- **Total onboarding outage (e.g., loopback callback broken on every platform).** Feature-flag gate `AIS_ONBOARDING_ENABLED=false` → daemon silently defaults to `choice_id: 'free-public-relay'` at first invite and logs a warning. This is a documented degradation; it skips Options 2 and 3 but does not break sessions. Users still need to run `sidekicks onboarding start` manually once the gate flips on to configure self-host / hosted-SaaS.
- **Partial-state corruption.** `sidekicks onboarding reset --force` removes the partial-state file unconditionally, bypassing the normal confirmation. Intended for ops use when the staleness window has somehow been exceeded but the file is still present (e.g., clock-skew bug).
- **Keystore outage on Option 2/3.** Onboarding refuses to persist; surfaces `onboarding.keystore_unavailable`; session proceeds in memory-only mode for the outbound invite that triggered the flow. The user can retry once the keystore is back. No silent downgrade to plaintext persistence.
- **PKCE callback stuck.** 5-min `AbortSignal.timeout` always fires; partial state (including the short-lived verifier) is cleared. Worst case: user waits 5 minutes and then retries.
- **`smol-toml` parse regression.** Roll back the `smol-toml` version in `package.json`; `@iarna/toml` is not a drop-in replacement (it lacks TOML 1.0.0 strict conformance). If a parser bug is discovered post-ship, the fallback is a pin to the previous `smol-toml` minor + a forked bugfix if severe.

## Risks And Blockers

- **`@inquirer/prompts` v8.x ESM-only.** v8 removed CommonJS output in favor of ESM per [Inquirer.js v8 release notes](https://github.com/SBoudrias/Inquirer.js/releases). The `apps/cli` package must be published ESM-only (or dual-publish via `tsup`). If the CLI stack is CommonJS-only, pin to `@inquirer/prompts` v7.x (last CJS-supporting line) and note the downgrade. Preference: ship ESM; Node 24 LTS is ESM-native and the CLI sits on the Node-24 Active-LTS tier per [ADR-022 §Decision](../decisions/022-v1-toolchain-selection.md#decision) — the two-tier target (Node 22 Maintenance LTS for daemon + Electron renderer; Node 24 Active LTS for control plane + CLI). ADR-016 carries no Node-version text; the Node target has always been ADR-022's.
- **`smol-toml` recency.** `smol-toml` v1.6.1 is actively maintained (last published 2025-Q4 — see [squirrelchat/smol-toml releases](https://github.com/squirrelchat/smol-toml/releases)) but has a smaller user base than the historically-popular `@iarna/toml`. `@iarna/toml` is the traditional choice but has had no publish since 2021, does not claim TOML 1.0.0 conformance, and lacks TOML 1.1.0 support (which we will need for the `schema_version` integer-with-underscore-separator form per TOML 1.1.0). Accepted: `smol-toml` is correct choice despite smaller ecosystem. Mitigation: contract tests against the exact TOML-1.0.0 + 1.1.0 fixtures in the spec's §Persistence table.
- **`smol-toml` comment preservation gap.** `smol-toml` is a _parser+stringifier_ pair, not a format-preserving round-trip library. Writing back a parsed TOML file loses comments and whitespace. Mitigation: on write, read the existing `[onboarding]` block; if we are only updating fields within that block, use a regex-based in-place replacement that preserves the surrounding document (including comments). Cleaner mitigation in follow-up: adopt `toml-edit`-style format-preserving editor library when one becomes available in the JS ecosystem. For V1, regex-based in-place replacement is acceptable because `[onboarding]` lives in a stable-named block.
- **`oauth4webapi` minimal surface.** `oauth4webapi` v3.8.5 (panva) exposes primitives, not a prebuilt flow. That's deliberate — we only need verifier+challenge+state generation, not token-endpoint negotiation — because the hosted token endpoint is our own. Alternative: `openid-client` v6.8.3 (same author) bundles full OIDC discovery + token exchange; rejected because OIDC semantics exceed our Option 3 needs and the bundle size penalty hits the CLI startup path (Node ESM cold-start sensitive to dep graph).
- **TOFU pins the leaf SPKI, deliberately refining ADR-020's CA-bundle wording.** [ADR-020 §First-Run UX](../decisions/020-v1-deployment-model-and-oss-license.md#first-run-ux) names a CA-bundle fingerprint as the trust-on-first-use material; this plan pins the leaf SPKI SHA-256 instead, following the OWASP recommendation `Spec-026 §Implementation Notes` ratifies, so operators can rotate certificates without re-prompting. The two are not interchangeable under rotation — a CA-bundle pin survives any leaf reissued under the same CA, while an SPKI pin survives only a reissue that reuses the key pair — and this plan's §Test And Verification Plan asserts the stricter SPKI mismatch behaviour, so the departure is load-bearing rather than cosmetic. Recording the refinement in ADR-020's Decision Log is routed as an upstream housekeeping item and is not made in this plan.
- **`'127.0.0.1'` vs `'localhost'` binding.** RFC 8252 §7.3 ("Loopback Interface Redirection") says the client "MAY" use either — but there is a well-documented class of bug where the browser resolves `localhost` to `::1` (IPv6 loopback) while the Node listener bound via `listen(0, 'localhost')` only listens on `127.0.0.1` (or vice versa), producing intermittent `ECONNREFUSED` on the callback. See [Node.js dual-stack localhost issue](https://github.com/nodejs/node/issues/40702) for the long history. Mitigation: bind literally to `'127.0.0.1'` and emit the `redirect_uri` as `http://127.0.0.1:<port>/callback`. IPv6-only systems are out of scope for Option 3 in V1 (documented in `Spec-026 §Open Questions`).
- **AbortSignal.timeout 5-min ceiling.** Available since Node 17.3 ([Node.js AbortSignal.timeout docs](https://nodejs.org/api/globals.html#abortsignaltimeoutdelay)), so the repo's shipped `">=22.12.0"` daemon floor already carries it and **no `engines` bump is owed**. An earlier draft of this bullet instructed a `"node": ">=24.0.0"` bump in `packages/runtime-daemon/package.json`; that instruction is withdrawn — it was both unnecessary (22.12 already satisfies the API) and wrong, because [ADR-022 §Decision](../decisions/022-v1-toolchain-selection.md#decision) puts the daemon and the Electron renderer on the Node 22 Maintenance-LTS tier (forced by ADR-016's Electron floor) and reserves Node 24 Active LTS for the control plane and the CLI. Raising the daemon floor to 24 would break that tier.
- **`@napi-rs/keyring` v1.2.0 no existence-check.** `@napi-rs/keyring` v1.2.0 does not expose an `exists()` method per [Brooooooklyn/keyring-node source](https://github.com/Brooooooklyn/keyring-node/blob/main/src/lib.rs). Existence-check idiom is try/catch on `getPassword()` treating `not-found` as `null`. This idiom is stable across napi-rs versions and mirrors what the Rust `keyring` crate does natively. Downside: the library is younger than `node-keytar` (the project's previous choice) — we inherit whatever bugs exist in its macOS Keychain bridge. Plan-023 is the canonical owner of the keystore surface; this plan is a consumer. Any keystore-client library swap would be a Plan-023 edit, not a Plan-026 edit.
- **Electron `safeStorage` Linux backend refusal.** Spec-023 requires refusing `'basic_text'` and `'unknown'` backends because they are plaintext files masquerading as keystores. Plan-026 implements this refusal on the hosted / self-host token write path. If a barebones Linux install lacks `gnome-keyring` or `kwallet*`, Options 2 and 3 fail at the keystore step — documented in `Spec-026 §Open Questions` as an intentional refusal.
- **Single-flight trigger discipline.** Two concurrent invite attempts on a fresh install must not both trigger two overlapping onboarding flows. Mitigation: the service holds a single in-flight lock (a `Promise` stored on `OnboardingService.activeFlow`); the second caller awaits the first's completion rather than starting anew. Acceptance test in §Test And Verification Plan covers this.
- **Partial-state races.** If the daemon crashes after the keystore write but before the `[onboarding]` promote, the next `onboarding.start` must detect "keystore present AND partial state in `token-persisted-telemetry-pending` step" and resume at the telemetry step. Mitigation: the service's resume logic reads both the partial state file AND probes the keystore for the expected entry, resolving to the further-along step if they disagree. Edge case covered by integration test.
- **Spec-006 registration resolved.** BL-086 (completed 2026-04-18) registered `onboarding.choice_made` / `onboarding.choice_reset` in the Spec-006 `onboarding_lifecycle` category with payload shapes matching this plan's emitter. Plan-026's event emission consumes the registered `EventType` union directly; no generic `DomainEvent` fallback is required.
- **Plaintext-token entry surface.** The password-dialog isolated-BrowserWindow pattern (step 15) is the one place this plan renders plaintext into any Chromium surface. A review must verify the password-dialog window carries: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a CSP of `default-src 'none'`, and a preload script whose only import is `ipcRenderer.send` with one channel (`password-entered`) subscribed. Its assets live under `apps/desktop/src/main/onboarding/`, so it is outside the `apps/desktop/src/renderer/src/**` scope Plan-023's restricted-imports rule guards and **no ESLint ignore-list entry is owed** — an earlier draft of this bullet asked for one under a renderer `password-dialog/` subtree; that path is withdrawn, since a renderer-tree password input is exactly what `Spec-026 §Pitfalls To Avoid` forbids. What this plan does add to that rule is the token- and SPKI-type ban-list **extension** (T5.1), which tightens the application renderer rather than exempting anything.
- **Hosted-sign-up redirect URL is a build-time constant.** Option 3's redirect URL is hardcoded in the daemon binary at build time (per `Spec-026 §Open Questions` tentative). If the hosted-SaaS sign-up URL changes, users on older daemons remain pointed at the old URL until they upgrade. Mitigation: ship the URL as a config-overrideable field (`AIS_HOSTED_SIGNUP_URL`) for power users; the happy path uses the build-time constant. Mid-term: adopt well-known discovery at `<hosted-saas-base>/.well-known/onboarding` per `Spec-026 §Open Questions`.
- **The refusal-routing legs consume two surfaces this plan does not own, and neither needs a new one.** T7.2's CLI leg is a recognition branch in the CLI's shared error-rendering path — the surface `apps/cli/src/exit-codes.ts` (Plan-007 T-007r-3-3) already discriminates on `error.data.type` rather than the numeric code, so recognizing five more typed codes adds a branch to a discrimination that exists and mints no file, no exit code, and no §Touched But Not Owned entry. T7.3's desktop leg is a call **into** this plan's own activation entry point from the shell's run-failure surface; the caller is Plan-023's, and the entry point being exported is what keeps the edit on the caller's side one call rather than an integration this plan would have to author. If either surface turns out not to exist at dispatch, the correct move is to register the ownership row then — not to mint a parallel error renderer or a second run-failure surface here.
- **No plan authors the desktop application menu — inherited, and named here rather than papered over.** `Spec-026 §Trigger` has required a _Set up collaboration_ menu activation since before this amendment, and `Spec-026 §Interfaces And Contracts` now names _Set up providers_ beside it. Neither label has an owning task: this plan's desktop steps author walkthrough and dialog surfaces only, and [Plan-023](./023-desktop-shell-and-renderer.md) — whose spec names a "platform-appropriate menu bar" — carries no menu module, no menu task, and no menu file anywhere in its body. T7.3 therefore exports a Group-B **activation entry point** from the walkthrough host and mints no menu file, because minting one would invent an integration point into a module no plan has committed to build. **Group B's explicit trigger does not wait on that module**: `SetUpProvidersCommand.tsx` surfaces _Set up providers_ in the shell's existing renderer command surface, so all three of the spec's triggers are reachable on desktop today — an approved acceptance criterion cannot be left pending on an unowned module, and routing around it costs one renderer entry. The menu remains the _conventional_ home for both labels and would be the better one; when the menu module gets an owner, both entries become menu items calling the same activation point, which is a caller change and not a redesign. What stayed inherited and unclosed was Group A's `Set up collaboration` label, whose only desktop caller would be that menu. **Closed 2026-09-01 (§6 node NS-97):** Plan-023 now owns the application menu — `apps/desktop/src/main/menu.ts`, authored by its Phase-1B task T-023p-1B-2 — and that menu carries both labels as `Session` submenu entries calling this plan's exported activation entry point, each entry **absent** until this plan's desktop step registers the route it opens (the console's absent-not-disabled rule), so no menu entry ever points at a surface that does not exist.

- **Walkthrough host-window accessibility.** The VS-Code-walkthrough-patterned renderer must expose keyboard navigation and screen-reader labels. Plan-026 does not author the full a11y audit; the desktop design track it deferred to has landed (2026-09-01, §6 node NS-97), and the walkthrough shell and the first-run frame are console routes held to [Spec-023 §Console Test Tiers](../specs/023-desktop-shell-and-renderer.md#console-test-tiers)' accessibility tier — zero `@axe-core/playwright` violations at WCAG 2.2 AA on every route and dialog — with minimal landmark roles + focus management the floor below which the first-run UX is inaccessible. `axe-core` is MPL-2.0 and admitted as a never-distributed test dependency per [ADR-020 §Decision Log](../decisions/020-v1-deployment-model-and-oss-license.md#decision-log). Acceptance test: that tier's sweep passes under the Playwright `_electron` harness.

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

- 2026-08-25 — **First-run provider-authentication surfacing amendment and its restoring targeted readiness-audit delta, in one swap** (§6 node NS-77; the NS-63 / NS-65..NS-74 in-swap shape). Audit scope: this plan's amendment growth (I-026-11..13, CP-026-6, Implementation Steps 23-25, Phase 7) plus Spec-026's §Provider Authentication (Group B). Gate walk: **Gate 1** (paired spec flipped and restored `approved` in the same diff, its promotion gate cleared here). **Gate 2** (Phase 7 carries a `#### Tasks` block, all four tasks carrying Files / Provides-equivalent body / Consumes / Spec coverage / Verifies invariant / Tests / Acceptance, matching the six shipped phases' shape). **Gate 3** (I-026-11, I-026-12, and I-026-13 each ground in a named `Spec-026` clause authored by this same amendment — no plan self-cite, no sibling-plan precedent; the `Spec-029` references inside them are supporting rationale, not the grounding cite. CP-026-6 is bidirectionally surfaced at Plan-029 CP-029-7). **Gate 4** (every new `Spec coverage:` marker carries the unbackticked `Spec-NNN §Heading` form, each heading byte-compared against Spec-026's real headings; every `Verifies invariant:` value is a declared `I-026-M` id). **Gate 5** (**no born-unchecked box is minted**: the Plan-029 dependency is carried mechanically by Phase 7's `external_plan_phase_merged` entry on Plan-029 Phase 3 — raised from Phase 2 at the Codex round-1 fold — which resolves against that plan's own shipment manifest rather than a human tick — the NS-64 "check the box by making the carrier unnecessary" outcome. The added §Preconditions Plan-029 row is a legibility record of that mechanical gate, matching the four sibling dependency rows, and gates nothing a second time. The two pre-existing governance boxes are Re-opened and Delivered in-diff). **Closed-set quantifiers re-derived by counting the post-edit body**, not by arithmetic: `### Phase ` headings = **7**, top-level numbered Implementation Steps = **25**, `#### Tasks` entries = **26**, `### Touched but not owned` entries = **10** (eight when this gate walk first ran; the Codex round-2 and round-3 folds recorded below each add one, and the figure stated here is the post-edit count, recounted after the last fold rather than carried from the walk). The §Preconditions Tier-9 audit row's own counts (six phases, 22 steps, 22 tasks, I-026-1..10, CP-026-1..5) are a dated record of that audit and are deliberately left as written. **Audit outcome: pass**; Status flipped and restored `approved` within this diff on the strength of it. **Codex round 1 (three findings, all accepted and folded into normative content):** the Phase-7 external gate was raised Plan-029 Phase 2 → **Phase 3**, because T7.4's mandatory acceptance path asserts a provider run starts and account resolution, admission stamping, and fail-closed spawn validation are Plan-029 T3.1/T3.2 — a Phase-2 gate would have let the phase dispatch against machinery that does not exist (every gate site swept: the phase prose, the YAML entry, §Parallelization Notes, the PR-sequence line, CP-026-6, T7.4's Consumes, and this blockquote); T7.2 and T7.3 gained the **post-refusal trigger's consumers** — exposing an activation entry point routes nothing into it, so the CLI's shared error-rendering path recognizes the five typed account-plane refusal codes and prints an invitation (never auto-launching, so no non-interactive caller has a flow started under it) and the shell's run-failure surface calls the desktop activation entry point on the same codes, making the second of the spec's exactly three triggers reachable; and T7.3 gained the **desktop action path** it lacked — the renderer's four controls post credential-free step-action messages over the walkthrough's existing main-process channel and the **host** calls the `providerAccount.*` verb, which is how the step can act while the renderer still makes no registry call, adds no preload method, and leaves `desktop-bridge.ts` untouched. The four re-derived closed-set quantifiers were re-counted after that fold and unmoved (7 phases, 25 steps, 26 tasks, 8 §Touched But Not Owned entries). **Codex round 2 (twelve findings, all accepted and folded):** on this plan's side, the Group-B coordinator moved from `packages/runtime-daemon` to `packages/client-sdk` — it had been out of process from both of its consumers with no transport and no new RPC, and the client SDK is where a coordinator over `providerAccount.*` belongs, so both clients reach it by ordinary import; the two refusal-routing legs and the desktop explicit trigger became **owned files** rather than prose claims about surfaces no task authorized, adding `account-plane-refusal-hint.ts`, `run-failure-notice.ts`, and `SetUpProvidersCommand.tsx` — the last making _Set up providers_ reachable without the unowned application menu, since an approved acceptance criterion cannot wait on a module no plan has committed to build; and the post-refusal trigger now **fetches** the remedy from readiness rather than reading it off a refusal the disclosure invariant keeps it out of. Quantifiers re-counted again after this round: 7 phases, 25 steps, 26 tasks — **§Touched But Not Owned moves 8 → 9**, for the Plan-007-owned `exit-codes.ts` call. **Codex round 3 (six findings, all accepted and folded; four on this pair):** the `choose_default` remedy arm was **renderable and unresolvable** — the four controls could not call `providerAccount.setDefault`, so the flow could show an operator a candidate list and offer no way to act on it; a fifth choose-default control now carries an operator-chosen candidate and re-reads readiness, electing nothing itself even on a one-candidate node; T7.1 gained the `packages/client-sdk/src/index.ts` **barrel line** its promised ordinary import required, the convention every domain client in that package follows, taking §Touched But Not Owned to **ten**; the post-refusal path now performs an **account-scoped** readiness read so an override-bound refusal yields that account's remedy rather than the provider default's; and `Spec-026 §Event Taxonomy Additions` lost the stray seen-and-settled marker sentence that contradicted this plan's own persists-nothing rule.
- 2026-08-25 — **Why Group B mints no sixth `onboarding.*` method.** A persisted "seen and settled" marker was drafted and then removed: it would have needed a wire verb whose only job is recording a UI dismissal, moving the five-method count claim across sixteen sites, and it would have created a second record of a step whose truth already lives in the Plan-029 registry — accurate about history and wrong about the node one sign-out later. None of Group B's three triggers needs one: two are events (a running flow; a refusal that just happened) and the third is an explicit request. Re-entering the flow after `sidekicks onboarding reset` re-offers Group B, which is what a reset means.

## Done Checklist

- [ ] `packages/contracts/src/onboarding.ts` exports every type from §API And Transport Changes.
- [ ] `[onboarding]` block is persisted at `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (or Windows equivalent) with the fields `choice_id`, `resolved_at`, `relay_url`, `self_host_spki_pin` (Option 2 only), `telemetry_opt_in` via `smol-toml` v1.6.1.
- [ ] Partial-state file at `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (or Windows equivalent) holds in-progress state with 24-hour staleness window and `0600` permissions.
- [ ] Five JSON-RPC methods (`onboarding.start`, `onboarding.submitChoice`, `onboarding.submitTelemetry`, `onboarding.reset`, `onboarding.read` — all but `onboarding.read` registered with `mutating: true`) are registered against Plan-007's `MethodRegistry` via `register()` and respond with the shapes in §API And Transport Changes.
- [ ] CLI command `sidekicks onboarding start` presents the three-way choice via `@inquirer/prompts` v8.x (default = `free-public-relay`) followed by the separate-step telemetry opt-in (default = off).
- [ ] CLI commands `sidekicks onboarding reset|status` and `sidekicks telemetry set {on,off}` implement the `Spec-026 §Interfaces And Contracts` surface.
- [ ] Headless detection (`!process.stdin.isTTY`) returns exit code 2 with the machine-readable env-var instruction; env-var path (`SIDEKICKS_ONBOARDING_CHOICE`, etc.) produces byte-identical `[onboarding]` block to the interactive path.
- [ ] Desktop preload bridge exposes `window.sidekicks.onboarding.{presentChoice, telemetryPrompt}` (the `Spec-026 §Desktop Surface` pair) with narrow typed surface; renderer never receives plaintext tokens.
- [ ] Desktop walkthrough renders the three-way choice in the VS-Code-walkthrough pattern (left-rail progress + right-pane steps + explicit primary CTA) and cannot be dismissed until a choice is made.
- [ ] Option 2 TOFU: SPKI SHA-256 b64 pin is computed from `tls.connect().getPeerCertificate().pubkey`, shown for out-of-band user confirmation, and written to `[onboarding]`; admin token is written to keystore only, never `config.toml`.
- [ ] Option 3 PKCE: loopback HTTP server binds to `'127.0.0.1'` (literal, not `'localhost'`) on an OS-assigned ephemeral port, awaits callback with matching `state` parameter, exchanges code + verifier for scoped token, and writes scoped token to keystore with 5-minute `AbortSignal.timeout(300_000)` ceiling.
- [ ] Linux `safeStorage.getSelectedStorageBackend()` returns something other than `'basic_text'` or `'unknown'` before hosted / self-host token writes; otherwise the write refuses and emits `onboarding.keystore_unavailable`.
- [ ] `onboarding.choice_made` and `onboarding.choice_reset` events emit into the daemon event bus with payload shapes carrying no secret material (no tokens, no SPKI raw bytes).
- [ ] Partial-state resume correctly re-enters at the step the user left when the daemon crashes mid-onboarding; integration test covers crash-resume for every step transition.
- [ ] Config-schema-version bump wired: older daemons detect the new `[onboarding]` schema and either migrate or refuse with `onboarding.already_resolved`.
- [ ] `docs/architecture/contracts/api-payload-contracts.md` has a new §Onboarding APIs section; `docs/architecture/contracts/error-contracts.md` has the seven new error codes from §Error Codes.
- [ ] BL-086 (completed 2026-04-18) registration of `onboarding.choice_made` / `onboarding.choice_reset` in Spec-006 §Event Taxonomy (`onboarding_lifecycle` category) has been cross-checked against this plan's `events.ts` emitter output; any drift resolved before merge.
- [ ] All six test scenarios pass (CLI × 3 options, desktop × 3 options); shared contract test suite confirms CLI and desktop produce identical `[onboarding]` state for identical inputs.
- [ ] The provider-authentication step group ships on both surfaces: a zero-account node is offered registration through the node-local `providerAccount.*` namespace, a provider is reported set up only on the authenticated readiness arm, onboarding completes with zero accounts while naming what the first run will do, and the first provider run on a node that completed the step starts rather than refusing.
- [ ] No Group-B surface accepts provider credential material, re-derives readiness, runs a sign-in command, persists a step record, or lets a credential-home path or provider sign-in output reach an event payload or a log line.
- [ ] Every phase's `#### Tasks` block is complete — each of the 26 tasks landed or explicitly re-staged, with its `Spec coverage:` rows still resolving against Spec-026.
- [ ] The I-026-1…I-026-13 invariant set holds — every task-declared `Verifies invariant:` assertion is backed by a green test or a recorded verification note, and every §Cross-Plan Obligation (CP-026-1…CP-026-6) is either satisfied with a return-cite from its provider or consumer plan or explicitly staged.

## Tier Placement

Tier 9 per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Plan-026 is **strictly downstream** of:

- Plan-007 (daemon JSON-RPC transport + config surface — Plan-026 consumes and extends).
- Plan-023 (desktop shell — Plan-026's desktop surface rides Plan-023's preload bridge and keystore surface).
- Plan-025 (self-hostable relay — Option 2's TOFU probe target).
- Plan-008 (hosted relay / control-plane — Option 3's sign-up redirect endpoint, when deployed).

And **strictly upstream** of nothing — it is a leaf-node plan. CLI-first-release shippability is gated on Plan-007 only; desktop shippability is additionally gated on Plan-023.

## References

### Primary project docs

- [Spec-026: First-Run Three-Way-Choice Onboarding](../specs/026-first-run-onboarding.md)
- [Spec-023: Desktop Shell And Renderer](../specs/023-desktop-shell-and-renderer.md)
- [Spec-007: Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)
- [Spec-025: Self-Hostable Node Relay](../specs/025-self-hostable-node-relay.md)
- [Spec-008: Control-Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Spec-006: Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md)
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)
- [ADR-022: V1 Toolchain Selection](../decisions/022-v1-toolchain-selection.md)
- [Security Architecture](../architecture/security-architecture.md)
- [Plan-023: Desktop Shell And Renderer](./023-desktop-shell-and-renderer.md)
- [Plan-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md)
- [Plan-025: Self-Hostable Node Relay](./025-self-hostable-node-relay.md)

### External primary sources

| Source | URL | Accessed |
| --- | --- | --- |
| RFC 8252 — OAuth 2.0 for Native Apps (§7.1 private-use URI / §7.3 loopback interface / §8.8 malicious external user-agents) | <https://datatracker.ietf.org/doc/html/rfc8252> | 2026-04-17 |
| RFC 7636 — Proof Key for Code Exchange (PKCE) by OAuth Public Clients | <https://datatracker.ietf.org/doc/html/rfc7636> | 2026-04-17 |
| XDG Base Directory Specification v0.8 | <https://specifications.freedesktop.org/basedir-spec/latest/> | 2026-04-17 |
| EU ePrivacy Directive (Directive 2002/58/EC, Art. 5(3), consolidated) | <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219> | 2026-04-17 |
| OWASP Certificate and Public Key Pinning | <https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning> | 2026-04-17 |
| Electron `safeStorage` API | <https://www.electronjs.org/docs/latest/api/safe-storage> | 2026-04-17 |
| `@inquirer/prompts` (v8.x) — ESM-native TTY prompt library | <https://github.com/SBoudrias/Inquirer.js> | 2026-04-17 |
| `oauth4webapi` (v3.8.5, panva) — minimal OAuth + PKCE primitives | <https://github.com/panva/oauth4webapi> | 2026-04-17 |
| `smol-toml` (v1.6.1) — TOML 1.1.0 / 1.0.0 parser + stringifier | <https://github.com/squirrelchat/smol-toml> | 2026-04-17 |
| `@napi-rs/keyring` (v1.2.0) — Node-native OS keystore | <https://github.com/Brooooooklyn/keyring-node> | 2026-04-17 |
| VS Code walkthroughs UX guideline | <https://code.visualstudio.com/api/ux-guidelines/walkthroughs> | 2026-04-17 |
| Node.js `AbortSignal.timeout()` API | <https://nodejs.org/api/globals.html#abortsignaltimeoutdelay> | 2026-04-17 |
| Node.js dual-stack `localhost` resolution caveat (issue #40702) | <https://github.com/nodejs/node/issues/40702> | 2026-04-17 |
