# Provider Account Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-023 — Provider Accounts And Credential Homes

Wire surfaces for [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md). The `providerAccount.*` namespace administers this machine's provider accounts: this machine's own client or any linked device may call every verb, and no session may (I-023-1).

Each of the namespace's verbs carries the payload pair named below: the reads `providerAccount.list`, `providerAccount.subscribe` and `providerAccount.usageRead`, and the mutating verbs `providerAccount.register`, `providerAccount.update`, `providerAccount.remove`, `providerAccount.setCurrent`, `providerAccount.probe`, `providerAccount.resetCredentialHome`, `providerAccount.login`, `providerAccount.loginCancel` and `providerAccount.memoryImport`. `providerAccount.subscribe` and `providerAccount.usageRead` are grouped with the reads: they mutate nothing and take the same device gate `providerAccount.list` does, for the same disclosure reason. `providerAccount.probe` is grouped with the mutating verbs for two reasons, and the weaker one is the row write: it writes back the observed health state and its observation timestamp to the probed account's row, and — **atomically with that write** — applies I-023-2's generation rule, which names "a transition of the account's probe result into or out of `authenticated`" as a lifecycle transition. So a probe that observes the same authenticated-ness as the stored row leaves `credentialGeneration` untouched, while one that observes a **crossing** of the authenticated boundary bumps it in the same transaction as the health write. Both directions bump: a repaired credential is a new generation, and a destroyed one must not leave consumers holding a generation that still reads as usable. The verb mints and removes no account. The load-bearing reason for the gate is that it reaches into a credential home and drives provider-side credential I/O. That is account-administration work, so it takes the device gate — this machine's own client or any linked device, and no session — rather than the laxer read gate.

**The probe verb is not the only writer of the stored pair.** Every validation that actually observes an account's authentication state writes it back under the same rule — the deliberate probe above, the registration-time status invocation (Spec-025 §Non-interactive token registration), and the **background health observer** (Spec-025 §Credential-home health observation), which is the third writer and joins the set rather than replacing it. **The generation-bump authority is deliberately NOT widened with it.** `credentialGeneration` still bumps only on I-023-2's credential-home lifecycle transitions, and a background observation is not one, so an observer that bumped on a transient fault would tell every consumer of the generation that the home changed when nothing did — the precise harm the both-directions bump rule above exists to produce **only** when the boundary is genuinely crossed by an act that changed the home. The observer is constrained in what the DAEMON may do to take its reading, not in what the provider may do inside its own home: the daemon never reads, writes or copies credential material, never speaks a provider token endpoint itself, and never puts a provider into external-authentication mode. What it does is ask a provider its own limits question inside that provider's own per-account home, which on one pinned leg renews that login as a side effect — the provider's own rotation, taken by the provider, under the provider's own re-read-before-refresh guard. That is the keep-alive, and it is safe only because the home is daemon-owned and is never the person's own; a renewal of that kind is NOT a credential-home lifecycle transition and moves no `credentialGeneration`. Anything else would make the stored reading a record of _explicit probes_ rather than of _the last validation_, which is what the readiness derivation reads and what `observedAt` claims, and the row records observations.

**The identifier is opaque everywhere.** `ProviderAccountId` is daemon-minted and immutable. No client, driver, or renderer parses it, decomposes it, or uses it to locate credential material — it selects a credential environment and nothing else. It is deliberately not derived from an email, a provider subject id, or any credential value, because those rotate and an identity that rotates cannot key historical spend.

```ts
type ProviderAccountId = string & { readonly __brand: "ProviderAccountId" };
type BillingMode = "subscription" | "metered" | "unknown"; // `unknown` is the honest-absence arm (Spec-025 §Billing mode) — never rendered as metered

interface ProviderAccount {
  accountId: ProviderAccountId;
  provider: "claude" | "codex";
  credentialGeneration: number; // monotonic; bumps at every credential-home lifecycle transition (I-023-2)
  billingMode: BillingMode;
  // Provider-REPORTED identity, present only where a health observation surfaced it, each member
  // independently optional because a provider may report any subset. User-adjacent PII
  // (Spec-020 §PII Data Map, `provider_accounts` row): a later observation replaces these, and they
  // are never logged, evented, or carried on an error. THIS IS THE WHOLE IDENTITY OF AN ACCOUNT the
  // provider names: the address, the plan as the provider itself names it, and the organization where
  // the plan has one. One email can hold two accounts on different plans, which is why the plan and
  // the organization are part of the identity rather than decoration around a name someone invented.
  observedAccountEmail?: string;
  observedAccountPlan?: string; // the provider's own word for the plan, carried verbatim and never mapped onto a vocabulary of ours; distinct from `billingMode`, which says how the account is paid for rather than which plan it is on
  observedAccountOrgId?: string;
  observedAccountOrgName?: string;
  // Present only on an account added by a pasted token or API key, which the provider names nowhere:
  // the name the person gave it, required at that registration, different from that provider's other
  // account names, and renamed through `providerAccount.update`. No other account carries a typed name.
  displayLabel?: string;
  isDefault: boolean; // exactly one per provider, enforced by a partial unique index (I-023-5); the provider's CURRENT account, which `providerAccount.setCurrent` moves
  healthState: ProviderAccountHealthState;
  // The OTHER HALF of the stored observation pair (`provider_accounts.health_observed_at`, whose
  // table-level CHECK holds the two set and cleared together). Required-shape and nullable on the
  // reading the four members below take: `null` means no observation has ever been recorded for this
  // account. That is exactly the case a bare `healthState` cannot express — a never-observed account
  // and a probe that genuinely could not decide both project `indeterminate`, and only the timestamp
  // separates them: `null` for the first, a time for the second. It rides the ACCOUNT ROW rather than
  // only `ProviderReadiness.observedAt` because readiness is derived per PROVIDER from the resolved
  // account, so every non-default account in a list reply — and every `account_changed` notification,
  // which carries this shape — would otherwise carry a state with no age at all and no surface could
  // apply the freshness test the stored reading exists to support. Carried VERBATIM from the column,
  // never re-derived and never defaulted to `updated_at`: a registry read still spawns no provider
  // process, and an edit to a billing mode must not read as a fresh authentication observation.
  healthObservedAt: string | null;
  // The window-start switch sits UNDER `probeEnabled` rather than beside it: on by default, and
  // inert while `probeEnabled` is false, so an account silenced for the observer spends nothing at a
  // window's reset either. It is its own durable value because the two are separately settable in
  // the direction that matters — the person may keep the limits read running and still decline to
  // spend a turn at every reset (Spec-025 §Credential-home health observation).
  windowStartEnabled: boolean;
  // The four members below are nullable-by-absence rather than defaulted: an unobserved fact is
  // reported as unobserved, never as a value the daemon has not seen. They are required-shape
  // rather than additive-optional, the same reading the readiness member takes.
  observedAuthMode: ProviderAuthMode | null; // = `provider_accounts.observed_auth_mode`; null until observed
  loggedInAt: string | null; // RFC 3339 UTC of the sign-in this credential came from; null where neither a brokered sign-in nor a token registration produced it
  // ESTIMATE, and the wire says so in its name. Mode-dispatched from `loggedInAt` by the provider's
  // published issuance interval for that mode; null whenever `loggedInAt` or `observedAuthMode` is
  // null, because an estimate with no anchor is a fabrication. A renderer MUST present it as an
  // approximation ("about N days after sign-in"), never as a deadline the daemon can vouch for —
  // the interval belongs to the provider's issuance policy, which the daemon cannot verify, and at
  // least one pinned leg's horizon is server-rewritable on any refresh.
  expectedReloginAtEstimate: string | null;
  probeEnabled: boolean; // false = the person silenced the background observer for this account; the deliberate probe verb and spawn validation still write the stored pair
  // When the credential was last seen refreshed; null on a token account, which has no refresh, and
  // until a refresh is observed. The page draws it as an age, never a countdown.
  lastRefreshObservedAt: string | null;
  // Wake this computer for this account's window start (set through `providerAccount.update`).
  wakeForWindowStartEnabled: boolean;
  // The one-time memory import's recorded outcome, which the account row reads in place of the button
  // once it has run; null until then.
  memoryImport:
    | { outcome: "imported"; count: number; importedAt: string }
    | { outcome: "nothingToImport" }
    | null;
}

// The authentication mode the provider's OWN status surface reports for a home — OBSERVED, never
// assumed, and never derived by the daemon from the shape of a credential file. `unknown` is the
// tolerant arm for "observed, and the provider named a mode this build does not recognize": a
// vendor adding a mode must not fail an observation closed, so the union accepts and records it as
// unknown rather than refusing the observation. `oauth_token` is the ADR-026 D2 class and is the
// mode under which a token-mode account is admitted; the token VALUE is not on this wire.
type ProviderAuthMode =
  | "oauth_subscription"
  | "oauth_token"
  | "api_key"
  | "external"
  | "none"
  | "unknown";

// NOTE (ADR-026 D2). Credential material appears on EXACTLY ONE input on this wire surface and on
// NO output: `ProviderAccountRegisterRequest.nonInteractiveToken` below. It is write-only — it is
// on no reply, no event, no error, no notification, no metric, and no log line, and no reply type
// in this section carries a token-shaped member of any name. In sum:
// one credential-accepting input, named above, and zero credential-bearing outputs.
// `ProviderAccount` itself still carries none — tokens for interactively-authenticated accounts
// live in the per-account credential home written by the provider's own tooling, the daemon
// brokers refresh without holding values, and the ADR-026 D2 token is sealed in the operating
// system's credential store, or in the daemon's secrets.json where that store cannot be used,
// rather than in any column or on any payload here.
type ProviderAccountHealthState =
  | "authenticated"
  | "reauth_required"
  | "home_missing"
  | "indeterminate"; // probe could not decide — not authenticated, and never a refusal: a session starts and the provider signs in on its own (I-023-3)

// NOTE: no credential-home path appears on `ProviderAccount` or on the readiness reply below. On
// every surface a linked device can reach — the relay included — `credential_home_path` names a
// column and nothing else.

// Readiness is the pre-computed answer to the question run admission will ask, derived by the SAME
// resolution the daemon performs at spawn (Spec-025 §Validation at spawn — fail-closed) and served
// from the account row's STORED last-probe result — a list call spawns no provider process, so a
// surface may poll it; `providerAccount.probe` is the deliberate refresh. It AUTHORIZES NOTHING:
// a session starts whatever readiness last reported, and the spawn path re-validates registration
// and the home (I-023-3). Enumerated in full rather
// than aliased off `ProviderAccountHealthState` so a later health arm cannot silently widen this
// client-facing union: it widens ONLY in lockstep with that union, and a new health arm requires an
// explicit readiness arm added here.
type ProviderReadinessState =
  // The first four arms are the resolved account's STORED health state, verbatim. That stored
  // value is the outcome of the last validation — probe reading plus home observation taken at the
  // same moment — so `home_missing` is a recorded observation, never a live stat() at read time.
  | "authenticated" // last validation said so — advisory (I-023-8)
  | "reauth_required" // home was present but held no usable credential
  | "home_missing" // credential home was absent or unreadable when last observed
  | "indeterminate" // probe could not decide, or none taken yet — NOT authenticated, NOT a failure
  | "no_account" // nothing registered for this provider; mirrors `provideraccount.not_registered`
  | "no_default"; // accounts exist, none is default; mirrors `provideraccount.no_default`

interface ProviderReadiness {
  provider: "claude" | "codex";
  state: ProviderReadinessState;
  resolvedAccountId?: ProviderAccountId; // present iff resolution reached exactly one account
  // RFC 3339 UTC of the STORED observation this entry's state was read from. Absent in exactly two
  // cases, both about THIS resolution rather than about the node's probe history: resolution reached
  // no account (`no_account`, `no_default`), so there is no row to have observed — on `no_default`
  // the candidates may well have been probed, and their timestamps are deliberately not summarized
  // into one here, since averaging or picking among them would report an observation of an account
  // this reply did not resolve — or resolution reached an account whose observation pair is still
  // unset. Absence therefore never means "no probe has ever been taken on this node".
  observedAt?: string;
  // Required on every non-authenticated arm and refused on `authenticated`: the schema checks the
  // remedy kind against the state, so a state the person must act on never parses bare. It exists because the spec REQUIRES every non-authenticated
  // surface to display the next action, and no client can compose one — only the daemon knows which
  // account resolution reached and which home it holds. Composed at read time, never stored, so it
  // cannot go stale against the row it describes.
  remedy?: ProviderRemedy;
}

// Guidance for the person that happens to travel structured. The disclosure rule (Spec-025 §Node
// provider readiness and the sign-in handoff) governs it UNCHANGED and binds the READER: these
// values reach the person's screen and NEVER an event payload, anything the control plane can read, a
// log line, or a refusal envelope. `providerAccount.list` takes the SAME device gate as
// the mutating verbs — not the laxer read gate a list verb would otherwise get (Spec-025
// §Authorization Posture; enforced and tested by Plan-023 T2.4).
//
// A UNION rather than one shape, because the remedy is "the person's next action" and the
// non-authenticated states have five different next actions, each with its own producible field set. A single sign-in shape was unproducible on two of them: `no_account` has no account to name
// at all, and `no_default` deliberately resolved to none of several accounts, so composing either
// reply would have required inventing an account or arbitrarily picking one — precisely
// the arbitrary selection I-023-5's single-default rule exists to prevent. The discriminant is
// `kind`, and it is NOT redundant with `state`: `reauth_required` maps to `sign_in` or, on a token
// or API-key account, to `paste_token`; `home_missing` maps to `sign_in`; and `indeterminate` maps
// to `look_again`, never to a sign-in, because "cannot tell right now" means look again and
// conflating it with a lost login walks a person through a sign-in over a passing fault. A client
// renders off `kind` without re-deriving it.
type ProviderRemedy =
  | ProviderRegisterRemedy
  | ProviderChooseDefaultRemedy
  | ProviderSignInRemedy
  | ProviderPasteTokenRemedy
  | ProviderLookAgainRemedy;

// `state: "no_account"` — nothing is registered, so there is nothing to sign into yet.
interface ProviderRegisterRemedy {
  kind: "register";
  provider: "claude" | "codex";
}

// `state: "no_default"` — accounts exist and none is default. Resolution reached no account BY
// DESIGN, so the daemon names the candidates and refuses to choose: picking one here would bind a
// run's spend to an account the person never selected.
interface ProviderChooseDefaultRemedy {
  kind: "choose_default";
  candidateAccountIds: ProviderAccountId[]; // at least one — a one-account no-default state is
  // still `no_default`, and the daemon lists whatever exists
  // and never elects one
}

// `state: "reauth_required" | "home_missing"` on an account that signs in through the provider's
// own flow — resolution reached exactly one account, so the account is known and the next action is
// the vendor's own flow.
interface ProviderSignInRemedy {
  kind: "sign_in";
  accountId: ProviderAccountId; // REQUIRED on this arm: it is the arm where an account resolved
}

// `state: "reauth_required"` on a token or API-key account (`observedAuthMode` `oauth_token` or
// `api_key`): it cannot refresh itself, so the one remedy is to mint a fresh token at the provider
// and paste it, never a sign-in, a retry or a refresh.
interface ProviderPasteTokenRemedy {
  kind: "paste_token";
  accountId: ProviderAccountId;
}

// `state: "indeterminate"` — nothing wrong can be seen from here: the next check may settle it, and
// `Check now` (`providerAccount.probe`) asks again.
interface ProviderLookAgainRemedy {
  kind: "look_again";
  accountId: ProviderAccountId;
}

interface ProviderAccountListRequest {
  provider?: "claude" | "codex";
  // Scopes the readiness derivation to ONE account instead of the provider's default. It exists for
  // a single caller: a run refused on the account plane while bound to an account a saved agent
  // definition or a workflow step pinned
  // (Spec-025 §Node provider readiness and the sign-in handoff). Without it the post-refusal remedy
  // would necessarily describe the provider DEFAULT — a different account from the one that failed,
  // whose home and sign-in state may be entirely healthy — and the person would be handed a
  // remedy for something that is not broken. When present, resolution is pinned to this account:
  // the two registry-shape arms cannot occur (an account was named), and the reply's single
  // readiness entry carries that account's stored reading. An unknown or removed id refuses with
  // the already-registered `provideraccount.unknown` rather than silently falling back to the
  // default, which would re-introduce exactly the wrong-account remedy this member removes.
  accountId?: ProviderAccountId;
}
interface ProviderAccountListResponse {
  accounts: ProviderAccount[];
  // The durable quota rows, delivered on the READ because the subscription only follows and never
  // catches up from a snapshot — without this a client opened after a reading, or after a daemon restart, could
  // not reach `provider_account_usage_windows` until another probe or run happened to produce an
  // update. Entries carry the provenance they were OBSERVED under, so a stored window may legitimately
  // carry `source: "run"`; provenance is a property of the reading, never of the transport that
  // delivers it, and a consumer must accept both values here rather than assuming `"probe"`.
  usageWindows: ProviderAccountUsageWindow[];
  // Required, not optional. A reply that could omit readiness would push
  // every client back into deriving it locally, which I-023-8 exists to prevent.
  // Exactly one entry per provider the request selects: never zero, never two. With `accountId`
  // supplied the selection is that account's provider, so the reply still carries exactly one entry
  // — derived against the named account rather than the provider default.
  readiness: ProviderReadiness[];
}

interface ProviderAccountRegisterRequest {
  provider: "claude" | "codex";
  billingMode: BillingMode;
  makeDefault?: boolean;
  // The name the person gives an account the provider names nowhere: REQUIRED with `nonInteractiveToken`
  // on a new registration and on an API-key registration, absent on a sign-in one, and refused when it
  // matches another of that provider's account names.
  displayLabel?: string;
  // RE-SUPPLY, not a second credential-accepting verb. Supplied, this means "replace the sealed
  // token on THIS account" and `provider` must match the stored row; omitted, this is an ordinary
  // registration and the daemon mints a new identity. It exists because the terminal
  // `reauth_required` remedy is to mint a fresh token and re-supply it, and deregister-then-register
  // would daemon-mint a NEW immutable identity — discarding the spend, quota, and attention history
  // keyed to the account the person is trying to repair. A successful replacement bumps
  // `credentialGeneration` and re-runs the registration-time observation. There is still exactly one
  // credential-accepting input: this adds a selector, not a second credential input.
  //
  // NEVER ADMITTED ALONE. `accountId` names a re-supply, and a re-supply with nothing to supply is
  // not a request this verb can serve: it is not a registration (an identity already exists) and not
  // a replacement (no token accompanies it), so admitting it would leave the caller's intent to be
  // guessed by a handler — and the guess a strict parser makes cheap is the wrong one, since the only
  // reading that touches nothing is a silent no-op reported as success. `accountId` present therefore
  // REQUIRES `nonInteractiveToken` present, enforced at the parse boundary and refused against the
  // absent member. The converse is deliberately unconstrained: a token with no `accountId` is the
  // ordinary token-mode registration of a new account, which is the shape this verb was written for.
  accountId?: ProviderAccountId;
  // THE ONE CREDENTIAL-ACCEPTING INPUT ON THIS WIRE (ADR-026 D2; Spec-025 §Non-interactive token
  // registration). Optional: omitted is the ordinary registration, and the account authenticates
  // through `providerAccount.login` or the person's own out-of-band sign-in.
  //
  // WRITE-ONLY, and the rule is absolute in the direction that matters: this value is never
  // returned on this verb's response or any other, never logged, never echoed to a terminal, never
  // rendered, never placed in an error message or a diagnostic dump, and never carried in an
  // argument vector (an argv is readable by any process running as the same user). A transport
  // that logs request bodies MUST redact this member by name.
  //
  // A token the provider's own tooling minted: the daemon never mints, exchanges, refreshes, or
  // derives credential material and never speaks a provider token endpoint.
  //
  // Kept as its own item in the operating system's credential store, verified by
  // write-probe-read-delete, and nowhere else. Every entry opens its store explicitly — the Secret
  // Service on Linux, never the kernel keyring, which a reboot empties; where no Secret Service answers,
  // and on a Mac whose service runs while the person is logged out, the daemon keeps its items in
  // one file in its own data folder, readable by this account alone (mode `0600`).
  // Where the store cannot take it, registration refuses with `provideraccount.credential_seal_refused`
  // carrying `cause: "locked" | "unavailable"` and nothing is stored anywhere. Where the registration-time
  // status observation reports no signed-in mode for it, registration refuses with
  // `provideraccount.token_not_accepted` and nothing is registered, sealed or replaced. It is NOT written into
  // the credential home: daemon-owned bytes in provider-owned space are indistinguishable to every
  // later reader, the provider's own tooling included. It reaches the provider only on the
  // invocations ADR-026 D2 enumerates — the registration-time status observation, and each provider
  // process of a run bound to this account — and on Claude Code never in an environment variable: the
  // variable the provider documents for it, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, names a pipe the
  // daemon writes once per start, so no command the model issues can read the token from its
  // process's environment. The project's own probe re-runs that observation when the project moves
  // to a new Claude Code version. A pasted OpenAI API key on a Codex account is kept the same way, in the credential store and
  // the daemon's memory only, never in Codex's plaintext file mode.
  nonInteractiveToken?: string;
}
interface ProviderAccountRegisterResponse {
  account: ProviderAccount;
}

// The billing mode the person declared is correctable in place. This verb exists because the
// alternative — remove and re-register — is barred by the identity model: `accountId` is immutable
// and deliberately not re-derivable, so re-registering to fix a mis-declared billing mode would mint
// a NEW identity and orphan the spend history keyed to the old one. A correctable mistake must not
// cost an account its history. The one name the person authors is a token or API-key account's
// `displayLabel`; every other account's identity is what the provider reports, so there is no other
// name here to correct.
interface ProviderAccountUpdateRequest {
  accountId: ProviderAccountId;
  billingMode?: BillingMode; // omitted = unchanged; this is how `unknown` is resolved to a declared mode
  // Rename. Accepted only on an account that carries a `displayLabel`, and refused when it matches
  // another of that provider's account names. Omitted = unchanged.
  displayLabel?: string;
  // The durable per-account opt-out AC-19 requires. Carried on the update verb rather than as a
  // dedicated verb: it is an ordinary mutable account preference, and a verb of its own would add
  // a verb for a boolean. Omitted = unchanged; the column default is enabled, so
  // silence never silences an observer.
  probeEnabled?: boolean;
  // The window-start switch, carried here for the same reason its sibling is: an ordinary mutable
  // account preference, not a verb. Omitted = unchanged; the column default is enabled. Setting it
  // true while `probeEnabled` is false leaves it inert rather than refusing, because the two are one
  // switch under another on the surface and the parent is what silences both.
  windowStartEnabled?: boolean;
  // Wake this computer for this account's window start. The first account turned on installs the
  // wake helper and the last one turned off uninstalls it; on Windows the service schedules the wake
  // itself and no helper exists. Omitted = unchanged.
  wakeForWindowStartEnabled?: boolean;
}
interface ProviderAccountUpdateResponse {
  account: ProviderAccount;
  // Present when this update moved `wakeForWindowStartEnabled`: whether the wake helper is installed
  // now, or why it could not be.
  wakeHelper?: { state: "installed" } | { state: "notInstalled"; reason: string };
}
// NOT updatable, by omission from the request and enforced on write: `accountId` (immutable
// identity), `provider` (an account does not change vendor), `credentialHomePath` (rebinding a
// registration to a different home would silently re-point historical spend at other credentials),
// and `credentialGeneration` (daemon-owned, bumped only by the lifecycle transitions in I-023-2 —
// never by the person's edit, since a descriptive correction is not a credential event).
// `isDefault` is not updatable here either: it has its own verb, `providerAccount.setCurrent`, whose
// partial-unique-index race semantics this verb must not duplicate.

interface ProviderAccountRemoveRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountRemoveResponse {
  accountId: ProviderAccountId;
  removed: true;
}

// Makes this account its provider's CURRENT account, and that is the whole of the account switch
// (Spec-025 §Moving a session to another account). The current mark is the same mark the registry
// calls the default — one fact, the registry's word and the surface's word — and pressing it does
// two things in one act: new sessions on that provider start on this account, and EVERY RUNNING
// SESSION on that provider that is not PINNED to an account moves to it. Pinned means a saved agent
// definition or a workflow step set to a specific account; those stay where they are pinned.
//
// THE MOVE IS IN PLACE on both providers, at each session's next request: an idle session's next turn
// runs on the new account, and a busy session's model call after the step in flight does — a running
// tool finishes and is never repeated — with no hold, interrupt, copy, resume or `continue`. On Claude
// Code the daemon sends each such session `apply_flag_settings` pointing `CLAUDE_SECURESTORAGE_CONFIG_DIR`
// at the new account's credential store, and the provider re-reads the store at its next request; the
// daemon never reads or copies a Claude credential. On Codex every session that follows the current
// account runs in the one Codex service the daemon keeps for the current account, which runs on tokens
// the daemon hands it, and the switch is one `account/login/start {type: "chatgptAuthTokens"}` on that
// service with the new account's tokens, which the daemon holds only in its own memory and never
// stores, logs, shows or hands to a renderer. Each session's cost splits at the switch's
// acknowledgment: requests before it stay on the old account, requests after it go to the new one.
// Every supported version moves in place, and no version is checked: there is no second way to move a
// session's account. The move lands at the acknowledgment and writes no pending switch, so the
// working line shows no waiting words for it.
//
// Each move settles on its own session with `agent.provider_binding_changed` (orchestration-payloads.md §Plan-013),
// `continuity: "in_place"`: one faint collapsed row at the point of the move,
// `Switched all sessions to <name>` (the account as the Providers page lists it), opening to the account
// it came from, the account it went to and the time. A move that fails settles with
// `agent.provider_binding_change_failed`, reason `account_unavailable`: the session stays on the
// account it had — where the new login fails at the next request, the daemon hands the previous
// account back — and the transcript gains one system message naming the switch and the reason.
// Those events are the settlement; this reply is not. A session at a level its new account cannot run
// (`Reviewed` on a Claude Code account whose plan lacks auto mode) moves with the rest and runs at
// `Ask`; it gains one `session.notice` of kind `level_unavailable` naming the level it left, whose
// flow row reads "Reviewed isn't available on this Claude Code account". Nothing is blocked.
//
// NO PER-SESSION SWITCH VERB EXISTS. `agent.configUpdate` carries no account member (orchestration-payloads.md §Plan-013): one
// control setting one fact is what stops a session sitting on an account the provider surface says
// it is not on. Nothing here copies a credential or a conversation between homes, and the provider's
// own login in each home is left exactly as it is.
//
// REFUSES IN PLACE where the named account fails the fail-closed spawn validation, or where its last
// limits read showed a dead login (Claude Code's read answering `rate_limits_available: false`): the
// current mark does not move, no session moves, and the refusal carries that account's own remedy.
interface ProviderAccountSetCurrentRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountSetCurrentResponse {
  account: ProviderAccount; // the account now current for its provider
  // The sessions the daemon is moving, each at its next request, so the caller knows the press
  // reached live work rather than only the registry. It is NOT a settlement: each move settles on
  // its own session's transcript. A press that reached no running session carries an empty array,
  // which is a claim that nothing was live rather than an absence of information.
  movingSessions: Array<{
    sessionId: SessionId;
  }>;
}

// Rebuilds this account's credential home from empty so the person can authenticate into it
// again — the remedy the provider-failure runbook issues when a home is absent or husked (present
// but holding no usable credential). It is a credential-home lifecycle transition under I-023-2,
// so it BUMPS `credentialGeneration`; the generation is never reset by it, which is what lets a
// stale consumer still order two readings across the rebuild. Identity survives untouched:
// `accountId` is the same afterward, so the account keeps its spend history. Its stored quota
// readings are kept for the same reason and are NOT cleared — the provider-side allowance kept
// running while the home was empty — but each carries the generation it was observed under, so a
// consumer renders a pre-rebuild reading as stale. The stored health pair is the opposite case:
// the bump invalidates it, which is why `healthState` is returned here.
interface ProviderAccountResetCredentialHomeRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountResetCredentialHomeResponse {
  accountId: ProviderAccountId;
  credentialGeneration: number; // the post-reset generation; strictly greater than the pre-reset value
  healthState: ProviderAccountHealthState; // expected `reauth_required` until the person authenticates
}

// `Check now`: the same limits read the background observer runs, taken at once when the account's
// last read is at least 60 seconds old and otherwise answered with that last read; the 60-second
// floor is the daemon's, so no surface runs a timer of its own.
interface ProviderAccountProbeRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountProbeResponse {
  accountId: ProviderAccountId;
  healthState: ProviderAccountHealthState;
  credentialGeneration: number; // the generation the probe observed; a later bump invalidates this reading
}

// The one-time memory import: copies the person's own ambient memory store — Claude Code's
// `~/.claude/projects/*/memory/`, Codex's `~/.codex/memories/` — into THIS account's credential home,
// once, on the person's press. On Claude Code it also copies the person's own agent notes,
// `~/.claude/agent-memory/<name>/`, into the daemon's one agent-memory folder
// (`~/.ai-sidekicks/agent-memory/<name>/`), never overwriting a file that is there, and counts them
// in the same figure; that folder is shared by every account because an agent's notes belong to the
// agent. The two homes are never joined, no symbolic link is followed out of a source folder, and a
// repeat call answers the recorded outcome. The outcome is also written to the account
// (`ProviderAccount.memoryImport`) and published as `account_changed`.
interface ProviderAccountMemoryImportRequest {
  accountId: ProviderAccountId;
}
type ProviderAccountMemoryImportResponse =
  | { outcome: "imported"; count: number; importedAt: string }
  | { outcome: "nothingToImport" };

// The service's own per-turn usage table, summed: each row names the account that paid for its turn,
// its model, its tokens and its cost in integer micro-dollars. It answers one account's tokens for a
// day or a week and the same figures by day and by model, and a provider's figures summed across its
// accounts. Every figure is the service's own — no provider report of totals, streaks or peak days is
// read — so it never disagrees with the usage windows beside it by counting something different.
type ProviderAccountUsageReadRequest = (
  | { accountId: ProviderAccountId }
  | { provider: "claude" | "codex" }
) & {
  from: string; // RFC 3339 UTC, inclusive
  to: string; // RFC 3339 UTC, exclusive
  groupBy: "day" | "model";
};
interface ProviderAccountUsageReadResponse {
  rows: Array<{
    day?: string; // present when grouped by day: the calendar date on this machine's clock
    modelId?: string; // present when grouped by model
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsdMicros: number;
  }>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsdMicros: number;
  };
}

// Brokered interactive sign-in (ADR-026 D1; Spec-025 §Brokered interactive sign-in). The daemon
// constructs the invocation, spawns the provider's UNMODIFIED binary with this account's home
// pinned, and reads nothing the flow writes. What returns is what the provider emits for the
// PERSON to act on, plus an opaque daemon-minted attempt id. It is deliberately NOT a shell
// string: the request names only the account, the daemon authors the invocation itself, and no
// client-supplied string is ever executed.
//
// SHAPE MIRRORS THE PROVIDER'S OWN, deliberately: the pinned Codex login-start returns either an
// authorization URL or a device code with its verification URL, and the pinned Claude flow prints
// a URL and accepts a pasted code. A provider arm emitting neither cannot be brokered and is
// refused `provideraccount.signin_unsupported` rather than spawning a flow the person cannot
// finish. A second start against an account with one in flight is refused
// `provideraccount.signin_in_flight` — at least one pinned provider holds exactly ONE active login
// slot and SILENTLY DROPS the previous attempt, which would strand the person mid-flow on another
// device with no signal that their code had stopped working.
interface ProviderAccountLoginRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountLoginResponse {
  attemptId: string; // opaque, daemon-minted, single-use; the correlation key for cancel and for completion
  verificationUri: string; // where the person completes the flow — the provider's own URL, verbatim
  userCode?: string; // present on a device-code arm; the person types it at `verificationUri`
  expiresAt?: string; // RFC 3339 UTC, where the provider bounds the attempt; null/absent = the provider published no bound. A whitelisted field (Spec-025 §Brokered interactive sign-in), admitted under the same parse-and-validate rule as the others: parsed to an RFC 3339 instant, required to be in the future and within the provider's documented attempt ceiling, and OMITTED rather than surfaced where it fails either test. It is a bound on an attempt, not provider state — it carries no OAuth, PKCE, or credential field.
}

// Cancellation is a FIRST-CLASS OUTCOME, not an abandonment: a broker that could only be abandoned
// would leave a provider-side login slot occupied until it timed out. `notFound` is the honest arm
// for an attempt that already completed, already canceled, or never existed — it is NOT an error,
// because a client racing a completion should not see a refusal for having lost the race.
interface ProviderAccountLoginCancelRequest {
  attemptId: string;
}
interface ProviderAccountLoginCancelResponse {
  status: "canceled" | "notFound";
}

// Read-shaped live tail of registry changes for this node (Plan-005 streaming primitive, the
// `session.subscribe` consumer shape). It carries a WIRE-ONLY notification and NEVER an
// `EventEnvelope`: the provider-account registry is un-evented by design (Spec-025 §State And Data
// Implications), because an account act on the machine's registry has no session to
// belong to and minting a session event type for it would put node administration into a session's
// audit log. So no Spec-005 event type is minted here and the taxonomy census does not move.
//
// This is where a brokered sign-in's completion arrives. Ordering matches `mcp.subscribe`'s: a
// client opens the subscription BEFORE calling `providerAccount.login`, so registration is live
// before the flow starts and a completion concurrent with the call arrives on the stream rather
// than falling between them. Re-observation is harmless — every notification is a re-entrant state
// update, not a delta.
interface ProviderAccountSubscribeRequest {}
type ProviderAccountSubscribeStream = AsyncIterable<ProviderAccountNotification>;

type ProviderAccountNotification =
  | { kind: "account_changed"; account: ProviderAccount } // registered, corrected, default moved, or a stored reading rewritten by ANY of its writers
  | { kind: "account_removed"; accountId: ProviderAccountId }
  // Correlated on `attemptId`. `succeeded` is a report FROM THE PROVIDER that its flow finished —
  // it is NOT itself a reading that the account is authenticated. The daemon takes an ordinary
  // health observation next and publishes the result as `account_changed`; a client that treats
  // this notification as the authentication verdict will render an account as ready that a spawn
  // would refuse. `failureReason` is message text shown to the person and carries NO credential
  // material, no provider error body verbatim, and no home path.
  | {
      kind: "login_completed";
      attemptId: string;
      accountId: ProviderAccountId;
      outcome: "succeeded" | "failed" | "canceled";
      failureReason?: string;
    }
  // The outer `accountId` is the ROUTING key and `window.accountId` is part of the reading itself.
  // Both are carried deliberately — the list reply's `usageWindows` entries carry the same member, so
  // a live update and a snapshot row key alike — and they MUST be EQUAL. A notification whose reading
  // names a different account than its routing key is not a routable update in either direction: a
  // consumer keying off the outer member files the reading under an account it does not describe, and
  // one keying off the inner member ignores the routing the daemon performed. Enforced at the parse
  // boundary rather than left to each consumer to re-check, and refused against `window.accountId`,
  // which is the half that contradicts the envelope it arrived in.
  | {
      kind: "usage_window_updated";
      accountId: ProviderAccountId;
      window: ProviderAccountUsageWindow;
    };

// The newest quota reading for one `(accountId, limitId)` pair — the wire mirror of
// `provider_account_usage_windows` (Spec-025 §Per-limit provider quota).
//
// `limitId` IS THE KEY, and `windowMins` is an attribute of the reading rather than part of its
// identity: the pinned Claude surface publishes several limits at once of which more than one share
// a 10080-minute window, so a `(account, windowMins)` key silently collapses them and the survivor
// depends on arrival order. A reading naming no limit takes the reserved id `default`, so a
// provider publishing one window needs no special case and the single-window shape stays valid as
// the degenerate case.
//
// WHERE EACH LEG'S `limitId` COMES FROM. On the Claude leg the windows are read from the
// `get_usage` reply's `limits[]` list, and a `limitId` is that entry's kind together with the model
// display name where the entry is scoped to a model — one model's weekly window is a different
// limit from another's and from the account-wide weekly window over the same length. The FLAT
// per-model keys beside that list answer null and are NEVER read: a design keyed on them renders an
// empty per-model window for an account with real per-model usage. On the Codex leg the windows are
// the keys of the reply's `rateLimitsByLimitId` map, which are the provider's own metered ids.
//
// `windowMins` IS WHAT NAMES THE WINDOW, and its POSITION in the provider's reply never is. A Codex
// limit id carries a primary and a secondary window and the provider has moved a given window
// between those slots, so a surface that read the primary slot as "the short window" would relabel
// every bar the day that moved. Key on the id; label from the length.
//
// COMPLETENESS RIDES `source`, and the prune rule turns on it. A `probe`-source reading set is the
// account's WHOLE standing and replaces the stored set for that account; a `run`-source reading is
// the provider's own sparse push and is merged into it, pruning no window it does not name. Without
// the distinction one sparse push would delete every window it happened not to mention.
interface ProviderAccountUsageWindow {
  // Which account this window describes. Required, and NOT inferable from position: the read
  // returns one flat array across every registered account, and two accounts of one provider can
  // publish the same `limitId`, so without this a reconnecting client cannot associate a durable
  // window with its account and would be free to render one account's quota under another's name.
  // The live `usage_window_updated` notification already carries it; the snapshot carries the same
  // member so both paths key alike.
  accountId: ProviderAccountId;
  limitId: string; // untrusted provider-adjacent string, `wireFreeFormString`-bounded; NOT a closed union — the provider's limit vocabulary is open and versioned
  windowMins: number;
  label?: string; // the provider's own display label where it publishes one; display-only, never parsed, never a key
  usedPercent: number; // NOT clamped to 100 on the wire: a provider may report over-consumption against a soft limit and clamping would misreport it. Renderers clamp for display.
  resetsAt?: string; // RFC 3339 UTC where the provider supplies it; absent = unknown, never "now" and never "never"
  observedAt: string; // RFC 3339 UTC. THE ORDERING KEY: newest `observedAt` wins per `(accountId, limitId)`, and `source` breaks ONLY exact ties. Ordering by arrival, or by preferring one source, would let a stale reading mask real consumption. It is ALSO the read time the surface renders beside the figure: a percentage with no read time invites a reader to plan against a number that on an idle account will be hours old.
  observedCredentialGeneration: number; // the account's `credentialGeneration` when this reading was taken — the same member `usage.rate_limit_update` carries. A credential-home rebuild does NOT clear stored readings (the provider-side allowance keeps running while the home is empty), so a renderer compares this against `ProviderAccount.credentialGeneration` and renders a behind-generation reading as STALE rather than current. The stored health pair is the opposite case: a bump invalidates it outright.
  source: "probe" | "run"; // the deliberate limits read, or the account-scoped quota event from real traffic. The background observer performs THE SAME limits read on its cadence (Spec-025 §Credential-home health observation), so a reading it took is recorded as `probe`: it is another caller of one read, not another provenance — and so is the turn-end read the daemon sends to a live Claude process, which is the same read asked of a process that already exists. The Codex leg's rolling push with a turn is the `run` value. The two values also differ in COMPLETENESS, which is what the prune rule turns on — a `probe` reading describes the account's whole standing and replaces the stored set, while a `run` reading is the provider's own sparse push and is merged into it, pruning nothing it does not name.
}
```

**Provider readiness.** `providerAccount.list` answers the registry question and the admissibility question in one reply, because a client that had to ask them separately would be free to combine them differently from admission. `readiness` is a **derivation**, not a stored second opinion: resolve the provider's default account, then report that account's stored health verbatim, with the two registry-shape arms standing in where resolution never reaches an account. No client re-derives it from `accounts` — a surface that recomputes readiness from account fields is the defect this member exists to remove, since the recomputed answer is the one nothing enforces. `authenticated` is a statement about the last observation and not a grant: a run bound to an `authenticated`-reading account still refuses at spawn if the home has since been signed out, and `indeterminate` is rendered as undetermined rather than as a sign-in failure.

**Run-start selection.** Which account a run pays from is **resolved by the daemon and never supplied by a client**: the account pinned by the run's saved agent definition or workflow step where one pins, and otherwise the provider's current account. The resolved value rides the driver's session-creation and resume parameter shapes as `providerAccountId` ([Spec-004 §Interfaces And Contracts](../../specs/004-provider-driver-contract-and-capabilities.md#interfaces-and-contracts)) and is stamped server-side as `admittedProviderAccountId` on the run's admission record. No wire request carries an account per session or per run, so there is no per-run override to authorize and a client-supplied stamp is ignored. Resume rebinds to the account the session was last on rather than re-resolving whichever account is current now, so a restart never moves billing. Moving the current account DOES move a live session, in place at its next request (`providerAccount.setCurrent` above): the usage rows before the switch's acknowledgment name the old account and the rows after it the new one, so the receipt's per-paying-account key stays exact and a session that moved mid-way yields two account rows summing to the same total.

**Switching a live session's account is `providerAccount.setCurrent` and nothing else.** A session starts on its provider's current account — the one marked current at the moment the session is minted — and moves when that mark moves: in place at its next request, and a session pinned to an account not at all. The verb's own comment above states the mechanism. `agent.configUpdate` carries no account member (orchestration-payloads.md §Plan-013), so there is no per-session account switch and nothing for a client to reconcile between two controls; an account move writes no pending switch, and it settles with the same binding events as every other switch. The console's account word on the provider surface presses this verb; the session inspector's account fact reads which account the session is on and carries no control.

**The one-time memory import is `providerAccount.memoryImport`.** Each account row offers to copy the person's own ambient memory store into THAT account's credential home, once, on a press: after it the row reads how many were copied and when, and an account with nothing to copy settles into saying so and offers the press no more. The two homes are never joined, and the copy is the person's act rather than a background sweep. Its payload pair is `ProviderAccountMemoryImportRequest` / `ProviderAccountMemoryImportResponse` above, and the outcome it records is `ProviderAccount.memoryImport`.

**The provider's own standing rules are `provider.standingRuleList` and `provider.standingRuleRevoke`.** Each provider keeps rules of its own that allow or refuse a command on this machine; they are read from and revoked in the provider's own files, the same files the session inspector's `approval.ruleList` and `approval.ruleRevoke` read for one session, so one rule has one place: the provider's. The `provider` root sits beside `providerAccount`, because a machine-wide page cannot use the `driver.*` reads, which need an active session.

```ts
// provider.standingRuleList — one row per rule, in the provider's own words, read from every account
// home and every attached project: on Codex the `.rules` files under each account home and each
// trusted project's `.codex/rules/` (loaded only once the project is trusted); on Claude Code the
// `permissions` of its user-level, project and project-local settings files. A provider holding none
// answers an empty list, which the page reads as saying so.
interface ProviderStandingRuleListRequest {
  provider?: "claude" | "codex";
}
interface ProviderStandingRuleListResponse {
  rules: Array<{
    ruleId: string; // daemon-minted, stable while the rule's file and text are unchanged
    provider: "claude" | "codex";
    text: string; // the rule as the provider's file spells it
    effect: "allow" | "deny";
    scope:
      | { kind: "accountHome"; accountId: ProviderAccountId }
      | { kind: "project"; projectId: ProjectId };
    sourcePath: string; // the file it came from; display-only data, never a capability
  }>;
}

// provider.standingRuleRevoke — removes the rule where the provider keeps it, and the provider follows
// the change as it does on its own: Claude Code from its next tool call, and Codex in each conversation
// it loads after the change, a loaded Codex conversation keeping the rules it loaded with, which is
// Codex's own behavior. The daemon adds nothing over the provider's rules: no copy, no hash, no check.
interface ProviderStandingRuleRevokeRequest {
  ruleId: string;
}
interface ProviderStandingRuleRevokeResponse {
  ruleId: string;
  revoked: true;
}
```
