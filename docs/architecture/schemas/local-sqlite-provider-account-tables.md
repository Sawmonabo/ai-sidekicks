# Provider Account Tables (Plan-023)

The provider account tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

Node-local registry of the provider accounts this runtime node may execute against, for [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md). One row per registered account. The table stores **no credential material of any kind** — no token, no refresh token, no cookie, no keychain payload. Credentials live inside the per-account credential home, owned and written by the provider's own tooling; the daemon brokers refresh without ever holding the values, so there is no credential column here to leak, log, or delete. What is stored is the identity of an account, where its home lives, and how it bills.

`account_id` is daemon-minted, opaque, and immutable. It is deliberately **not** derived from credential material, an email address, or any provider-side subject identifier: those rotate, and an identity that rotates cannot key historical spend. `credential_generation` is a monotonic integer bumped at every credential-home lifecycle transition (initial authentication, re-authentication, revocation, home rebuild). The pair `(account_id, credential_generation)` is the account-scoped reading key — a quota reading or usage-limit signal taken under one generation must not be read as current after a re-authentication, which is exactly what the generation makes detectable.

```sql
-- Owner: Plan-023
CREATE TABLE provider_accounts (
  account_id            TEXT NOT NULL PRIMARY KEY,  -- daemon-minted opaque immutable identity; never derived from credential material (Spec-025 §Account identity and credential generation). A NULL identity would key nothing — `(account_id, credential_generation)` would be unmatchable, the child table's `ON DELETE CASCADE` would never fire for it, and the credential home derived from it could not be attributed back — and a `STRICT` table's PRIMARY KEY column cannot hold NULL, which the explicit `NOT NULL` states.
  provider              TEXT NOT NULL
                        CHECK(provider IN ('claude', 'codex')),  -- the same closed driver-id union the MCP governance tables use
  display_label         TEXT,  -- the name the person typed, present only on an account added from a pasted token or API key, where it is required; NULL on every other account, which its provider-reported identity names (Spec-025 §The account registry). Treated as personal data. Unique per provider ignoring case and surrounding spaces, by the index below
  credential_home_path  TEXT NOT NULL,  -- absolute path to this account's isolated credential home; the daemon constructs the spawn environment from it and never inherits ambient provider credentials (I-023-4)
  credential_generation INTEGER NOT NULL DEFAULT 1
                        CHECK(credential_generation >= 1),  -- monotonic, starts at 1; bumped at every credential-home lifecycle transition (I-023-2). The CHECK makes the floor enforced rather than asserted: a zero or negative generation sorts BEFORE a freshly registered account, so a reading stamped with one would read as newer than the account it describes and invert the staleness comparison the stamp exists for. A fractional generation never reaches the column: a `STRICT` INTEGER column stores `2.0` and `'3'` as integers and refuses `1.5`, so a monotonic counter cannot become divisible.
  billing_mode          TEXT NOT NULL
                        CHECK(billing_mode IN ('subscription', 'metered', 'unknown')),  -- how this account is charged; `unknown` is the honest-absence arm, never a synonym for metered; drives cost labeling, never cost derivation (Spec-025 §Billing mode)
  is_default            INTEGER NOT NULL DEFAULT 0
                        CHECK(is_default IN (0, 1)),  -- the provider's CURRENT account: the one a new run starts on, and the one a press on the Providers page moves, which carries every running session on that provider that is not pinned to an account with it (Spec-025 §Moving a session to another account). Exactly one per provider, enforced by the partial unique index below. The column keeps the `default` spelling the wire keeps in `isDefault` and in the `no_default` readiness arm, so the flag has one name across the schema and the payloads
  health_state          TEXT
                        CHECK(health_state IS NULL OR health_state IN ('authenticated', 'reauth_required', 'home_missing', 'indeterminate')),  -- the STORED outcome of the last validation of this account: the driver's authentication probe reading together with the credential-home observation taken at that same moment. NULL until a probe has ever been taken, which the wire renders as `indeterminate` — NOT as a failure and never as authenticated (I-023-8, I-023-9). This is the column the readiness projection reads; a registry read never re-derives it, so a read spawns no provider process and opens no credential file (Spec-025 §Node provider readiness and the sign-in handoff).
  health_observed_at    TEXT,  -- RFC 3339 UTC of the observation `health_state` records, written by the same act. NULL exactly when `health_state` is NULL, so the pair is set and cleared together; surfaced as `ProviderReadiness.observedAt` so a caller can apply its own age test. Deliberately NOT `updated_at`, which is NOT NULL and moves on any row mutation — a relabel would report the person's display-label edit as a fresh authentication observation.
  observed_auth_mode    TEXT
                        CHECK(observed_auth_mode IS NULL OR observed_auth_mode IN ('oauth_subscription', 'oauth_token', 'api_key', 'external', 'none', 'unknown')),  -- the authentication mode the provider's OWN status surface reports for this home, OBSERVED and never assumed (Spec-025 §Non-interactive token registration). NULL until observed; `unknown` is the distinct arm for "observed, but the provider named a mode this daemon does not recognize" — a tolerant arm so a vendor adding a mode does not fail an observation closed. `oauth_token` is the ADR-026 D2 class and is what admits a token-mode account; the token VALUE is not here and is in no column of any table (Spec-025 §State And Data Implications).
  last_refresh_observed_at TEXT,  -- RFC 3339 UTC of the most recent credential refresh the daemon has OBSERVED to have completed for this home, read from the provider's own durable marker where it publishes one. NULL = not observed, never "fine". Drives the freshness reading. The daemon never touches the credential itself: what renews a login is the provider's own code running inside its own home, which the limits read on one leg causes as that provider's own side effect, and a renewal there is no lifecycle transition — it moves this column and never `credential_generation` (Spec-025 §Credential-home health observation).
  logged_in_at          TEXT,  -- RFC 3339 UTC of the moment this home's credential was ISSUED. On a brokered sign-in that is the observed completion, which the daemon witnessed. On a token-mode registration it is the token's ISSUANCE time — read from the provider's own status surface where it publishes one, else supplied explicitly by the person — and is NOT the registration time: a token is minted out of band and may be registered months later, so anchoring here to registration would shift the horizon forward by the token's pre-registration age and could report a credential as good after it had expired. Where no issuance anchor exists the column stays NULL and the estimate renders as unknown; it is never defaulted to `created_at`. NULL also for a home imported by a registration that neither signed in nor supplied a token. The re-login horizon derived from it is MODE-DISPATCHED and is an ESTIMATE, never a fact: the interval belongs to the provider's issuance policy, which the daemon does not control and cannot verify.
  -- Provider-REPORTED account identity, surfaced by a health observation. This IS an account's
  -- identity on every surface that names one — the address, the plan as the provider itself names it,
  -- and the organization where the plan has one — and only an account added from a pasted token or
  -- API key carries a typed `display_label` beside it: one address can hold two accounts on
  -- different plans, so the plan and the organization are part of telling them apart rather than
  -- decoration around an invented name. Nullable and independently so: a provider may report any
  -- subset, and an absent value stays absent rather than defaulting. A later
  -- observation REPLACES these values (Spec-020 §PII Data Map, `provider_accounts` row); they are
  -- never logged, never evented, and never carried on an error.
  observed_account_email     TEXT,
  observed_account_plan      TEXT,  -- the provider's own word for the plan, verbatim; distinct from billing_mode, which says how the account is paid for rather than which plan it is on
  observed_account_org_id    TEXT,
  observed_account_org_name  TEXT,
  removal_intent        INTEGER NOT NULL DEFAULT 0
                        CHECK(removal_intent IN (0, 1)),  -- the durable half of the cross-store removal protocol (Spec-025 §Non-interactive token registration). The registry row and the token's credential-store item are SEPARATE DURABILITY DOMAINS — SQLite and the operating system's credential store commit independently — so removal marks intent here FIRST, then destroys the secret, then deletes the row. A crash mid-sequence therefore strands a row already marked unusable rather than a live credential nobody can see. Admission REFUSES any account whose row is intent-marked, and daemon-start reconciliation completes every marked row and destroys every token item matching no row. Not a status enum: the row's other states are already carried by `health_state`, and folding removal into that column would let an observation overwrite an in-flight removal.
  probe_enabled         INTEGER NOT NULL DEFAULT 1
                        CHECK(probe_enabled IN (0, 1)),  -- per-account opt-out for the background health observer (Spec-025 §Credential-home health observation). Default-on, because an account nobody observes is an account whose stored reading silently ages; durable rather than in-memory, so a restart does not resume observing an account the person silenced. Opting out suppresses the OBSERVER only: the deliberate probe verb and spawn validation still write the pair, because both are acts the person or a run explicitly asked for.
  window_start_enabled  INTEGER NOT NULL DEFAULT 1
                        CHECK(window_start_enabled IN (0, 1)),  -- per-account switch for the one smallest turn the daemon spends at each window reset so the new window's clock starts then (Spec-025 §Credential-home health observation; `windowStartEnabled` on the wire). Default-on, and it sits UNDER `probe_enabled` rather than beside it: switching this off leaves the limits read running on its cadence, and switching `probe_enabled` off leaves this inert, so an account silenced for the observer spends nothing at a reset.
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- The stored observation is a PAIR, and the pair is enforced rather than asserted: a reading with
  -- no observation time cannot answer `observedAt`, and an observation time with no reading is a
  -- timestamp for nothing. Either half-populated row would make the readiness projection serve an
  -- incoherent observation, so the database refuses both instead of leaving it to every writer.
  CHECK ((health_state IS NULL) = (health_observed_at IS NULL))
);

-- Exactly one current account per provider (I-023-5) — the flag this schema calls `is_default` and
-- every surface calls the current account, one fact under two words. A partial unique index rather
-- than application-level enforcement: two concurrent `providerAccount.setCurrent` calls racing on
-- the same provider would both read "no other one" and both write one, and the resulting ambiguity
-- would be resolved silently at the next spawn by whichever row sorted first — binding a run, and
-- its spend, to an account the person did not choose, and leaving a press that moves live sessions
-- with two destinations. The database refuses the second writer instead.
CREATE UNIQUE INDEX provider_accounts_one_default_per_provider
  ON provider_accounts(provider)
  WHERE is_default = 1;

-- Exactly one account per credential home, across every provider (I-023-7). Two rows sharing a
-- home share its credentials: the daemon builds each spawn environment from this path, so a
-- duplicate reduces per-account isolation to a naming convention — one account's re-authentication
-- rewrites the other's credentials in place, and spend keyed to two identities is drawn from one.
-- Deliberately NOT scoped per provider: two providers pointed at one home is the same collision,
-- and the path is what the spawn environment carries either way. The database refuses the second
-- writer instead.
CREATE UNIQUE INDEX provider_accounts_unique_credential_home
  ON provider_accounts(credential_home_path);

-- One typed name per provider, compared ignoring case and surrounding spaces, where a name is
-- present: a second account of one provider with the same name is unrepresentable, and a register
-- or rename that would make one is refused `provideraccount.display_label_taken`.
CREATE UNIQUE INDEX provider_accounts_unique_display_label
  ON provider_accounts(provider, lower(trim(display_label)))
  WHERE display_label IS NOT NULL;
```

The newest quota reading per account and limit. A provider's quota standing is **not one window**: one pinned provider publishes **several distinct limits at a time, more than one of them over the same window length**, so a key of `(account, window length)` cannot hold them — the ones sharing a length would overwrite each other and the survivor would depend on arrival order. The limit identifier is therefore the key and the window length is an attribute of the reading, not part of its identity. Holding the newest reading durably is what lets a client that connects after a reading was taken render quota standing without waiting for the next one.

```sql
-- Owner: Plan-023
CREATE TABLE provider_account_usage_windows (
  account_id    TEXT NOT NULL
                REFERENCES provider_accounts(account_id) ON DELETE CASCADE,  -- a window reading has no meaning without its account; deregistering an account takes its readings with it
  limit_id      TEXT NOT NULL,  -- the provider's own limit identifier, carried verbatim as an untrusted provider-adjacent string. A reading that names no limit takes the reserved value 'default', so a provider publishing a single window needs no special case and the pre-Spec-025 single-window shape stays valid as the degenerate case (Spec-025 §Per-limit provider quota). NOT enumerated by a CHECK: the provider's limit set is an open, versioned vocabulary and a closed CHECK would fail a reading closed the moment a vendor adds a window.
  window_mins   INTEGER NOT NULL,  -- the reading's window length in minutes. An ATTRIBUTE, not part of the key: within one provider the limit identifier determines the length, so keying on both would admit two rows for one limit with different lengths — the same incoherence the health-pair CHECK above exists to refuse.
  label         TEXT,  -- the provider's own display label for this window where it publishes one; NULL where it does not. Display-only, never parsed, never a key.
  used_percent  REAL NOT NULL
                CHECK(used_percent >= 0),  -- utilization at `observed_at`. NOT capped at 100: a provider may report over-consumption against a soft limit, and clamping would silently misreport it. The renderer clamps for display; the store records what was observed.
  resets_at     TEXT,  -- RFC 3339 UTC when this window resets, where the provider supplies it; NULL where it does not. NULL means unknown, never "now" and never "never".
  observed_at   TEXT NOT NULL,  -- RFC 3339 UTC of the reading. This is the ordering key: where two readings key alike the later `observed_at` is current, and `source` breaks only exact ties. Ordering by arrival or by a source preference would let a stale reading mask real consumption.
  observed_credential_generation INTEGER NOT NULL
                CHECK(observed_credential_generation >= 1),  -- the account's `credential_generation` when this reading was taken, mirroring the member the account-scoped quota event already carries. A credential-home rebuild does NOT delete these rows — a quota window describes the provider-side allowance, which keeps running while a home sits empty — so this stamp is what lets a consumer render a pre-rebuild reading as stale rather than as current (Spec-025 §Per-limit provider quota). Contrast the health pair on the parent row, which a generation bump invalidates outright, because that pair describes the home itself. The CHECK carries the same floor the parent row's `credential_generation` and the wire's `CredentialGenerationSchema` both enforce, so the stamp cannot be written outside the range of the values it claims to compare against: a stamp below 1 names a generation that never existed, matches no account state, and would render its reading permanently stale rather than legibly refusing at write time. Like the parent's column it is a `STRICT` INTEGER, so a fractional stamp, which would place the reading between two generations, is refused at write.
  source        TEXT NOT NULL
                CHECK(source IN ('probe', 'run')),  -- which sanctioned source produced the reading: a deliberate read of the provider's own limits surface, or the account-scoped quota event emitted from real traffic. The background health observation is not a third value because it is not a third provenance: it performs the same deliberate read on its cadence, as another caller of it, and its readings record as 'probe' (Spec-025 §Credential-home health observation). The two values differ in COMPLETENESS, which is what consumers key on: a 'probe' reading is a whole-account read and replaces that account's stored set, while a 'run' reading is sparse and merges into it, pruning nothing it does not name.
  PRIMARY KEY (account_id, limit_id)
);
```

Spend joins to an account through the run wherever a run exists: a provider run carries the server-stamped `admittedProviderAccountId` on its `run.queued` admission record. **Two** usage kinds carry account identity directly, and both for the same reason — a figure that belongs to an account rather than to a run. `usage.rate_limit_update` does because provider quota is account-scoped and has no run to join through, and `usage.token_count` does because a turn can be spent on an account with no session at all (the window start, Spec-025 §Credential-home health observation) and because the per-turn projection below is keyed on the account rather than on the run. User identity stays off every usage row either way.

One row per turn, so the figures the person reads per account can be sliced by a day and by a model. It is a **projection** of the per-turn usage event ([Spec-005 §Usage Telemetry](../../specs/005-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)) and not a second accountant: the same events feed it and feed the in-memory committed-spend fold, it is rebuilt like every other projection, and every figure it answers is served through the one committed-spend accessor. What it adds over the fold is an **axis**, not a second arithmetic — a running total cannot be cut by a day or a model it never kept ([Spec-025 §State And Data Implications](../../specs/025-provider-accounts-and-credential-homes.md#state-and-data-implications)).

```sql
-- Owner: Plan-023
CREATE TABLE provider_account_usage_turns (
  source_event_id TEXT NOT NULL PRIMARY KEY,  -- the id of the `usage.token_count` event this row projects. It is the key because a turn IS that event: keying on it makes the projector idempotent, so a rebuild from the log writes each turn exactly once and a rebuild is byte-equal to the original. Deliberately NO foreign key to `session_events`: a session purge deletes that log's rows, and tying the figures to those rows would let the purge reach an account's spend history — the figures outlive the rows they were derived from, and what a rebuild can no longer see it does not invent.
  account_id      TEXT NOT NULL
                  REFERENCES provider_accounts(account_id) ON DELETE CASCADE,  -- a turn's figures have no meaning without the account that paid for them; deregistering an account takes its usage rows with it, exactly as it takes its window readings
  provider        TEXT NOT NULL
                  CHECK(provider IN ('claude', 'codex')),  -- the same closed driver-id union the registry and the MCP governance tables use. Held on the row rather than joined from the account so a provider-wide slice reads one table, and it is the account's provider by construction
  occurred_at     TEXT NOT NULL,  -- RFC 3339 UTC of the turn, carried from the source event's envelope. This is what the by-day slice groups on; the day boundary is the reader's, never baked in here
  session_id      TEXT,  -- the session whose run spent this turn. NULL for a turn NO session owns -- the window-start turn Spec-025 spends on an account outside every session -- so the account's own totals include it and no session's receipt does. No foreign key, for the reason the event log's own `session_id` carries none
  run_id          TEXT,  -- the run within that session. NULL exactly where `session_id` is NULL, and also where the provider attributed the turn no further than the session
  model_id        TEXT,  -- the model the turn ran on, as the provider names it. This is what the by-model slice groups on; NULL where the provider attributed usage no further than the run, and a NULL groups as its own unattributed bucket rather than being folded into another model
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_write_tokens    INTEGER,
  reasoning_tokens      INTEGER,  -- the five counts, each NULL where the provider reported none. NULL is NOT zero: one provider reports all five per turn and the other reports what its per-model usage block carries, so coalescing an unreported count to zero would present a partial reading as a complete one. Taken from the carrier that is complete on each leg -- on the Claude leg the result frame's PER-MODEL block, never its top-level one, which counts the outer loop alone and undercounts as soon as helper conversations run.
  cost_usd_micros INTEGER,  -- integer micro-dollars; NULL = no figure yet, which is a different fact from a cost of zero and renders as no figure at all. Both providers are priced: Claude Code's own figure where its cost basis reads list or managed, and the daemon's price table, matched by the model's exact id, for Codex and for a Claude Code model whose basis reads unknown. A turn is priced once, at completion, and never repriced; a turn on a model the price table does not carry yet is held here with no figure until the table's next fetch carries that model
  cost_source     TEXT
                  CHECK(cost_source IS NULL OR cost_source IN ('provider_reported', 'derived_exact')),  -- where the figure came from: the provider's own figure, or the daemon's price table by exact model id; the same vocabulary the source event carries. Provenance is REUSED and not re-enumerated here: a second spelling of where a number came from is a second answer to one question
  observed_credential_generation INTEGER NOT NULL
                  CHECK(observed_credential_generation >= 1),  -- the account's `credential_generation` when the turn was metered, mirroring the member the account-scoped quota event and the window readings both carry, with the same floor: a stamp below 1 names a generation that never existed. Its `STRICT` INTEGER type refuses a fractional stamp, which would sort between two whole generations.
  CHECK ((cost_usd_micros IS NULL) = (cost_source IS NULL)),  -- a figure always names where it came from, and a provenance with no figure is a source for nothing; an unlabeled number is the one thing the app never draws as money
  CHECK (run_id IS NULL OR session_id IS NOT NULL)  -- a run belongs to a session, so a row naming a run and no session describes a turn that cannot exist
);

-- The two slices the account surface draws, and nothing else reads this table by any other shape.
CREATE INDEX idx_provider_account_usage_turns_account_day
  ON provider_account_usage_turns(account_id, occurred_at);
CREATE INDEX idx_provider_account_usage_turns_account_model
  ON provider_account_usage_turns(account_id, model_id);
```

Rows are appended and never rewritten. A provider's own usage history, where it publishes one, is drawn **beside** this table with the vendor named and is never reconciled into it: two accountants counting the same tokens differently is what one source of truth exists to prevent.
