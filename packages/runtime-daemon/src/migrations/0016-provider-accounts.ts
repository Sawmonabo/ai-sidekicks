// Plan-029 T1.2 + T1.4 — version-16 migration: the node-local provider-account
// registry and its per-limit quota-window store.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. Both tables and both indexes are transcribed from
// `docs/architecture/schemas/local-sqlite-schema.md` §"Provider Account Tables
// (Plan-029)" — same direction of authority `0007-pii-participant-id.ts` and
// `0013-content-payload.ts` state: the schema doc defines the columns, the
// constraints, and the defaults; this file applies them. Change the doc first,
// then mirror it here.
//
// DRIFT CHECK. To compare this constant against those two fenced blocks: strip
// the doc's markdown backticks (this constant is a template literal, so an
// unescaped backtick would end the string, and no migration in this directory
// escapes one -- every shipped migration writes identifiers bare inside SQL
// comments), then ignore this file's own scaffolding, which the doc has no
// counterpart for: the `-- Owner: ... | Migration: ...` provenance line, the two
// `-- ---` section banners, and the trailing `schema_version` INSERT. After
// those, exactly one difference remains, and it is deliberate: the doc's
// identity-column comment closes with three lines recording WHEN the three
// observed-identity columns were added and which review found them missing.
// That is corpus provenance rather than a constraint on the column, so the
// comment here stops at "never carried on an error."
//
// ----------------------------------------------------------------------------
// Why one ordinal for two tables and every column
// ----------------------------------------------------------------------------
//
// The registry has never shipped. Its column set grew across three amendments —
// the stored health pair, the observed-authentication and issuance columns, and
// the provider-reported identity trio — and the quota table arrived with the
// last of them, but none of that growth touched a released database, so there
// is no prior ordinal to amend and no migration to supersede. A second ordinal
// here would record a history the schema never had.
//
// Atomicity is what makes the pairing correct rather than merely convenient:
// `provider_account_usage_windows.account_id` carries a
// `REFERENCES provider_accounts(account_id) ON DELETE CASCADE`, so a torn apply
// that landed the child without its parent would leave every window insert
// failing — and, because SQLite resolves foreign-key targets at DML time rather
// than at CREATE time, failing as `no such table` at the first write rather than
// at migration time.
//
// ----------------------------------------------------------------------------
// What this script stores, and what it deliberately cannot
// ----------------------------------------------------------------------------
//
// NO CREDENTIAL MATERIAL, in any column of either table — no token, no refresh
// token, no cookie, no keystore payload. Credentials live inside the per-account
// credential home, owned and written by the provider's own tooling; the sealed
// ADR-028 D2 token lives in the ADR-021 ladder's store. There is therefore no
// column here to leak, to log, or to shred.
//
// The four constraints that make an invariant unrepresentable rather than merely
// intended:
//   * `provider_accounts_one_default_per_provider` — a PARTIAL unique index, so
//     two concurrent set-default calls on one provider cannot both commit. In
//     application code both writers would read "no other default" and both would
//     write one, and the ambiguity would be resolved silently at the next spawn
//     by whichever row sorted first — binding a run, and its spend, to an
//     account the operator did not choose.
//   * `provider_accounts_unique_credential_home` — a TOTAL unique index, so two
//     accounts cannot name one home. The daemon builds each spawn environment
//     from this path, so a duplicate reduces per-account isolation to a naming
//     convention: one account's re-authentication rewrites the other's
//     credentials in place, and spend keyed to two identities is drawn from one.
//   * the table-level `CHECK ((health_state IS NULL) = (health_observed_at IS
//     NULL))` — the stored observation is a PAIR. A reading with no observation
//     time cannot answer "when", and an observation time with no reading is a
//     timestamp for nothing; either half-populated row would make the readiness
//     projection serve an incoherent observation.
//   * `CHECK(credential_generation >= 1)` — the floor the DEFAULT alone only
//     asserts. A zero or negative generation sorts BEFORE a freshly registered
//     account, so a reading stamped with one would read as newer than the
//     account it describes and invert the staleness comparison it exists for.
//
// Ordering against every earlier version is FREE: both tables are new, neither
// is referenced by any earlier migration's `REFERENCES` clause, and no earlier
// table is read, rebuilt, or backfilled here. The ordinal is an append position,
// not a dependency.
//
// Spec coverage: `Spec-029 §State And Data Implications`,
// `Spec-029 §The account registry`, `Spec-029 §Per-limit provider quota`.
// Refs: Plan-029 T1.2, T1.4, I-029-1, I-029-2, I-029-5, I-029-13.

export const PROVIDER_ACCOUNTS_MIGRATION_SQL: string = `
-- Owner: Plan-029 | Migration: 0016-provider-accounts.ts (Tier 4 Phase 1)

-- ---------------------------------------------------------------------------
-- provider_accounts: the node-local registry of accounts this runtime node may
-- execute against. One row per registered account. Stores NO credential material
-- of any kind: credentials live inside the per-account credential home, owned and
-- written by the provider's own tooling, so there is no column here to leak, log,
-- or shred.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_accounts (
  account_id            TEXT PRIMARY KEY,  -- daemon-minted opaque immutable identity; never derived from credential material (Spec-029 §Account identity and credential generation)
  provider              TEXT NOT NULL
                        CHECK(provider IN ('claude', 'codex')),  -- the same closed driver-id union the MCP governance tables use
  display_label         TEXT NOT NULL,  -- operator-chosen label for disambiguation in the UI; free text, treated as participant-adjacent PII (Spec-022 §PII Data Map)
  credential_home_path  TEXT NOT NULL,  -- absolute path to this account's isolated credential home; the daemon constructs the spawn environment from it and never inherits ambient provider credentials (I-029-4)
  credential_generation INTEGER NOT NULL DEFAULT 1
                        CHECK(credential_generation >= 1),  -- monotonic, starts at 1; bumped at every credential-home lifecycle transition (I-029-2). The CHECK makes the floor enforced rather than asserted: a zero or negative generation sorts BEFORE a freshly registered account, so a reading stamped with one would read as newer than the account it describes and invert the staleness comparison the stamp exists for.
  billing_mode          TEXT NOT NULL
                        CHECK(billing_mode IN ('subscription', 'metered', 'unknown')),  -- how this account is charged; unknown is the honest-absence arm, never a synonym for metered; drives cost labeling, never cost derivation (Spec-029 §Billing mode)
  is_default            INTEGER NOT NULL DEFAULT 0
                        CHECK(is_default IN (0, 1)),  -- exactly one default per provider, enforced by the partial unique index below
  health_state          TEXT
                        CHECK(health_state IS NULL OR health_state IN ('authenticated', 'reauth_required', 'home_missing', 'indeterminate')),  -- the STORED outcome of the last validation of this account: the driver's authentication probe reading together with the credential-home observation taken at that same moment. NULL until a probe has ever been taken, which the wire renders as indeterminate — NOT as a failure and never as authenticated (I-029-9, I-029-10). This is the column the readiness projection reads; a registry read never re-derives it, so a read spawns no provider process and opens no credential file (Spec-029 §Node provider readiness and the sign-in handoff).
  health_observed_at    TEXT,  -- RFC 3339 UTC of the observation health_state records, written by the same act. NULL exactly when health_state is NULL, so the pair is set and cleared together; surfaced as ProviderReadiness.observedAt so a caller can apply its own age test. Deliberately NOT updated_at, which is NOT NULL and moves on any row mutation — a relabel would report an operator's display-label edit as a fresh authentication observation.
  observed_auth_mode    TEXT
                        CHECK(observed_auth_mode IS NULL OR observed_auth_mode IN ('oauth_subscription', 'oauth_token', 'api_key', 'external', 'none', 'unknown')),  -- the authentication mode the provider's OWN status surface reports for this home, OBSERVED and never assumed (Spec-029 §Non-interactive token registration). NULL until observed; unknown is the distinct arm for "observed, but the provider named a mode this daemon does not recognize" — a tolerant arm so a vendor adding a mode does not fail an observation closed. oauth_token is the ADR-028 D2 class and is what admits a token-mode account; the token VALUE is not here and is in no column of any table (Spec-029 §State And Data Implications).
  last_refresh_observed_at TEXT,  -- RFC 3339 UTC of the most recent credential refresh the daemon has OBSERVED to have completed for this home, read from the provider's own durable marker where it publishes one. NULL = not observed, never "fine". Drives the freshness reading; the daemon never CAUSES a refresh to produce it (Spec-029 §Credential-home health observation).
  logged_in_at          TEXT,  -- RFC 3339 UTC of the moment this home's credential was ISSUED. On a brokered sign-in that is the observed completion, which the daemon witnessed. On a token-mode registration it is the token's ISSUANCE time — read from the provider's own status surface where it publishes one, else supplied explicitly by the operator — and is NOT the registration time: a token is minted out of band and may be registered months later, so anchoring here to registration would shift the horizon forward by the token's pre-registration age and could report a credential as good after it had expired. Where no issuance anchor exists the column stays NULL and the estimate renders as unknown; it is never defaulted to created_at. NULL also for a home imported by a registration that neither signed in nor supplied a token. The re-login horizon derived from it is MODE-DISPATCHED and is an ESTIMATE, never a fact: the interval belongs to the provider's issuance policy, which the daemon does not control and cannot verify.
  -- Provider-REPORTED account identity, surfaced by a health observation and stored so the
  -- management page can tell two accounts of the same provider apart by something truer than the
  -- operator's own label. Nullable and independently so: a provider may report any subset, and an
  -- absent value stays absent rather than defaulting. A later observation REPLACES these values
  -- (Spec-022 §PII Data Map, provider_accounts row); they are never logged, never evented, and
  -- never carried on an error.
  observed_account_email     TEXT,
  observed_account_org_id    TEXT,
  observed_account_org_name  TEXT,
  removal_intent        INTEGER NOT NULL DEFAULT 0
                        CHECK(removal_intent IN (0, 1)),  -- the durable half of the cross-store removal protocol (Spec-029 §Non-interactive token registration). The registry row and the sealed token are SEPARATE DURABILITY DOMAINS — SQLite and the OS keystore commit independently — so removal marks intent here FIRST, then destroys the secret, then deletes the row. A crash mid-sequence therefore strands a row already marked unusable rather than a live credential nobody can see. Admission REFUSES any account whose row is intent-marked, and daemon-start reconciliation completes every marked row and destroys every sealed value matching no row. Not a status enum: the row's other states are already carried by health_state, and folding removal into that column would let an observation overwrite an in-flight removal.
  probe_enabled         INTEGER NOT NULL DEFAULT 1
                        CHECK(probe_enabled IN (0, 1)),  -- per-account opt-out for the background health observer (Spec-029 §Credential-home health observation). Default-on, because an account nobody observes is an account whose stored reading silently ages; durable rather than in-memory, so a restart does not resume observing an account the operator silenced. Opting out suppresses the OBSERVER only: the deliberate probe verb and spawn validation still write the pair, because both are acts the operator or a run explicitly asked for.
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- The stored observation is a PAIR, and the pair is enforced rather than asserted: a reading with
  -- no observation time cannot answer observedAt, and an observation time with no reading is a
  -- timestamp for nothing. Either half-populated row would make the readiness projection serve an
  -- incoherent observation, so the database refuses both instead of leaving it to every writer.
  CHECK ((health_state IS NULL) = (health_observed_at IS NULL))
);

-- Exactly one default account per provider (I-029-5). A partial unique index rather than
-- application-level enforcement: two concurrent set-default calls racing on the same provider
-- would both read "no other default" and both write one, and the resulting ambiguity would be
-- resolved silently at the next spawn by whichever row sorted first — binding a run, and its
-- spend, to an account the operator did not choose. The database refuses the second writer instead.
CREATE UNIQUE INDEX provider_accounts_one_default_per_provider
  ON provider_accounts(provider)
  WHERE is_default = 1;

-- Exactly one account per credential home, across every provider (I-029-8). Two rows sharing a
-- home share its credentials: the daemon builds each spawn environment from this path, so a
-- duplicate reduces per-account isolation to a naming convention — one account's re-authentication
-- rewrites the other's credentials in place, and spend keyed to two identities is drawn from one.
-- Deliberately NOT scoped per provider: two providers pointed at one home is the same collision,
-- and the path is what the spawn environment carries either way. The database refuses the second
-- writer instead.
CREATE UNIQUE INDEX provider_accounts_unique_credential_home
  ON provider_accounts(credential_home_path);

-- ---------------------------------------------------------------------------
-- provider_account_usage_windows: the newest quota reading per account and limit.
-- A provider's quota standing is NOT one window -- the pinned Claude surface
-- publishes five limit identifiers, three of which share a 10080-minute window, so
-- a key of (account, window length) cannot hold them: two of the three would
-- overwrite the third and the survivor would depend on arrival order.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_account_usage_windows (
  account_id    TEXT NOT NULL
                REFERENCES provider_accounts(account_id) ON DELETE CASCADE,  -- a window reading has no meaning without its account; deregistering an account takes its readings with it
  limit_id      TEXT NOT NULL,  -- the provider's own limit identifier, carried verbatim as an untrusted provider-adjacent string. A reading that names no limit takes the reserved value 'default', so a provider publishing a single window needs no special case and the pre-Spec-029 single-window shape stays valid as the degenerate case (Spec-029 §Per-limit provider quota). NOT enumerated by a CHECK: the provider's limit set is an open, versioned vocabulary and a closed CHECK would fail a reading closed the moment a vendor adds a window.
  window_mins   INTEGER NOT NULL,  -- the reading's window length in minutes. An ATTRIBUTE, not part of the key: within one provider the limit identifier determines the length, so keying on both would admit two rows for one limit with different lengths — the same incoherence the health-pair CHECK above exists to refuse.
  label         TEXT,  -- the provider's own display label for this window where it publishes one; NULL where it does not. Display-only, never parsed, never a key.
  used_percent  REAL NOT NULL
                CHECK(used_percent >= 0),  -- utilization at observed_at. NOT capped at 100: a provider may report over-consumption against a soft limit, and clamping would silently misreport it. The renderer clamps for display; the store records what was observed.
  resets_at     TEXT,  -- RFC 3339 UTC when this window resets, where the provider supplies it; NULL where it does not. NULL means unknown, never "now" and never "never".
  observed_at   TEXT NOT NULL,  -- RFC 3339 UTC of the reading. This is the ordering key: where two readings key alike the later observed_at is current, and source breaks only exact ties. Ordering by arrival or by a source preference would let a stale reading mask real consumption.
  observed_credential_generation INTEGER NOT NULL,  -- the account's credential_generation when this reading was taken, mirroring the member the account-scoped quota event already carries. A credential-home rebuild does NOT delete these rows — a quota window describes the provider-side allowance, which keeps running while a home sits empty — so this stamp is what lets a consumer render a pre-rebuild reading as stale rather than as current (Spec-029 §Per-limit provider quota). Contrast the health pair on the parent row, which a generation bump invalidates outright, because that pair describes the home itself.
  source        TEXT NOT NULL
                CHECK(source IN ('probe', 'run')),  -- which sanctioned source produced the reading: the deliberate probe verb, or the account-scoped quota event emitted from real traffic. The background health observer is NOT a source and no third value exists, because reading quota on one pinned provider leg traverses a path documented to refresh proactively — which Spec-029 §Credential-home health observation forbids the observer to do.
  PRIMARY KEY (account_id, limit_id)
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (16, datetime('now'), 'Provider-account registry + per-limit quota windows (provider_accounts, provider_account_usage_windows)');
`;
