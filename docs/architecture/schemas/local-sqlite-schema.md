# Local SQLite Schema

Canonical schema for the local daemon's SQLite database. Each runtime node maintains its own instance.

**Storage boundary:** Machine-scoped execution truth and recovery data. See [Data Architecture](../data-architecture.md).

## Pragmas

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- override better-sqlite3 default (NORMAL) for chain-of-custody durability (see Spec-015 §Pragmas + Spec-006 §Integrity Protocol)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

---

## Session Events (Plan-001, extended by Plans 006, 008, 015)

```sql
-- Owner: Plan-001 | Extended by: Plan-006 (event taxonomy + integrity protocol), Plan-008 (received-row provenance marker), Plan-015 (replay cursors)
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,           -- ULID or UUID
  session_id             TEXT NOT NULL,              -- real session ULID/UUID, or a reserved node-scope sentinel for daemon-scope events (no FK; see Spec-006 §Security Events + Plan-022 D-022-8)
  sequence               INTEGER NOT NULL,           -- monotonic per session
  occurred_at            TEXT NOT NULL,              -- RFC 3339 UTC with ms precision (wall-clock; display + audit)
  monotonic_ns           INTEGER NOT NULL,           -- process.hrtime.bigint() at emit; within-daemon ordering only (see Spec-015 §Clock Handling, BL-062)
  category               TEXT NOT NULL,              -- e.g. 'run_lifecycle', 'assistant_output', 'tool_activity'
  type                   TEXT NOT NULL,              -- specific event type within category
  actor                  TEXT,                       -- participant_id or agent_id or NULL for system
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  pii_payload            BLOB,                       -- encrypted per-participant AES-256-GCM (GDPR); NOT hashed/signed
  pii_participant_id     TEXT,                       -- PII owner stamp (Plan-006 T3.1): the participant whose key encrypts pii_payload. NULL on every row with no pii_payload. Deliberately no NOT NULL, no CHECK, and NO FK to participant_keys — Spec-022 crypto-shred DELETEs the key row, and this stamp must OUTLIVE the key it names so I-006-2-12 can compare it against the same id signed into the canonical payload under PII_PARTICIPANT_ID_PAYLOAD_KEY (divergence is the tamper the read-side reports, not an error state the writer handles). Compaction CLEARS it alongside pii_payload: the audit-stub projection carries no PII and no PII owner, so a surviving stamp would name a participant for a row whose encrypted payload is gone.
  content_payload        BLOB,                       -- Assistant- and tool-generated prose (Spec-006 §Assistant Output + §Tool Activity): the assistant message body, the reasoning-update body, and tool-call arguments / result / error bodies. Sealed AES-256-GCM under the SESSION-scoped content key, AAD = session_id || event_id, stored iv || ciphertext || tag. That key is NOT derived from anything: it is a random 32-byte DEK looked up by session_id in session_content_keys and unwrapped under the daemon master key (Plan-006 I-006-3-08). Deriving it — the pre-2026-08-30 design — recreates the defect that finding fixed: the next rotate-on-shred destroys the old master and every existing content_payload on the daemon becomes permanently unreadable. NOT hashed/signed: excluded from the canonical bytes exactly as pii_payload is, with contentCiphertextDigest (BLAKE3 over the ciphertext) embedded in the signed payload instead, so the signature commits to these bytes without carrying them and survives their destruction. Deliberately NO owner-stamp sibling column: the sealing key is session-scoped and session_id is already a canonical signed member, so there is nothing left to bind — this is why the durable home for machine-authored prose costs one column and not two. NULL by construction on every audit_integrity and event_maintenance row (Plan-006 §Audit Integrity Invariant: never-compacted, never-shredded categories carry no destroyable content), and NULL on every row whose event type carries no prose. Compaction CLEARS it alongside pii_payload. Distinct from pii_payload, which holds PARTICIPANT-authored text under a per-participant key and is a crypto-shred path; this column is machine-authored session work product and is deliberately NOT a per-participant erasure path (Spec-022 §PII Data Map, the artifact-payload posture).
  correlation_id         TEXT,                       -- links related events
  causation_id           TEXT,                       -- parent event that caused this one
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'), -- semver "MAJOR.MINOR" per ADR-018 §Decision #1
                                                               -- (never INTEGER; comparison must parse MAJOR/MINOR as ints —
                                                               -- lexical TEXT comparison is unsafe, e.g. "1.10" < "1.9")
  -- Integrity protocol (BL-050): hash-chain + per-event daemon signature
  prev_hash              BLOB NOT NULL,              -- 32 bytes; row_hash of previous row (zero-filled at sequence=0)
  row_hash               BLOB NOT NULL,              -- 32 bytes; BLAKE3(prev_hash || JCS-canonical envelope bytes); frozen pre-compaction
  daemon_signature       BLOB NOT NULL,              -- 64 bytes; Ed25519 over same canonical bytes; frozen pre-compaction
  participant_signature  BLOB,                       -- 64 bytes; Ed25519 from participant key; NULL for non-sensitive events
  -- Compaction (Plan-006 Tier 4 Phase 3): typed retention discriminator + post-compaction stub commitment
  retention_class        TEXT CHECK (retention_class IS NULL OR retention_class = 'audit_stub'), -- NULL = live row (per-row chain-verified); 'audit_stub' = compacted (anchor + stub_signature verified). Column-level CHECK closes the discriminator domain; it is ALTER-ADD-COLUMN-addable (references only this column; NULL-permitting so pre-migration rows pass). Co-presence (audit_stub ⟺ non-NULL stub_signature) is a two-column invariant that cannot be an ALTER-added table-level CHECK without a 12-step table rebuild; it is instead enforced at the verification layer per Spec-006 §Post-Compaction Integrity (NULL stub_signature on an audit_stub row → stub_signature_invalid; surviving scalar columns category/type/actor/occurred_at bound to the signed payload projection → stub_scalar_mismatch on divergence).
  stub_signature         BLOB,                       -- 64 bytes; Ed25519 over canonical_bytes(audit-stub projection); NULL for live rows. Authenticates the post-compaction stub representation per Spec-006 §Post-Compaction Integrity (frozen row_hash/daemon_signature commit only to the now-discarded pre-compaction bytes)
  -- Received-row provenance (Plan-008 Tier 5 R4 backfill task; Spec-006 §Canonical Serialization Rules, 2026-08-11 amendment)
  received_from_node_id  TEXT,                       -- Origin NodeId whose roster key verified this row's origin-signed bytes before the local re-sequenced, re-signed append (Spec-008 live relay or peer history backfill). NULL on every origin-authored row. Mirrored into the receiver-signed canonical bytes as the conditional receivedFromNodeId member, so clearing it (to fake origin authorship) or planting it (to dodge the PII binding checks) fails the ordinary signature_mismatch mode while the row is live, and preserved in the signed audit-stub projection after compaction, where rule 4's scalar binding catches a flip as stub_scalar_mismatch — no new verification mode in either retention class. Doubles as the backfill serving selector (a daemon serves only its received_from_node_id IS NULL rows — Spec-008 possession-scoped serving) and as the dispatch key for the fourteenth + fifteenth PII binding checks: the four-state compare on origin rows, a require-absent arm on received rows (both PII columns MUST be NULL — a received row never held the partition, so a planted value is reported unbound, never compared).
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;
-- Hot-path replay keeps live rows fast; the partial index excludes compacted stubs.
CREATE INDEX idx_session_events_live ON session_events(session_id, sequence) WHERE retention_class IS NULL;
CREATE UNIQUE INDEX idx_session_events_run_terminal_once ON session_events(json_extract(payload, '$.runId'), json_extract(payload, '$.runVersion')) WHERE category = 'run_lifecycle' AND type IN ('run.completed', 'run.failed', 'run.interrupted');

-- Projection-level terminal-key CHECK (Spec-006 at-most-once terminal emission; assigned to the campaign B11
-- schema work). SQLite has no ALTER TABLE ... ADD CHECK on an existing table (sqlite.org/`lang_altertable`.html), so a
-- trigger trio is the idiomatic equivalent: abort any terminal run_lifecycle write whose runId/runVersion key is NULL
-- OR the wrong storage class (json_type: runId 'text', runVersion 'integer' — a type-drifted "7"-vs-7 key bypasses the
-- UNIQUE index, which keys by storage class). The BEFORE UPDATE leg keys off OLD (the row WAS terminal) and additionally aborts a value-changing key rewrite (NEW key IS NOT OLD, null-safe) or a category/type de-scope — either frees the index slot for a duplicate terminal — enforcing stub-preservation against the compactor (key + category + type kept for the row's whole retention life). The promote leg rejects re-typing any non-terminal row INTO the guarded set (terminal rows are INSERT-only): an OLD-keyed guard alone would let a null-keyed promotion slip both legs and the NULL-distinct UNIQUE index.
CREATE TRIGGER trg_run_terminal_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer')
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle requires text runId + integer runVersion (non-null, correct storage class)');
END;
CREATE TRIGGER trg_run_terminal_key_update BEFORE UPDATE OF payload, category, type ON session_events
WHEN OLD.category = 'run_lifecycle'
  AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer' OR json_extract(NEW.payload, '$.runId') IS NOT json_extract(OLD.payload, '$.runId') OR json_extract(NEW.payload, '$.runVersion') IS NOT json_extract(OLD.payload, '$.runVersion') OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle stub must preserve runId + runVersion (value + storage class) + category + type');
END;
CREATE TRIGGER trg_run_terminal_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'run_lifecycle' AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted'))
  AND NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
BEGIN
  SELECT RAISE(ABORT, 'session_events rows cannot be promoted to terminal run_lifecycle by UPDATE — terminal rows are INSERT-only');
END;
```

**Integrity protocol.** `prev_hash`, `row_hash`, `daemon_signature` are required; `participant_signature` is NULL-able and present only for sensitive events (approvals, policy changes, membership revocations). For un-compacted rows (`retention_class IS NULL`) the verifier recomputes the per-row chain hash + signature over the live `payload`. After compaction (`retention_class = 'audit_stub'`) the original canonical bytes are discarded, so `row_hash`/`daemon_signature` freeze as a commitment to the (now-gone) pre-compaction state and the **`stub_signature`** authenticates the surviving audit-stub bytes; range existence is additionally witnessed by the covering Merkle anchor in `pending_anchor_uploads` / `event_log_anchors`. The canonical serialization (RFC 8785 JCS) and the full verification order are specified in [Security Architecture § Audit Log Integrity](../security-architecture.md#audit-log-integrity) and [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol) + [§ Post-Compaction Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity). The `idx_session_events_run_terminal_once` partial unique index is the schema-level terminal-exactly-once backstop (Plan-006, campaign B11): a duplicate terminal `run_lifecycle` row for the same `(runId, runVersion)` epoch fails loud with a `UNIQUE` violation; NULL `runId`/`runVersion` rows bypass it (SQLite NULL-distinctness), so the Plan-004 terminal emitter (campaign B9) enforces the non-null-key precondition this index backstops. The engine semantics this backstop relies on are load-bearing, and each is cited to the official SQLite documentation: [expression indexes](https://sqlite.org/expridx.html) (the index keys on `json_extract(payload, …)` expressions), [partial indexes](https://sqlite.org/partialindex.html) (the `WHERE category = 'run_lifecycle' AND type IN (…)` filter), [UNIQUE-index enforcement](https://sqlite.org/lang_createindex.html#unique_indexes), and [NULL-distinctness](https://sqlite.org/nulls.html) (two NULLs are distinct for UNIQUE purposes, so NULL-key rows bypass the constraint). It ships via the additive migration `0006-run-lifecycle-terminal-backstop-index.ts`. The same migration installs the `trg_run_terminal_key_insert` / `trg_run_terminal_key_update` / `trg_run_terminal_key_promote` trigger trio — the projection-level CHECK-equivalent Spec-006's at-most-once-terminal-emission rule assigns to this schema work — which aborts terminal `run_lifecycle` writes whose `runId` / `runVersion` key is NULL **or the wrong storage class** (`json_type` must be `'text'` for `runId` and `'integer'` for `runVersion`, per the `RunId` string / any-run-progression-counter payload contract in [Spec-006 §Run Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) — a `"7"`-vs-`7` type-drifted key would otherwise bypass the storage-class-keyed UNIQUE index for exactly the malformed rows the backstop exists to catch). The INSERT leg closes the NULL-distinctness bypass the UNIQUE index cannot catch; the UPDATE leg (`BEFORE UPDATE OF payload, category, type`, keyed off `OLD` so a row that WAS terminal cannot escape by mutation) additionally aborts a **value-changing key rewrite** (`NEW` key `IS NOT` `OLD`, null-safe — a compactor bug rewriting `(R,7)` to another non-null pair would otherwise free the index slot for a duplicate terminal) and a **`category`/`type` de-scope** (flipping a terminal row out of the guarded set is the same escape), enforcing stub-preservation against the compactor across the row's whole retention life. The promote leg closes the inverse escape: an UPDATE re-typing a non-terminal row INTO the guarded set is rejected outright — terminal rows are INSERT-only — so a null-keyed promotion cannot slip past the OLD-keyed update leg and the NULL-distinct UNIQUE index (campaign B11 schema work, hardened by the W2.5 re-audit).

**Content payload (machine-authored prose).** `content_payload` is the durable encrypted home for the prose the _machine_ side of a session produces — the assistant message body, the reasoning-update body, and tool-call arguments / result / error bodies. It exists because [ADR-029](../../decisions/029-canonical-transcript-is-authoritative.md) rules the daemon's canonical transcript authoritative for the content of a provider session, and a projection rebuilt from `session_events` can only be authoritative for content the rows actually hold. It is a **sibling of `pii_payload`, not a replacement**: the two columns partition one row's text by authorship, `pii_payload` carrying participant-authored text under that participant's own key (a crypto-shred path) and `content_payload` carrying machine-authored session work product under a session-scoped stored key (deliberately not a per-participant erasure path — [Spec-022 §PII Data Map](../../specs/022-data-retention-and-gdpr.md#pii-data-map), the artifact-payload posture). A row may carry both, one, or neither.

**Sealing.** The session content key is a **random 32-byte AES-256 key generated once per session and stored wrapped**, never a value derived from the daemon master key. It lives in `session_content_keys` below as an XChaCha20-Poly1305 envelope under that master key — byte-for-byte the `participant_keys.encrypted_key_blob` custody shape, over the master key whose ladder is [Spec-022 §Daemon Master Key](../../specs/022-data-retention-and-gdpr.md#daemon-master-key). **Stored-and-wrapped rather than derived is load-bearing, not stylistic** (2026-08-30, Codex PR #383 round 1): [Spec-022 §Retention Policies](../../specs/022-data-retention-and-gdpr.md)' rotate-on-shred generates a fresh master `M'`, re-wraps the stored key rows, and destroys `M`. A key _derived_ from `M` cannot be recovered once `M` is gone, so every existing body on the daemon would become permanently unreadable the first time any unrelated participant exercised erasure — destroying co-owned session work product that the erasure request has no claim on, and doing it silently. A stored key is re-wrappable, so it survives rotation unchanged; only its envelope changes. Sealing is AES-256-GCM with a fresh 96-bit IV per write and AAD = `session_id || event_id`, the same record-binding `pii_payload` uses, so a ciphertext cannot be replayed onto another row or another session.

**Bound and truncation.** Unlike `pii_payload`, whose size is bounded in practice by human typing, `content_payload` admits machine-scale text: a tool result is routinely a file dump or a command's whole stdout. It is therefore bounded — `CONTENT_PAYLOAD_PLAINTEXT_MAX = 262144` bytes (256 KiB) of UTF-8 plaintext per row — and an over-bound body is **truncated at a codepoint boundary, never refused and never dropped**, because refusing the append would lose the turn entirely and dropping it would misreport that the turn never happened. Truncation is recorded, never silent: the signed `payload` carries `contentTruncated: true` and keeps `contentLength` at the **pre-truncation** byte length, so the size of what was dropped stays recoverable from the audit log, and no invisible or zero-width sentinel is written into the text ([Spec-005 §Required Behavior](../../specs/005-provider-driver-contract-and-capabilities.md#required-behavior)'s prohibition, applied unchanged). The full pre-truncation bytes remain reachable for `≤ 7` days in the bounded-retention diagnostic tier (`driver_raw_events` / `tool_traces`) and nowhere after that; the canonical prefix is what outlives them. The per-row bound governs one row only — a session's aggregate is governed by the existing [Spec-006 §Event Compaction Policy](../../specs/006-session-event-taxonomy-and-audit-log.md#event-compaction-policy) triggers, and **those triggers must count this column's bytes** (2026-08-30, Codex PR #383 round 1). The shipped compactor sums `payload` + `pii_payload` only, in both of its byte-accounting statements — the per-session `live_bytes` summary and the storage cutoff's running total — so without this obligation a content-bearing session compacts on the 50,000-event count trigger alone: at 256 KiB per row the store can reach roughly 12.5 GiB before the count fires, twenty-five times past the 500 MB threshold the policy claims. Both statements therefore add `COALESCE(LENGTH(content_payload), 0)`. Naming the two rather than saying _every accounting query_ is deliberate — it makes the obligation checkable by count. The thresholds themselves do not change; the triggers stay independent and a pass compacts their union.

**Compaction.** Compaction CLEARS `content_payload` alongside `pii_payload`, for the same reason: the audit-stub projection is a non-PII, non-content commitment and a surviving ciphertext would outlive the payload that describes it. The `contentCiphertextDigest` member does **not** survive, and does not need a stub field of its own: it is a commitment to bytes this same act destroys, and a commitment to nothing verifies nothing. Its two **descriptive** siblings do survive — the stub preserves `contentLength` and `contentTruncated` verbatim whenever the source payload carries them (2026-08-30, Codex PR #383 round 1). The distinction is the principle, not a compromise: an audit stub exists to record _what_ was destroyed, so how much the machine said and whether the log ever held all of it are exactly its business, while a digest of the destroyed bytes is not. Without them the pre-truncation-length guarantee two paragraphs above would silently expire at compaction. They ride the conditional-stub-member shape `channelId` already uses — payload-derived, not durable columns — so the [§Post-Compaction Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity) scalar binding is untouched. That disposition is stated rather than left implicit — the corpus paid a dated amendment (2026-07-27) for leaving the `pii_participant_id` compaction case implicit, and this column does not repeat it. Post-compaction integrity is unaffected: `row_hash` / `daemon_signature` were already frozen commitments to the discarded pre-compaction bytes, and `stub_signature` authenticates the surviving projection.

**Relay disposition — the column is node-local.** `content_payload` is **never relayed and never backfilled**, exactly as `pii_payload` is never relayed (2026-08-30, Codex PR #383 round 1). It follows by construction rather than by a new filter: [Spec-008 §Peer History Backfill On Join (V1)](../../specs/008-control-plane-relay-and-session-join.md#peer-history-backfill-on-join-v1) carries only the origin daemon's **canonical bytes**, and this column is excluded from those bytes. A receiving daemon therefore holds the row's signed `contentCiphertextDigest`, `contentLength`, and `contentTruncated` — which ride the canonical payload — with the ciphertext itself absent, and its `content_payload` MUST be NULL. That is the same digest-present-ciphertext-gone shape the received-row provenance amendment already settled for `pii_payload`, so it takes the same two-arm resolution rather than a new one: the sixteenth verification mode dispatches on `received_from_node_id`, comparing on origin rows and **requiring absence** on received rows ([Spec-006 §Canonical Serialization Rules](../../specs/006-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules)).

**What a peer's projection shows, stated rather than implied.** On a node that received a row rather than authoring it, the body is not available, and the canonical-transcript fold reports `'turn_content_unavailable'` for that turn. This is a **named residual, not a solved problem**: it is bounded to multi-node sessions, it is honest at the wire (the peer knows a body existed, how long it was, and that it cannot read it, rather than seeing a turn that looks empty), and the amendment that closes it is the one that distributes the session content key. That amendment is now _possible_ — and this is the second reason the key is stored rather than derived: a stored key is a distributable object that the established pairwise ciphertext envelope can carry as an application payload, exactly as [Spec-014](../../specs/014-artifacts-files-and-attachments.md)'s artifact-key attestations already travel, whereas a key derived from a node's own master key is by construction underivable anywhere else. Registering that distribution leg — its ordering against row append, its behaviour for a row whose key has not yet arrived, and its mid-session-join semantics — is owed by the swap that ships it, and is deliberately not sketched here: a mechanism named without a producer is the defect this PR's own follow-up commit was paid to fix.

### Session Content Keys (Plan-006)

```sql
-- Owner: Plan-006
CREATE TABLE session_content_keys (
  session_id         TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob BLOB NOT NULL,           -- XChaCha20-Poly1305-wrapped AES-256 session content key under the daemon master key. 24-byte random nonce, wire: nonce || ciphertext || tag, AAD = session_id || "ais.session-content-wrap.v1" || key_version — the participant_keys.encrypted_key_blob custody shape, domain-separated by its own info string
  key_version        INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  rotated_at         TEXT
);
```

The wrapped home of the key that seals every `content_payload` in one session — deliberately a mirror of `participant_keys` rather than a new custody idea, so the machinery that already re-wraps that table covers this one. Keyed by session, because the body is session work product co-owned by every member and has no participant to key on ([Spec-022 §PII Data Map](../../specs/022-data-retention-and-gdpr.md#pii-data-map), the artifact-payload posture). The row is created lazily on the session's first content-bearing append, so a session that never runs an agent stores no key.

**The wrap binds session and key version, and the AAD is what does it** (2026-08-30, Codex PR #383 round 3). The envelope is XChaCha20-Poly1305 with a 24-byte random nonce and `AAD = session_id || "ais.session-content-wrap.v1" || key_version`, the exact form [Spec-022 §Participant Keys](../../specs/022-data-retention-and-gdpr.md#participant-keys) uses for `participant_keys` (`participant_id || "ais.master-wrap.v1" || key_version`), with its own info string so the two wrap domains can never be confused. Without the AAD the envelope authenticates on the master key **alone**, so two rows' `encrypted_key_blob` values could be swapped, or one replayed under a different `key_version`, and both would unwrap cleanly — the wrong key would then simply fail to open that session's bodies, surfacing as ordinary `'turn_content_unavailable'` while the ciphertext-digest verifier stayed green, because the event ciphertext was never touched. That is a silent key-substitution attack wearing the costume of a routine unreadable turn, which is precisely the confusion the sixteenth verification mode exists to prevent on the event side. Binding `key_version` additionally forecloses rollback to a superseded wrap. Plan-006 T3.6 owns the format and **must test both negatives** — a blob moved to another session's row and a blob replayed under another `key_version` each fail the unwrap — the obligation [Plan-022 I-022-9](../../plans/022-data-retention-and-gdpr.md#invariants) carries for the participant wrap.

**It joins rotate-on-shred's existing transaction rather than following it.** [Spec-022](../../specs/022-data-retention-and-gdpr.md)' rotation step 2 re-wraps `participant_keys` inside a single `BEGIN EXCLUSIVE` alongside the `rotation_in_progress` sentinel, and its guarantee is that _either every row is under `M'` after commit or every row remains under `M`_. This table is re-wrapped **in that same transaction**, not in a step of its own: a separate re-wrap pass would falsify that all-or-nothing claim, leaving a crash window in which participant keys are under `M'` while content keys are still under `M` and the destroyed master is the only thing that could read them. The inner AES-256 key is unchanged by rotation — only the envelope moves — so no ciphertext is rewritten and no body is re-sealed.

**Erasure disposition.** This key is **not** a per-participant erasure path and destroying it is not a shred: it seals content that every session member co-owns. It dies with its session — at session purge, when the last of the session's rows is compacted away, or with daemon master-key destruction — and the row carries `key_version` / `rotated_at` so a future rotation is representable. V1 does **not** re-key on membership change; a removed member is cut off by the relay ceasing to address them rather than by cryptographic revocation, which is a forward-secrecy guarantee this corpus defers to its MLS era ([ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md)) and does not claim here.

## Session Snapshots (Plan-001, extended by Plans 006, 015)

```sql
-- Owner: Plan-001 | Extended by: Plan-006, Plan-015
CREATE TABLE session_snapshots (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  as_of_sequence        INTEGER NOT NULL,           -- snapshot reflects events up to this sequence (replay-cursor state)
  state_blob            BLOB NOT NULL,              -- serialized session state
  created_at            TEXT NOT NULL,
  -- Compaction hints (Plan-006 Tier 4 Phase 4, migration 0NNN-session-snapshots-compaction-cursor.ts):
  -- let replay/projection detect compacted regions without scanning session_events.
  has_compacted_ranges  INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1; whether [.., as_of_sequence] contains audit_stub rows
  compacted_range_count INTEGER NOT NULL DEFAULT 0, -- count of distinct compacted ranges reflected in this snapshot
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);
```

---

## Queue and Intervention Tables (Plan-004)

```sql
-- Owner: Plan-004 (the Spec-004 2026-08-18 admitting-principal + queue-PII amendment adds the
-- pii_payload / pii_participant_id pair and admitting_intervention_id)
CREATE TABLE queue_items (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  channel_id      TEXT,                       -- nullable for session-level items
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled', 'expired')),
  priority        INTEGER NOT NULL DEFAULT 0, -- higher = more urgent
  payload         TEXT NOT NULL DEFAULT '{}', -- JSON: NON-PII members only — context, metadata, and the
                                              -- non-PII identifiers. A participant-authored send's body
                                              -- never rides this column (it encrypts into pii_payload;
                                              -- Spec-004 §Required Behavior at-rest split, 2026-08-18
                                              -- amendment). Orchestration-authored content (a workflow
                                              -- phase input, an orchestrated child-run prompt) is session
                                              -- work product, not participant PII, and stays here in
                                              -- plaintext with both PII columns NULL — the system arm has
                                              -- no participant DEK to encrypt under (CP-004-10's
                                              -- NULL-for-system actor). Every drain-selection field is its
                                              -- own column (state, priority, target_run_id, channel_id,
                                              -- session_id), so the split costs no queryability.
  pii_payload     BLOB,                       -- encrypted per-participant AES-256-GCM via Plan-006's
                                              -- PiiEncryptor (CP-006-1): the participant-authored send
                                              -- body (Plan-004 T1.4, Spec-004 2026-08-18 amendment).
                                              -- Same-key parity with session_events.pii_payload and
                                              -- interventions.pii_payload, so one Plan-022 Path-1 key
                                              -- deletion shreds every copy of the same send identically
                                              -- (Spec-022 §PII Data Map row). NULL on rows carrying no
                                              -- participant-authored body.
  pii_participant_id TEXT,                    -- PII owner stamp: the authoring participant whose key
                                              -- encrypts pii_payload — the erasure/export selector this
                                              -- table otherwise lacks entirely (no other column names a
                                              -- participant, so without it the GDPR fan-out cannot address
                                              -- these rows); NULL on rows carrying no PII leg
  target_run_id   TEXT,                       -- run-bound admission arm (Plan-004 T1.4, 2026-08-16
                                              -- rewind-hardening amendment round-2 fold): NULL on
                                              -- ordinary follow-up items (admission converts them
                                              -- into a new run); stamped solely by the edit-and-resend
                                              -- composite's admission in V1 — the item delivers into
                                              -- its bound run as its next provider send on run.resume,
                                              -- never converting into a new run
  admitting_intervention_id TEXT,             -- row-anchored linkage to the interventions row whose
                                              -- admission created this item (Plan-004 T1.4, Spec-004
                                              -- 2026-08-18 amendment): NULL on ordinary participant sends,
                                              -- stamped beside target_run_id in T3.17's single durable
                                              -- transaction. T3.5's drain reads it to resolve the drained
                                              -- turn's admitting principal — a run accumulates
                                              -- interventions over its life, so the resolution is durable
                                              -- on the row and never inferred from run history
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_target_run ON queue_items(target_run_id) WHERE target_run_id IS NOT NULL;
CREATE INDEX idx_queue_items_channel ON queue_items(channel_id) WHERE channel_id IS NOT NULL;
-- No index on pii_participant_id, matching the interventions.pii_participant_id sibling: the Plan-022
-- Path-1 erasure/export selector is a V1.1 maintenance scan, never a hot path, and both tables carry the
-- stamp unindexed for the same reason.

-- Owner: Plan-004 (campaign B9 adds rejection_reason; the Spec-004 2026-08-16 rewind-hardening amendment adds the pii_payload / pii_participant_id pair; the Spec-004/Spec-012 2026-08-18 admitting-principal amendment adds origin + admitting_principal_id; the Spec-004 2026-09-06 typed-composite-guard amendment adds rejection_guard, this table's first post-ship column and therefore Plan-004's own next-ordinal migration rather than an edit of the shipped 0015) | Extended by: Spec-005 campaign B3 (client_idempotency_key intervention dedupe); Spec-004 campaign B2 (rollback type — targetPosition rides the payload JSON, no new column)
CREATE TABLE interventions (
  id                     TEXT PRIMARY KEY,
  target_run_id          TEXT NOT NULL,
  type                   TEXT NOT NULL
                         CHECK(type IN ('steer', 'interrupt', 'cancel', 'rollback')),
  state                  TEXT NOT NULL DEFAULT 'requested'
                         CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired')),
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON: type-specific NON-PII fields only — neither a rollback's replacementSend body nor a steer's directive text rides this column (both encrypt into pii_payload; Spec-004 §Required Behavior at-rest split, 2026-08-16 amendment as widened to steer content 2026-08-18)
  expected_run_version   INTEGER NOT NULL,           -- MANDATORY fail-closed comparand (Spec-004 §Interfaces And Contracts / Plan-004 D-004-2)
  client_idempotency_key TEXT NOT NULL,              -- MANDATORY requester-generated UUID (participant client or daemon system-origination); replay-or-conflict intervention dedupe (Spec-005 §Required Behavior, campaign B3)
  pii_payload            BLOB,                       -- encrypted per-participant AES-256-GCM via Plan-006's PiiEncryptor (CP-006-1): the participant-authored intervention body — the rollback replacementSend body (Plan-004 T1.4, Spec-004 2026-08-16 amendment) and, from the 2026-08-18 amendment, the steer directive text; same-key parity with session_events.pii_payload, so the Plan-022 Path-1 key deletion shreds every copy identically; NULLed by the daemon retention pass past the Spec-022 90-day full-retention bound (Spec-022 §PII Data Map row — no digest binding attaches, unlike session_events)
  pii_participant_id     TEXT,                       -- PII owner stamp: the requesting participant whose key encrypts pii_payload; NULL on rows carrying no PII leg
  origin                 TEXT NOT NULL               -- daemon-resolved admission-path discriminator (D-004-4 / D-012-20, 2026-08-18): 'participant' for a request admitted over an identity-carrying transport, 'system' for the in-process orchestration entrypoint below the wire authz boundary (CP-004-10's budget / idle / moderation interventions). NO DEFAULT by design — a default would fail OPEN for the system path, so every insert site declares. Deliberately NOT inferred from initiator_id IS NULL: initiator_id is client-supplied and informational (ADR-011; api-payload-contracts §Authenticated Principal And Authorization Model), so its absence proves nothing about how the request was admitted
                         CHECK(origin IN ('participant', 'system')),
  admitting_principal_id TEXT,                       -- participant recorded as the intervention's admitting principal, daemon-resolved at acceptance (D-004-4: node-owner binding on the local socket; verified PASETO sub on authenticated surfaces; caller_token.sub on the Spec-024 cross-node arm — the approval_resolutions.approver_id resolution semantics, D-012-12). NEVER read from the wire: a body-supplied actor disagreeing with the verified identity refuses as auth.principal_mismatch (the existing error row — no duplicate is minted). Read by Plan-012's turn-scoped effective-principal resolution (CP-012-12)
  result                 TEXT,                       -- JSON: outcome details
  rejection_reason       TEXT,                       -- machine-readable rejected cause (driver.capability_unsupported foremost) — replay-durable: the wire contract forbids result on rejected, so an idempotent replay reconstructs rejectionReason from this column (Plan-004 T1.4/T3.12, campaign B9)
  -- Plan-004 EXTEND of its own SHIPPED CREATE (additive nullable, landing by its own next-ordinal
  -- migration -- the statement above shipped as
  -- packages/runtime-daemon/src/migrations/0015-queue-and-interventions.ts (PR #402, 2026-09-01)
  -- and is never edited): which of the atomic edit-and-resend composite's four
  -- structural refusal guards refused, as the closed literal the wire's rejectionGuard carries
  -- (Spec-004 §Required Behavior; api-payload-contracts.md §Plan-004 — Queue Steer Pause Resume;
  -- the shipped mirror is
  -- packages/contracts/src/runControl.ts#RollbackCompositeRejectionGuardSchema).
  -- REPLAY-DURABLE for the same reason rejection_reason is, and NOT derivable from that sibling:
  -- the wire contract forbids result on rejected, so an idempotent replay of the same
  -- client_idempotency_key -- across a daemon restart included -- reconstructs the response from
  -- this row alone, and rejection_reason -- a machine-readable cause, never prose -- carries an
  -- OPEN vocabulary that no contract enumerates (error-contracts.md §Intervention registers no
  -- code for an intervention outcome), so recovering the literal from it would be exactly the
  -- match against an unpublished value set the typed member exists to abolish. Written by
  -- Plan-004 T3.17 in the SAME write that settles state = 'rejected' (the four guards are
  -- pre-dispatch admission refusals, so the settlement is one write); read back by T3.12's replay
  -- reconstruction. NULL on every other refusal family -- the EIGHT the transition table admits
  -- for a rollback: the capability gate, the authorization refusal, the target-position domain
  -- check, the compaction-boundary classification, an incompatible target run state, the Spec-010
  -- restore precondition, the uncompacted-rewind-span intersection, and execution-root busy -- and
  -- on every non-rejected row, so presence reads as "a composite guard refused" and never as "some
  -- rollback refused".
  --
  -- The CHECK is attached to the COLUMN rather than stated as a table constraint, deliberately.
  -- SQLite's ALTER TABLE ... ADD COLUMN accepts a column-attached CHECK whose expression
  -- references sibling columns -- measured on 3.51.0: the constraint below survives reopen and
  -- refuses a guard on a steer row, on a non-'rejected' state, and on an unknown literal -- while
  -- a CHECK in the table-constraint position has no ALTER form at all and would force the 12-step
  -- rebuild of https://www.sqlite.org/lang_altertable.html#otheralter on a shipped table. The
  -- documented ADD COLUMN restrictions
  -- (https://www.sqlite.org/lang_altertable.html#altertabaddcol) bar -- among others -- a NOT NULL
  -- column without a default, a PRIMARY KEY or UNIQUE, a REFERENCES clause while foreign keys are
  -- enabled, and a non-constant default; this column is none of those and admits NULL, so every
  -- pre-migration row satisfies the constraint as the column is appended and no rebuild is owed.
  -- ADD COLUMN appends, so the physical ordinal is after created_at rather than here; column order
  -- is not part of the contract (the 0017-command-receipt-mcp-task-handle.ts convention).
  --
  -- No Spec-022 reciprocal is owed: the value is a daemon-minted member of a closed four-literal
  -- vocabulary, carries no participant content, and identifies no participant, so it takes no PII
  -- data-map row, no export disposition, and no erasure selector -- unlike the pii_payload /
  -- pii_participant_id pair above.
  rejection_guard        TEXT                        -- NULL default; which composite guard refused
                         CHECK(rejection_guard IS NULL
                               OR (type = 'rollback' AND state = 'rejected'
                                   AND rejection_guard IN ('no-active-turn', 'no-pending-send',
                                                           'participant-authored-target',
                                                           'resumable-target'))),
  initiator_id           TEXT,                       -- participant or system — routing/audit metadata only, never an authorization input (see admitting_principal_id)
  created_at             TEXT NOT NULL,
  resolved_at            TEXT,
  UNIQUE(target_run_id, client_idempotency_key),     -- identical retry replays the recorded outcome; key reuse with a differing payload rejects as intervention.idempotency_conflict — the PII body compared by decrypt-and-compare under the requester's live key, never by ciphertext or persisted digest (Spec-004 §Interfaces And Contracts) — distinct grain from command_receipts.command_id (per-command crash-recovery dedupe)
  CHECK((origin = 'participant' AND admitting_principal_id IS NOT NULL)
        OR (origin = 'system' AND admitting_principal_id IS NULL))
                                                     -- principal required iff participant-origin (D-004-4): the participant arm can never persist without its verified identity, and the system arm can never smuggle one in. Enforced by the engine, not by convention
);

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state) WHERE state IN ('requested', 'accepted');

-- Owner: Plan-004 | Extended by: Plan-015 (recovery + two-phase idempotency protocol, BL-051); Plan-005 (additive nullable mcp_task_id — MCP Tasks durable recovery handle, campaign B10; own Plan-005 migration, never a Plan-004 migration edit); Plan-028 (additive nullable mcp_binding_digest — governed-binding provenance for the durable trust-revocation neutralization, CP-028-7; own Plan-028 migration, never a Plan-004 migration edit)
CREATE TABLE command_receipts (
  id                TEXT PRIMARY KEY,
  command_id        TEXT NOT NULL UNIQUE,         -- idempotency key (client-supplied)
  run_id            TEXT,
  status            TEXT NOT NULL
                    CHECK(status IN ('accepted', 'rejected', 'completed', 'failed')),
  -- BL-051 two-phase commit columns
  idempotency_class TEXT NOT NULL
                    CHECK(idempotency_class IN ('idempotent', 'compensable', 'manual_reconcile_only')),
  dedupe_key        TEXT,                         -- propagated to remote side for 'compensable' tools
  started_at        TEXT,                         -- set by Phase 2 optimistic CAS; NULL until claimed
  completed_at      TEXT,                         -- set by Phase 3; NULL until terminal-status
  -- Plan-005 EXTEND (campaign B10; additive nullable, own Plan-005 migration): receiver-generated
  -- MCP Tasks taskId for a task-augmented MCP call (from the CreateTaskResult acceptance response).
  -- NULL until the receiver accepts — a crash before that leaves NULL and the call stays on the
  -- manual_reconcile_only halt. Spec-015 recovery reads this handle and polls tasks/get + tasks/result
  -- instead of halting. Landed by Plan-005 T5.1, which also activated the T3.13 receipt-write seam, in
  -- packages/runtime-daemon/src/migrations/0017-command-receipt-mcp-task-handle.ts#COMMAND_RECEIPT_MCP_TASK_HANDLE_MIGRATION_SQL
  -- (see also cross-plan-dependencies.md §1 command_receipts EXTEND row). Bounded like every persisted
  -- provider-declared string (the runtime_bindings defense-in-depth convention): the taskId is untrusted
  -- remote-peer output, so the CHECK bounds the SQLite-expressible part and the T5.1 write seam mirrors
  -- the same 256 — in CODE POINTS, since length(X) returns "the number of Unicode code points (not bytes)
  -- in input string X prior to the first U+0000 character"
  -- (https://www.sqlite.org/lang_corefunc.html#length). Both halves bind: the first sets the unit, the
  -- second is why the write seam's single bounded scan reports NUL over size whenever one walk sees
  -- both within its 256-code-point bound — a NUL-bearing handle measures short to length(X) and would
  -- otherwise be misreported as well-sized — while a NUL first reachable past that bound reports
  -- too-long instead: the scan stops at the first terminal fact it meets and never walks more than
  -- 257 code points of a hostile handle, so refusal cost is bounded. The seam additionally refuses a handle that
  -- is not well-formed Unicode, which the CHECK cannot see: UTF-8 prohibits encoding a lone surrogate
  -- outright ("The definition of UTF-8 prohibits encoding character numbers between U+D800 and U+DFFF",
  -- RFC 3629 §3, https://datatracker.ietf.org/doc/html/rfc3629#section-3), and the standard
  -- JavaScript-to-bytes conversion substitutes U+FFFD for each unpaired surrogate rather than failing
  -- ("To convert a JavaScript string into a scalar value string, replace any surrogates with U+FFFD",
  -- WHATWG Infra Standard, https://infra.spec.whatwg.org/#javascript-string-convert) — one or more
  -- U+FFFD per surrogate in practice, since the substitution width is the platform encoder's choice
  -- (both observed widths are pinned by the executable hazard proof in
  -- packages/runtime-daemon/src/provider/__tests__/mcp-task-handle-recorder.test.ts) — so the row
  -- would store a handle the receiver never issued.
  mcp_task_id       TEXT                          -- NULL default; MCP Tasks durable recovery handle
                    CHECK (mcp_task_id IS NULL OR (length(mcp_task_id) > 0 AND length(mcp_task_id) <= 256 AND instr(mcp_task_id, char(0)) = 0)),
  -- Plan-028 EXTEND (additive nullable, own Plan-028 migration): the governed MCP binding this
  -- receipt's tool resolved from, as the path-free keyed digest -- "b3:"-prefixed keyed BLAKE3
  -- (key = the binding-identity subkey, derived from the daemon-held node-local master key that
  -- never enters the database) over the RFC 8785 JCS canonicalization of the McpServerBindingRef
  -- tuple. The raw scopeRef is a user-specific filesystem path (a Spec-022 durable-tier PII class),
  -- so it never lands here, and the non-colocated key keeps the digest non-brute-forceable even
  -- from a database copy -- the McpServerBindingAuditRef.scopeRefDigest discipline, applied to the
  -- whole binding tuple rather than the scopeRef alone (api-payload-contracts.md §Plan-028).
  -- Deliberately EXCLUDES the config hash: a binding's config drifts while its identity does not,
  -- and a revocation triggered BY drift must still match receipts stamped before it, so the digest
  -- is stable for the binding's life. NULL means the tool resolved from no governed binding at all
  -- (a provider built-in, or a daemon-hosted callback tool) -- those rows are never neutralization
  -- candidates. Written from the same Plan-028 resolution output that supplies idempotency_class,
  -- so no new write seam is introduced (I-028-6, CP-028-7; Plan-028 T28.4.4 + T28.4.11, the column and
  -- its index created and populated by T28.4.12). The digest is KEYED, so key availability is part of
  -- the guarantee: if the binding-identity subkey is unavailable, a revocation cannot recompute which
  -- rows it covers, and every non-terminal digest-bearing row is neutralized to the floor rather than
  -- left dispatching under an authority the daemon can no longer identify (I-028-6).
  mcp_binding_digest TEXT                         -- NULL default; governed-binding provenance
                    CHECK (mcp_binding_digest IS NULL OR mcp_binding_digest GLOB 'b3:*'),
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;
-- Recovery sweep index: find in-flight receipts needing idempotency-class-based handling
CREATE INDEX idx_command_receipts_inflight ON command_receipts(run_id)
  WHERE started_at IS NOT NULL AND completed_at IS NULL;
-- Plan-028 neutralization lookup: on trust revocation, find every non-terminal receipt stamped with
-- the revoked binding so its stamped idempotency_class can be rewritten to the manual_reconcile_only
-- floor inside the revocation's own transaction (I-028-6). Partial on completed_at IS NULL because a
-- terminal receipt is never re-dispatched, so it is not a candidate.
CREATE INDEX idx_command_receipts_mcp_binding ON command_receipts(mcp_binding_digest)
  WHERE mcp_binding_digest IS NOT NULL AND completed_at IS NULL;
```

---

## Driver and Runtime Binding Tables (Plan-005)

```sql
-- Owner: Plan-005 | Extended by: Plan-015 (recovery-aware persistence)
-- Provider-output defense-in-depth CHECKs (Plan-005 T2.1): contract_version and
-- resume_handle are provider-declared strings persisted at the write seam. The
-- DB CHECK layer bounds the SQLite-expressible part (length + NUL-rejection);
-- semver-shape validation is NOT expressible as a pure-SQLite CHECK and is
-- enforced at the write seam Zod guard (T2.2 runtime_bindings) using the
-- `semver` package. The 4096/64 length literals are the canonical bounds that
-- the T2.2 write-path guard reuses, so the two layers stay consistent.
CREATE TABLE runtime_bindings (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  driver_name         TEXT NOT NULL,            -- e.g. 'claude', 'codex'
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of driver contract (build metadata rejected by the T2.2 write-path Zod guard)
                      CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT                      -- verbatim provider-reported CLI version captured at binding write (Spec-005 §Required Behavior `cliVersion` report, campaign B3); NULL only on pre-B3 rows — the write path stores the pair or neither
                      CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  cli_version_semver  TEXT                      -- parsed floor-compare form of the pair; the fail-closed floor gate (`driver.cli_version_unparseable`) runs before any binding write, so a stored pair is always parseable
                      CHECK ((cli_version_semver IS NULL) = (cli_version_raw IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  resume_handle       TEXT                      -- provider-owned opaque handle
                      CHECK (resume_handle IS NULL OR (length(resume_handle) > 0 AND length(resume_handle) <= 4096 AND instr(resume_handle, char(0)) = 0)),
  spawn_config        TEXT NOT NULL DEFAULT '{}', -- JSON: daemon-owned record of the spawn-bound configuration realized at process spawn (executionPosture / callbackTools / subagentPolicy / outputSchema + the admitted cap, plus providerAccountId and resolvedExecutablePath — minted now, valued later by Plan-005 T3.17 / T3.23); written at every spawn — the durable source recovery re-reads to reconstruct ResumeSessionParams' data legs without the original client request (function legs re-injected fresh, never stored; campaign B10 T1.7 catch-up migration, Codex rounds 3–4). Daemon-constructed, so no provider-string CHECK — same trust class as runtime_metadata below
  runtime_metadata    TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific recovery data
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

-- Owner: Plan-005
CREATE TABLE driver_capabilities (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation',
                      'structured_output', 'rollback', 'session_goals',
                      'callback_tools', 'subagents', 'cost_cap',
                      'transcript_replay', 'context_compaction',
                      'provider_commands', 'output_speed'
                    )),
  supported         INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1
                    -- Campaign-B3/B6 widening note: the catch-up migration that widens the CHECK above MUST
                    -- widen the CHECK to every value the union declares at that moment, all at once — a CHECK is a whitelist, so admitting a value before any
                    -- row uses it costs nothing and spares a second migration — and MUST backfill supported=0 rows for every existing driver_name (undeclared =
                    -- unsupported, I-005-2), since a cache whose row count differs from the union's breaks the hydrator's exact-cardinality guard before any refresh could heal it. The rows land in three waves
                    -- matching the three union widenings: the thirteen campaign flags at Plan-005 T1.7, transcript_replay when T3.19 widens the union (2026-08-26), and
                    -- context_compaction / provider_commands / output_speed when T3.26 widens it to seventeen (2026-08-29, the desktop-console parity amendment). That last
                    -- widening rebuilds an ALREADY-SHIPPED CHECK (migration 0011 froze it at fourteen), so it consumes a next-ordinal table-rebuild migration in the documented
                    -- lang_altertable shape rather than amending a CREATE — it adds no table and no column, and the local-SQLite table census does not move.
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
);

-- Owner: Plan-005
-- Per-tool metadata for the daemon's two-phase command-receipt protocol at
-- crash-recovery dispatch time (idempotency_class lookup without round-tripping
-- the driver per Spec-005 §Recovery Consequences). Normalized per-tool rows mirror the
-- per-flag-row shape of driver_capabilities.
CREATE TABLE driver_tools (
  driver_name        TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  idempotency_class  TEXT NOT NULL
                     CHECK(idempotency_class IN (
                       'idempotent', 'compensable', 'manual_reconcile_only'
                     )),
  description        TEXT,
  refreshed_at       TEXT NOT NULL,
  PRIMARY KEY (driver_name, tool_name)
);

-- Owner: Plan-005
-- Per-driver capability-contract metadata. The capability cache is keyed by driver_name
-- (driver_capabilities + driver_tools are per-driver children); this parent row holds the
-- single per-driver contract_version so cold-start hydration can reconstruct
-- GetCapabilitiesResult = { capabilities: { flags, contractVersion }, tools } WITHOUT
-- round-tripping the driver (Spec-005 §Recovery Consequences cache-as-source-of-truth). Distinct from
-- runtime_bindings.contract_version, which records the version bound to a specific run.
-- Provider-output defense-in-depth CHECK (Plan-005 T2.1): `contract_version`
-- mirrors the `runtime_bindings.contract_version` bound (length + NUL-rejection,
-- 64-char ceiling). Semver-shape validation lives at the T2.4 write-path Zod
-- guard (the `semver` package) — not expressible as a pure-SQLite CHECK.
-- `contract_version` is a CANONICAL, IDENTIFYING semver string: build metadata
-- (SemVer §10, non-identifying) is rejected by the T2.4 write-path Zod guard, so
-- two byte-different strings can never denote the same contract version (which
-- would otherwise spuriously fire `runtime_node.capability_updated` on a
-- non-change).
CREATE TABLE driver_contract_meta (
  driver_name         TEXT PRIMARY KEY,
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of the driver's advertised capability contract (build metadata rejected by the T2.4 write-path Zod guard)
                      CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT                      -- cached `cliVersion.raw` from the last capability refresh (Spec-005 §Required Behavior, campaign B3); NULL only on pre-B3 rows
                      CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  cli_version_semver  TEXT                      -- cached parsed form; cold-start hydration MUST treat a NULL pair as a cache miss and refresh from the driver — the required `GetCapabilitiesResult.cliVersion` is never fabricated from cache
                      CHECK ((cli_version_semver IS NULL) = (cli_version_raw IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  refreshed_at        TEXT NOT NULL             -- last contract-meta write: every capability-refresh write, plus the eventless cli_version pair-only currency refresh, so it may lead driver_capabilities.refreshed_at
);
```

The build-metadata rejection above is grounded in the SemVer specification itself: per [Semantic Versioning 2.0.0 §10](https://semver.org/#spec-item-10), "Build metadata MUST be ignored when determining version precedence. Thus two versions that differ only in the build metadata, have the same precedence." (fetched 2026-06-15). Because `1.2.3+build.5` and `1.2.3+build.6` denote the SAME contract version under that precedence rule, persisting them as byte-distinct `contract_version` strings would let a non-change masquerade as a change. The shared write-path Zod guard (`assertValidContractVersion`, invoked from both the T2.2 `runtime_bindings` and T2.4 `driver_contract_meta` write paths) therefore REJECTS — rather than strips/normalizes — any value carrying build metadata, keeping the stored value byte-identical to what was validated and both `contract_version` columns canonical-identifying.

---

## Audit Log Crypto Tables (Plan-006)

```sql
-- Owner: Plan-006 | Migration: 0005-daemon-signing-keys.ts (Tier 4 Phase 2)
-- Per-session daemon Ed25519 signing keypair. Private key is sealed via the
-- OS keystore master key (@napi-rs/keyring v1.2.0 per Spec-022 §Daemon Master Key — Keychain
-- kSecAttrAccessibleWhenUnlockedThisDeviceOnly on macOS / CRED_TYPE_GENERIC
-- CRED_PERSIST_LOCAL_MACHINE on Windows / Secret Service via libsecret +
-- kwallet6 + keyutils fallback on Linux). Public key is registered in the
-- session participant roster at join time per security-architecture.md
-- §Per-Event Daemon Signature. Sealed-key storage
-- lives in local SQLite (NOT shared-Postgres sessions) per ADR-004 SQLite-
-- local-state boundary — daemon-private secrets are per-machine.
-- rotated_at is reserved and unwritten in V1: no daemon signing-key rotation
-- ceremony is specified anywhere (a different-key registration is refused per
-- security-architecture.md §Per-Event Daemon Signature); only a future
-- rotation extension writes it.
-- Store lineage (Plan-008 EXTEND, CP-008-15 — 2026-08-12, Codex PR #323 round 3):
-- one row per NodeId this store has ever been registered under, so the
-- Spec-008 §Peer History Backfill serving selector can durably label
-- origin-authored (received_from_node_id NULL) rows in a carried-forward
-- store. At succession the registering daemon stamps the predecessor row's
-- superseded_at_sequence with the store's highest session_events.sequence
-- and inserts its own active (NULL-watermark) row: a NULL-marker row's
-- origin is the lineage row whose watermark window covers its sequence,
-- the open tail belonging to the active NodeId. The predecessor's
-- sealed_private_key is dead weight after carry (OS-keystore sealing is
-- per-machine, deliberately unrecoverable elsewhere); its public_key and
-- watermark are the durable lineage record. Additive migration: node_id
-- backfills to the daemon's current NodeId, PK widens (session_id) ->
-- (session_id, node_id) via SQLite table rebuild.
CREATE TABLE daemon_signing_keys (
  session_id          TEXT NOT NULL,
  node_id             TEXT NOT NULL,         -- NodeId this row's keypair was registered under (CP-008-15)
  public_key          BLOB NOT NULL,         -- Ed25519 32-byte public key
  sealed_private_key  BLOB NOT NULL,         -- Ed25519 private key sealed via OS keystore master key
  created_at          TEXT NOT NULL,
  rotated_at          TEXT,                  -- reserved; see rotation note above
  superseded_at_sequence INTEGER,            -- NULL = active row; else the succession watermark (CP-008-15)
  PRIMARY KEY (session_id, node_id)
);

-- Owner: Plan-006 | Migration: 0008-pending-anchor-uploads.ts (Tier 4 Phase 3)
-- Durable partition-tolerance queue for Merkle anchors awaiting control-plane upload. Unflushed
-- anchors survive daemon restart without re-signing per Plan-006 §Merkle Anchor Emission (its
-- partition-tolerance bullet: anchors queue locally on upload failure and flush on reconnect). The
-- (session_id, node_id, start_sequence, end_sequence) UNIQUE constraint makes the T3.3
-- anchorRange() force-fire path (consumed by T3.2 compactor's anchor-before-compaction protocol
-- per Spec-006 §Post-Compaction Integrity) idempotent against re-entry of an identical range (the
-- key dedups genuine re-fires only — coverage semantics in the constraint comment below).
-- Node-scope (sentinel session_id) chains queue their local Merkle anchors here too, as the durable
-- LOCAL witness. In V1 those sentinel-partitioned rows are NOT upload candidates -- the upload worker
-- selects session-scoped rows only (the sentinel cannot satisfy event_log_anchors' non-null session_id
-- FK, and node-scope control-plane witnessing is a V1.1 extension per ADR-017 §Node-Scope Anchor
-- Witnessing). Their uploaded_at stays NULL by design in V1.
CREATE TABLE pending_anchor_uploads (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  node_id             TEXT NOT NULL,
  start_sequence      INTEGER NOT NULL,
  end_sequence        INTEGER NOT NULL,
  merkle_root         BLOB NOT NULL,         -- BLAKE3 Merkle root over row_hash leaves (RFC 9162 §2.1.1 MTH: split at largest power of two, 0x00/0x01 domain separation)
  root_signature      BLOB NOT NULL,         -- Ed25519 by daemon_signing_keys.sealed_private_key over the anchor CLAIM ({endSequence, merkleRoot, nodeId, sessionId, startSequence}, RFC 8785) per Spec-006 §Anchoring Cadence (2026-08-11: coordinates signed, not merkle_root alone)
  anchored_at         TEXT NOT NULL,         -- daemon-local timestamp at anchor computation
  uploaded_at         TEXT,                  -- non-NULL once control-plane confirms upload to event_log_anchors
  -- Durable retry/backoff state (partition-anchor queue durability decision, resolved per Plan-006 §Open Authoring Decisions (Category 2 — Audit-Surfaced)): survives daemon
  -- restart so upload retry resumes and the last failure is queryable for operator triage post-restart.
  attempt_count       INTEGER NOT NULL DEFAULT 0, -- upload attempts since enqueue; drives exponential backoff
  last_attempt_at     TEXT,                  -- daemon-local timestamp of most recent upload attempt; NULL until first attempt
  last_error          TEXT,                  -- last upload failure detail (operator triage); NULL on success or before first attempt
  -- end_sequence is part of the key: a cadence anchor [1,1000] and a wider compaction-covering anchor [1,5000] share start_sequence=1 and MUST coexist.
  -- "Covering anchor exists" (Spec-006 §Post-Compaction Integrity step 1) is a COVERAGE query (start_sequence <= range_start AND end_sequence >= range_end), NOT an exact-start match; the key only dedups genuine re-fires of the identical range.
  UNIQUE (session_id, node_id, start_sequence, end_sequence)
);

CREATE INDEX idx_pending_anchor_uploads_pending
  ON pending_anchor_uploads(session_id, anchored_at)
  WHERE uploaded_at IS NULL;
```

---

## Runtime Node Local Tables (Plan-003)

```sql
-- Owner: Plan-003
CREATE TABLE node_capabilities (
  node_id           TEXT NOT NULL,
  capability_key    TEXT NOT NULL,
  capability_value  TEXT NOT NULL DEFAULT '{}', -- JSON
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (node_id, capability_key)
);

-- Owner: Plan-003
CREATE TABLE node_trust_state (
  node_id           TEXT NOT NULL PRIMARY KEY,
  trust_level       TEXT NOT NULL DEFAULT 'untrusted',
                    -- V1 value set ratified by the Tier-6 audit (Plan-012 D-012-15): 'untrusted' | 'envelope_trusted'.
                    -- The shipped 0002 migration carries no CHECK (a retroactive CHECK requires a table rebuild);
                    -- enforcement is at the seams: Plan-012 owns the elevation write (parse-at-boundary) and its
                    -- policy evaluator treats any out-of-set value as 'untrusted' (fail-closed read; Spec-012 §Fallback Behavior).
  established_at    TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

---

## Workspace and Git Tables (Plan-009, Plan-010, Plan-011)

```sql
-- Owner: Plan-009
CREATE TABLE repo_mounts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  node_id         TEXT NOT NULL,              -- owning runtime node (the node that can access the path)
  local_path      TEXT NOT NULL,              -- user-entered attach path (provenance)
  canonical_root  TEXT NOT NULL,              -- resolver output: absolute, symlink-resolved (envelope/dedupe key)
  vcs_type        TEXT NOT NULL DEFAULT 'git'
                  CHECK(vcs_type IN ('git', 'none')),
  state           TEXT NOT NULL DEFAULT 'attached'
                  CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}' -- JSON; commonDir: attach-persisted canonicalized git common directory — the repo-identity anchor bind/run re-derivation must match (Spec-009, PR #340; absent on pre-amendment rows, repaired at the first mutating contact per Spec-009's anchor-repair rule — health reads never write it)
);

CREATE INDEX idx_repo_mounts_session ON repo_mounts(session_id);
-- Active-mount uniqueness binds the CANONICAL root per owning node (Plan-009 D-009-7): two
-- entered aliases resolving to one root on one node are one mount; the same absolute path on two
-- different nodes is two distinct node-local filesystems (Spec-009 §State And Data Implications) and both attach;
-- detached rows stay re-attachable as new rows.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(session_id, node_id, canonical_root) WHERE state = 'attached';

-- Owner: Plan-009
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL DEFAULT 'read-only' -- read-only until a writable mode is explicitly selected (Spec-009; 'worktree' is the default WRITABLE run mode per ADR-006, not the row default)
                  CHECK(execution_mode IN ('read-only', 'branch', 'worktree', 'ephemeral clone')),
  fs_root         TEXT,                       -- resolved filesystem root
  state           TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK(state IN ('provisioning', 'ready', 'busy', 'stale', 'archived')),
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON; lastError detail on a failed mode switch (Spec-009); boundRoot: admitted bind origin — the branch-mode execution-root carrier, never cleared by reprovision (Spec-009/Spec-010, PR #340; absent on pre-amendment rows falls back to canonical_root); checkoutRoot: the current checkout's top level — derived at bind, rewritten when provisioning installs a provisioned root — the restore/tenancy normalized-root carrier (Spec-010; an absent pre-amendment key is derived at the run-setup gate from the just-materialized execution root's top level and healed back onto this key — never canonical_root, the bind-time checkout). It reaches the turn-snapshot callees by capture into run_execution_contexts.checkout_root at run setup, never by a callee reading this row: the tenancy comparison reads this column directly (node-local by construction — one node, one database), restore reads the run-context copy, which survives this workspace being reprovisioned or the nested bound path being deleted mid-turn (2026-08-17 amendment, CP-010-12 ⇄ CP-010-15)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);

-- Owner: Plan-010 (Tier-6 audit: provenance columns, active-branch uniqueness, cleanup stamp — D-010-5)
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,              -- creating-session provenance (Spec-010 §State And Data Implications; session ids are event-sourced — no FK, matching session_id columns elsewhere)
  created_by_run_id     TEXT,                       -- creating-run provenance; NULL = pre-run explicit prepare (run ids are event-sourced, not FK-constrained)
  branch_name           TEXT NOT NULL,
  fs_root               TEXT NOT NULL,              -- filesystem path to worktree (under the daemon execution-roots dir, D-010-6)
  state                 TEXT NOT NULL DEFAULT 'creating'
                        CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  cleaned_at            TEXT                        -- async disk-cleanup stamp (retire records state; the sweep stamps cleanup)
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- At most one live checkout per (mount, branch): mirrors git's own constraint — a checkout existing
-- on disk (any non-retired, non-failed state, including 'merged') still holds the branch. Race arbiter
-- for the provenance-split collision policy (Spec-010 §Resolved Questions).
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- Owner: Plan-010 (Tier-6 audit: TTL + cleanup bookkeeping — D-010-5)
CREATE TABLE ephemeral_clones (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  clone_root      TEXT NOT NULL,              -- filesystem path (under the daemon execution-roots dir, D-010-6)
  branch_name     TEXT NOT NULL,              -- head branch inside the clone (caller-supplied or slug-derived at prepare; the status read exposes it — Spec-010 §Interfaces)
  cleanup_policy  TEXT NOT NULL DEFAULT 'on_run_complete'
                  CHECK(cleanup_policy IN ('on_run_complete', 'manual')),
  state           TEXT NOT NULL DEFAULT 'creating'
                  CHECK(state IN ('creating', 'ready', 'retired', 'failed')),
  expires_at      TEXT NOT NULL,              -- TTL deadline (daemon config, default 24h; Spec-009 §Ephemeral Clone Lifecycle)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  cleaned_at      TEXT                        -- async disk-cleanup stamp
);

CREATE INDEX idx_ephemeral_clones_workspace ON ephemeral_clones(workspace_id);
CREATE INDEX idx_ephemeral_clones_sweep ON ephemeral_clones(state, expires_at);  -- cleanup-tick scan

-- Owner: Plan-010 | Extended by: Plan-011
-- Polymorphic root carrier (Tier-6 audit, D-010-5): worktree-mode rows reference the worktree,
-- ephemeral-clone rows the clone, branch-mode rows neither (the main checkout carries no Plan-010 root row).
CREATE TABLE branch_contexts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id        TEXT REFERENCES worktrees(id),
  ephemeral_clone_id TEXT REFERENCES ephemeral_clones(id),
  base_branch        TEXT NOT NULL,
  head_branch        TEXT NOT NULL,
  upstream_ref       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (worktree_id IS NULL OR ephemeral_clone_id IS NULL)
);

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;  -- one binding row per (workspace, worktree) — D-010-15 upsert; the worktree-keyed BranchContextRead resolves on the pair

-- Owner: Plan-010 (Tier-6 audit, D-010-16)
-- Per-run execution binding (Spec-010 §State And Data Implications: execution mode as run setup data):
-- which workspace/mode/root a repo-bound run executes against. run_id is event-sourced (runs live in
-- the event log, not a table) — PRIMARY KEY without FK. released_at stamps run-terminal release; a terminal-source rollback clears it atomically with the run's re-open, and a rollback composite ending without a confirmed rewind restores it (campaign B2 — Spec-004 §Required Behavior; the campaign's Plan-010 bundle owns the implementing task).
-- Migration lineage: the block below is the table's FINAL shape, not the content of any single migration. Every
-- column except checkout_root shipped in the version-4 four-table CREATE (Plan-010 T1.3, PR #253); checkout_root
-- lands via the Phase-3 table-rebuild migration (create successor -> copy omitting the column -> drop -> rename ->
-- recreate the index; `lang_altertable` §8 — Plan-010 T3.2, its only writer; 2026-08-17 amendment, shape corrected at
-- the NS-69 PR's round-1 fold), after which PRAGMA table_info order matches this block exactly.
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,                  -- event-sourced session id (no FK, matching session_id columns elsewhere)
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ('read-only', 'branch', 'worktree', 'ephemeral clone')),
  execution_root     TEXT NOT NULL,
  checkout_root      TEXT NOT NULL,                  -- the enclosing working tree's top level for execution_root, captured at context creation by the Plan-010 T3.2 gate from workspaces.metadata.checkoutRoot (absent on pre-amendment workspace rows → derived at the gate from the just-materialized execution root's top level, the carrier healed — never canonical_root, the bind-time checkout; Codex PR #346 round 2): the durable normalized root CP-010-15 restore consumes, so rollback survives the turn deleting a nested execution_root. Same durable-capture-at-context-creation pattern as git_common_dir, and likewise mode-agnostic — read-only rows carry it too, because the CP-010-4 checkout-keyed run tenancy and the I-010-14 gate are both mode-agnostic. Under CP-010-12 the caller reads it from this row (beside execution_root and execution_mode) and passes it to the pure capture/restore callees, which never read workspace state themselves. Added by the Phase-3 table-rebuild migration that lands T3.2, not by the version-4 four-table CREATE (2026-08-17 amendment; shape corrected at the NS-69 PR's round-1 fold — the ALTER documentation refuses ADD COLUMN ... NOT NULL without a default unconditionally, and the empty-table allowance the bundled engine exhibits is undocumented, so the rebuild's documented semantics replace it): the successor table declares this column with no sentinel default, and the copy step omits it, so any pre-existing row fails the engine-enforced NOT NULL at copy time rather than back-filling a lie — vacuously clean in practice, since no writer of this table has ever shipped and every deployed instance holds it row-less. Declared here in its LOGICAL position beside execution_root, which after the rebuild is also its physical PRAGMA table_info position — no retention_class-style CID-last divergence; the migration-shape column pin asserts the identical order
  git_common_dir     TEXT NOT NULL,                  -- `git rev-parse --git-common-dir` (absolute) captured at context creation: the surviving canonical git dir for snapshot-ref ops, so Plan-010 T5.3 ref pruning outlives a worktree retirement of execution_root (worktree mode → main repo git dir; branch/read-only → <root>/.git; ephemeral clone → the clone's own git dir, refs sharing the clone's disposal lifecycle)
  worktree_id        TEXT REFERENCES worktrees(id),
  ephemeral_clone_id TEXT REFERENCES ephemeral_clones(id),
  branch_context_id  TEXT REFERENCES branch_contexts(id),
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- Mode-conditional identity (Tier-6 audit): the mode names exactly which root id is
  -- present, and every writable mode carries its branch context (Spec-010 §State And
  -- Data Implications); read-only carries none of the three.
  CHECK (
    (execution_mode = 'read-only' AND worktree_id IS NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NULL)
    OR (execution_mode = 'branch' AND worktree_id IS NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'worktree' AND worktree_id IS NOT NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'ephemeral clone' AND ephemeral_clone_id IS NOT NULL AND worktree_id IS NULL AND branch_context_id IS NOT NULL)
  )
);

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);

-- Owner: Plan-011
CREATE TABLE diff_artifacts (
  id                    TEXT PRIMARY KEY,
  artifact_manifest_id  TEXT NOT NULL REFERENCES artifact_manifests(id),  -- every diff_artifact links to its minted manifest (CP-011-2; the diff is the manifest's payload, D-014-1 never-payload-less). The session is reached via this FK (artifact_manifests.session_id NOT NULL); a manifest-less row would be session-unreachable.
  run_id                TEXT,                 -- nullable: present for run_attributed, absent for workspace_fallback (Spec-011:44/58 — a fallback artifact must not imply precise run attribution; D-011-2)
  workspace_id          TEXT REFERENCES workspaces(id),  -- nullable mirror of run_id: present for workspace_fallback (the durable workspace-level provenance Spec-011:44 mandates — D-011-4 persists what the wire's workspace_fallback.workspaceId carries; the prior schema dropped it, treating the workspace as a transient mint-time resolver), null for run_attributed (whose workspace is reachable via the run's run_execution_contexts.workspace_id). FK because workspaces is table-backed, unlike event-sourced run_id/session_id.
  attribution_mode      TEXT NOT NULL         -- Spec-011:52/58 provenance quality (D-011-2)
                        CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback')),
  base_ref              TEXT NOT NULL,
  head_ref              TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  CHECK(
    (attribution_mode = 'run_attributed' AND run_id IS NOT NULL AND workspace_id IS NULL)
    OR (attribution_mode = 'workspace_fallback' AND run_id IS NULL AND workspace_id IS NOT NULL)
  )  -- biconditional (D-011-2, D-011-4): run_attributed binds to its originating run (its workspace reached via that run's run_execution_contexts.workspace_id, so workspace_id is null); a workspace_fallback artifact MUST NOT carry a run_id (else it would imply the precise attribution it explicitly lacks, contradicting the run_id comment above + Spec-011:44/52/58) and MUST carry workspace_id (the durable workspace-level label, mirroring the wire union). The prior one-way form (<> OR) admitted a fallback row with a non-null run_id; the prior schema also dropped workspace_id entirely (KscWH).
);

CREATE INDEX idx_diff_artifacts_run ON diff_artifacts(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_diff_artifacts_workspace ON diff_artifacts(workspace_id) WHERE workspace_id IS NOT NULL;

-- Owner: Plan-011
CREATE TABLE pr_preparations (
  id                  TEXT PRIMARY KEY,
  branch_context_id   TEXT NOT NULL REFERENCES branch_contexts(id),
  state               TEXT NOT NULL DEFAULT 'draft'
                      CHECK(state IN ('draft', 'ready', 'submitted', 'merged', 'abandoned')),
  proposal_blob       TEXT,                   -- JSON: title, description, reviewers
  target_branch       TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_pr_preparations_branch ON pr_preparations(branch_context_id);
```

---

## Artifact Tables (Plan-014)

```sql
-- Owner: Plan-014
-- Tier-7 audit (NS-19): + subject, size_bytes, annotations realize the OCI manifest envelope (D-014-1, D-014-2);
--   + replication_status realizes the Spec-014 §Fallback Behavior manifest-first replication surface (A-014-3) — nullable;
--   the multi-state CHECK the audit deferred (anti-fabrication) arrived 2026-07-08: the cross-node relay
--   amendment spec-names the full value set (Spec-014 §Cross-Node Artifact Relay (V1)); see note below;
--   + relay_cek_ciphertext arrived 2026-07-09 (publisher-retained CEK, Spec-014 Publish step 1).
CREATE TABLE artifact_manifests (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  run_id             TEXT,
  created_by         TEXT,                       -- participant_id of the publishing caller; NULL for a daemon-produced artifact with no attributable caller. The permission-matrix Delete own-artifacts scope evaluates this column FAIL-CLOSED: NULL matches no collaborator, so only the owner role deletes it (PR #341 round 2 — a rule the store carries no data to evaluate is prose, not policy)
  artifact_type      TEXT NOT NULL              -- Spec-014 §Interfaces And Contracts discriminator (D-014-4)
                     CHECK(artifact_type IN ('file', 'diff', 'summary', 'log', 'design', 'workflow_output')),
  subject            TEXT REFERENCES artifact_manifests(id),  -- OCI `subject`: NULL for originals; a derivative (redacted/summarized shareable form) points to its source manifest, never an in-place UPDATE of the original (I-014-2, Spec-014 §State And Data Implications, A-014-4)
  visibility         TEXT NOT NULL DEFAULT 'local-only'
                     CHECK(visibility IN ('local-only', 'shared')),
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK(state IN ('pending', 'published', 'superseded')),
  content_hash       TEXT NOT NULL,              -- SHA-256 content address (OCI `digest`); intrinsic to a content-addressed manifest (I-014-1), set at insert by the writing producer (AttachmentIngest or ArtifactPublish) from its own payload — D-014-1
  size_bytes         INTEGER NOT NULL,           -- OCI manifest-descriptor `size` (payload byte length); set at insert by the writing producer from its own payload, never a payload-less row — D-014-1
  annotations        TEXT NOT NULL DEFAULT '{}', -- OCI `annotations`: JSON-encoded string→string map (first-class OCI manifest property, not freeform `metadata`) — D-014-1, D-014-2
  replication_status TEXT                        -- A-014-3 surface; value set spec-named by the 2026-07-08 relay amendment (mirrors ArtifactManifest.replicationStatus?: pending_replication while payload transfer is pending; pinned once every chunk is relay-acknowledged — the offline-availability guarantee attaches only to a LIVE relay pin (state = 'pinned' AND expires_at > now(), Spec-014 §TTL sweep disposition (V1), bounded 2026-08-26) and ends at the artifact's retention TTL, so this row can still read pinned after the relay has released the bytes, which is exactly why the fetch-path write-back below exists; over_cap / quota_exceeded = honest publisher-local degradation; expired = payload not obtainable from the relay, written on THIS node by its own fetch path on EITHER refusal that establishes it — artifact.relay_expired (410) at the mint, a chunk GET, or a resume; or a zero-row artifact.no_access_key (404), which is where a fetch lands once a GC path has removed the blob row and its recipient rows have cascaded away with it — refcount-zero delete, watermark eviction, or a TTL tombstone already purged past relay_tombstone_grace, while a TTL-swept blob still inside that grace takes the typed 410 instead (narrowed 2026-08-26) — because the relay's TTL sweep and watermark eviction run past the node boundary and emit no event, so a recipient learns of expiry only by fetching; every node holds its own row under manifest-first replication and its daemon is that row's only writer, the transition applies only to a pinned row, is idempotent, and an ordinary re-publish re-pin returns it to pinned, so the column tracks availability rather than latching (writer named 2026-08-17 by the ingest-protocol hardening amendment — the value was already in the CHECK below and had no recipient-side writer, which left the unresolved-attachment marker's expired cause unreachable). NULL = local-only artifact with no replication surface.
                     CHECK(replication_status IN ('pending_replication', 'pinned', 'over_cap', 'quota_exceeded', 'expired')),
  relay_cek_ciphertext BLOB,                  -- publisher-retained CEK for the relay pin, wrapped by the Spec-022 daemon master key; NULL for local-only artifacts, set at the first relay-bound publish — before any pin: a solo-session publish uploads nothing and stays pending_replication yet retains the CEK, so the first re-publish performs the initial pin under the SAME CEK. Re-publish re-wraps this SAME CEK for new recipients (the pinned ciphertext is under it; the relay holds only recipient-wrapped copies) — without it the publisher could not extend late-join access except by re-encrypting + re-uploading under a fresh key. Deliberately not a per-participant erasure target: dies with the manifest row or the daemon master key (Spec-022 §PII Data Map artifact-payload posture). Spec-014 Publish step 1.
  metadata           TEXT NOT NULL DEFAULT '{}', -- JSON: freeform daemon-side provenance/media-type/etc. — distinct from the OCI `annotations` map (own column above)
  created_at         TEXT NOT NULL,
  CHECK(subject IS NULL OR subject <> id)        -- I-014-2: a derivative points to a *distinct* source manifest, never itself (no self-referential subject; same guard pattern as run_links parent<>child)
);

CREATE INDEX idx_artifact_manifests_session ON artifact_manifests(session_id);
CREATE INDEX idx_artifact_manifests_run ON artifact_manifests(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_artifact_manifests_hash ON artifact_manifests(content_hash);
CREATE INDEX idx_artifact_manifests_subject ON artifact_manifests(subject) WHERE subject IS NOT NULL;

-- Owner: Plan-014
CREATE TABLE artifact_payload_refs (
  id              TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES artifact_manifests(id),
  storage_path    TEXT NOT NULL,              -- filesystem path or CAS key
  media_type      TEXT NOT NULL,              -- MIME type
  size_bytes      INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_artifact_payload_refs_manifest ON artifact_payload_refs(manifest_id);
-- 2026-08-17 (PR #341 round 2): the derived-refcount lookup key — ArtifactDelete and the session sweep
-- count surviving references by storage_path on every reclaim decision (Spec-014 §Local Artifact
-- Deletion And CAS Reclaim (V1)), and an unindexed lookup would full-scan the table each time.
CREATE INDEX idx_artifact_payload_refs_storage_path ON artifact_payload_refs(storage_path);

-- Owner: Plan-014 (2026-07-09 cross-node relay amendment)
-- The daemon-local durable artifact-encryption keypair — one row per participant on this node
-- (node scoping is the database itself: each daemon holds its own store). Relay CEKs are wrapped
-- to this key, NEVER to the ADR-010 session-ephemeral X25519 keys (those are zeroed at session
-- end — wrapping to them would orphan every relay-held CEK on the first restart and silently
-- void the offline-fetch guarantee). The private half is wrapped by the Spec-022 daemon master
-- key (same custody + backup-exclusion posture as participant_keys); the public half is announced
-- in-session as an Ed25519-identity-signed attestation (Spec-014 Publish step 3). Rotation
-- RETIRES rather than replaces: a rotated-out key stays in this table (retired_at set, never used
-- for new wraps) until every artifact_relay_recipients row bearing its thumbprint is delivered or
-- TTL-expired — bounded by the 30 d 'extended'-tier ceiling — because a within-TTL pinned blob
-- wrapped to it must stay fetchable while the publisher is offline. Hence one row per
-- (participant, key_thumbprint), not one per participant; exactly one active row per participant.
-- Erasure is participant-keyed, so it destroys active and retired keys together (Spec-022 Path 1).
CREATE TABLE artifact_encryption_keys (
  participant_id        TEXT NOT NULL,
  key_thumbprint        TEXT NOT NULL,   -- matches artifact_relay_recipients.key_thumbprint (post-restart/rotation key selection)
  encrypted_private_key BLOB NOT NULL,   -- X25519 private half, master-key-wrapped (nonce || ciphertext || tag — the D-022-2 wire form)
  public_key            BLOB NOT NULL,   -- X25519 public half (attested to session peers)
  created_at            TEXT NOT NULL,
  retired_at            TEXT,            -- NULL = the active key; non-NULL = retained for undelivered/within-TTL blobs only
  PRIMARY KEY (participant_id, key_thumbprint)
);

-- Exactly one active (non-retired) artifact key per participant on this node.
CREATE UNIQUE INDEX idx_artifact_encryption_keys_active
  ON artifact_encryption_keys(participant_id) WHERE retired_at IS NULL;
```

> **Tier-7 audit (NS-19) — ratified design (Plan-014 → `approved`).** `artifact_manifests.subject` (OCI `subject`, self-referential FK — derivative-not-mutation per I-014-2, guarded by a table-level `CHECK(subject IS NULL OR subject <> id)` so no manifest is its own subject — a derivative must point to a _distinct_ source, the same self-reference guard pattern as `run_links` parent≠child), `artifact_manifests.size_bytes` (OCI manifest-descriptor `size`), and `artifact_manifests.annotations` (OCI `annotations`, a first-class string→string map per the [OCI image-manifest spec](https://github.com/opencontainers/image-spec/blob/main/manifest.md)) realize the OCI envelope per D-014-1. **`content_hash`/`size_bytes` are `NOT NULL`:** a content-addressed manifest's `digest` is intrinsic to its identity (I-014-1), and each producer (Plan-014 Task 2 AttachmentIngest, Task 3 ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref — the two are independent producers, each writing its own manifest (so the `artifactId` AttachmentIngest returns resolves from the ingest-written manifest, not a later publish), so neither is ever NULL and no payload-less manifest is ever read — this is 1:1 with the **required** `digest`/`size` fields on the `ArtifactManifest` wire shape ([api-payload-contracts.md](../contracts/api-payload-contracts.md)). **D-014-2 (OCI `annotations` reciprocity):** `annotations` is its own column rather than riding inside `metadata` JSON, so the at-rest shape is 1:1 with the wire — `ArtifactReadResponse.annotations` is a field distinct from `metadata` in [api-payload-contracts.md](../contracts/api-payload-contracts.md) — and consistent with `subject`/`size_bytes` getting dedicated columns; `metadata` stays purely freeform. `artifact_manifests.replication_status` (A-014-3) realizes the `Spec-014 §Fallback Behavior` manifest-first replication surface — the column exists (spec-required: shared artifacts replicate manifest-first with deferred payload, `Spec-014 §Resolved Questions and V1 Scope Decisions` + `Spec-014 §Fallback Behavior`), nullable, and V1 writes the spec-named `pending_replication` while a shared artifact awaits payload transfer; it surfaces on the wire as the optional `ArtifactManifest.replicationStatus?` field (1:1 at-rest↔wire). It carried **no multi-state `CHECK`** at the audit: `Spec-014 §Fallback Behavior` named only `pending_replication` ("or equivalent"), so terminal/failed values were a deferred owner refinement — none was invented there (anti-fabrication). This schema edit + the `api-payload-contracts.md` artifact-wire edit + Plan-014 CP-014-1 landed as one ratified bundle in the NS-19 audit swap. **(2026-07-08: the deferred refinement arrived — the [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) amendment spec-names the full value set `pending_replication | pinned | over_cap | quota_exceeded | expired`, so the CHECK above now exists; the wire mirror stays `ArtifactManifest.replicationStatus?`.)**

---

## Approval Tables (Plan-012)

The 9 canonical approval categories: `tool_execution`, `file_write`, `network_access`, `destructive_git`, `user_input`, `plan_approval`, `mcp_elicitation`, `gate`, `human_phase_contribution`.

```sql
-- Owner: Plan-012 (amended by the Tier-6 plan-readiness audit, D-012-2)
CREATE TABLE approval_requests (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,        -- owning session (Spec-012 line 58; Spec-006 §Approval Flow payload; projection key);
                                              -- no local FK target (sessions are control-plane rows per ADR-004)
  run_id                TEXT NOT NULL,        -- no REFERENCES: run state is event-sourced (ADR-017; interventions precedent)
  requested_by          TEXT NOT NULL,        -- requester actor (participant or agent actor id; Spec-012 line 58)
  category              TEXT NOT NULL
                        CHECK(category IN (
                          'tool_execution', 'file_write', 'network_access', 'destructive_git',
                          'user_input', 'plan_approval', 'mcp_elicitation', 'gate',
                          'human_phase_contribution'                              -- SA-12 addition; mirrors Spec-012 canonical enum
                        )),
  scope                 TEXT NOT NULL,        -- requested scope descriptor
  resource_descriptor   TEXT NOT NULL DEFAULT '{}', -- target resource details (JSON; Spec-012 line 96 'must include')
  ask_id                TEXT,                 -- originating driver_ask askId, set iff the request was minted by the
                                              -- CP-012-6 driver-ask normalizer (Spec-012 §Resolved Questions, Part-B
                                              -- fail-closed follow-up 2026-07-17); rebuilt from approval.requested.askId
                                              -- at replay (D-012-6/D-012-7) so outcome/expiry routing to the native
                                              -- ask survives restart with multiple in-flight asks on one run
  expiry_at             TEXT,                 -- ISO 8601, nullable for no-expiry (equals the ask's expiresAt when
                                              -- ask_id is set — the Spec-012 one-shared-deadline rule)
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK(state IN ('pending', 'approved', 'rejected', 'expired', 'canceled')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,        -- last state-transition instant (expiry/cancel carry no resolution row)
  CHECK (ask_id IS NULL OR expiry_at IS NOT NULL)
                                              -- an ask-associated (normalizer-minted) row always carries the shared
                                              -- deadline: ask_id without expiry_at could never re-arm the durable
                                              -- timeout after restart, re-creating an unbounded pending ask
                                              -- (Spec-012 Part-B fail-closed follow-up 2026-07-17; replay-side
                                              -- backstop — the approval-flow emission refinement enforces the same
                                              -- askId ⇒ expiryAt pairing origin-blind at parse, so an invalid mint
                                              -- refuses before it is durable; the T1.3 migration copies this CHECK
                                              -- verbatim and pins it in its tests)
);

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);
CREATE INDEX idx_approval_requests_session ON approval_requests(session_id);
CREATE INDEX idx_approval_requests_state ON approval_requests(state) WHERE state = 'pending';
CREATE UNIQUE INDEX idx_approval_requests_ask ON approval_requests(run_id, ask_id) WHERE ask_id IS NOT NULL;
-- UNIQUE (run_id, ask_id): exactly one approval row per native ask — a normalizer retry or replay
-- re-mint collides here instead of persisting a duplicate pending row whose outcome/expiry routing
-- would then fan out or pick arbitrarily (Spec-012 one ask↔one approval; duplicate-normalization test
-- rides the T1.3 migration suite)

-- Owner: Plan-012
CREATE TABLE approval_resolutions (
  request_id               TEXT PRIMARY KEY REFERENCES approval_requests(id),
                                              -- PK = the durable wire id (approvalRequestId): enforces the 1:1 decision row
                                              -- and keeps every column event-derivable for peer/replay rebuild (I-012-9).
                                              -- A D-012-19 multi-principal conjunction spans one such row per member
                                              -- request; the wait-for-all aggregate settles across rows, never as
                                              -- multiple resolutions on one row
  approver_id              TEXT NOT NULL,     -- participant recorded as approver (D-012-12: node-owner binding on the
                                              -- local socket; verified PASETO sub on authenticated surfaces; Spec-012 line 97)
  decision                 TEXT NOT NULL
                           CHECK(decision IN ('approved', 'rejected')),
  effective_scope          TEXT NOT NULL,     -- granted scope; = request scope unless approver narrowed it (Spec-012 line 59);
                                              -- never broader than requested (domain invariant; Phase-2 enforced)
  remembered_scope_kind    TEXT               -- 'run' | 'session' when remembering was requested; NULL otherwise (Spec-012 line 118)
                           CHECK(remembered_scope_kind IS NULL OR remembered_scope_kind IN ('run', 'session')),
  remembered_scope_pattern TEXT,              -- resource-matching pattern for the remembered rule, nullable
  resolved_at              TEXT NOT NULL,
  audit_metadata           TEXT NOT NULL DEFAULT '{}' -- JSON: audit trail
);

-- Owner: Plan-012
CREATE TABLE remembered_approval_rules (
  id                         TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL,   -- rules are session-scoped (Spec-012 line 82); membership-invalidation key
  participant_id             TEXT NOT NULL,   -- the GRANTOR (approver who opted in); audit + membership-invalidation key AND the actor-axis
                                              -- match key: a rule matches only when the adjudicating turn's effective principal equals it, so
                                              -- one participant's grant never authorizes another's direction (D-012-10; Spec-012 §Required Behavior).
                                              -- Grantor = beneficiary by construction: the request was addressed to that principal (D-012-12)
  node_id                    TEXT NOT NULL,   -- executing node whose trust envelope the grant rides; node-trust-invalidation key (Spec-012 line 91)
  run_id                     TEXT,            -- originating run; NOT NULL iff scope_kind = 'run' (the Spec-012 line 111 'this run only' binding)
  created_from_request_id    TEXT NOT NULL REFERENCES approval_resolutions(request_id), -- origin decision (Spec-012 line 106 audit history); the durable wire id carried on approval.remembered, so the FK rebuilds byte-equal from events alone (I-012-9)
  category                   TEXT NOT NULL
                             CHECK(category IN (
                               'tool_execution', 'file_write', 'network_access', 'destructive_git',
                               'user_input', 'plan_approval', 'mcp_elicitation', 'gate',
                               'human_phase_contribution'                              -- SA-12 addition; mirrors Spec-012 canonical enum
                             )),
  scope_kind                 TEXT NOT NULL
                             CHECK(scope_kind IN ('run', 'session')),  -- explicit enum, not free-form (Spec-012 line 118)
  scope_pattern              TEXT,            -- resource-matching pattern within the kind boundary; NULL = category-wide within
                                              -- (session, node, participant, kind); semantics are category-derived (D-012-10)
  granted_at                 TEXT NOT NULL,
  revoked_at                 TEXT,            -- nullable; set when rule is invalidated
  invalidation_trigger       TEXT
                             CHECK(invalidation_trigger IS NULL OR invalidation_trigger IN
                               ('explicit', 'membership_change', 'node_trust_change', 'session_end')),
  CHECK((revoked_at IS NULL) = (invalidation_trigger IS NULL)),  -- co-presence: a revocation always records its trigger
  CHECK((scope_kind = 'run') = (run_id IS NOT NULL))             -- run-kind rules bind to their originating run
);

CREATE INDEX idx_remembered_rules_participant ON remembered_approval_rules(participant_id, category);
CREATE INDEX idx_remembered_rules_session ON remembered_approval_rules(session_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_remembered_rules_node ON remembered_approval_rules(node_id) WHERE revoked_at IS NULL;
```

---

## Credential Policy Artifacts (Plan-012)

Content-addressed store for the credential-policy artifact documents that `executionPosture.credentialPolicyRef` cites ([Spec-012 §Required Behavior](../../specs/012-approvals-permissions-and-trust-boundaries.md#required-behavior), campaign B20 posture semantics; store authored by campaign B13). A row persists **write-ahead** — before the first `run.running` posture stamp citing its ref (the ADR-019 spawn-intent ordering discipline), so a stamped ref can never dangle — and is retained at least as long as any run event citing it (the audit-stub retention class governs compaction/shred). Content addressing makes rows immutable and self-deduplicating by construction: identical policy ⇒ identical ref, so re-resolution INSERTs idempotently by primary key, and two runs carrying the same ref carried the same effective policy.

```sql
-- Owner: Plan-012 (campaign B13, 2026-07-20)
CREATE TABLE credential_policy_artifacts (
  ref         TEXT PRIMARY KEY    -- content address: 'sha256:<hex>' over the RFC 8785 JCS-canonicalized
              NOT NULL,           -- artifact document stored in `artifact` (Spec-012 §Required Behavior);
                                  -- identical policy ⇒ identical ref — immutable, self-deduplicating.
                                  -- NOT NULL is explicit: a TEXT PRIMARY KEY on a rowid table admits
                                  -- NULL (SQLite legacy quirk) and a NULL-valued CHECK passes
  artifact    TEXT NOT NULL,      -- the JCS-canonicalized document bytes verbatim:
                                  -- {schemaVersion: 1, denyPaths: [...], denyEnvVars: [...], envNameMatch: ...}
                                  -- (daemon-expanded canonical absolute denyPaths; denyEnvVars canonicalized to
                                  -- the host's env-name case semantics with the match mode recorded as
                                  -- envNameMatch; both arrays lexicographically sorted + deduped pre-hash) —
                                  -- the ref re-verifies from these stored bytes
  created_at  TEXT NOT NULL,
  CHECK (                         -- the ref format is load-bearing: posture stamps cite it verbatim.
    length(ref) = 71              -- 'sha256:' (7) + 64 hex chars; a LIKE prefix test would admit an
    AND substr(ref, 1, 7) = 'sha256:'  -- empty/non-hex suffix and case variants (SQLite LIKE is
    AND substr(ref, 8) NOT GLOB '*[^0-9a-f]*'  -- ASCII-case-insensitive); GLOB is case-sensitive,
  )                               -- so uppercase hex and 'SHA256:' both reject (Plan-012 T2.9 tests)
);
```

No `REFERENCES` clauses: citing runs are event-sourced (`run.running` posture stamps in `session_events`), so retention is enforced at the event-deletion boundary, never by an FK to a table that does not exist: compaction never frees a ref (the audit stub preserves the posture object, ref included), the Plan-022 crypto-shred clears `pii_payload` only (citing rows survive), and Plan-012 T2.9's `pruneUnreferencedArtifacts` — an idempotent maintenance entry invoked at the V1.1 `gdpr.sessionPurge` completion, the only operation that removes citing rows (V1 reserves the stub, so V1 retention is indefinite and bounded by the store's one-row-per-distinct-policy content addressing) — deletes rows whose ref no remaining event row or stub cites.

---

## Cross-Node Dispatch Tables (Plan-027)

Stores per-daemon ApprovalRecord envelopes for Spec-024. The same logical dispatch may produce one caller-local row and one target-local row, distinguished by `local_role`. Dispatch payloads, action payloads, and result payloads are not stored here; the durable audit artifact is the dual-signed ApprovalRecord envelope plus lifecycle metadata.

```sql
-- Owner: Plan-027
CREATE TABLE cross_node_dispatch_approvals (
  id                    TEXT PRIMARY KEY,
  dispatch_id           TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  local_role            TEXT NOT NULL
                        CHECK(local_role IN ('caller', 'target')),
  caller_participant_id TEXT NOT NULL,
  target_participant_id TEXT NOT NULL,
  target_node_id        TEXT NOT NULL,
  capability            TEXT NOT NULL,
  request_body_hash     TEXT NOT NULL CHECK(request_body_hash GLOB 'b3:*'),
  approval_record_json  TEXT,                 -- JSON: Spec-024 dual-token ApprovalRecord envelope; NULL until decision
  caller_token_jti      TEXT NOT NULL,
  approver_token_jti    TEXT,                 -- NULL until target-owner decision exists
  decision              TEXT
                        CHECK(decision IS NULL OR decision IN ('allow', 'deny')),
  state                 TEXT NOT NULL DEFAULT 'requested'
                        CHECK(state IN (
                          'requested', 'approved', 'denied', 'executed',
                          'completed', 'failed', 'expired', 'rejected'
                        )),
  created_at            TEXT NOT NULL,
  resolved_at           TEXT,
  expires_at            TEXT NOT NULL,
  UNIQUE(dispatch_id, local_role)
);

CREATE INDEX idx_cross_node_dispatch_approvals_session_state
  ON cross_node_dispatch_approvals(session_id, state);

CREATE INDEX idx_cross_node_dispatch_approvals_target
  ON cross_node_dispatch_approvals(target_node_id, state);

CREATE INDEX idx_cross_node_dispatch_approvals_expiry
  ON cross_node_dispatch_approvals(expires_at)
  WHERE state IN ('requested', 'approved', 'executed');
```

Caller-local durable record of an outbound cross-node dispatch whose result the caller has not yet observed, backing the run-idle exemption (campaign B17). While an open row — `closed_at IS NULL` **and** `expires_at > now` — names a run as its **originating run**, the `runHasPendingCrossNodeDispatch(runId)` predicate holds and the run-idle sweep hard-skips that run (per [Spec-024 § Cross-Node Failure Semantics](../../specs/024-cross-node-dispatch-and-approval.md#cross-node-failure-semantics); consumed by [Plan-016](../../plans/016-multi-agent-channels-and-orchestration.md) T2.7's idle-reaper seam — a hard skip, not an activity-timestamp bump). The expiry bound is **part of the predicate**, not merely a sweep side effect: an overdue open row (past `expires_at`, not yet closed by the expiry sweep) does not satisfy the predicate, so a caller restarting after the deadline never hard-skips the run on a stale row before the sweep has run — a restarting daemon rebuilds its idle timers fresh, so the lapse is safe across restart. On a **live** daemon the same lapse ends the exemption at the deadline while the `expiry_bound` close follows only on the next sweep; the fresh-idle-window guarantee therefore keys on that exemption **end**, not the row close, and the sweep's first encounter with an overdue open row re-arms the originating run rather than reaping it (the consumer-side re-arm lands with campaign B15). The daemon writes the row **before** the relay send (INSERT-before-relay-write ordering), so the initiating run's idle-exemption is durable across a caller restart at any point in the send path — a crash between the intent record and the relay write still leaves the run correctly idle-protected until its window closes. On send success the daemon then commits a **caller-local outbox** — one SQLite transaction stamps `sent_at` and appends the base-payload `dispatch.sent` event together — so the row marker and its audit event are all-or-nothing: a crash before the transaction leaves neither, after leaves both, never a half state where the row records delivery without the event or the event without the marker. `sent_at` is orthogonal to closure — a row may be open-unsent, open-sent, closed-sent, or closed-unsent — so no CHECK couples it with `closed_at`; a `send_failed` close specifically implies `sent_at` NULL by construction, since the marker is stamped only on the send-success path a synchronous failure never reaches. This record backs the run-idle hard-skip; it is **not** a resend outbox — the caller token and action payload are deliberately not retained here (see the custody sentence below), so a dispatch lost before its relay send is bounded by `expires_at` rather than silently resent or protecting the run indefinitely. The row is **closed in place** at conclusion — `closed_at` / `close_reason` stamped, the row is never deleted at close — so a restart rebuilds each run's open pending window from the open rows alone and never resurrects a concluded window. The terminal-observation event append (`dispatch.result_observed`, or `dispatch.approval_observed` for a denial) and this row's closure **commit in one SQLite transaction**: restart rebuilds from the rows alone, so a non-atomic close would either idle-protect a concluded dispatch to its expiry bound (event appended, row still open) or destroy the only recovery record before its audit event exists (row closed, event lost). This single-transaction atomicity is scoped to **terminal-observation** closes (`close_reason = 'observed_terminal'`) — the only closes that append an event; the other two close reasons append nothing and carry no atomicity obligation: the expiry sweep's `expiry_bound` close of an unobserved window, and the `send_failed` close, where a synchronous relay-send failure is caller-observed but precedes `dispatch.sent`, so (Spec-006 registers no send-failure event, and a terminal the caller never observes appends nothing) the caller closes the row in place immediately — the closed row standing as the durable record — rather than holding the run idle-protected to the expiry bound, with the expiry sweep remaining the backstop only for a crash during send. A terminal observed **after** the row has already closed (**any** `close_reason` — including an ambiguous `send_failed` whose frame in fact reached the target) or been pruned — the target's buffered-delivery window equals the caller's `expires_at`, so clock skew or delivery latency can straddle the edge — does not mutate, reopen, or re-close the row: the verified observation appends its `dispatch.result_observed` / `dispatch.approval_observed` event **idempotently, event-only**, deduped per `dispatch_id` against the prior event (an `observed_terminal` row implies its event exists; post-prune the event log is the dedupe source), so the audit trail is fulfilled while closed-in-place and never-resurrect hold and the restart rebuild (rows alone) is untouched. Event-only acceptance is **bounded to one expiry-sweep interval past `expires_at`**: a verified terminal arriving beyond that window is rejected **out-of-window** with a diagnostic and appends nothing — the target's buffered-delivery bound already ends at `expires_at` (= `caller_token.exp` + the 5-minute result-buffer window), so the bound rejects only replays or anomalies, never a legitimate delivery, and within it the event log still holds full `dispatch_id` payloads (Spec-006's compaction thresholds of 50,000 events / 500 MB / 90 days — [Spec-006 § Event Compaction Policy](../../specs/006-session-event-taxonomy-and-audit-log.md#event-compaction-policy) — sit orders of magnitude past it), so the dedupe source is provably sufficient with no Spec-006 change. If that observation is the first proof of delivery for a row whose `dispatch.sent` was never recorded (`sent_at` NULL, or post-prune absent from the log), the same transaction appends a late-repaired `dispatch.sent` immediately before the observation event; a dispatch that never yields a verified result closes at its expiry bound with no fabricated `dispatch.sent`, delivery left unknown and the closed row recording only the attempt. The complementary `dispatch.sent` event stays base-payload per [Spec-006 § Cross-Node Dispatch](../../specs/006-session-event-taxonomy-and-audit-log.md#cross-node-dispatch-cross_node_dispatch); it is the audit record, not the rebuild source. Only routing/liveness metadata lives here — ApprovalRecord envelopes, PASETO tokens, action payloads, and result payloads do not (those follow the `cross_node_dispatch_approvals` custody rules above).

```sql
-- Owner: Plan-027
CREATE TABLE cross_node_pending_dispatch (
  dispatch_id       TEXT PRIMARY KEY,     -- one caller-local pending row per dispatch
  session_id        TEXT NOT NULL,
  run_id            TEXT NOT NULL,        -- the ORIGINATING run; runHasPendingCrossNodeDispatch(runId) keys on this
  target_node_id    TEXT NOT NULL,        -- routing/audit context only, never authoritative
  capability        TEXT NOT NULL,        -- dispatched capability, for surfacing/audit context
  caller_token_jti  TEXT NOT NULL,        -- correlates to caller_token / the caller's cross_node_dispatch_approvals(dispatch_id, local_role='caller') row
  expires_at        TEXT NOT NULL,        -- caller-local clock bound = caller_token.exp + result-buffer window; the unobserved-conclusion backstop
  created_at        TEXT NOT NULL,        -- stamped at INSERT, BEFORE the relay send
  sent_at           TEXT,                 -- NULL until the caller-local outbox stamps it with dispatch.sent on send success; a verified late result with sent_at NULL proves delivery and triggers dispatch.sent repair-on-proof
  closed_at         TEXT,                 -- NULL = window open (pending); stamped in place when the window closes
  close_reason      TEXT                  -- how the window closed; the observed outcome discriminator lives in the dispatch.result_observed event, not duplicated here
                    CHECK (close_reason IS NULL OR close_reason IN ('observed_terminal', 'expiry_bound', 'send_failed')),
  -- closed_at and close_reason are set together: a row is either fully open or fully closed
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);

-- runHasPendingCrossNodeDispatch(runId) hot query: partial index on open rows; the predicate adds `AND expires_at > now`.
CREATE INDEX idx_cross_node_pending_dispatch_open_by_run
  ON cross_node_pending_dispatch(run_id)
  WHERE closed_at IS NULL;

-- The caller-local expiry sweep that closes windows at the clock bound (close_reason = 'expiry_bound').
CREATE INDEX idx_cross_node_pending_dispatch_expiry
  ON cross_node_pending_dispatch(expires_at)
  WHERE closed_at IS NULL;
```

Retention: a closed row is pruned once `expires_at` has elapsed — a concrete caller-local bound, `caller_token.exp` + the 5-minute result-buffer window ([Plan-027 § Data And Storage Changes](../../plans/027-cross-node-dispatch-and-approval.md#data-and-storage-changes) Implementation Step 9 / [Spec-024 § Cross-Node Failure Semantics](../../specs/024-cross-node-dispatch-and-approval.md#cross-node-failure-semantics)); no separate audit-retention window governs this table, because the durable audit trail of the observed outcome is the caller's `dispatch.result_observed` event, not this transient liveness row. Migration: additive `0NNN-cross-node-pending-dispatch.ts`, shipped in the single shared migration chain (`applyMigrations(db)` in `migration-runner.ts` runs one unconditional chain per daemon), so the table is created on every daemon; only the caller role writes and reads it, and a daemon that never originates a dispatch keeps it empty. This differs from `cross_node_dispatch_approvals` by row-population, not presence: a dispatch writes approvals rows on both its caller and target daemons, but a pending-dispatch row exists only on the originating daemon.

---

## Workflow Tables (Plan-017)

Full workflow-engine V1 schema. Nine tables implement the 10-state phase machine, append-only hash-chained gate history (C-13/I7), parallel-join bookkeeping, and OWN-only channel linkage. `session_events` remains canonical truth; tables 3/4/7/8/9 are rebuildable projections, and 1/2/5/6 are immutable truth (6 additionally carries a per-run BLAKE3 chain anchored to [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol)).

The normalized-table-over-blob shape, the per-run hash-chained gate-resolution audit trail, and the rebuildable-projection split align with industry persistence precedents: durable-execution engines persist normalized state per run rather than monolithic blobs ([Restate — What is Durable Execution](https://restate.dev/what-is-durable-execution), fetched 2026-04-26); large-engine persistence tiers separate hot live state from cold archive ([Argo Workflows — Workflow Archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/), fetched 2026-04-25); and append-only hash-chained audit trails are the canonical academic precedent for tamper-evident logging (_"a tamper-evident log... uses a hash chain to detect tampering with high probability"_ — [Crosby & Wallach, Efficient Data Structures for Tamper-Evident Logging, USENIX Security 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf), fetched 2026-04-25). `Spec-017 §References` > Persistence + hash-chain enumerates the full primary-source corpus.

`workflow_definitions` stores no canvas geometry, at this table or any other. Canvas layout is client-local per `Spec-017 §Canvas layout is not definition bytes (SA-35)` — the same tier as `human_phase_form_state` drafts — because a mutable per-author geometry is neither immutable truth nor a projection rebuildable from `session_events`, and the SA-25 hierarchy defines no third durable tier. Layout travels between machines only inside the definition file form, outside the hashed body. **The nine-table census is unchanged by every amendment since — the visual-builder amendment and the 2026-08-16 workflow-hardening amendment both add columns to tables that already exist: no table is added or removed.** The hardening amendment's growth is four park-and-resume projection columns across tables 3 and 4 plus two partial indexes; its always-on engine event record lands on the Plan-020-owned bounded-retention diagnostic tier (`Spec-017 §Engine event record (SA-43)`), whose bucket registration — including the fifth bucket's storage shape and any table-census move it implies, the existing four buckets being SQLite tables of this schema — is Plan-020's to record at its registration amendment (Plan-017 CP-017-9); no bucket for it exists in this schema today and the hardening amendment adds none.

```sql
-- ========================================================================
-- 1. workflow_definitions — content-hashed, immutable, schema-versioned
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: C-1 (YAML + TS SDK), C-8 (schema version marker)
CREATE TABLE workflow_definitions (
  id                   TEXT PRIMARY KEY,               -- ULID; NOT the content hash
  session_id           TEXT NOT NULL,                  -- owning session
  name                 TEXT NOT NULL,                  -- author-facing name
  -- Three-value scope domain per Spec-017 §Resolved Questions and V1 Scope Decisions
  -- (amended 2026-08-10, Tier-8 audit): 'session' binds to the authoring session,
  -- 'project' spans a project's sessions, 'shared' is the cross-project reuse tier —
  -- visible to any project on this daemon, out of this same table. 'shared' is
  -- breadth only: no distribution, no cross-machine sync, no additional table.
  -- session_id below keeps recording the authoring session at every scope.
  -- The pre-audit 'channel' value was never in the governing spec and is struck.
  scope                TEXT NOT NULL DEFAULT 'session'
                       CHECK(scope IN ('session','project','shared')),
  -- Scope identity, in the shape Spec-028 §Unified Inventory already uses for
  -- scope-qualified bindings (see mcp_server_trust.scope_ref below): the authoring
  -- session id at 'session', the canonical symlink-resolved repository root
  -- (repo_mounts.canonical_root) at 'project', the '' sentinel at 'shared'. Without
  -- this column a 'project' row would name no project, so the scope tier is not
  -- storable on `scope` alone.
  -- The DEFAULT '' is safe beside `scope`'s DEFAULT 'session' only because the
  -- CHECK below makes an all-defaults row invalid — and an all-defaults INSERT is
  -- already unreachable, since content_hash, name, schema_version, and
  -- definition_body are NOT NULL with no defaults. The default exists so the
  -- 'shared' sentinel is written by the schema rather than by every caller,
  -- matching mcp_server_trust.scope_ref below. Do not "fix" it by dropping the
  -- CHECK.
  scope_ref            TEXT NOT NULL DEFAULT '',
  -- Copy-on-write provenance (Spec-017 §Definition scope in the builder (SA-36)):
  -- the content hash of the 'shared' definition this row was branched from when an
  -- author edited a shared definition, NULL for a definition authored from scratch.
  -- Provenance only — it is not part of the hashed body, so a branched definition
  -- and a from-scratch definition with identical bodies carry the same content_hash
  -- and collide on the dedupe key below, which is the intended convergence.
  parent_content_hash  TEXT,
  content_hash         TEXT NOT NULL,                  -- BLAKE3 over JCS-canonicalized definition body
  schema_version       TEXT NOT NULL                   -- `ai-sidekicks-schema: 1.0` per C-8
                       CHECK(schema_version GLOB '[0-9]*.[0-9]*'),
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); full author-supplied definition
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- participant_id
  -- Only 'shared' is daemon-wide and therefore ref-free; 'session' and 'project'
  -- REQUIRE a ref. Mirrors the Spec-028 binding CHECK idiom as defense in depth
  -- behind the schema-layer validation.
  CHECK((scope = 'shared') = (scope_ref = '')),
  -- Dedupe is per scope identity, NOT per authoring session: two sessions storing
  -- the same 'shared' or 'project' definition must converge on one row, or
  -- resolution has two irreconcilable candidates. session_id stays provenance only.
  UNIQUE(scope, scope_ref, content_hash)
);

CREATE INDEX idx_workflow_definitions_session ON workflow_definitions(session_id);
CREATE INDEX idx_workflow_definitions_scope ON workflow_definitions(scope, scope_ref);
CREATE INDEX idx_workflow_definitions_content_hash ON workflow_definitions(content_hash);

-- Note: `updated_at` intentionally absent — definitions are immutable by C-9/F13 convention.
-- Edits create a new row in workflow_versions referencing this row as a parent.

-- ========================================================================
-- 2. workflow_versions — definition history chain (F13 additive versioning)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: F13 / C-8 version-API-at-V1; see Spec-017 §Required Behavior
CREATE TABLE workflow_versions (
  id                   TEXT PRIMARY KEY,               -- ULID
  definition_id        TEXT NOT NULL REFERENCES workflow_definitions(id),
  version_number       INTEGER NOT NULL,               -- monotonic per definition_id
  parent_version_id    TEXT REFERENCES workflow_versions(id), -- NULL at version_number=1
  parent_content_hash  TEXT,                           -- BLAKE3 of parent definition body; NULL at version 1
  content_hash         TEXT NOT NULL,                  -- BLAKE3 of THIS version's body
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); THIS version's full definition body — name, entry record, and the phase-definitions array (each phase entry carrying the per-phase dependsOn list and join-phase parallelJoinPolicy when the definition declares explicit topology, Spec-017 §Graph model — nodes, ports, and edges (SA-32)) — the BLAKE3 preimage of content_hash, so a version read serves name/entry/phaseDefinitions parsed from this body and read -> export reproduces the canonical bytes verbatim (PR #318 review round: was phase_definitions, which stored the array alone and left later versions' name/entry unreconstructable against content_hash; not a duplicate of workflow_definitions.definition_body above — that row carries the definition's current author-supplied body, each version row snapshots its own immutable bytes)
  author_note          TEXT,                           -- opt-in changelog message
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- participant_id
  UNIQUE(definition_id, version_number),
  UNIQUE(definition_id, content_hash)                  -- per-definition: one definition never stores the same bytes as two versions; copy-on-write and project -> shared promotion reuse a hash under a new definition id by design (Spec-017 §Definition scope in the builder (SA-36))
);

CREATE INDEX idx_workflow_versions_definition ON workflow_versions(definition_id, version_number DESC);
CREATE INDEX idx_workflow_versions_parent ON workflow_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- ========================================================================
-- 3. workflow_runs — top-level run state; counters and deadlines
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: SA-1 (max_phase_transitions), SA-2 (max_duration), SA-3 (resource pools)
CREATE TABLE workflow_runs (
  id                        TEXT PRIMARY KEY,          -- ULID
  workflow_version_id       TEXT NOT NULL REFERENCES workflow_versions(id),
  session_id                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN (
                              'pending','running','suspended','completed','failed','cancelled'
                            )),
  -- SA-1 iteration counter
  phase_transitions_count   INTEGER NOT NULL DEFAULT 0,
  max_phase_transitions     INTEGER NOT NULL DEFAULT 100, -- SA-1 default
  -- SA-2 duration deadline
  started_at                TEXT,                      -- RFC 3339 UTC
  deadline_at               TEXT,                      -- started_at + max_duration (computed at start)
  max_duration_ms           INTEGER NOT NULL DEFAULT 86400000, -- SA-2 default 24h
  completed_at              TEXT,
  -- SA-3 pool reservations (snapshot only; pool runtime state is ephemeral and NOT persisted)
  pool_reservations_snapshot TEXT NOT NULL DEFAULT '{}', -- JSON: {pty_slots: n, agent_memory_mb: n}
  -- Result
  failure_reason            TEXT,                       -- null unless status in ('failed','cancelled')
  failure_detail            TEXT,                       -- JSON; includes cancellation_reason per Spec-017 §Workflow Timeline Integration
  created_at                TEXT NOT NULL,
  -- participant_id at V1: the entry node's only V1 start mode is manual, so every run
  -- is participant-initiated (Spec-017 §Entry node and the V1 trigger surface (SA-37)).
  -- The 'or trigger' arm is the forward-compatible hook for a firing engine, which V1
  -- does not ship — the persistence seam exists so no schema change is owed when one does.
  created_by                TEXT,                       -- participant_id or trigger
  CHECK(phase_transitions_count <= max_phase_transitions),
  CHECK(max_duration_ms > 0)
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status)
  WHERE status IN ('pending','running','suspended');
CREATE INDEX idx_workflow_runs_deadline ON workflow_runs(deadline_at)
  WHERE status IN ('running','suspended') AND deadline_at IS NOT NULL;
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);

-- ========================================================================
-- 4. workflow_phase_states — per-phase state machine projection
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: the 10-state phase machine (see the `state` CHECK below)
CREATE TABLE workflow_phase_states (
  -- This id IS the phase_run_id — the OWN-channel anchor (SA-6) and the retry-attempt
  -- identity. A derived opaque identifier, NOT a ULID: totally determined per Spec-017
  -- §Deterministic identity (SA-21) by BLAKE3(workflow_run_id || phase_id ||
  -- attempt_number). A ULID's leading 48 bits are a millisecond timestamp, which that
  -- preimage cannot produce, so the pre-audit "ULID" comment contradicted the
  -- determinism the spec mandates. The digest's text rendering — width, padding or
  -- truncation rule, alphabet — is open; see Spec-017 §Open Questions. The column stays
  -- TEXT under every candidate rendering, so this DDL does not wait on that ruling.
  id                      TEXT PRIMARY KEY,
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  phase_id                TEXT NOT NULL,               -- logical phase id from the phase-definitions array in workflow_versions.definition_body
  -- The four V1 phase types per Spec-017 §Phase-Type and Gate-Type Taxonomy. Gate
  -- types (`auto-continue`, `quality-checks`, `human-approval`, `done`) live on the
  -- gate column, never here. Corrected 2026-08-10 by the Tier-8 audit: the previous
  -- constraint conflated the two taxonomies, carried two values (`gate`, `terminal`)
  -- in no taxonomy at all, and omitted `automated` — so inserting a first-class V1
  -- `automated` phase violated the CHECK.
  phase_type              TEXT NOT NULL
                          CHECK(phase_type IN (
                            'single-agent','multi-agent','automated','human'
                          )),
  -- 10-state machine
  state                   TEXT NOT NULL DEFAULT 'admitted'
                          CHECK(state IN (
                            'admitted','waiting_on_pool','started','progressed',
                            'suspended','resumed','cancelling','failed','completed','retried'
                          )),
  attempt_number          INTEGER NOT NULL DEFAULT 1,  -- 1..max_retries; retry creates new row per C-9
  -- Parent-sibling (for parallel blocks)
  parallel_join_id        TEXT REFERENCES parallel_join_state(id), -- NULL unless under a parallel join
  -- Timing
  admitted_at             TEXT NOT NULL,
  started_at              TEXT,
  progressed_at           TEXT,                        -- most recent progress heartbeat
  completed_at            TEXT,
  -- Failure & cancellation
  failure_reason          TEXT,
  cancellation_reason     TEXT
                          CHECK(cancellation_reason IS NULL
                                OR cancellation_reason IN ('sibling_failure','deadline_exceeded','user_cancel','gate_rejected')),
  -- Park state (Spec-017 §Park integrity and cancellability (SA-42) + §Provider-limit
  -- pacing and durable resumption (SA-40); added 2026-08-16, workflow-hardening
  -- amendment). Four columns, all carried by the `workflow.phase_suspended` payload
  -- and projected from it — so a rebuild from session_events reconstructs all four
  -- byte-equal and none needs a special case in SA-25 — split RECORD versus LIVE,
  -- and the asymmetry is the contract: park_reason / park_cause are the RECORD of a
  -- park and survive resume and cancellation untouched, because rewriting them at
  -- cancel would erase the only account of why a human was ever asked, while
  -- auto_resume_at / park_attention_key are LIVE state and clear on every exit from
  -- the park (SA-40 rule 5; the CHECK below). All four are per-phase, not per-run:
  -- two parallel branches of one run may park concurrently against different
  -- provider accounts with different reset boundaries (Spec-017 §Graph model —
  -- nodes, ports, and edges (SA-32)), and a run-level schedule or fold key could
  -- hold only one of them. A phase is parked iff `state = 'suspended'` and its
  -- run's status is non-terminal; do not read the presence of a park reason as a
  -- phase still waiting.
  --
  -- Closed two-value union, in domain lockstep with the contract union per Plan-017
  -- I-017-12. Widening it is an additive MINOR bump under ADR-018 that moves this
  -- CHECK and the contract union together — never a comment. `waiting-human` here is
  -- the PARK reason and is a third distinct axis from the gate-result status of the
  -- same spelling (Spec-017 §Phase-Type and Gate-Type Taxonomy) and from the
  -- `workflow.phase_suspended` payload `reason` this column is projected from: one
  -- word, three domains, deliberately not merged (the SA-17 late-rename cost in
  -- miniature).
  park_reason             TEXT
                          CHECK(park_reason IS NULL
                                OR park_reason IN ('waiting-human','provider-usage-limited')),
  -- The engine's own sentence about why this run is waiting and, where a schedule is
  -- armed, the instant it holds — read from the same value auto_resume_at below is
  -- written from, so the time named in the cause and the time the
  -- schedule holds are one value from one place and cannot drift. Bounded at 8 KiB,
  -- truncated at a UTF-8 code-point boundary with a visible truncation marker: a
  -- durable, operator-facing, engine-authored string with no bound is an unbounded
  -- write on the projection tier. NEVER written into a phase output, an artifact, or
  -- an agent-visible context — engine prose arriving through a model-output channel
  -- is read as something a model said, and phase outputs are immutable truth (SA-16),
  -- so the sentence would be unretractable.
  park_cause              TEXT,
  -- The armed resume instant (SA-40) — durable by construction, never an in-memory
  -- timeout, so a park outlives daemon restart and the phase resumes itself. Armed
  -- ONLY where the typed provider refusal carried a reset boundary the driver
  -- stamped provider-reported; NULL where that provenance was a driver default, a
  -- driver estimate, or absent, because an unscheduled park is a first-class state
  -- and a boundary the driver called a guess is not a wall-clock instant to hold a
  -- run against. Never armed at or past the run's deadline_at: the SA-2 wall-clock
  -- deadline stays authoritative, and a phase that would wake after it parks
  -- unscheduled and the run hard-fails at the deadline instead. Moved here from
  -- workflow_runs 2026-08-17 (the workflow-hardening amendment's review round):
  -- parallel branches park independently, so the schedule is phase state.
  auto_resume_at          TEXT,                        -- RFC 3339 UTC; NULL unless a schedule is armed
  -- The outage fold key (SA-40): provider + account identity + the credential
  -- generation held stable across the refusing dispatch. Parked phases sharing a
  -- non-null key present as ONE attention record, so one spent account refusing
  -- many concurrent runs surfaces once. Correlation for presentation only — no
  -- start, resume, retry, or schedule fire consults it, so it can never become an
  -- availability lock (Plan-017 I-017-23).
  park_attention_key      TEXT,
  -- Pool reservation (transient; for crash recovery decision)
  pool_reservation        TEXT,                        -- JSON {pty_slots: n, agent_memory_mb: n}; NULL after release
  -- Resume metadata
  resume_cursor           TEXT,                        -- opaque; for driver adapter; see Plan-015 recovery
  last_event_sequence     INTEGER,                     -- session_events.sequence projected from at rebuild
  -- The LIVE half of SA-40's clear-on-exit rule, structural where SQLite can see
  -- it: an armed instant or a fold key exists only on a phase sitting in the park.
  -- SQLite enforces CHECKs per statement, so the same UPDATE that moves state out
  -- of 'suspended' must null both live columns — the phase-exit half of rule 5 is
  -- DDL-enforced, not a code convention, and it is STRONGER than the terminal-half
  -- form the columns' original workflow_runs placement could express, because the
  -- two cases that blocked a suspended-scoped CHECK there evaporate per-phase: a
  -- parallel sibling's park is its own row, and a schedule fire that re-checked
  -- and failed to transition leaves the phase 'suspended', where an armed value is
  -- exactly legal. The run-cancel half cannot be DDL-enforced — run status lives
  -- in workflow_runs and a CHECK cannot cross tables — so SA-42's cancel clears
  -- these two columns in the cancel's own unit of work (code-enforced,
  -- failure-injection-tested at Plan-017 T5.11) while park_reason / park_cause
  -- above survive as the record.
  CHECK(state = 'suspended' OR (auto_resume_at IS NULL AND park_attention_key IS NULL)),
  UNIQUE(workflow_run_id, phase_id, attempt_number)    -- retry creates new attempt row per C-9
);

CREATE INDEX idx_workflow_phase_states_run ON workflow_phase_states(workflow_run_id);
CREATE INDEX idx_workflow_phase_states_active ON workflow_phase_states(workflow_run_id, state)
  WHERE state IN ('admitted','waiting_on_pool','started','progressed','suspended','cancelling');
CREATE INDEX idx_workflow_phase_states_parallel ON workflow_phase_states(parallel_join_id)
  WHERE parallel_join_id IS NOT NULL;
-- Backs the boot sweep that re-arms every durable schedule after projection rebuild
-- (SA-40 rule 4) and the attention fold's read of the parked phases one outage
-- affected. Both predicates are the bare non-null form: the columns are non-null
-- only across a park (the CHECK above confines them to `state = 'suspended'`), so
-- a state predicate would narrow nothing. The sweep and the fold both join to
-- workflow_runs.status and skip phases of terminal runs — the run-cancel clear is
-- code-enforced rather than structural, so the read-side join is the belt to that
-- suspender.
CREATE INDEX idx_workflow_phase_states_auto_resume ON workflow_phase_states(auto_resume_at)
  WHERE auto_resume_at IS NOT NULL;
CREATE INDEX idx_workflow_phase_states_park_attention ON workflow_phase_states(park_attention_key)
  WHERE park_attention_key IS NOT NULL;

-- ========================================================================
-- 5. phase_outputs — immutable per C-9; retry creates new output identity
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: C-9 output immutability; GitHub Actions v3→v4 artifact-API lesson
CREATE TABLE phase_outputs (
  id                      TEXT PRIMARY KEY,            -- ULID; content-stable identity
  phase_run_id            TEXT NOT NULL REFERENCES workflow_phase_states(id),
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id), -- denormalized for index
  output_name             TEXT NOT NULL,               -- name within the phase's output contract
  value_kind              TEXT NOT NULL
                          CHECK(value_kind IN ('scalar','json','artifact_ref','agent_transcript_ref')),
  value_json              TEXT,                        -- primitive/JSON payload; NULL when value_kind=artifact_ref
  artifact_manifest_id    TEXT REFERENCES artifact_manifests(id), -- Plan-014 integration; NULL unless value_kind=artifact_ref
  content_hash            TEXT NOT NULL,               -- BLAKE3 of canonicalized output bytes (for dedupe + replay check)
  created_at              TEXT NOT NULL,
  UNIQUE(phase_run_id, output_name)                    -- outputs are write-once per attempt
);

CREATE INDEX idx_phase_outputs_run ON phase_outputs(workflow_run_id);
CREATE INDEX idx_phase_outputs_phase ON phase_outputs(phase_run_id);
CREATE INDEX idx_phase_outputs_artifact ON phase_outputs(artifact_manifest_id)
  WHERE artifact_manifest_id IS NOT NULL;
-- Immutability invariant: no UPDATE trigger — all writes INSERT-only; a retry inserts
-- a new row under a new phase_run_id (attempt_number+1) rather than mutating the existing row.

-- ========================================================================
-- 6. workflow_gate_resolutions — append-only hash-chained per C-13 / I7
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: C-13 append-only hash-chained approval history; the invariant
-- is I7 in Spec-017 §Pitfalls To Avoid, the scheme Spec-017 §State And Data Implications
-- Algorithm anchored to Spec-006 §Integrity Protocol (BLAKE3 + Ed25519 + RFC 8785 JCS)
-- to keep one canonicalization rule across the daemon.
CREATE TABLE workflow_gate_resolutions (
  id                         TEXT PRIMARY KEY,          -- ULID
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence                   INTEGER NOT NULL,          -- per-run monotonic starting at 1
  phase_run_id               TEXT REFERENCES workflow_phase_states(id), -- NULL for run-level gates
  -- Gate identity
  gate_kind                  TEXT NOT NULL
                             CHECK(gate_kind IN (
                               'human-approval','quality-checks','human','channel-moderation',
                               'workflow-phase','definition-edit-audit'
                             )),
  approval_category          TEXT                       -- mirrors Plan-012 approval_requests.category when applicable
                             CHECK(approval_category IS NULL OR approval_category IN (
                               'tool_execution','file_write','network_access','destructive_git',
                               'user_input','plan_approval','mcp_elicitation','gate',
                               'human_phase_contribution'                                      -- SA-12 addition
                             )),
  approval_request_id        TEXT REFERENCES approval_requests(id), -- Plan-012 integration; NULL for non-approval gate kinds
  -- Resolution
  outcome                    TEXT NOT NULL
                             CHECK(outcome IN ('approved','rejected','timed_out','withdrawn','admin_override')),
  approver_id                TEXT,                      -- participant_id; NULL for 'timed_out' / 'withdrawn'
  approver_capability        TEXT,                      -- Cedar capability string (C-14 typed capability)
  resolved_at                TEXT NOT NULL,
  -- Policy-at-resolution-time (C-13: replays use at-execution-time policy, not current)
  policy_snapshot_hash       TEXT NOT NULL,             -- BLAKE3 of the Plan-012 policy bundle active at resolved_at
  decision_context           TEXT NOT NULL DEFAULT '{}', -- JSON: scope, resource, reason text, etc.
  -- Hash chain (per-run, anchored to Spec-006 scheme)
  prev_hash                  BLOB NOT NULL,             -- 32 bytes; row_hash of prior entry; zero-filled at sequence=1
  row_hash                   BLOB NOT NULL,             -- 32 bytes; BLAKE3(prev_hash || JCS-canonical(row_body))
  daemon_signature           BLOB NOT NULL,             -- 64 bytes; Ed25519 over same canonical bytes
  approver_signature         BLOB,                      -- 64 bytes; Ed25519 from approver's participant key; NULL for 'timed_out'
  UNIQUE(workflow_run_id, sequence)
);

CREATE INDEX idx_gate_resolutions_run ON workflow_gate_resolutions(workflow_run_id, sequence);
CREATE INDEX idx_gate_resolutions_phase ON workflow_gate_resolutions(phase_run_id)
  WHERE phase_run_id IS NOT NULL;
CREATE INDEX idx_gate_resolutions_approval ON workflow_gate_resolutions(approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- No UPDATE or DELETE triggers — append-only enforced at application layer (writer worker only inserts).
-- Verification procedure: BLAKE3 chain recompute per Spec-006 §Integrity Protocol + dual-anchor cross-check vs session_events payload (see "Hash-chain verification" note below this block).

-- ========================================================================
-- 7. parallel_join_state — sibling set + cancellation bookkeeping
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: SA-4 ParallelJoinPolicy per Spec-017 §Execution semantics
CREATE TABLE parallel_join_state (
  id                      TEXT PRIMARY KEY,           -- ULID; referenced by workflow_phase_states.parallel_join_id
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  join_node_id            TEXT NOT NULL,              -- phase id of the join node in the DAG
  policy                  TEXT NOT NULL
                          CHECK(policy IN ('fail-fast','all-settled','any-success')),
  expected_sibling_count  INTEGER NOT NULL,           -- number of siblings entering the join
  completed_count         INTEGER NOT NULL DEFAULT 0,
  failed_count            INTEGER NOT NULL DEFAULT 0,
  cancelled_count         INTEGER NOT NULL DEFAULT 0,
  resolution              TEXT
                          CHECK(resolution IS NULL OR resolution IN ('all_succeeded','any_succeeded','any_failed','all_failed','cancelled')),
  resolved_at             TEXT,                       -- set when the join condition fires
  -- Cancellation cascade bookkeeping — the tick-synchronous cascade required by
  -- Spec-017 §Workflow Timeline Integration (SA-20: never mid-callback)
  cancel_wave_tick        INTEGER,                    -- executor tick at which cancel wave fired; NULL until fail-fast triggers
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_parallel_join_state_run ON parallel_join_state(workflow_run_id);
CREATE INDEX idx_parallel_join_state_unresolved ON parallel_join_state(workflow_run_id)
  WHERE resolution IS NULL;

-- ========================================================================
-- 8. workflow_channels — phase_run_id ↔ channel_id (OWN-only V1)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: SA-6 ownership: OWN V1 (BIND deferred to V1.1 under criterion-gated commitments per ADR-015)
-- Channel-lifecycle coupling per Spec-017 §Interfaces And Contracts; the channel_id
-- foreign key below is Plan-016-owned surface consumed over its wire methods (CP-017-5)
CREATE TABLE workflow_channels (
  id                      TEXT PRIMARY KEY,           -- ULID
  phase_run_id            TEXT NOT NULL UNIQUE REFERENCES workflow_phase_states(id), -- UNIQUE = OWN 1:1
  channel_id              TEXT NOT NULL REFERENCES channels(id),
  ownership               TEXT NOT NULL DEFAULT 'OWN'
                          CHECK(ownership IN ('OWN')),  -- V1: OWN only; BIND reserved for V1.1 per ADR-015
  termination_policy      TEXT NOT NULL DEFAULT 'CLOSE_WITH_RECORDS_PRESERVED'
                          CHECK(termination_policy IN (
                            'CLOSE_WITH_RECORDS_PRESERVED','REQUEST_CANCEL','TERMINATE'
                          )),
  grace_period_ms         INTEGER NOT NULL DEFAULT 30000, -- SA-9: 30s grace on REQUEST_CANCEL
  created_at              TEXT NOT NULL,
  terminated_at           TEXT,
  termination_reason      TEXT
);

CREATE INDEX idx_workflow_channels_channel ON workflow_channels(channel_id);

-- ========================================================================
-- 9. human_phase_form_state — draft autosave (daemon-side fallback for V1.x)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 status per Spec-017 §Ship-empty tables (SA-28) — V1 clients use
-- localStorage/IndexedDB; this table ships empty in V1 so the V1.x daemon-side draft
-- persistence has no migration cost. Its wire companion `workflow.humanFormDraftSave`
-- is declared in api-payload-contracts.md §Plan-017 with no V1 handler: table and
-- operation light up together in V1.x.
CREATE TABLE human_phase_form_state (
  id                      TEXT PRIMARY KEY,           -- ULID
  phase_run_id            TEXT NOT NULL REFERENCES workflow_phase_states(id),
  participant_id          TEXT NOT NULL,              -- who's drafting (implicit-claim on first open)
  draft_json              TEXT NOT NULL DEFAULT '{}', -- JSON: current form field values
  draft_version           INTEGER NOT NULL DEFAULT 1, -- bumps on each autosave tick; optimistic-concurrency token
  submitted               INTEGER NOT NULL DEFAULT 0  -- boolean; 1 terminal
                          CHECK(submitted IN (0,1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE(phase_run_id, participant_id)                -- one draft slot per (phase, participant)
);

CREATE INDEX idx_human_phase_form_state_phase ON human_phase_form_state(phase_run_id)
  WHERE submitted = 0;
```

**Index rationale + write-amplification estimate:** Per-index query justifications above are sized against SQLite's standard query-planner cost model — partial indexes with `WHERE` clauses are evaluated only over the matching subset, yielding the smallest workable index for the live-set queries ([SQLite — Partial Indexes](https://www.sqlite.org/partialindex.html), fetched 2026-04-25). The ~42 KB / 110-write projection for a 10-phase workflow assumes Spec-015's 50-event batch flushed under one `db.transaction(fn)` call — `better-sqlite3` commits each batch atomically and rolls back on throw (_"Calling [.transaction()] returns a new function that, when called, runs the given function inside an SQLite transaction"_ — [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), fetched 2026-04-25). Two to three batch flushes therefore absorb the full workflow lifecycle without triggering write-amplification regressions under `synchronous = FULL` WAL ([SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html), fetched 2026-04-25).

**Hash-chain verification:** Per-run BLAKE3 chain recompute follows the exact algorithm specified in [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol) — recompute `BLAKE3(prev_hash || canonical_bytes(row))` for each entry and compare to the stored `row_hash`, then verify `daemon_signature` against the canonical bytes. The hash function is the BLAKE3 reference specification ([BLAKE3 specification](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf), fetched 2026-04-25). The dual-anchor check additionally cross-checks `session_events` (category `workflow_gate_resolution`, payload fields `gate_resolution_id` + `row_hash`) so a tampered `workflow_gate_resolutions` row is detected even if its local chain is internally consistent — the same tamper-evidence pattern Crosby & Wallach formalized ([Efficient Data Structures for Tamper-Evident Logging, USENIX Security 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf), fetched 2026-04-25). Verification is exposed as a CLI subcommand (Plan-017).

---

## Channel and Orchestration Tables (Plan-016)

DDL hardened during the Tier-6 plan-readiness audit (D-016-15, A-016-5, A-016-2, D-016-5). Posture per table: `channels`, `run_links`, and `agents` are events-canonical projections ([ADR-017](../../decisions/017-shared-event-sourcing-scope.md) Option B — rebuilt from `session_events` on replay; never written except by the projector); `session_budgets` is row-canonical daemon configuration (the `queue_items` posture — mutated by wire method, not evented). `channels` holds **user-created channels only**: the bootstrap main channel is projected (`deriveMainChannelId(sessionId)` per CP-002-7) and never has a row or a `channel.created` event — so it carries no `ChannelConfig`, and its audience is always `participants` and never restrictable (D-016-21). The 2026-08-03 channel-audience amendment is additive on `channels` and adds **no table**: `audience` rides the existing `config` JSON value, while the channel kind and the `direct` member pair are columns because they are identity rather than configuration.

```sql
-- Owner: Plan-016 (events-canonical projection of channel.* events; user channels only — main is synthesized)
CREATE TABLE channels (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT,
  state           TEXT NOT NULL DEFAULT 'active'
                  CHECK(state IN ('active', 'muted', 'archived')),
  config          TEXT NOT NULL DEFAULT '{}', -- JSON: ChannelConfig (packages/contracts/src/orchestration.ts) — {turnPolicy?, roundRobinOrder?, moderation?, audience?, turnsPerAgent?}; `audience` needs no column (D-016-21); `turnsPerAgent` likewise rides the JSON (D-016-23, 2026-08-11)
  kind            TEXT NOT NULL DEFAULT 'general'
                  CHECK(kind IN ('general', 'direct')), -- D-016-21 (2026-08-03): 'direct' = two-human channel, audience forced 'humans-only' and immutable
  direct_member_a TEXT,                                 -- D-016-21: participant ids of the immutable pair; fixed arity, so no membership table
  direct_member_b TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((kind = 'direct' AND direct_member_a IS NOT NULL AND direct_member_b IS NOT NULL AND direct_member_a < direct_member_b) -- direct: the pair exists, in canonical order — one representation per pair, so the events-canonical rebuild is deterministic
      OR (kind <> 'direct' AND direct_member_a IS NULL AND direct_member_b IS NULL)) -- non-direct: no pair — two closed arms, because SQLite passes a CHECK whose expression evaluates NULL, so any open form admits partial pairs (Codex PR #284 round 3)
);

CREATE INDEX idx_channels_session ON channels(session_id);

-- Owner: Plan-016 (events-canonical projection of the run.queued orchestration-carrier fields — D-016-3)
CREATE TABLE run_links (
  parent_run_id     TEXT NOT NULL,
  child_run_id      TEXT NOT NULL,
  session_id        TEXT NOT NULL,                      -- session provenance (I-016-3): replay + relay rebuild scope by session
  link_type         TEXT NOT NULL DEFAULT 'spawn'
                    CHECK(link_type IN ('spawn', 'delegate', 'handoff')),
  internal_helper   INTEGER NOT NULL DEFAULT 0
                    CHECK(internal_helper IN (0, 1)),   -- durable home of the internal-helper flag (I-016-10)
  producing_node_id TEXT NOT NULL,                      -- runtime node that admitted the child run (reachability projection input)
  invoking_principal_id TEXT,                           -- 2026-08-26 (CP-030-4 ⇄ CP-016-19): the effective principal of the TURN that
                                                        -- issued a peer-invocation tool call, stamped daemon-side at child-run creation.
                                                        -- NULL for links created by any other path (a workflow-spawned child, a handoff).
                                                        -- A peer-invoked child run has no intervention row and no participant who "started"
                                                        -- it, and chaining to the parent RUN cannot answer which turn called: a run
                                                        -- accumulates turns from several principals and recency is not a correct answer.
                                                        -- Daemon-resolved, never client-supplied (the NS-71 durable-recording discipline).
  created_at        TEXT NOT NULL,
  PRIMARY KEY (child_run_id),                       -- single-parent: a child run links to exactly one parent (one-shot run.queued linkage D-016-3; depth-1 model)
  CHECK (parent_run_id <> child_run_id)             -- a run never parents itself
);

CREATE INDEX idx_run_links_parent ON run_links(parent_run_id); -- parent → children scans (orchestration.childRunLinkRead; active-child accounting)
CREATE INDEX idx_run_links_session ON run_links(session_id);

-- Owner: Plan-016 (events-canonical projection of agent.* events — A-016-2; state enum is the
-- canonical 4-state agent lifecycle from domain/agent-channel-and-run-model.md §Lifecycle.
-- V1 wire mapping: agent.attach -> 'ready' (or 'configured' when the named default node is not
-- currently attached), agent.detach -> 'disabled', re-attach -> 'ready'; 'archived' is registered
-- but no V1 wire mutation reaches it. The resulting state is carried ON the agent.* event payloads
-- so the projection is deterministic from the log alone.)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  driver_name     TEXT NOT NULL,                        -- provider driver key (Plan-005 capability surface)
  model_id        TEXT NOT NULL,
  default_node_id TEXT,                                 -- NULL = any local attached node
  state           TEXT NOT NULL DEFAULT 'ready'
                  CHECK(state IN ('configured', 'ready', 'disabled', 'archived')),
  config          TEXT NOT NULL DEFAULT '{}',           -- JSON: agent-scoped driver config (opaque to the schema)
  provider_account_id TEXT,                             -- 2026-08-26 (D-016-26): the Plan-029 `provider_accounts.account_id` this agent
                                                        -- spawns under; NULL = the provider's registered default. Not inside
                                                        -- `config` because the Spec-029 spawn gate reads it, and `config` is
                                                        -- opaque to everything outside the driver
  effort          TEXT,                                 -- 2026-08-26 (D-016-26): reasoning effort, validated against the target
                                                        -- model's driver-reported `effortLevels` rather than a schema CHECK --
                                                        -- the valid set is per-model and provider-owned, so a CHECK here would
                                                        -- go stale against the provider rather than protect anything
  output_speed    TEXT,                                 -- 2026-08-29 (D-016-26, the output-speed axis): the EFFECTIVE speed mode this
                                                        -- agent spawns under. NULL = never set, so the provider's own default stands --
                                                        -- an agent is not born with a speed mode and no attach surface carries one.
                                                        -- Uncheckable here for the same reason as `effort`: the valid set is the
                                                        -- driver-published `outputSpeedLevels`, so a CHECK would go stale behind a vendor.
                                                        -- A column rather than a `config` key because the applying coordinator commits
                                                        -- the effective binding into these columns inside the transaction that clears
                                                        -- `pending_switch` below: a spawn-bound axis with a durable pending slot and no
                                                        -- durable effective slot would apply once and silently revert at the next
                                                        -- restart, and `config` is opaque to the spawn path that has to read it
  execution_posture_mode TEXT
                  CHECK(execution_posture_mode IS NULL OR execution_posture_mode IN
                        ('trusted','workspace-sandboxed','readonly-sandboxed')),
                                                        -- 2026-08-26 (CP-030-7): the resolved posture MODE snapshotted at attach.
                                                        -- NULL = the session default. A mode only, never a composed
                                                        -- ExecutionPosture: writableRoots and credentialPolicyRef belong to a live
                                                        -- run's workspace and would freeze a path set that outlives it. CHECKable
                                                        -- here, unlike `effort` above, because this vocabulary is corpus-owned
                                                        -- rather than provider-reported, so it cannot go stale behind a vendor
  tool_allowlist  TEXT,                                 -- 2026-08-26 (CP-030-7): JSON array, THREE-state like its wire axis —
                                                        -- SQL NULL = driver defaults, '[]' = no tools, populated = exactly these.
                                                        -- Outside `config` because the daemon composes the callback registry from
                                                        -- it (I-030-10), and `config` is opaque to everything outside the driver
  instructions    TEXT,                                 -- 2026-08-26 (CP-030-7): the system-prompt content AS APPLIED at attach
  goal            TEXT,                                 -- 2026-08-26 (CP-030-7): the agent goal as applied; NULL = none
                                                        -- Both are read by prompt construction, which is why they are typed
                                                        -- columns rather than `config` keys: after the source definition is
                                                        -- deleted the row itself must still answer what the agent was given
                                                        -- (I-030-12), and an opaque blob cannot be read back by that path
  pending_switch  TEXT,                                 -- 2026-08-26 (D-016-26): the JSON AgentProviderSwitchPending shape, status literal
                                                        -- included so the stored blob is self-identifying rather than a wire artifact
                                                        -- reproduced in a column: a row read in isolation names what it is -- {status:
                                                        -- 'pending', switchId, appliesAt: 'turn_boundary'|'run_boundary',
                                                        -- interruptRequested, pendingAxes: {driverName?, providerAccountId?, modelId?,
                                                        -- effort?, outputSpeed? (2026-08-29)}, replacedSwitchId?} -- shared with the mutation reply and the
                                                        -- agent.config_updated payload, so what a client was told, what the log records,
                                                        -- and what a restart re-arms from are the same record. What is stored here is a
                                                        -- SUPERSET of that shared shape: it additionally carries admittingPrincipalId
                                                        -- and, on the immediate arm, interruptDispatch ('requested' | 'dispatched'),
                                                        -- neither of which is ever returned to a caller or appended to a payload. Both
                                                        -- are members of THIS JSON blob and not columns of their own -- no column is
                                                        -- minted and no census moves; the agents CREATE is unchanged apart from this
                                                        -- comment. The
                                                        -- principal is recorded under the api-payload-contracts.md Authenticated
                                                        -- Principal class rule -- a pending switch is an admitting write, both terminals
                                                        -- require an actor, and a switch settling after a restart has no request left to
                                                        -- resolve one from; the class binds a durable home, which a mutation reply is
                                                        -- not. interruptDispatch is two-state rather than boolean because recovery must
                                                        -- separate 'crashed before the interrupt went out, so dispatch it' from 'crashed
                                                        -- after it landed, so reconcile' -- redispatching in the second case would fire a
                                                        -- second interrupt at a run that already took one -- and it advances by its own
                                                        -- durable write, so a crash between the two costs one idempotent redispatch and
                                                        -- never the switch. interruptRequested is stored rather than derived because
                                                        -- appliesAt does not imply it: a deferred switch and an interrupted one can both
                                                        -- read 'turn_boundary'. pendingAxes carries TARGET VALUES and not axis names: at
                                                        -- the boundary the caller's request is gone, so the row must be sufficient to
                                                        -- apply the switch by itself. This is the ONE switch
                                                        -- acknowledged to a caller but not yet applied at its boundary; NULL = none.
                                                        -- Durable because the acknowledgment is a promise a restart must keep: startup
                                                        -- re-arms from this column instead of dropping the intent. A single nullable
                                                        -- slot is what makes one-pending-per-agent structural -- a later provider-axis
                                                        -- update overwrites it (supersession, last writer wins) under the same row lock,
                                                        -- so a queue of half-wanted switches is unrepresentable. Holds the PENDING
                                                        -- binding only; the effective binding stays in the columns above and moves
                                                        -- there at application. Cleared by whichever terminal event settles the switch
                                                        -- (agent.provider_switched / agent.provider_switch_failed) and by supersession
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_agents_session ON agents(session_id);

-- Owner: Plan-016 (row-canonical daemon configuration — queue_items posture, NOT evented; one row per session, created on first read/update with Spec-016 §Budget Policies / §Scheduler Limits defaults; mutated only via orchestration.budgetUpdate, session owner only — D-016-5)
CREATE TABLE session_budgets (
  session_id                    TEXT PRIMARY KEY,
  cost_limit_cents              INTEGER NOT NULL DEFAULT 1000,  -- Spec-016: $10 per session
  turn_limit_per_agent          INTEGER NOT NULL DEFAULT 50,    -- Spec-016 §Budget Policies (turn-limit row): max consecutive turns per (channel, agent), reset on interleave (D-016-8) — not a per-session total; the session default a channel's ChannelConfig.turnsPerAgent overrides per channel (D-016-23, 2026-08-11)
  max_executing_channels        INTEGER NOT NULL DEFAULT 5,     -- Spec-016 §Scheduler Limits
  max_queue_depth_per_channel   INTEGER NOT NULL DEFAULT 25,
  max_pending_orchestration_runs INTEGER NOT NULL DEFAULT 10,
  active_child_limit            INTEGER NOT NULL DEFAULT 5,     -- Spec-016 §Scheduler Limits (active-children row): daemon default, configurable
  unpriced_family_caps          TEXT NOT NULL DEFAULT '[]',     -- JSON [{modelFamily, hardCapUsdCents}] — owner-supplied unpriced-family escapes, native-cap legs only (Spec-016 §Cost Derivation And Absent-Cost Semantics, campaign B6); wire mirror = OrchestrationBudgetUpdate.unpricedFamilyCaps
  updated_at                    TEXT NOT NULL,
  -- Non-negative-integer floors on every limit; wire mirror = orchestration.budgetUpdate Zod .int().nonnegative() (D-016-5)
  CHECK (typeof(cost_limit_cents) = 'integer' AND cost_limit_cents >= 0),
  CHECK (typeof(turn_limit_per_agent) = 'integer' AND turn_limit_per_agent >= 0),
  CHECK (typeof(max_executing_channels) = 'integer' AND max_executing_channels >= 0),
  CHECK (typeof(max_queue_depth_per_channel) = 'integer' AND max_queue_depth_per_channel >= 0),
  CHECK (typeof(max_pending_orchestration_runs) = 'integer' AND max_pending_orchestration_runs >= 0),
  CHECK (typeof(active_child_limit) = 'integer' AND active_child_limit >= 0)
);

-- Live-leg goal-delivery crash consistency (Spec-016 §Session Goals, campaign B6): the durable
-- goal-dispatch intent written BEFORE the driver op (ADR-019 spawn-intent pattern); startup
-- reconciliation completes a dangling row keyed on durable leg states: no 'failed' leg = interrupted apply (re-issue to EVERY leg, acked included — idempotent last-write-wins re-send; acked is advisory across restart); any 'failed' leg = revert mode (re-assert the prior goal on EVERY leg, pending included — an in-flight call may have applied unacked; never re-issue the new goal — a refusing leg is marked 'failed' BEFORE compensation begins, so a doomed mutation never re-applies across a crash) — each successful prior-goal re-assertion flips its leg to 'reverted' ('acked' -> 'reverted' and 'pending' -> 'reverted' alike — pending is unknown-outcome and converges only by re-assertion) — and delete WITHOUT appending (converging with a refusal outcome). Deleted on append — the append and the delete commit in ONE transaction (both tables daemon-local), so a committed event with a live row is unrepresentable; on failure, deleted only once EVERY non-'failed' leg is 'reverted' — pending included, since a pending leg's in-flight call may already carry the goal unacked (a failed or unconverged revert keeps the row durable with that leg still 'acked'/'pending', so restart reconciliation knows exactly which legs still carry the unapplied goal and the durable turn gate stays alive; further goal mutations for the session stay blocked until convergence) — a refused mutation never re-applies on replay.
-- One in-flight goal mutation per session (goal ops serialize per session).
CREATE TABLE session_goal_dispatch_intents (
  session_id  TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,   -- JSON {op: 'set'|'clear', goal?: {text}, prior: {goal?}, actor: ParticipantId, legs: {bindingId: 'pending'|'acked'|'failed'|'reverted'}} — everything the crash-recovered session.goal_* event and the revert path need (Spec-006 envelope attribution; last-write-wins revert)
  created_at  TEXT NOT NULL
);
```

Per-run token (`tokenLimit`, default 100000) and idle-timeout (`idleTimeoutMs`, default 300000) budgets are per-run `OrchestrationRunConfig` values resolved at admission (request override else session default) and persisted durably as the `run.queued` payload's `effectiveRunConfig` (Plan-016 D-016-5; api-payload `RunStateChangeEvent`) — they have no session-level column, and budget/idle enforcement rebuilds from that event field on replay, never by re-merging session defaults that may have changed mid-run. Budget _accounting_ (tokens/cost consumed) has no table: the daemon's `BudgetAccountant` is an in-memory projection rebuilt on replay from `usage_telemetry` + `run.*` events (D-016-5).

---

## GDPR and Recovery Tables (Spec-022, Plan-015)

```sql
-- Owner: Spec-022 (GDPR)
CREATE TABLE participant_keys (
  participant_id    TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob BLOB NOT NULL,           -- XChaCha20-Poly1305-wrapped AES-256 content key (wire: nonce || ciphertext || tag) — Plan-022 D-022-2
  key_version       INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  rotated_at        TEXT
);

-- Owner: Plan-015
CREATE TABLE replay_cursors (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE,
  last_sequence   INTEGER NOT NULL,           -- last replayed event sequence
  state           TEXT NOT NULL DEFAULT 'current'
                  CHECK(state IN ('current', 'rebuilding', 'stale')),
  updated_at      TEXT NOT NULL
);

-- Owner: Plan-015
CREATE TABLE recovery_checkpoints (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,              -- e.g. 'full', 'incremental'
  as_of_sequence  INTEGER NOT NULL,
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_recovery_checkpoints_session ON recovery_checkpoints(session_id);
```

---

## Diagnostic Bucket Tables (Plan-020)

Runtime-local bounded-retention buckets for raw diagnostic material. These tables may contain PII-bearing content, command output, tool traces, or reasoning detail, so they stay in Local SQLite only, default-deny outbound telemetry, and support both TTL expiry and participant-scoped purge per Spec-022 shred fan-out Path 3.

```sql
-- Owner: Plan-020
CREATE TABLE driver_raw_events (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'driver_raw_event',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_driver_raw_events_session ON driver_raw_events(session_id, created_at);
CREATE INDEX idx_driver_raw_events_participant ON driver_raw_events(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_driver_raw_events_expiry ON driver_raw_events(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE command_output (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'command_output',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_command_output_session ON command_output(session_id, created_at);
CREATE INDEX idx_command_output_participant ON command_output(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_command_output_expiry ON command_output(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE tool_traces (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'tool_trace',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_tool_traces_session ON tool_traces(session_id, created_at);
CREATE INDEX idx_tool_traces_participant ON tool_traces(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_tool_traces_expiry ON tool_traces(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE reasoning_detail (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'reasoning_detail',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_reasoning_detail_session ON reasoning_detail(session_id, created_at);
CREATE INDEX idx_reasoning_detail_participant ON reasoning_detail(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_reasoning_detail_expiry ON reasoning_detail(expires_at)
  WHERE purged_at IS NULL;
```

---

## MCP Governance Tables (Plan-028)

Node-scoped governance state for [Spec-028](../../specs/028-mcp-server-configuration-and-governance.md) (V1 feature #18): the operator trust store, the per-tool override store, and the governance-mutation idempotency receipt store. Provider config files remain the config source of truth — the daemon persists only governance state and derives the unified inventory on read, so no table here mirrors provider config ([Spec-028 § State And Data Implications](../../specs/028-mcp-server-configuration-and-governance.md#state-and-data-implications)). All three tables are daemon-local with no session FK; the audit trail is the five `mcp.*` event types in the `mcp_governance` category, appended through the Plan-006 `EventLogService` path with daemon-scope sentinel binding (receipts are retry-window dedup evidence, deliberately not audit rows).

```sql
-- Owner: Plan-028
CREATE TABLE mcp_server_trust (
  provider           TEXT NOT NULL
                     CHECK(provider IN ('claude', 'codex')),  -- the closed McpProvider contract union (driver id namespace); a third provider is a Spec-028 ADR trigger, and widening this CHECK is that ADR's migration — an unchecked value would hand inventory code an impossible row its exhaustive McpProvider handling cannot represent
  scope              TEXT NOT NULL
                     CHECK(scope IN ('user', 'project', 'local')),  -- scope axis of the binding identity (Spec-028 §Unified Inventory): user = writable both providers; project/local = observed read-only in V1 ('local' is Claude-only)
  scope_ref          TEXT NOT NULL DEFAULT '',  -- canonical project root (project) / keying directory (local); '' for user scope
  server_name        TEXT NOT NULL,
  trusted            INTEGER NOT NULL DEFAULT 0
                     CHECK(trusted IN (0, 1)),  -- untrusted by default; observation creates the row, never trust (Spec-028 §Unified Inventory)
  config_hash        TEXT NOT NULL CHECK(config_hash GLOB 'b3:*'),  -- keyed BLAKE3 over the RFC 8785 JCS canonicalization of the normalized BASE config — daemon-managed override-projection fields excluded so a governed override write never drifts the bound hash (Spec-028 §Trust Governance); the bound hash while trusted, the last-observed hash otherwise. The key is the binding's config-hash subkey, derived (BLAKE3 keyed-PRF, exactly-32-byte keys) from the daemon-held MCP governance master key — node-local key material stored OUTSIDE this database, deliberately never a column beside the digest: the canonical input includes credential-bearing values so their drift is detected, and only a non-colocated key keeps this stored digest (and the event-side scopeRefDigest, keyed under the sibling scope-ref subkey) non-brute-forceable for an attacker holding the database file or a backup. Losing the master key is fail-closed: no key, no comparable hash, no trust — re-grant re-binds. Event payloads never carry the raw scope_ref path; only this table resolves a digest back to its path
  enabled_override   INTEGER
                     CHECK(enabled_override IS NULL OR enabled_override IN (0, 1)),  -- the daemon's per-server enabled overlay (Claude bindings only in V1 — Claude user scope has no enabled field; Codex uses its native `enabled` config field); NULL = no overlay
  native_tool_baseline_json TEXT,        -- pre-governance snapshot of the binding's native override-projection fields (enabled_tools / disabled_tools / tools.<t>.approval_mode), captured at trust grant or first facet materialization — whichever first — held while trusted or while any facet is materialized, dropped once untrusted and facet-free; Codex-materialized bindings only (Claude facets are daemon-enforced — no native writes, no baseline). The anchor that makes the expected native state well-defined (baseline overlaid with materialized facets): drift reconciliation compares against it, mcp.clearToolOverride restores from it, and revocation rewrites weakening fields to baseline + surviving tightening facets (Spec-028 §Trust Governance / §Tool-Level Overrides) — without it, restore-on-clear would invent values and a trusted no-override binding's native tool fields would be unreconcilable
  granted_at         TEXT,                 -- RFC 3339 UTC grant provenance; NULL while never trusted
  granted_by         TEXT,                 -- node-operator identity that granted trust
  revoked_at         TEXT,                 -- most recent revoke; reset to NULL on re-grant
  revoked_reason     TEXT
                     CHECK(revoked_reason IS NULL OR revoked_reason IN ('operator_revoke', 'config_drift')),
  first_observed_at  TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, server_name),
  -- a trusted row always carries grant provenance and no active revoke; the revoke pair is set and cleared together
  CHECK(trusted = 0 OR (granted_at IS NOT NULL AND granted_by IS NOT NULL AND revoked_reason IS NULL)),
  CHECK((revoked_at IS NULL) = (revoked_reason IS NULL)),
  -- binding-ref structural validity, mirroring the schema-level discriminated union (defense in depth):
  -- user scope has no scope_ref ('' sentinel); project/local REQUIRE one; local is Claude-only
  CHECK((scope = 'user') = (scope_ref = '')),
  CHECK(NOT (provider = 'codex' AND scope = 'local'))
);
```

Config-drift auto-revoke ([Spec-028 § Trust Governance](../../specs/028-mcp-server-configuration-and-governance.md#trust-governance)): on any observation where a trusted row's current base-config hash differs from `config_hash`, the daemon flips `trusted` to `0` with `revoked_reason = 'config_drift'` **before** the changed config is used, rewrites any Codex-materialized safety-weakening override fields in the same operation to the baseline-anchored safe state — the preserved `native_tool_baseline_json` overlaid with surviving tightening facets (revocation neutralizes weakening) — and emits `mcp.server_trust_changed` (`reason: 'config_drift'`). "Before use" is enforced at every provider-session admission point, not left to eventual observation: the Spec-028 drift gate performs a fresh provider-config read and completes drift processing before any provider process spawns against those bindings — registered through the Plan-004 `RunSetupGate` seam for run/thread starts, and invoked from the Plan-015 startup-recovery attach seam before any recovery adoption or cold-resume dispatch (the two CP-028-5 admission points), so an edit made while the daemon was down processes drift before any session re-attaches. Drift evaluation on a trusted row covers more than the keyed hash: the daemon-managed override-projection fields (excluded from the hash so governed writes never self-revoke) are separately reconciled against the expected native state — the preserved `native_tool_baseline_json` baseline overlaid with the materialized facets, which covers the trusted-no-override corner too (the baseline snapshots at grant, so a hand edit of these fields on a facet-free trusted row still reconciles) — any divergence is out-of-band tool-governance drift: auto-revoke, re-assertion of the facet-governed portions to the expected state while ungoverned portions adopt the observed values (revoke, never undo the operator's own config — mirroring base-config drift semantics), `mcp.tool_override_changed` per re-asserted facet. The drift comparison applies to trusted rows only — an untrusted row absorbing config changes updates `config_hash` silently, and an untrusted row's native tool fields are ungoverned provider config (observed and served in the config view, never trust-laundered). Re-trusting after drift is an explicit operator `mcp.setTrust`, which re-binds `config_hash` to the then-current base-config hash.

```sql
-- Owner: Plan-028
CREATE TABLE mcp_tool_overrides (
  provider          TEXT NOT NULL
                    CHECK(provider IN ('claude', 'codex')),  -- the closed McpProvider union, mirroring mcp_server_trust
  scope             TEXT NOT NULL
                    CHECK(scope IN ('user', 'project', 'local')),  -- binding identity axes mirror mcp_server_trust
  scope_ref         TEXT NOT NULL DEFAULT '',
  server_name       TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  enabled           INTEGER
                    CHECK(enabled IS NULL OR enabled IN (0, 1)),  -- allow/deny facet; NULL = provider default; enabled = 1 is a safety-WEAKENING facet (broadens the executable tool set) — trusted-server-only and neutralized on revocation like every weakening facet (Spec-028 §Trust Governance)
  approval_mode     TEXT                   -- Codex-native vocabulary adopted as the normalized set (Spec-028 §Tool-Level Overrides)
                    CHECK(approval_mode IS NULL OR approval_mode IN ('auto', 'prompt', 'writes', 'approve')),
  idempotency_class TEXT                   -- NULL = the Spec-005 manual_reconcile_only floor; assignment is trusted-server-only + Cedar-gated; safety-weakening facets stop resolving when the binding's trust is revoked (Spec-028 §Trust Governance — revocation neutralizes weakening)
                    CHECK(idempotency_class IS NULL OR idempotency_class IN ('idempotent', 'compensable')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, server_name, tool_name),
  -- an all-NULL facet row is meaningless: mcp.clearToolOverride deletes the row instead of blanking
  -- it — and the request schema mirrors this as a Zod refinement (>= 1 facet required), so a
  -- facet-less request dies as a typed validation error before it can reach this constraint
  CHECK(enabled IS NOT NULL OR approval_mode IS NOT NULL OR idempotency_class IS NOT NULL),
  -- binding-ref structural validity, mirroring mcp_server_trust (defense in depth)
  CHECK((scope = 'user') = (scope_ref = '')),
  CHECK(NOT (provider = 'codex' AND scope = 'local')),
  FOREIGN KEY (provider, scope, scope_ref, server_name)
    REFERENCES mcp_server_trust(provider, scope, scope_ref, server_name)
    ON DELETE CASCADE  -- overrides never outlive their binding's governance anchor
);
```

The FK targets the trust table because first observation of any binding upserts an untrusted trust row ([Spec-028 § Unified Inventory](../../specs/028-mcp-server-configuration-and-governance.md#unified-inventory)) — that row is each binding's durable governance anchor, so overrides cascade to it rather than to any provider-config mirror (there is none). Identity is the scope-qualified binding `(provider, scope, scope_ref, server_name)`: same-named servers in two scopes are distinct configurations with independent trust, so collapsing them would drift-revoke one scope's trust on the other's legitimate config. Lookups ride the composite primary keys: the inventory merge and the Spec-005 tool-metadata resolution both read by binding prefix, so no secondary indexes are warranted.

```sql
-- Owner: Plan-028
CREATE TABLE mcp_mutation_receipts (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,  -- requester-generated UUID (the Spec-005/B3 clientIdempotencyKey discipline; the interventions UNIQUE(target_run_id, client_idempotency_key) precedent, adapted to node-scoped operations with no run axis)
  operation               TEXT NOT NULL,              -- the receipted mcp.* operation the key was spent on (the six governance mutations + mcp.oauthLogin; mcp.reconnect is unreceipted)
  request_digest          TEXT NOT NULL
                          CHECK(request_digest GLOB 'b3:*'),  -- keyed BLAKE3 over the RFC 8785 JCS canonical full request INCLUDING secret values (a retry differing only in a secret value must NOT replay), idempotency-key field excluded; replay requires digest equality — key reuse with a differing digest refuses mcp.idempotency_conflict, original untouched. The key is the receipt-digest subkey of the daemon-held MCP governance master key (BLAKE3 keyed mode takes exactly 32 bytes) — node-local key material stored OUTSIDE this database, deliberately NOT the colocated client_idempotency_key: keying with a value stored in the adjacent column would let a database copy or backup verify low-entropy secret guesses offline, defeating the same no-keyless-digest-of-secret-bearing-input discipline config_hash follows. A receipt that cannot be verified (key material lost) refuses as mcp.idempotency_conflict — fail closed; re-driving under a fresh key is safe by construction (sanctioned provider writes are upserts, full-set replacements, or version-guarded)
  status                  TEXT NOT NULL
                          CHECK(status IN ('pending', 'committed')),  -- two-phase (the Plan-015 command_receipts discipline, Spec-028 §Authorization): the row INSERTs as a 'pending' intent in its own transaction BEFORE any provider leg runs, and flips to 'committed' in the same transaction as the mutation's store writes and event append — closing both crash windows around the external provider side effect (a durable provider write can never be left unaudited: startup reconciliation completes any pending intent — verifying provider state, finishing store writes, appending the event set exactly once — or expires an intent whose provider leg never ran)
  response_json           TEXT,                       -- the acknowledged response, replayed verbatim on identical retry — no provider call, store write, or second event (Spec-028 §Authorization); NULL while 'pending' (recorded at finalization). One representation exception: the mcp.oauthLogin row stores the acknowledgment with authorizationUrl STRUCTURALLY OMITTED — launch URLs embed single-use PKCE state and are never durable (Plan-028 I-028-1) — so its replay is a URL-free acknowledgment (the flow already launched; a caller that never received the URL starts a new login under a fresh key)
  created_at              TEXT NOT NULL,              -- RFC 3339 UTC; 'committed' rows older than 24 h are pruned opportunistically on later mutation writes ('pending' intents resolve at startup reconciliation, never silently pruned)
  CHECK((status = 'committed') = (response_json IS NOT NULL))
);
```

Receipts are **two-phase** because the provider config write is an external side effect no SQLite transaction can span. The `'pending'` intent row (key, operation, digest) commits in its **own transaction before** the provider leg runs; finalization — `status = 'committed'` plus the recorded response — commits in the **same transaction** as the mutation's governance-store writes and `EventLogService` append, making acknowledgment, audit event, and replay evidence atomic. That closes both crash windows: crash before the provider leg leaves a pending intent with no provider effect (startup reconciliation expires it — the caller retries fresh); crash after a durable provider write but before finalization leaves a pending intent whose provider state startup reconciliation verifies, completing the store writes and appending the event set **exactly once, late**, then finalizing. An identical-key retry that meets a pending row first drives that reconciliation, then replays the finalized response; a lost IPC response after commit can re-drive only the provider leg (safe by construction — sanctioned provider writes are upserts, full-set replacements, or version-guarded), never a second acknowledgment or a duplicate governance event. Receipts are deliberately **not** part of the audit trail (events are) and carry no config values — the digest is a keyed canonical-request hash used solely for equality, never served back by any code path (the `mcp.idempotency_conflict` refusal names the key, not the digests).

---

## Provider Account Tables (Plan-029)

Node-local registry of the provider accounts this runtime node may execute against, for [Spec-029](../../specs/029-provider-accounts-and-credential-homes.md). One row per registered account. The table stores **no credential material of any kind** — no token, no refresh token, no cookie, no keychain payload. Credentials live inside the per-account credential home, owned and written by the provider's own tooling; the daemon brokers refresh without ever holding the values, so there is no credential column here to leak, log, or shred. What is stored is the identity of an account, where its home lives, and how it bills.

`account_id` is daemon-minted, opaque, and immutable. It is deliberately **not** derived from credential material, an email address, or any provider-side subject identifier: those rotate, and an identity that rotates cannot key historical spend. `credential_generation` is a monotonic integer bumped at every credential-home lifecycle transition (initial authentication, re-authentication, revocation, home rebuild). The pair `(account_id, credential_generation)` is the account-plane key — a quota reading or usage-limit signal taken under one generation must not be read as current after a re-authentication, which is exactly what the generation makes detectable.

```sql
-- Owner: Plan-029
CREATE TABLE provider_accounts (
  account_id            TEXT NOT NULL PRIMARY KEY,  -- daemon-minted opaque immutable identity; never derived from credential material (Spec-029 §Account identity and credential generation). `NOT NULL` is declared explicitly because a `TEXT PRIMARY KEY` on a rowid table admits NULL, which is a documented SQLite compatibility quirk rather than a design choice: a PRIMARY KEY there is usually just a UNIQUE constraint, an historical oversight lets its column values be NULL, and the vendor's own stated workaround is a NOT NULL constraint on each PRIMARY KEY column — https://www.sqlite.org/quirks.html#primary_keys_can_sometimes_contain_nulls (§5, accessed 2026-08-31). NULLs compare distinct in that unique index, so two identity-less rows would both commit. A NULL identity keys nothing: `(account_id, credential_generation)` becomes unmatchable, the child table's `ON DELETE CASCADE` never fires for it, and the credential home derived from it cannot be attributed back. Neither documented exception applies here: this is not an `INTEGER PRIMARY KEY` rowid alias, and the table is not `WITHOUT ROWID`.
  provider              TEXT NOT NULL
                        CHECK(provider IN ('claude', 'codex')),  -- the same closed driver-id union the MCP governance tables use
  display_label         TEXT NOT NULL,  -- operator-chosen label for disambiguation in the UI; free text, treated as participant-adjacent PII (Spec-022 §PII Data Map)
  credential_home_path  TEXT NOT NULL,  -- absolute path to this account's isolated credential home; the daemon constructs the spawn environment from it and never inherits ambient provider credentials (I-029-4)
  credential_generation INTEGER NOT NULL DEFAULT 1
                        CHECK(typeof(credential_generation) = 'integer' AND credential_generation >= 1),  -- monotonic, starts at 1; bumped at every credential-home lifecycle transition (I-029-2). The CHECK makes the floor enforced rather than asserted: a zero or negative generation sorts BEFORE a freshly registered account, so a reading stamped with one would read as newer than the account it describes and invert the staleness comparison the stamp exists for. The `typeof` conjunct is not redundant with the `INTEGER` declaration and is the second half of the same guarantee: a SQLite column type is an AFFINITY, and INTEGER affinity converts a bound REAL only where the conversion is lossless, so `1.5` is stored as REAL `1.5`, satisfies `>= 1`, and makes a monotonic counter divisible — two bumps could then land on `1.5` and `1.75` and order by fraction rather than by generation. Lossless bindings are untouched: `2.0` and `'3'` both convert to integer and remain admitted, so the conjunct refuses exactly the values that were never generations.
  billing_mode          TEXT NOT NULL
                        CHECK(billing_mode IN ('subscription', 'metered', 'unknown')),  -- how this account is charged; `unknown` is the honest-absence arm, never a synonym for metered; drives cost labeling, never cost derivation (Spec-029 §Billing mode)
  is_default            INTEGER NOT NULL DEFAULT 0
                        CHECK(is_default IN (0, 1)),  -- exactly one default per provider, enforced by the partial unique index below
  health_state          TEXT
                        CHECK(health_state IS NULL OR health_state IN ('authenticated', 'reauth_required', 'home_missing', 'indeterminate')),  -- the STORED outcome of the last validation of this account: the driver's authentication probe reading together with the credential-home observation taken at that same moment. NULL until a probe has ever been taken, which the wire renders as `indeterminate` — NOT as a failure and never as authenticated (I-029-9, I-029-10). This is the column the readiness projection reads; a registry read never re-derives it, so a read spawns no provider process and opens no credential file (Spec-029 §Node provider readiness and the sign-in handoff).
  health_observed_at    TEXT,  -- RFC 3339 UTC of the observation `health_state` records, written by the same act. NULL exactly when `health_state` is NULL, so the pair is set and cleared together; surfaced as `ProviderReadiness.observedAt` so a caller can apply its own age test. Deliberately NOT `updated_at`, which is NOT NULL and moves on any row mutation — a relabel would report an operator's display-label edit as a fresh authentication observation.
  observed_auth_mode    TEXT
                        CHECK(observed_auth_mode IS NULL OR observed_auth_mode IN ('oauth_subscription', 'oauth_token', 'api_key', 'external', 'none', 'unknown')),  -- the authentication mode the provider's OWN status surface reports for this home, OBSERVED and never assumed (Spec-029 §Non-interactive token registration). NULL until observed; `unknown` is the distinct arm for "observed, but the provider named a mode this daemon does not recognize" — a tolerant arm so a vendor adding a mode does not fail an observation closed. `oauth_token` is the ADR-028 D2 class and is what admits a token-mode account; the token VALUE is not here and is in no column of any table (Spec-029 §State And Data Implications).
  last_refresh_observed_at TEXT,  -- RFC 3339 UTC of the most recent credential refresh the daemon has OBSERVED to have completed for this home, read from the provider's own durable marker where it publishes one. NULL = not observed, never "fine". Drives the freshness reading; the daemon never CAUSES a refresh to produce it (Spec-029 §Credential-home health observation).
  logged_in_at          TEXT,  -- RFC 3339 UTC of the moment this home's credential was ISSUED. On a brokered sign-in that is the observed completion, which the daemon witnessed. On a token-mode registration it is the token's ISSUANCE time — read from the provider's own status surface where it publishes one, else supplied explicitly by the operator — and is NOT the registration time: a token is minted out of band and may be registered months later, so anchoring here to registration would shift the horizon forward by the token's pre-registration age and could report a credential as good after it had expired. Where no issuance anchor exists the column stays NULL and the estimate renders as unknown; it is never defaulted to `created_at`. NULL also for a home imported by a registration that neither signed in nor supplied a token. The re-login horizon derived from it is MODE-DISPATCHED and is an ESTIMATE, never a fact: the interval belongs to the provider's issuance policy, which the daemon does not control and cannot verify.
  -- Provider-REPORTED account identity, surfaced by a health observation and stored so the
  -- management page can tell two accounts of the same provider apart by something truer than the
  -- operator's own label. Nullable and independently so: a provider may report any subset, and an
  -- absent value stays absent rather than defaulting. A later observation REPLACES these values
  -- (Spec-022 §PII Data Map, `provider_accounts` row); they are never logged, never evented, and
  -- never carried on an error. Carriers for the render Spec-023 requires and the retention rule
  -- Spec-022 already governs — added 2026-08-26 at the Codex round, which found the rule and the
  -- render both citing a column that did not exist.
  observed_account_email     TEXT,
  observed_account_org_id    TEXT,
  observed_account_org_name  TEXT,
  removal_intent        INTEGER NOT NULL DEFAULT 0
                        CHECK(removal_intent IN (0, 1)),  -- the durable half of the cross-store removal protocol (Spec-029 §Non-interactive token registration). The registry row and the sealed token are SEPARATE DURABILITY DOMAINS — SQLite and the OS keystore commit independently — so removal marks intent here FIRST, then destroys the secret, then deletes the row. A crash mid-sequence therefore strands a row already marked unusable rather than a live credential nobody can see. Admission REFUSES any account whose row is intent-marked, and daemon-start reconciliation completes every marked row and destroys every sealed value matching no row. Not a status enum: the row's other states are already carried by `health_state`, and folding removal into that column would let an observation overwrite an in-flight removal.
  probe_enabled         INTEGER NOT NULL DEFAULT 1
                        CHECK(probe_enabled IN (0, 1)),  -- per-account opt-out for the background health observer (Spec-029 §Credential-home health observation). Default-on, because an account nobody observes is an account whose stored reading silently ages; durable rather than in-memory, so a restart does not resume observing an account the operator silenced. Opting out suppresses the OBSERVER only: the deliberate probe verb and spawn validation still write the pair, because both are acts the operator or a run explicitly asked for.
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- The stored observation is a PAIR, and the pair is enforced rather than asserted: a reading with
  -- no observation time cannot answer `observedAt`, and an observation time with no reading is a
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
```

The newest quota reading per account and limit. A provider's quota standing is **not one window**: the pinned Claude surface publishes five limit identifiers, **three of which share a 10080-minute window**, so a key of `(account, window length)` cannot hold them — two of the three would overwrite the third and the survivor would depend on arrival order. The limit identifier is therefore the key and the window length is an attribute of the reading, not part of its identity. Holding the newest reading durably is what lets a client that connects after a reading was taken render quota standing without waiting for the next one.

```sql
-- Owner: Plan-029
CREATE TABLE provider_account_usage_windows (
  account_id    TEXT NOT NULL
                REFERENCES provider_accounts(account_id) ON DELETE CASCADE,  -- a window reading has no meaning without its account; deregistering an account takes its readings with it
  limit_id      TEXT NOT NULL,  -- the provider's own limit identifier, carried verbatim as an untrusted provider-adjacent string. A reading that names no limit takes the reserved value 'default', so a provider publishing a single window needs no special case and the pre-Spec-029 single-window shape stays valid as the degenerate case (Spec-029 §Per-limit provider quota). NOT enumerated by a CHECK: the provider's limit set is an open, versioned vocabulary and a closed CHECK would fail a reading closed the moment a vendor adds a window.
  window_mins   INTEGER NOT NULL,  -- the reading's window length in minutes. An ATTRIBUTE, not part of the key: within one provider the limit identifier determines the length, so keying on both would admit two rows for one limit with different lengths — the same incoherence the health-pair CHECK above exists to refuse.
  label         TEXT,  -- the provider's own display label for this window where it publishes one; NULL where it does not. Display-only, never parsed, never a key.
  used_percent  REAL NOT NULL
                CHECK(used_percent >= 0),  -- utilization at `observed_at`. NOT capped at 100: a provider may report over-consumption against a soft limit, and clamping would silently misreport it. The renderer clamps for display; the store records what was observed.
  resets_at     TEXT,  -- RFC 3339 UTC when this window resets, where the provider supplies it; NULL where it does not. NULL means unknown, never "now" and never "never".
  observed_at   TEXT NOT NULL,  -- RFC 3339 UTC of the reading. This is the ordering key: where two readings key alike the later `observed_at` is current, and `source` breaks only exact ties. Ordering by arrival or by a source preference would let a stale reading mask real consumption.
  observed_credential_generation INTEGER NOT NULL
                CHECK(typeof(observed_credential_generation) = 'integer' AND observed_credential_generation >= 1),  -- the account's `credential_generation` when this reading was taken, mirroring the member the account-scoped quota event already carries. A credential-home rebuild does NOT delete these rows — a quota window describes the provider-side allowance, which keeps running while a home sits empty — so this stamp is what lets a consumer render a pre-rebuild reading as stale rather than as current (Spec-029 §Per-limit provider quota). Contrast the health pair on the parent row, which a generation bump invalidates outright, because that pair describes the home itself. The CHECK carries the same floor the parent row's `credential_generation` and the wire's `CredentialGenerationSchema` both enforce, so the stamp cannot be written outside the range of the values it claims to compare against: a stamp below 1 names a generation that never existed, matches no account state, and would render its reading permanently stale rather than legibly refusing at write time. It carries the parent's `typeof` conjunct for the same reason and with the same force: the staleness comparison is between this stamp and the parent's generation, so a fractional stamp admitted by INTEGER affinity would compare against a whole-numbered generation and place the reading between two of them.
  source        TEXT NOT NULL
                CHECK(source IN ('probe', 'run')),  -- which sanctioned source produced the reading: the deliberate probe verb, or the account-scoped quota event emitted from real traffic. The background health observer is NOT a source and no third value exists, because reading quota on one pinned provider leg traverses a path documented to refresh proactively — which Spec-029 §Credential-home health observation forbids the observer to do.
  PRIMARY KEY (account_id, limit_id)
);
```

Spend is joined to an account without duplicating account identity onto every usage row. A provider run carries the server-stamped `admittedProviderAccountId` on its `run.queued` admission record, so priced usage rows join to an account **through the run**. The one usage kind that carries account identity directly is `usage.rate_limit_update`, because provider quota is account-scoped and has no run to join through — the asymmetry is deliberate, and it also keeps participant identity off every usage row.

---

## Sidekick Definition Tables (Plan-030)

Node-local registry of saved sidekick configurations, for [Spec-030](../../specs/030-sidekick-definitions-and-peer-invocation.md). One row per definition. This is **configuration, not session state**: it is not events-canonical, is never replayed, is never rebuilt from the event log, and never leaves the node (I-030-9).

`id` is daemon-minted, opaque, and immutable, and is stable across a rename — `name` is a mutable human label and is never an identity key (I-030-1). An agent attached from a definition holds a **snapshot** of it: no foreign key binds an agent to this table, and no read path serving a running agent consults it, so editing or deleting a definition can never widen an already-attached sidekick's authority (I-030-2).

`provider_account_id` deliberately carries **no foreign key** to `provider_accounts` (D-030-1). `ON DELETE CASCADE` would discard operator-authored configuration when an account is removed; `ON DELETE SET NULL` would silently convert a pinned account into "the provider's default account", which is exactly the substitution the fail-closed resolution rule forbids; `ON DELETE RESTRICT` would make account removal fail because an unrelated definition names it. The reference is therefore unenforced at the schema layer and checked at attach time, which is the only point at which the answer matters.

`tool_allowlist` is three-state and the three states are **not** interchangeable (I-030-4): `NULL` means the driver's default tool set, the JSON array `'[]'` means no tools at all, and a populated array means exactly those tools. Representing "no tools" as an absent value would make the most restrictive choice unexpressible.

`execution_posture_mode` stores the posture **mode literal only** (I-030-8). A composed `ExecutionPosture` carries a content-addressed `credentialPolicyRef` meaningful only against the session that composed it, so persisting one would let a stale definition re-grant a superseded trust decision, or dangle outright; the session composes the full posture at attach time from this mode.

```sql
-- Owner: Plan-030
CREATE TABLE sidekick_definitions (
  id                     TEXT NOT NULL PRIMARY KEY,  -- daemon-minted opaque immutable definitionId; stable across a rename (I-030-1). `NOT NULL` declared explicitly: a TEXT PRIMARY KEY on a rowid table admits NULL (the documented SQLite quirk armored the same way on provider_accounts.account_id above — https://www.sqlite.org/quirks.html#primary_keys_can_sometimes_contain_nulls), and a NULL definitionId keys nothing: attach-by-reference could never resolve it and NULLs compare distinct, so two identity-less rows would both commit.
  name                   TEXT NOT NULL  -- mutable human label; NEVER an identity key on any wire request, stored reference, or audit row
                         CHECK(length(name) > 0 AND length(name) <= 128 AND instr(name, char(0)) = 0),
  name_folded            TEXT NOT NULL,  -- full-Unicode case fold of `name`, computed by the store on every write (I-030-7).
                                         -- Stored rather than derived because SQLite has no Unicode-aware collation to index on:
                                         -- this column is what the uniqueness index arbitrates, so the DATABASE enforces folded
                                         -- uniqueness and no concurrent pair of non-ASCII case variants can both commit.
  description            TEXT NOT NULL DEFAULT ''
                         CHECK(length(description) <= 1024 AND instr(description, char(0)) = 0),
  driver_name            TEXT NOT NULL,  -- provider driver key (Plan-005 capability surface), matching agents.driver_name
  model_id               TEXT NOT NULL,
  provider_account_id    TEXT,  -- NULL = the provider's default account resolved at attach time. Deliberately NO foreign key (D-030-1) — the row must outlive its account so resolution can refuse legibly instead of substituting
  effort                 TEXT,  -- NULL = the driver's default. Validated at resolution against the target model's driver-reported effortLevels, NOT against a corpus-wide enum, so no CHECK list appears here
  execution_posture_mode TEXT  -- NULL = the session default posture. Mode literal ONLY — no credentialPolicyRef, writableRoots, or network member is ever persisted here (I-030-8)
                         CHECK(execution_posture_mode IS NULL OR execution_posture_mode IN (
                           'trusted', 'workspace-sandboxed', 'readonly-sandboxed'
                         )),
  instructions           TEXT NOT NULL DEFAULT ''  -- the system-prompt text the sidekick runs under; operator-authored node-local configuration, never emitted into an event payload
                         CHECK(length(instructions) <= 32768 AND instr(instructions, char(0)) = 0),
  goal                   TEXT
                         CHECK(goal IS NULL OR (length(goal) > 0 AND length(goal) <= 4096 AND instr(goal, char(0)) = 0)),
  tool_allowlist         TEXT  -- three-state (I-030-4): NULL = driver defaults, '[]' = no tools, populated = exactly those. The array-shape CHECK admits '[]' and rejects a scalar or object
                         CHECK(tool_allowlist IS NULL OR (json_valid(tool_allowlist) AND json_type(tool_allowlist) = 'array')),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- Case-insensitive name uniqueness (I-030-7): two definitions differing only in letter case are
-- one handle to a human reading a picker, and a service-layer-only check races under concurrent
-- creates from the desktop and CLI clients at once. The index arbitrates the STORED FOLD KEY, so the
-- guarantee is the full-Unicode one and not an ASCII subset of it.
CREATE UNIQUE INDEX idx_sidekick_definitions_name_folded
  ON sidekick_definitions(name_folded);
```

**Why a stored fold key rather than `COLLATE NOCASE`.** SQLite's built-in `NOCASE` collation folds only the 26 ASCII letters — [SQLite datatype documentation](https://sqlite.org/datatype3.html#collating_sequences), accessed 2026-08-26 — so an index built on it collides `Reviewer` with `reviewer` but admits a pair differing only in a non-ASCII case mapping. An earlier revision paired that ASCII index with a full-Unicode check in the definition store and called the index a concurrency backstop; that arrangement does not hold, because the layer performing the real fold is the layer that cannot be atomic. Two concurrent creates of `Ärger` and `ärger` each pass the service precheck, and the ASCII index then accepts both — the exact race the backstop was there to close. Persisting the fold (`name_folded`, written by the store on every insert and update) moves the full-Unicode comparison into the unique index itself, so uniqueness is decided once, by the database, under the same folding the service uses. The store still performs the fold — it owns the Unicode algorithm — but it is no longer the correctness boundary, only the producer of the key. `name` continues to hold the operator's original casing for display.

## Schema Version Table

```sql
CREATE TABLE schema_version (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT NOT NULL,
  description     TEXT
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Initial schema');
```
