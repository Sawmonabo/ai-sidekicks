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
| **Dependencies** | Plan-007 (local daemon JSON-RPC transport and typed config surface — this plan adds five new `Onboarding*` methods to it); Plan-023 (desktop shell — this plan extends the preload bridge with an `onboarding.*` namespace, consumes the Spec-023 keystore surface and the `safeStorage` backend probe, and runs inside the main-process modal orchestration pattern); Plan-025 (self-hostable relay — Option 2's TOFU reachability probe targets its `GET /readyz` endpoint); Plan-008 (control-plane surface — Option 3's hosted-SaaS redirect URL is served by the project-operated deployment of this relay); Plan-006 (session event taxonomy — `onboarding.choice_made` / `onboarding.choice_reset` are registered here under BL-086, completed 2026-04-18; this plan consumes that registration) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Ship the Spec-026 three-way first-run-choice onboarding flow across both V1 clients (CLI via `@inquirer/prompts` v8.x; desktop via the Plan-023 preload bridge + a VS-Code-walkthrough-patterned renderer) with: single-trigger discipline (first outbound invite OR explicit `sidekicks onboarding start`), typed `[onboarding]` TOML persistence at `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` via `smol-toml` v1.6.1, keystore-only secret persistence via Spec-023's surface (never `config.toml`), RFC 8252 §7.3 loopback-preferred + RFC 7636 PKCE S256 callback for hosted SaaS (Option 3), OWASP-recommended SPKI SHA-256 TOFU pin for self-host (Option 2), explicit-second-step telemetry opt-in default-off per EU ePrivacy Directive Art. 5(3), headless env-var path producing byte-identical persisted state to the interactive path, and partial-state resume across daemon restart with a 24-hour staleness window. Event emission wires `onboarding.choice_made` / `onboarding.choice_reset` into the daemon event log; Spec-006 registration landed under BL-086 (completed 2026-04-18) per the same follow-up pattern BL-084 used, and this plan consumes the registered `EventType` union directly.

## Scope

- `packages/runtime-daemon/src/onboarding/` — **new module in the daemon.** Owns the orchestration service, the TOML config store, the partial-state store, the SPKI TLS probe, the loopback HTTP server for the PKCE callback, the keystore-client wrapper, the telemetry-opt-in store, and the event emitters.
- `packages/contracts/src/onboarding.ts` — **new contract file.** Exports the typed surface shared across daemon, CLI, and desktop: `OnboardingChoiceId`, `OnboardingState`, `OnboardingConfig`, `OnboardingPartialState`, and the five JSON-RPC request/response shapes.
- `packages/cli/src/commands/onboarding/` — **new CLI subcommand tree.** `start.ts`, `reset.ts`, `status.ts`, plus a top-level `telemetry/set.ts` command. Interactive prompts via `@inquirer/prompts` v8.x (successor to `inquirer` v9 — ESM-native, tree-shakable, active maintenance; see §Risks And Blockers for the ESM constraint).
- `apps/desktop/src/preload/onboarding.ts` — **new preload-bridge namespace.** Extends the `window.sidekicks` surface authored by Plan-023 with `onboarding.presentChoice()` and `onboarding.telemetryPrompt()` — both return promises whose resolution flows from main-process modals, not renderer DOM.
- `apps/desktop/src/main/onboarding/` — **new main-process orchestration.** `modal.ts` (native dialog for token paste — renderer never sees plaintext), `spki-confirm-dialog.ts` (Option 2 fingerprint confirmation), `hosted-browser.ts` (`shell.openExternal()` + loopback wait), `walkthrough-host.ts` (mounts the renderer walkthrough when the modal is non-native).
- `apps/desktop/src/renderer/src/onboarding/` — **new renderer walkthrough.** VS-Code-walkthrough-patterned step-through UI with left-rail progress + right-pane content per [VS Code walkthroughs UX guideline](https://code.visualstudio.com/api/ux-guidelines/walkthroughs). Three steps, explicit primary CTA per step, non-dismissible until a choice is made.
- Five new JSON-RPC methods authored on the daemon side: `OnboardingStart`, `OnboardingSubmitChoice`, `OnboardingSubmitTelemetry`, `OnboardingReset`, `OnboardingRead` per Spec-026 §Interfaces And Contracts.
- Config schema: `[onboarding]` block written to `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (or `%APPDATA%\ai-sidekicks\config.toml` on Windows) via `smol-toml` v1.6.1 per Spec-026 §Persistence.
- Partial-state file: `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (fallback `$HOME/.local/state/ai-sidekicks/onboarding.partial.json`) with 24-hour staleness window and clear-on-success / clear-on-reset semantics.
- Keystore writes via the Spec-023 surface: Option 2 writes `ai-sidekicks:self-host-admin-token:<relay_host>`; Option 3 writes `ai-sidekicks:hosted-saas-scoped-token`. Both are keystore-only — never `config.toml`.
- Option 2 TOFU: a one-shot TLS probe (`tls.connect()` + `getPeerCertificate()`) extracting the SPKI SHA-256 hash base64-encoded for pinning per [OWASP Certificate and Public Key Pinning](https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning).
- Option 3 callback: a loopback HTTP server bound to **`'127.0.0.1'`** (not `'localhost'` — see §Risks And Blockers), ephemeral port, one-shot callback, 5-minute `AbortSignal.timeout(300_000)` ceiling, PKCE S256 via [`oauth4webapi`](https://github.com/panva/oauth4webapi) v3.8.5 (panva's minimal-surface-area primitives — `openid-client` v6.8.3 would also work but carries full OIDC machinery we do not need).
- Headless environment detection via `!process.stdin.isTTY` (CLI only) + three env-var overrides (`SIDEKICKS_ONBOARDING_CHOICE`, `SIDEKICKS_RELAY_URL`, `SIDEKICKS_HOSTED_TOKEN_STDIN`) producing byte-identical persisted state to the interactive path.
- Event emission for `onboarding.choice_made` / `onboarding.choice_reset` wired into the daemon event bus (already owned by Plan-006); payload shapes per Spec-026 §Event Taxonomy Additions. Spec-006 registration landed under BL-086 (completed 2026-04-18) in the `onboarding_lifecycle` category — this plan now consumes that registration rather than forward-declaring it.

## Non-Goals

- **Re-specifying Spec-023 mechanisms.** Keystore access, `safeStorage` backend-probe, WebAuthn orchestration, preload-bridge invariants, deep-link protocol registration — all owned by Spec-023 / Plan-023. This plan consumes them. An edit to `safeStorage.ts` or to `preload/bridge.ts` main surface is a review rejection unless it is strictly additive (exposing a new `onboarding.*` method).
- **Installer / package-manager bootstrap.** This plan does not ship brew / apt / npm post-install hooks or a `setup.exe` wizard. Spec-026 §Scope excludes this; first-run onboarding starts when the daemon does, not when the installer runs.
- **Self-hosted operator first-run.** `docker-compose up` for the Spec-025 relay is a separate operator-facing flow owned by Plan-025. This plan is the _client_-side onboarding.
- **Hosted-SaaS sign-up web UX.** This plan authors only the daemon-side loopback callback contract; the sign-up page + pricing + billing UI lives in the hosted-product track. No new routes land here; the redirect URL is a build-time constant.
- **Spec-006 event registration.** The two new `onboarding.*` events are emitted here but were registered under the Spec-006 §Event Taxonomy table by BL-086 (completed 2026-04-18), matching the post-land follow-up pattern BL-084 used for `arbitration.paused` / `arbitration.resumed`.
- **Enterprise SSO onboarding (OIDC / SAML).** Deferred to V1.1+ per Spec-026 §Out Of Scope and BL-060.
- **Control-plane API for telemetry collection.** `sidekicks telemetry set {on,off}` flips the local flag; the server-side telemetry ingestion surface is tracked in a separate, unscheduled track.
- **Prompting on initial install, first daemon start, or first local session.** Single-user local-daemon mode reaches a working session without ever hitting this flow. Implementations that prompt earlier than the first-outbound-invite trigger are a review rejection (Spec-026 §Pitfalls To Avoid).

## Preconditions

- [x] Spec-026 is approved (this plan is paired with it).
- [x] ADR-020 (V1 Deployment Model) is accepted — defines the three-way-choice semantics this plan implements.
- [x] ADR-009 (JSON-RPC IPC Wire Format) is accepted — the transport the five new methods ride.
- [x] ADR-010 (PASETO + WebAuthn + MLS Auth) is accepted — hosted-SaaS scoped-token persistence target.
- [x] ADR-016 (Electron Desktop Shell) is accepted — preload-bridge pattern this plan extends.
- [ ] Plan-007 ships the JSON-RPC transport and config-surface IPC the daemon side of this plan uses. Plan-026 is a downstream consumer. If Plan-007 lands without a config-write path, this plan cannot persist `[onboarding]`.
- [ ] Plan-023 ships the preload bridge (`window.sidekicks`), the keystore surface, the `safeStorage` backend probe, and the main-process modal pattern. Plan-026's desktop surface is a strictly-additive namespace extension (`window.sidekicks.onboarding`). Until Plan-023's main-process scaffold is in, only the CLI path of this plan can ship.
- [ ] Plan-025 exposes the self-hostable relay's `GET /readyz` endpoint with a TLS-terminated HTTPS listener; Option 2's TOFU probe needs a reachable HTTPS certificate chain to pin.
- [ ] Plan-008 serves the project-operated hosted relay so the hosted-sign-up redirect URL is a real, served URL. Without Plan-008's deployment, Option 3 can be code-complete but not end-to-end testable.
- [x] BL-086 `completed` (2026-04-18) registered `onboarding.choice_made` and `onboarding.choice_reset` under Spec-006's `onboarding_lifecycle` category with payload shapes matching this plan's emitter. This plan consumes the registered `EventType` union directly.

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
  - `partial-state-store.ts` — reads / writes `onboarding.partial.json`; enforces the 24-hour staleness window on read (stale reads delete the file and return `null`).
  - `spki-probe.ts` — one-shot `tls.connect()` against the provided relay URL; extracts `PeerCertificate.pubkey` (Node's `getPeerCertificate()` documents this field only as "the public key"; it is empirically the SubjectPublicKeyInfo DER encoding via OpenSSL's `X509_PUBKEY_get0` path — integration test below validates by hashing against `openssl x509 -pubkey \| openssl pkey -pubin -outform DER \| sha256sum`); returns `base64(sha256(SPKI_DER))` for pin comparison.
  - `pkce-callback.ts` — Node-native `http.createServer()` bound to `'127.0.0.1'` at `port: 0` (OS-assigned ephemeral); one-shot listener; 5-minute `AbortSignal.timeout(300_000)` ceiling; state-parameter one-shot check.
  - `pkce-state.ts` — PKCE verifier / challenge generation via `oauth4webapi`'s `generateRandomCodeVerifier()` + `calculatePKCECodeChallenge()` (SHA-256 S256 only; `plain` is refused on the server side by design, but we refuse it on the client side too so downgrade attacks cannot succeed).
  - `keystore-client.ts` — thin wrapper around the Spec-023 keystore surface. CLI path uses `@napi-rs/keyring` v1.2.0 directly (with try/catch `not-found` idiom since the library lacks an existence-check API); desktop path forwards to main-process `safeStorage` via the IPC bridge Plan-023 authors. Linux: refuse writes when `safeStorage.getSelectedStorageBackend()` returns `'basic_text'` or `'unknown'` per Spec-023's Linux gotcha.
  - `events.ts` — emits `onboarding.choice_made` / `onboarding.choice_reset` into the daemon event bus; payload shapes per Spec-026 §Event Taxonomy Additions.
  - `rpc-handlers.ts` — registers the five new JSON-RPC methods on the daemon router (Plan-007 transport).

### New CLI surface

- `packages/cli/src/commands/onboarding/` — **created by this plan.**
  - `start.ts` — force-trigger; presents three-way choice + telemetry-opt-in; resumes partial state if present.
  - `reset.ts` — clears `[onboarding]` + keystore + partial state; emits `onboarding.choice_reset`.
  - `status.ts` — prints resolved state (never the plaintext token).
- `packages/cli/src/commands/telemetry/` — **created by this plan.**
  - `set.ts` — handles `sidekicks telemetry set {on,off}` (post-onboarding flip).
- `packages/cli/src/prompts/` — **created by this plan.**
  - `three-way-choice.ts` — `@inquirer/prompts` `select` driving the three-way choice.
  - `self-host-inputs.ts` — relay URL + admin-token `password`-prompt (no echo on TTY) for Option 2.
  - `spki-confirm.ts` — presents the derived SPKI SHA-256 b64 for out-of-band verification.
  - `telemetry-opt-in.ts` — standalone second-step prompt, default-off.
- `packages/cli/src/env/` — **created by this plan.**
  - `headless-detect.ts` — detects `!process.stdin.isTTY`; returns the machine-readable instruction payload.
  - `env-override.ts` — reads `SIDEKICKS_ONBOARDING_CHOICE`, `SIDEKICKS_RELAY_URL`, `SIDEKICKS_HOSTED_TOKEN_STDIN`; produces the same `OnboardingSubmitChoiceRequest` shape the interactive path produces.

### New desktop surface

- `apps/desktop/src/preload/onboarding.ts` — **created by this plan.** Extends `window.sidekicks` with the two `onboarding.*` methods from Spec-026 §Desktop Surface. Typed narrowly (no `any`) to remain inside Plan-023's narrow-preload-bridge contract.
- `apps/desktop/src/main/onboarding/modal.ts` — **created by this plan.** Native Electron `dialog.showMessageBox` (three-way choice buttons) + native password-dialog for Option 2 token paste. Renderer never handles token input.
- `apps/desktop/src/main/onboarding/spki-confirm-dialog.ts` — **created by this plan.** Shows the derived SPKI fingerprint (multi-line monospace) for out-of-band operator confirmation.
- `apps/desktop/src/main/onboarding/hosted-browser.ts` — **created by this plan.** Calls `shell.openExternal()` to the hosted sign-up URL; spins up the `pkce-callback.ts` loopback server; awaits callback or timeout.
- `apps/desktop/src/main/onboarding/walkthrough-host.ts` — **created by this plan.** When the modal flow is the VS-Code-walkthrough style (preferred over native dialog for the choice step), mounts the renderer walkthrough from `apps/desktop/src/renderer/src/onboarding/` into a dedicated `BrowserWindow` with the same hardened `webPreferences` Plan-023 authors.
- `apps/desktop/src/renderer/src/onboarding/Walkthrough.tsx` — **created by this plan.** VS-Code-walkthrough-patterned React component per [VS Code walkthroughs UX guideline](https://code.visualstudio.com/api/ux-guidelines/walkthroughs): left-rail progress, right-pane step content, explicit primary CTA per step. The renderer is a view-only projection; all decisions flow to `window.sidekicks.onboarding.*` which lives in main.

### Doc extensions

- `docs/architecture/contracts/api-payload-contracts.md` — **extended by this plan.** Adds the five new JSON-RPC request / response shapes under a new §Onboarding APIs section.
- `docs/architecture/contracts/error-contracts.md` — **extended by this plan.** Adds error codes `onboarding.already_resolved` (409), `onboarding.partial_stale` (410), `onboarding.spki_mismatch` (412), `onboarding.keystore_unavailable` (503), `onboarding.callback_timeout` (408), `onboarding.pkce_state_mismatch` (400), `onboarding.headless_required` (428).
- `docs/backlog.md` — **read-only verified by this plan.** BL-086 — "Register `onboarding.choice_made` / `onboarding.choice_reset` under Spec-006 §Event Taxonomy" completed 2026-04-18 (same pattern BL-084 uses); step 22 of this plan is a registration-landed + payload-shape cross-check against Spec-006, not a filing action.

### Touched but not owned

- `apps/desktop/src/preload/bridge.ts` (owned by Plan-023) — add a single import + spread of the `onboarding.*` namespace. No other edits. If the edit grows past a one-line addition, it is a review rejection — that means the plan has spilled outside its scope.
- `packages/runtime-daemon/src/rpc/router.ts` (owned by Plan-007) — register the five new method handlers via `router.add()`. No other edits.

## Data And Storage Changes

### `[onboarding]` TOML block (typed)

Path:

- Linux / macOS: `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (fallback `$HOME/.config/ai-sidekicks/config.toml` per [XDG Base Directory Specification v0.8](https://specifications.freedesktop.org/basedir-spec/latest/))
- Windows: `%APPDATA%\ai-sidekicks\config.toml`

Block (schema identical to Spec-026 §Persistence):

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
- Schema version: the top-level `schema_version` field (owned by Plan-007's config surface) bumps by 1 when this plan ships, so older daemons can detect and refuse (per Spec-026 §Fallback Behavior §Conflicting daemon).

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

### Five new JSON-RPC methods (Plan-007 router consumer)

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
  deferred_validation?: boolean; // set true when offline at first-invite time per Spec-026 §Fallback
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

- All five methods authenticated via the Spec-007 typed-principal model (daemon IPC is trusted by socket reachability per Spec-021 §Scope). No new auth primitive.
- Secrets (`admin_token`, `hosted_token`) appear in request payloads exactly once and are zeroed from memory after the keystore write. Never logged; the service's logger strips these field names via a scrubber.
- The JSON-RPC method names are registered in the Plan-007-owned `router.ts` via `router.add()`. Plan-007 exposes an `add(method, handler)` surface; Plan-026 imports and calls it. No router internals are touched.

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
  telemetryPrompt(): Promise<{ opt_in: boolean }>,
  reset(): Promise<void>,
  read(): Promise<OnboardingReadResponse>
}
```

- Exposed via `contextBridge.exposeInMainWorld('sidekicks', { ..., onboarding })`. Plan-023 owns the top-level `sidekicks` object; Plan-026's edit is a single-line spread addition in `apps/desktop/src/preload/bridge.ts`.
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
   - Desktop path (daemon runs as an Electron `utilityProcess` fork per Plan-023): forward to main-process `safeStorage` via the IPC bridge Plan-023 authors. Main-process `safeStorage.isEncryptionAvailable()` is checked at daemon boot; Linux-only `safeStorage.getSelectedStorageBackend()` must return something other than `'basic_text'` / `'unknown'` for us to persist secrets; otherwise refuse and log per Spec-023 §Fallback Behavior.
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
9. **Wire JSON-RPC handlers.** In `packages/runtime-daemon/src/onboarding/rpc-handlers.ts`, register the five methods from §API And Transport Changes against Plan-007's `router.add()` surface. Each handler delegates to the service; no business logic in the handler layer.
10. **Emit events.** In `packages/runtime-daemon/src/onboarding/events.ts`, emit `onboarding.choice_made` on final resolve and `onboarding.choice_reset` on reset into the event bus owned by Plan-006. Payload shapes per Spec-026 §Event Taxonomy Additions and §API And Transport Changes above. No secret fields.
11. **Author CLI prompts.** In `packages/cli/src/prompts/`:
    - `three-way-choice.ts` uses `@inquirer/prompts` v8.x `select({ message: 'Choose your relay deployment', default: 'free-public-relay', choices: [...] })` per [@inquirer/prompts README](https://github.com/SBoudrias/Inquirer.js). Default is Option 1 per Spec-026 §Default Behavior.
    - `self-host-inputs.ts` uses `input({ message: 'Relay URL', validate: (v) => v.startsWith('https://') || 'must start with https://' })` then `password({ message: 'Admin token', mask: '*' })` — `@inquirer/prompts` `password` suppresses TTY echo without us having to touch readline.
    - `spki-confirm.ts` prints the derived SPKI SHA-256 b64 in a fixed-width monospace block, then `confirm({ message: 'Does this fingerprint match what your relay operator posted out-of-band?' })`. Negative answer aborts onboarding cleanly (no partial state written).
    - `telemetry-opt-in.ts` uses `confirm({ message: '...', default: false })` with full disclosure copy. Default-off is load-bearing per EU ePrivacy Directive Art. 5(3) ([EU ePrivacy Directive (consolidated)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219)); the prompt cannot be skipped, only answered.
12. **Author CLI commands.** `packages/cli/src/commands/onboarding/start.ts|reset.ts|status.ts` + `packages/cli/src/commands/telemetry/set.ts`. Each command:
    - Calls the daemon JSON-RPC via Plan-007's transport.
    - Drives the appropriate prompt sequence from step 11.
    - Translates daemon error codes (`onboarding.already_resolved`, `onboarding.spki_mismatch`, etc.) to CLI exit codes per the table in §Error Codes below.
13. **Author headless detection + env-var path.** In `packages/cli/src/env/headless-detect.ts`, test `process.stdin.isTTY`. If false, print a machine-readable instruction listing the three override env-vars (`SIDEKICKS_ONBOARDING_CHOICE`, `SIDEKICKS_RELAY_URL`, `SIDEKICKS_HOSTED_TOKEN_STDIN`) and exit with code 2 per Spec-026 §Fallback Behavior. In `packages/cli/src/env/env-override.ts`, read the three env-vars, validate shape, and produce the same `OnboardingSubmitChoiceRequest` shape the interactive path produces. Byte-identical persisted state is an acceptance criterion; integration test verifies it by diffing the `[onboarding]` block between an interactive-path run and an env-var-path run.
14. **Author desktop preload bridge.** In `apps/desktop/src/preload/onboarding.ts`, define `onboarding.presentChoice|telemetryPrompt|reset|read` per §API And Transport Changes. Each method `ipcRenderer.invoke('onboarding.<method>', args)`; the corresponding main-process handler (step 15) performs the native-dialog work. Spread into the existing `window.sidekicks` object via a single-line addition in `apps/desktop/src/preload/bridge.ts` (the file Plan-023 authors) — this is the only edit outside this plan's directories.
15. **Author desktop main-process modal orchestration.** In `apps/desktop/src/main/onboarding/modal.ts`, register `ipcMain.handle('onboarding.presentChoice', ...)` which:
    - Opens a dedicated `BrowserWindow` hosting the renderer walkthrough (step 16) via `apps/desktop/src/main/onboarding/walkthrough-host.ts`. The walkthrough window carries the same locked `webPreferences` as Plan-023's main window.
    - For Option 2 token paste, uses Electron `dialog.showMessageBoxSync` with a custom input field — actually, since Electron's native `dialog` does not have a password-input variant, we use a **hidden `BrowserWindow` with a dedicated `password-input.html` preload page** whose single purpose is collecting the token via a `<input type="password">` — the page is loaded with CSP `'default-src none'` and runs no JS beyond the preload's `ipcRenderer.send('password-entered', value)` handler. This is the single renderer surface that touches plaintext tokens, and it is isolated by process and by window; the main renderer never sees it. (Alternative considered: OS-native credential-prompt libraries like `node-mac-password-prompt` — rejected because Windows and Linux have no equivalent and shipping three-platform-different secret-entry surfaces has a cost exceeding the isolation we already get from the dedicated-window pattern.)
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
19. **Wire partial-state resume.** On `OnboardingStart`, the service reads partial state (step 3); if non-null and fresh (< 24h), it returns `OnboardingStartResponse { state: 'partial', partial: ... }` and the CLI / desktop resumes at the indicated step. If stale, the partial-state file is deleted and the service returns `state: 'unresolved'`.
20. **Wire config-schema-version migration.** When the daemon starts and reads `config.toml` with a `schema_version` older than the version shipped by this plan, it treats the `[onboarding]` block as absent (or as legacy `[onboarding-legacy]` if such a block is found on the explicit migration path) and emits `onboarding.choice_made` with `migrated: true` when the user next resolves. The legacy-block mapping is a no-op today because there is no legacy onboarding config; the infrastructure is wired so that future migrations have a hook.
21. **Reconcile contracts docs.** Extend `docs/architecture/contracts/api-payload-contracts.md` with the five request / response shapes from §API And Transport Changes under a new §Onboarding APIs section (positioned before §GDPR And Rate Limiting to match the spec's rough alphabetic-by-domain ordering). Extend `docs/architecture/contracts/error-contracts.md` with the seven new error codes (see §Error Codes below).
22. **Verify BL-086 registration landed.** Confirm Spec-006 §Event Taxonomy now carries the `onboarding.choice_made` / `onboarding.choice_reset` entries registered under BL-086 (completed 2026-04-18, `onboarding_lifecycle` category). Cross-check the registered payload shapes against this plan's `events.ts` emitter output — any drift between the Spec-006-registered payload and what this plan emits is a review-blocking mismatch and must be resolved by editing whichever side is wrong _before_ merge.

### Error Codes

Added to `docs/architecture/contracts/error-contracts.md` in step 21.

| Code | HTTP-equivalent | Meaning |
| --- | --- | --- |
| `onboarding.already_resolved` | 409 | `OnboardingSubmitChoice` called when state is already `resolved`. Client should call `OnboardingRead` or `OnboardingReset`. |
| `onboarding.partial_stale` | 410 | Partial state older than 24h; caller should invoke `OnboardingStart` fresh. |
| `onboarding.spki_mismatch` | 412 | Subsequent connection's SPKI differs from pinned value (not raised by this plan's service directly but registered for Spec-008 / Plan-008 consumption). |
| `onboarding.keystore_unavailable` | 503 | Keystore probe failed; Option 2 / Option 3 cannot persist. |
| `onboarding.callback_timeout` | 408 | 5-min loopback callback ceiling elapsed. |
| `onboarding.pkce_state_mismatch` | 400 | Callback state parameter did not match the one generated at flow start. |
| `onboarding.headless_required` | 428 | CLI detected `!process.stdin.isTTY` and no env-var override was provided; prompts for the override. |

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

## Test And Verification Plan

### Unit tests (`packages/runtime-daemon/src/onboarding/*.test.ts`)

- `config-store.test.ts`: round-trip an existing `config.toml` with 3 non-`[onboarding]` sections; write an `[onboarding]` block; verify the other sections are byte-preserved (modulo the `smol-toml` comment-preservation gap — see §Risks And Blockers; test uses comment-free fixtures for strict byte-equality). Verify write permission is `0600`.
- `partial-state-store.test.ts`: write a partial state; read it back with fake-timer advanced 23.5h → returns the state; advance to 24.5h → returns `null` and deletes the file. Verify atomic write (concurrent-reader does not observe half-written content).
- `spki-probe.test.ts`: connect to a test HTTPS server with a known SPKI; assert `probeSPKI(url)` returns the expected base64 SHA-256. Test timeout path.
- `pkce-state.test.ts`: generated verifier matches RFC 7636 §4.1 character set + length bounds; challenge is `base64url(sha256(verifier))`; state is 128-char URL-safe.
- `pkce-callback.test.ts`: open server, issue a GET with matching state + code → resolves `{code, verifier}`; mismatching state → rejects with `pkce_state_mismatch`; AbortSignal fires → rejects with `callback_timeout`. Verify the server listens on `127.0.0.1` (not `::1`) by asserting `server.address().address === '127.0.0.1'`.
- `keystore-client.test.ts`: mock `@napi-rs/keyring` throwing a `not-found` error on `getPassword()` → wrapper returns `null`. Mock successful `setPassword` / `getPassword` round-trip. Test Linux `basic_text` refusal by mocking `safeStorage.getSelectedStorageBackend()`.
- `service.test.ts`: state machine transitions `unresolved → partial → resolved` with persistence ordering verified via spies (partial state written before side effect, deleted after promotion). Crash-resume: simulate an exception mid-`submitChoice` → verify next `OnboardingStart` returns `state: 'partial'` with the correct step.

### Integration tests (`packages/cli/integration/onboarding.test.ts`, `apps/desktop/e2e/onboarding.spec.ts`)

- CLI interactive: spawn `sidekicks onboarding start` under a PTY (`node-pty` already in the stack per Plan-024); drive Option 1 → assert `[onboarding]` block written with `choice_id: 'free-public-relay'` and `telemetry_opt_in: false`.
- CLI headless: run `sidekicks invite create` without a TTY → assert exit code 2 and instruction printout. Re-run with `SIDEKICKS_ONBOARDING_CHOICE=free-public-relay SIDEKICKS_TELEMETRY_OPT_IN=false` → assert `[onboarding]` block is byte-identical to the interactive-path result (this is the Spec-026 acceptance criterion "env-var path produces byte-identical persisted state").
- CLI Option 2 against a test HTTPS self-host relay (testcontainer running Plan-025's Node relay): paste admin token → verify SPKI pin in `[onboarding]`; verify admin token in keystore (mock keyring backend for CI). Subsequent connect with cert rotation → assert `onboarding.spki_mismatch` error code surfaces.
- CLI Option 3 against a mock hosted endpoint: start flow → browser opens (intercepted via `SIDEKICKS_BROWSER_OPEN=echo`) → simulated callback to `http://127.0.0.1:<port>/callback?code=...&state=...` → scoped token in keystore; `[onboarding]` block resolved.
- Desktop E2E via Playwright `_electron` (per Plan-023's test harness): launch packaged app → click _Invite collaborator_ → walkthrough appears → select Option 1 → verify the preload bridge's `presentChoice()` promise resolves → verify the daemon JSON-RPC `OnboardingSubmitChoice` was called.
- Desktop E2E: Option 2 path → password-dialog BrowserWindow opens → type admin token → window closes → SPKI-confirm dialog → click confirm → keystore write observed (via the main-process keystore-client spy).
- Desktop E2E: Option 3 path → `shell.openExternal` intercepted → loopback server responds to simulated callback → keystore write observed.

### Contract tests

- CLI and desktop both call `OnboardingSubmitChoice` and produce the same `[onboarding]` block for a given `choice_id + relay_url + admin_token` input. This shared test suite is the primary guarantee that "the CLI and desktop surfaces produce identical persisted state" (Spec-026 §Required Behavior §Persistence).

### Security tests

- Fuzz the PKCE callback handler with arbitrary query strings → never persists partial state, never writes to keystore.
- Fuzz the `smol-toml` parser against malformed `config.toml` → never silently falls back to empty config; always surfaces the parse error with line number.
- Static check via ESLint rule (added in Plan-023 step 19): no `import` of token or SPKI-pin-carrying types from renderer code. CI fails on violation.

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
11. Staging: drive all six test scenarios (CLI × 3 options, desktop × 3 options); monitor event log for correct `onboarding.choice_made` payloads.
12. Production: flip on via feature-flag gate; revert plan = flip gate off (flow reverts to "no onboarding, default = free-public-relay silent" which is acceptable for a few days while the team investigates).

## Rollback Or Fallback

- **Total onboarding outage (e.g., loopback callback broken on every platform).** Feature-flag gate `AIS_ONBOARDING_ENABLED=false` → daemon silently defaults to `choice_id: 'free-public-relay'` at first invite and logs a warning. This is a documented degradation; it skips Options 2 and 3 but does not break sessions. Users still need to run `sidekicks onboarding start` manually once the gate flips on to configure self-host / hosted-SaaS.
- **Partial-state corruption.** `sidekicks onboarding reset --force` removes the partial-state file unconditionally, bypassing the normal confirmation. Intended for ops use when the staleness window has somehow been exceeded but the file is still present (e.g., clock-skew bug).
- **Keystore outage on Option 2/3.** Onboarding refuses to persist; surfaces `onboarding.keystore_unavailable`; session proceeds in memory-only mode for the outbound invite that triggered the flow. The user can retry once the keystore is back. No silent downgrade to plaintext persistence.
- **PKCE callback stuck.** 5-min `AbortSignal.timeout` always fires; partial state (including the short-lived verifier) is cleared. Worst case: user waits 5 minutes and then retries.
- **`smol-toml` parse regression.** Roll back the `smol-toml` version in `package.json`; `@iarna/toml` is not a drop-in replacement (it lacks TOML 1.0.0 strict conformance). If a parser bug is discovered post-ship, the fallback is a pin to the previous `smol-toml` minor + a forked bugfix if severe.

## Risks And Blockers

- **`@inquirer/prompts` v8.x ESM-only.** v8 removed CommonJS output in favor of ESM per [Inquirer.js v8 release notes](https://github.com/SBoudrias/Inquirer.js/releases). The `packages/cli` package must be published ESM-only (or dual-publish via `tsup`). If the CLI stack is CommonJS-only, pin to `@inquirer/prompts` v7.x (last CJS-supporting line) and note the downgrade. Preference: ship ESM; Node 24 LTS is ESM-native and we target Node 24 per ADR-016.
- **`smol-toml` recency.** `smol-toml` v1.6.1 is actively maintained (last published 2025-Q4 — see [squirrelchat/smol-toml releases](https://github.com/squirrelchat/smol-toml/releases)) but has a smaller user base than the historically-popular `@iarna/toml`. `@iarna/toml` is the traditional choice but has had no publish since 2021, does not claim TOML 1.0.0 conformance, and lacks TOML 1.1.0 support (which we will need for the `schema_version` integer-with-underscore-separator form per TOML 1.1.0). Accepted: `smol-toml` is correct choice despite smaller ecosystem. Mitigation: contract tests against the exact TOML-1.0.0 + 1.1.0 fixtures in the spec's §Persistence table.
- **`smol-toml` comment preservation gap.** `smol-toml` is a _parser+stringifier_ pair, not a format-preserving round-trip library. Writing back a parsed TOML file loses comments and whitespace. Mitigation: on write, read the existing `[onboarding]` block; if we are only updating fields within that block, use a regex-based in-place replacement that preserves the surrounding document (including comments). Cleaner mitigation in follow-up: adopt `toml-edit`-style format-preserving editor library when one becomes available in the JS ecosystem. For V1, regex-based in-place replacement is acceptable because `[onboarding]` lives in a stable-named block.
- **`oauth4webapi` minimal surface.** `oauth4webapi` v3.8.5 (panva) exposes primitives, not a prebuilt flow. That's deliberate — we only need verifier+challenge+state generation, not token-endpoint negotiation — because the hosted token endpoint is our own. Alternative: `openid-client` v6.8.3 (same author) bundles full OIDC discovery + token exchange; rejected because OIDC semantics exceed our Option 3 needs and the bundle size penalty hits the CLI startup path (Node ESM cold-start sensitive to dep graph).
- **`'127.0.0.1'` vs `'localhost'` binding.** RFC 8252 §7.3 ("Loopback Interface Redirection") says the client "MAY" use either — but there is a well-documented class of bug where the browser resolves `localhost` to `::1` (IPv6 loopback) while the Node listener bound via `listen(0, 'localhost')` only listens on `127.0.0.1` (or vice versa), producing intermittent `ECONNREFUSED` on the callback. See [Node.js dual-stack localhost issue](https://github.com/nodejs/node/issues/40702) for the long history. Mitigation: bind literally to `'127.0.0.1'` and emit the `redirect_uri` as `http://127.0.0.1:<port>/callback`. IPv6-only systems are out of scope for Option 3 in V1 (documented in Spec-026 §Open Questions).
- **AbortSignal.timeout 5-min ceiling.** Available since Node 17.3 ([Node.js AbortSignal.timeout docs](https://nodejs.org/api/globals.html#abortsignaltimeoutdelay)). We target Node 24 LTS so this is safe. Confirm in the `engines` field of `packages/runtime-daemon/package.json` (add `"node": ">=24.0.0"` if not already present — this is a Plan-007 edit, noted here only for the precondition).
- **`@napi-rs/keyring` v1.2.0 no existence-check.** `@napi-rs/keyring` v1.2.0 does not expose an `exists()` method per [Brooooooklyn/keyring-node source](https://github.com/Brooooooklyn/keyring-node/blob/main/src/lib.rs). Existence-check idiom is try/catch on `getPassword()` treating `not-found` as `null`. This idiom is stable across napi-rs versions and mirrors what the Rust `keyring` crate does natively. Downside: the library is younger than `node-keytar` (the project's previous choice) — we inherit whatever bugs exist in its macOS Keychain bridge. Plan-023 is the canonical owner of the keystore surface; this plan is a consumer. Any keystore-client library swap would be a Plan-023 edit, not a Plan-026 edit.
- **Electron `safeStorage` Linux backend refusal.** Spec-023 requires refusing `'basic_text'` and `'unknown'` backends because they are plaintext files masquerading as keystores. Plan-026 implements this refusal on the hosted / self-host token write path. If a barebones Linux install lacks `gnome-keyring` or `kwallet*`, Options 2 and 3 fail at the keystore step — documented in Spec-026 §Open Questions as an intentional refusal.
- **Single-flight trigger discipline.** Two concurrent invite attempts on a fresh install must not both trigger two overlapping onboarding flows. Mitigation: the service holds a single in-flight lock (a `Promise` stored on `OnboardingService.activeFlow`); the second caller awaits the first's completion rather than starting anew. Acceptance test in §Test And Verification Plan covers this.
- **Partial-state races.** If the daemon crashes after the keystore write but before the `[onboarding]` promote, the next `OnboardingStart` must detect "keystore present AND partial state in `token-persisted-telemetry-pending` step" and resume at the telemetry step. Mitigation: the service's resume logic reads both the partial state file AND probes the keystore for the expected entry, resolving to the further-along step if they disagree. Edge case covered by integration test.
- **Spec-006 registration resolved.** BL-086 (completed 2026-04-18) registered `onboarding.choice_made` / `onboarding.choice_reset` in the Spec-006 `onboarding_lifecycle` category with payload shapes matching this plan's emitter. Plan-026's event emission consumes the registered `EventType` union directly; no generic `DomainEvent` fallback is required.
- **Renderer plaintext-token leak risk.** The password-dialog isolated-BrowserWindow pattern (step 15) is the one place we render plaintext in the renderer process. A review must verify the password-dialog window carries: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a CSP of `default-src 'none'`, and a preload script whose only import is `ipcRenderer.send` with one channel (`password-entered`) subscribed. Plan-023's restricted-imports CI gate should cover this; Plan-026 adds the specific password-dialog path to the ESLint ignore-list only under the `apps/desktop/src/renderer/src/password-dialog/` subtree.
- **Hosted-sign-up redirect URL is a build-time constant.** Option 3's redirect URL is hardcoded in the daemon binary at build time (per Spec-026 §Open Questions tentative). If the hosted-SaaS sign-up URL changes, users on older daemons remain pointed at the old URL until they upgrade. Mitigation: ship the URL as a config-overrideable field (`AIS_HOSTED_SIGNUP_URL`) for power users; the happy path uses the build-time constant. Mid-term: adopt well-known discovery at `<hosted-saas-base>/.well-known/onboarding` per Spec-026 §Open Questions.
- **Walkthrough host-window accessibility.** The VS-Code-walkthrough-patterned renderer must expose keyboard navigation and screen-reader labels. Plan-026 does not author the full a11y audit (deferred to the desktop design track), but the walkthrough shell must not ship without minimal landmark roles + focus management or the first-run UX is inaccessible. Acceptance test: `axe-core` pass under Playwright `_electron` harness.

## Done Checklist

- [ ] `packages/contracts/src/onboarding.ts` exports every type from §API And Transport Changes.
- [ ] `[onboarding]` block is persisted at `$XDG_CONFIG_HOME/ai-sidekicks/config.toml` (or Windows equivalent) with the fields `choice_id`, `resolved_at`, `relay_url`, `self_host_spki_pin` (Option 2 only), `telemetry_opt_in` via `smol-toml` v1.6.1.
- [ ] Partial-state file at `$XDG_STATE_HOME/ai-sidekicks/onboarding.partial.json` (or Windows equivalent) holds in-progress state with 24-hour staleness window and `0600` permissions.
- [ ] Five JSON-RPC methods (`OnboardingStart`, `OnboardingSubmitChoice`, `OnboardingSubmitTelemetry`, `OnboardingReset`, `OnboardingRead`) are registered with Plan-007's router and respond with the shapes in §API And Transport Changes.
- [ ] CLI command `sidekicks onboarding start` presents the three-way choice via `@inquirer/prompts` v8.x (default = `free-public-relay`) followed by the separate-step telemetry opt-in (default = off).
- [ ] CLI commands `sidekicks onboarding reset|status` and `sidekicks telemetry set {on,off}` implement the Spec-026 §Interfaces And Contracts surface.
- [ ] Headless detection (`!process.stdin.isTTY`) returns exit code 2 with the machine-readable env-var instruction; env-var path (`SIDEKICKS_ONBOARDING_CHOICE`, etc.) produces byte-identical `[onboarding]` block to the interactive path.
- [ ] Desktop preload bridge exposes `window.sidekicks.onboarding.{presentChoice, telemetryPrompt, reset, read}` with narrow typed surface; renderer never receives plaintext tokens.
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
