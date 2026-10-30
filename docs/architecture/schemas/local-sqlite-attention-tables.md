# Attention Tables (Plan-016)

The attention tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

The attention service keeps four tables of its own, none referring to another, beside each channel's outcome row, the web address's send queue and the pushes' `push_deliveries`. The send queue is the one table that refers to another: each queued message refers to its delivery in `attention_deliveries` with `ON DELETE CASCADE`, so a purge's delete of a delivery takes its queued message with it and the rest are deleted in any order ([Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery)). No table here holds a mail password, a web address or its signing secret: each is kept as its own item in the operating system's credential store and never written to a column, a reply, an event, a log or an error ([ADR-036](../../decisions/036-workflow-secrets-in-the-os-keychain.md)).

- **`attention_entries`** holds one row per entry: a wait on the person, an agent run's or a workflow run's end, or a Notify step's notice. It is a projection of the session events, written in each event's own write and rebuilt from the log; a Notify step's rows, which its step's own write makes, survive the rebuild's clear. An entry's id is the event that raised it, or for a Notify step its moment id, so a rebuild mints the same ids. Its source event's sequence in the session's log is what the seen mark and the retention cut compare it by.
- **`attention_deliveries`** holds what became of each entry's banner and web-address message — the banner decided once per entry and again for a handed-back wait, the web address once — and when an email digest carried it, so no entry is listed twice and the digest's one timer is restored from it at start. No row, or a NULL `banner_state`, is a banner not yet decided, which the wire carries as an absent `bannerState`. A rebuild leaves each delivery as the live writes left it, so what was decided survives one; an entry a crash left undecided is decided at the next start.
- **`attention_seen`** holds how far the person has seen each subject, a session or a workflow run in it, as the session's newest event sequence when they looked, so an entry raised after the look, even in the same millisecond, reads unseen.
- **`attention_versions`** holds a count per scope that every attention change raises, the whole machine's and each session's, which a live subscriber follows, and for each session the sequence up to which its entries are past keeping. An entry goes once its sequence is at or below that cut and it is an informational entry its subject has seen or a resolved wait; the cut is the session's newest event more than a day old; an entry whose web-address message is still waiting stays past it until the send is decided. The live writes and a rebuild apply the same cut from this row, so the two give the same entries; an open wait is never retired.
- **`provider_builds`** is the record of each provider's builds, kept in the provider drivers' part of the schema (`crates/sidekicks-provider/src/build_record.rs`), and the one source of every `providerBuild` entry: the attention read lists each row not retired of a provider a driver describes when it reads the whole projection, and no attention table holds a copy, so no channel, gate, sweep or purge meets one. A row with a `from_version` is a build the provider's command moved to, written by the capability declare in the same write that moves the stored version; one without is a build only available, written by the marker check. A provider's next build removes its earlier rows in its own write, and every record write bumps the machine's count in `attention_versions`. A moved-to row retires a day after it was recorded, on its day through the daemon's wall-clock timer, which fires across sleep, and the retirement bumps the count; an only-available row never retires on a timer. A retired row stays, so the same build named again lists nothing.
- **A session purge** deletes the session's deliveries, entries, seen marks and versions before its `sessions` row, and `workflow.run.deleted` deletes that run's deliveries and entries, its Notify entries among them, in the event's own write.
- **Each delivery channel** — the web address and the email digest — keeps one outcome row in `attention_delivery_outcomes(channel TEXT PRIMARY KEY, attempted_at TEXT, result TEXT, cause TEXT, http_status INTEGER CHECK(http_status BETWEEN 100 AND 599), undelivered INTEGER NOT NULL DEFAULT 0 CHECK(undelivered >= 0), CHECK((attempted_at IS NULL) = (result IS NULL)), CHECK((result IS 'storeUnavailable') = (cause IS NOT NULL))) STRICT`: when the last attempt ran, its result (`delivered`, `refused`, `unreachable`, `timedOut`, `signInRefused`, `notEncrypted` or `storeUnavailable`), on a `storeUnavailable` attempt its cause (`locked`, `unavailable` or `secretMissing`), the HTTP status where there was one, and how many messages were given up on since the last delivery, a give-up before any attempt counted on a row with no attempt yet. The row is overwritten on each attempt and removed with the channel's secret; a test send writes none; `attention.delivery.list` returns it.
- **`attention_web_address_sends(entry_id TEXT PRIMARY KEY REFERENCES attention_deliveries(entry_id) ON DELETE CASCADE, body BLOB NOT NULL, next_attempt_at TEXT NOT NULL) STRICT`** holds each web-address message still to send: its body, written once when the sender picks up a `pending` delivery and sent unchanged at every attempt under the delivery's entry id as its `webhook-id`, and when its next attempt is due. A row exists only while its delivery is `pending`; at most 100 wait, a newer one giving up on the oldest. The tries are counted on the delivery's `web_address_attempt_count`; a failed try is retried 5 seconds, 5 minutes and 30 minutes later, and the fourth failure gives up. A restart re-arms the daemon's wall-clock timer at the earliest `next_attempt_at`, a past one due at once.
- **The session row's `muted_at`** ([Session Tables §Session Directory](local-sqlite-session-tables.md#session-directory-plan-001)) keeps a muted session's `Finished` and `Failed` moments out of both channels.
- **Each push to another device** keeps a `push_deliveries` row, its device one of `trusted_devices` ([Remote Control Tables §The Account's Devices](local-sqlite-remote-control-tables.md#the-accounts-devices)).

```sql
-- Owner: Plan-016 (T2.1)
-- One row per entry; its id is the raising event's, or a Notify step's moment id.
CREATE TABLE attention_entries (
  id                TEXT PRIMARY KEY,
  moment_id         TEXT NOT NULL,             -- what a later state of the same moment replaces
  session_id        TEXT NOT NULL,
  run_id            TEXT,                      -- an agent run's wait or end, or a plan's run
  workflow_run_id   TEXT,                      -- a workflow run's end, a step's wait or a Notify step
  plan_id           TEXT,                      -- a plan waiting on its card
  node_id           TEXT,                      -- a workflow step's node, attempt and execution;
  attempt           INTEGER,                   -- a Notify step has no attempt
  execution_index   INTEGER,
  trigger           TEXT NOT NULL
                    CHECK(trigger IN ('pendingApproval', 'pendingInput', 'runCompleted', 'runFailed', 'workflowNotify')),
  severity          TEXT NOT NULL CHECK(severity IN ('actionable', 'informational')),
  notice_text       TEXT,                      -- a Notify step's notice; NULL on every other entry
  source_event_id   TEXT NOT NULL,             -- the event that raised it
  created_at        TEXT NOT NULL,             -- the raising event's instant
  resolved_at       TEXT                       -- the resolving event's instant; NULL while open
) STRICT;

CREATE INDEX idx_attention_entries_session ON attention_entries(session_id, resolved_at);
CREATE INDEX idx_attention_entries_workflow_run ON attention_entries(workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
-- A moment's entries: the open ones its next state resolves, and the later ones that tell whether
-- a waiting web-address message still stands.
CREATE INDEX idx_attention_entries_moment ON attention_entries(moment_id);

-- Owner: Plan-016 (T2.3)
-- What became of an entry's banner and web-address message; no row, or a NULL banner_state, is an
-- undecided banner.
CREATE TABLE attention_deliveries (
  entry_id                   TEXT PRIMARY KEY,
  banner_state               TEXT
                             CHECK(banner_state IS NULL
                                   OR banner_state IN ('pending', 'posted', 'withheld', 'withdrawn')),
  merged_into                TEXT,             -- the entry whose banner this one merged into; an open wait is decided again when that entry resolves
  web_address_state          TEXT
                             CHECK(web_address_state IS NULL
                                   OR web_address_state IN ('pending', 'delivered', 'undelivered')),
  web_address_attempt_count  INTEGER CHECK(web_address_attempt_count IS NULL
                                           OR web_address_attempt_count >= 0),
  digested_at                TEXT,             -- when an email digest carried it
  muted_at_decision          TEXT,             -- the session's mute when it was decided; NULL when not muted
  CHECK((web_address_state IS NULL) = (web_address_attempt_count IS NULL))
) STRICT;

CREATE INDEX idx_attention_deliveries_merged_into ON attention_deliveries(merged_into)
  WHERE merged_into IS NOT NULL;

-- Owner: Plan-016 (T2.4)
-- A session's own row has run_id ''; a workflow run's names the run.
CREATE TABLE attention_seen (
  session_id             TEXT NOT NULL,
  run_id                 TEXT NOT NULL DEFAULT '',
  seen_through_sequence  INTEGER NOT NULL,
  PRIMARY KEY (session_id, run_id)
) STRICT, WITHOUT ROWID;

-- Owner: Plan-016 (T2.1)
-- scope_key '' is the whole machine; a session's id is the session's own.
CREATE TABLE attention_versions (
  scope_key                  TEXT PRIMARY KEY,
  version                    INTEGER NOT NULL CHECK(version >= 1),
  retained_through_sequence  INTEGER         -- a session's retention cut; NULL on the machine's row
) STRICT;

-- Owner: Plan-023 (T4.9)
-- One row per provider and build; versions as the provider's command printed them.
CREATE TABLE provider_builds (
  provider_name  TEXT NOT NULL,
  version        TEXT NOT NULL                 -- the build
                 CHECK (length(version) > 0 AND length(version) <= 128 AND instr(version, char(0)) = 0),
  from_version   TEXT                          -- the build the command moved from; NULL on a build only available
                 CHECK (from_version IS NULL OR (length(from_version) > 0 AND length(from_version) <= 128 AND instr(from_version, char(0)) = 0)),
  recorded_at    TEXT NOT NULL,
  retired_at     TEXT,                         -- set once the line leaves the list; NULL while listed
  PRIMARY KEY (provider_name, version)
) STRICT;

-- Owner: Plan-016 (T3.6)
-- One row per device a push went to, so a withdrawal reaches exactly the devices that got the entry.
-- A row goes when its entry is withdrawn or 24 hours after it was sent.
CREATE TABLE push_deliveries (
  entry_id     TEXT NOT NULL,                     -- the attention entry the push announced
  device_id    TEXT NOT NULL REFERENCES trusted_devices(device_id),
  collapse_id  TEXT NOT NULL,                     -- the moment's stable id, sent as the push's collapse id, so a later push for the same moment replaces it in place
  state        TEXT NOT NULL
               CHECK(state IN ('sent', 'replaced')),  -- 'replaced' once a later push for the same moment took its place, which leaves nothing to withdraw
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (entry_id, device_id)
) STRICT;
```
