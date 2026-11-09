# Orchestration Tables (Plan-013)

The multi-agent orchestration tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

DDL per Plan-013 D-013-5. A child run's link to its parent is no table of its own: it is the `parent_run_id` and `reached_by` of the child's own `runs` row ([Local SQLite Schema §Runs](local-sqlite-schema.md#runs-plan-002)), written from its `agent.run.queued`. Posture per table: `agents` is an events-canonical projection ([ADR-016](../../decisions/016-shared-event-sourcing-scope.md) Option B — rebuilt from `session_events`; never written except by the projector), and so is `agent_tree_nodes`, each node written in the `agent.run.queued` of its helper's run and folded again from that event on a rebuild; `session_budgets` is row-canonical daemon configuration (the `queue_items` posture — mutated by wire method, not evented), and so are the session-messaging tables and the `agents.pending_switch` column (written before a switch is acknowledged, since no event records a switch being asked for, and kept by a rebuild), so none of them is rebuilt from the log.

```sql
-- Owner: Plan-013 (events-canonical projection of the agent events).
-- No wire verb brings an agent into a session or takes one out: a row appears where an agent
-- takes part -- the session's own lead, a delegation from it, or an agent the person named in the
-- composer -- and a row has no lifecycle state: an agent is in its session or it is not. The values
-- a row holds are carried on the events that create and move it, so the projection is deterministic
-- from the log alone.)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  provider_name     TEXT NOT NULL,                        -- the provider's open id, checked against the registered drivers (Plan-003)
  model_id        TEXT NOT NULL,
  provider_account_id TEXT,                             -- D-013-17: the binding's own account, the Plan-023 `provider_accounts.account_id`
                                                        -- this agent spawns under; NULL = follow the provider's current account, whichever it
                                                        -- is when a run starts, so this agent follows the mark when it moves. Set only when
                                                        -- the binding itself names an account. The account a run landed on is carried on the
                                                        -- settling agent.providerBinding.changed event, beside the binding, and is never
                                                        -- written here, so a following agent is never silently pinned. The Spec-025 spawn gate reads it
  effort          TEXT,                                 -- D-013-17: reasoning effort, validated against the target
                                                        -- model's driver-reported `effortLevels` rather than a schema CHECK --
                                                        -- the valid set is per-model and provider-owned, so a CHECK here would
                                                        -- go stale against the provider rather than protect anything
  options         TEXT,                                 -- D-013-17, the session options the binding's driver declares, as last
                                                        -- set: a JSON list of `{id, value}`, at most one per id. NULL = none set,
                                                        -- and an option absent from the list keeps the provider's own value.
  output_speed    TEXT,                                 -- D-013-17, the output-speed axis: the EFFECTIVE speed mode this
                                                        -- agent spawns under. NULL = never set, so the provider's own default stands --
                                                        -- an agent is not born with a speed mode and no surface sets one at birth.
                                                        -- Uncheckable here for the same reason as `effort`: the valid set is the
                                                        -- driver-published `outputSpeedLevels`, so a CHECK would go stale behind a vendor.
                                                        -- A durable column because the applying coordinator commits
                                                        -- the effective binding into these columns inside the transaction that clears
                                                        -- `pending_switch` below: a spawn-bound axis with a durable pending column and no
                                                        -- durable effective column would apply once and silently revert at the next
                                                        -- restart
  tool_allowlist  TEXT,                                 -- CP-024-3: JSON array, THREE-state like its wire axis —
                                                        -- SQL NULL = driver defaults, '[]' = no tools, populated = exactly these.
                                                        -- The daemon composes the callback registry from it (I-024-10)
  instructions    TEXT,                                 -- CP-024-3: the system-prompt content AS APPLIED when the run started
                                                        -- Read by prompt construction: after the source definition is
                                                        -- deleted the row itself must still answer what the agent was given
                                                        -- (I-024-12)
  resolved_from_definition_id TEXT,                     -- the saved agent definition this agent was resolved from, written from
                                                        -- the resolved configuration's resolvedFromDefinitionId; NULL for an agent no definition produced.
                                                        -- No foreign key: the row keeps naming its source after that definition is deleted,
                                                        -- as `instructions` keeps what it was given
  pending_switch  TEXT,                                 -- D-013-17: the JSON AgentBindingSwitchPending shape, status literal
                                                        -- included so the stored blob is self-identifying rather than a wire artifact
                                                        -- reproduced in a column: a row read in isolation names what it is -- {status:
                                                        -- 'pending', switchId, appliesAt: 'turnBoundary'|'runBoundary',
                                                        -- interruptRequested, pendingAxes: {providerName?, modelId?, providerAccountId?,
                                                        -- effort?, outputSpeed?}, replacedSwitchId?} -- shared with the mutation reply and
                                                        -- the `pendingSwitch` member agent.subscribe returns, so what a client was told and what
                                                        -- a restart re-arms from are the same record. What is stored here is a SUPERSET of
                                                        -- that shared shape: on the immediate arm it additionally carries
                                                        -- interruptDispatch ('requested' | 'dispatched'), which is never returned to a
                                                        -- caller or appended to a payload; it is a member of THIS JSON blob, not a column
                                                        -- of its own. interruptDispatch is 'requested' | 'dispatched' rather than boolean because recovery must
                                                        -- separate 'crashed before the interrupt went out, so dispatch it' from 'crashed
                                                        -- after it landed, so reconcile' -- redispatching in the second case would fire a
                                                        -- second interrupt at a run that already took one -- and it advances by its own
                                                        -- durable write, so a crash between the two costs one idempotent redispatch and
                                                        -- never the switch. interruptRequested is stored rather than derived because
                                                        -- appliesAt does not imply it: a deferred switch and an interrupted one can both
                                                        -- read 'turnBoundary'. pendingAxes carries TARGET VALUES and not axis names: at
                                                        -- the boundary the caller's request is gone, so the row must be sufficient to
                                                        -- apply the switch by itself. One writer admits a switch: agent.config.update, for
                                                        -- the provider, model, effort and speed axes. An account move writes nothing here: a
                                                        -- move asked while a turn runs waits in the driver, and the provider's current mark is
                                                        -- what a restart moves a session by. This is the ONE switch
                                                        -- acknowledged to a caller but not yet applied at its boundary; NULL = none.
                                                        -- Durable because the acknowledgment is a promise a restart must keep: startup
                                                        -- re-arms from this column instead of dropping the intent. A single nullable
                                                        -- column is what makes one-pending-per-agent structural -- a later switch
                                                        -- overwrites it (supersession, last writer wins) under the same row lock,
                                                        -- so a queue of half-wanted switches is unrepresentable. Holds the PENDING
                                                        -- binding only; the effective binding stays in the columns above and moves
                                                        -- there at application. Cleared by whichever terminal event settles the switch
                                                        -- (agent.providerBinding.changed / agent.providerBinding.changeFailed, which leaves the
                                                        -- columns above untouched, so a switch that fails after it was accepted keeps the
                                                        -- agent on its previous binding) and by supersession
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_agents_session ON agents(session_id);

-- Owner: Plan-013 (row-canonical daemon configuration — queue_items posture, NOT evented; one row per session, written when the session is created from the Runtime settings' Spend limit and Tokens per run; mutated only via session.spendLimit.update and session.tokensPerRun.update — D-013-5)
CREATE TABLE session_budgets (
  session_id                    TEXT PRIMARY KEY,
  spend_limit_usd_micros        INTEGER,                        -- integer micro-dollars; NULL = `Unlimited`, the default; the session's `Spend limit` across every provider and account it uses (Spec-014 §Budget Policies)
  tokens_per_run                INTEGER,                        -- input and output tokens together for one run; NULL = `Unlimited`, the default; the session's `Tokens per run`
  updated_at                    TEXT NOT NULL,
  -- Each limit is NULL (no limit) or an integer the wire's limit verbs also check (D-013-5)
  CHECK (spend_limit_usd_micros IS NULL OR spend_limit_usd_micros >= 0),
  CHECK (tokens_per_run IS NULL OR tokens_per_run >= 1)
) STRICT;

-- The daemon's own agent tree: one row per helper a provider named in a session (a Claude Code
-- task, a Codex child thread), keyed by the handle the daemon mints at the helper's first start.
-- Each start of the helper queues a run of its own, and that run's `agent.run.queued` writes the
-- node in the event's own write: the first start inserts it, each later one binds its newest own
-- run. A rebuild folds the nodes again from those events. A helper's state is its newest own run's,
-- read from `runs`. After a daemon restart every helper still running is re-attached by its
-- provider id, and every fan-out count is read from here.
CREATE TABLE agent_tree_nodes (
  child_handle         TEXT PRIMARY KEY,                -- the daemon's handle for the helper, a UUID
  session_id           TEXT NOT NULL,
  provider_name        TEXT NOT NULL,                   -- provider driver key, as on `agents`
  subagent_id          TEXT NOT NULL,                   -- the provider's own id for the helper, verbatim: the Claude Code
                                                        -- task id or the Codex thread id, which is also what a restart resumes it by
  parent_subagent_id   TEXT,                            -- its parent's provider id; NULL under the lead
  parent_child_handle  TEXT REFERENCES agent_tree_nodes(child_handle), -- its parent's node; NULL under the lead
  name                 TEXT,                            -- Codex's nickname; NULL on Claude Code
  role                 TEXT,                            -- Claude Code's subagent type or Codex's agent role
  provider_path        TEXT,                            -- the helper's path in Codex's tree; NULL on Claude Code
  model_id             TEXT,                            -- the model its first start named, which the tree's head shows before
                                                        -- the parent's binding
  effort               TEXT,                            -- the effort its first start named, likewise
  start_call_id        TEXT,                            -- the Claude Code call that started the newest own run, which an
                                                        -- automatic resume names again; NULL on Codex
  own_run_id           TEXT NOT NULL,                   -- the newest own run, whose state is the helper's
  started_at           TEXT NOT NULL,                   -- the first own run's start
  updated_at           TEXT NOT NULL,                   -- when the newest own run was bound
  UNIQUE (session_id, provider_name, subagent_id)       -- one node per helper: a later start binds its newest run
) STRICT;

CREATE INDEX idx_agent_tree_nodes_name ON agent_tree_nodes(session_id, name) WHERE name IS NOT NULL;
CREATE INDEX idx_agent_tree_nodes_provider_path ON agent_tree_nodes(session_id, provider_path)
  WHERE provider_path IS NOT NULL;
CREATE INDEX idx_agent_tree_nodes_own_run ON agent_tree_nodes(own_run_id);
CREATE INDEX idx_agent_tree_nodes_parent ON agent_tree_nodes(parent_child_handle); -- a deleted node's children

-- Two sessions trading messages. [Spec-014 §State And Data Implications](../../specs/014-multi-agent-orchestration.md#state-and-data-implications)
-- declares the four tables below durable, session-scoped daemon state, because a daemon restart
-- mid-exchange must deliver what it was holding, answer or wake every call still waiting, fire every
-- reminder still due and not forget which two sessions were talking. No table refers to `sessions`:
-- a session's purge deletes its rows here before its directory row.
-- The session directory those tables are read against is the daemon's `sessions` table (local-sqlite-session-tables.md §Session Directory),
-- and an address that moved with a restarted provider process is looked up again rather than remembered.
--
-- No table holds a message. The send and the arrival are the ordinary tool events of the two
-- sessions' own logs ([Spec-014 §Sessions Talking To Each Other](../../specs/014-multi-agent-orchestration.md#sessions-talking-to-each-other)),
-- which is where the words live; a queue row names the send it is holding and nothing else.
CREATE TABLE session_exchanges (
  session_id        TEXT NOT NULL,   -- the pair, held as ONE row with the two ids in ascending order
  peer_session_id   TEXT NOT NULL,   -- so the count below is one count for one exchange. Two rows for one pair would be two answers to "how many since the person last wrote", and each session's own row in the sessions list reads the peer it is not
  messages_since_user_wrote INTEGER NOT NULL
                    CHECK (messages_since_user_wrote >= 1),  -- what the exchange line on each session's row states, `talking to builder · 14`. The row is made at the pair's first message, counting one, and deleted when the person writes in either session, so the next message starts a new count; it is a fact on the row and never a limit, nothing of this runtime bounding how many messages two sessions trade
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, peer_session_id),
  CHECK (session_id < peer_session_id)  -- the canonical ordering that makes the pair one row. An interrupt taken on either session reads this row to reach the other, so the pair is what is stored and the direction of the last message is not
) STRICT;

CREATE INDEX idx_session_exchanges_peer ON session_exchanges(peer_session_id);

-- Every message addressed to a PAUSED session, in arrival order. The daemon holds them while the
-- session is paused and delivers them one at a time in this order when it continues; a row is deleted
-- when its message is delivered, so the table is empty whenever nothing is being held.
CREATE TABLE session_paused_message_queue (
  target_session_id  TEXT NOT NULL,   -- the paused session the message is addressed to
  arrival_sequence   INTEGER NOT NULL CHECK (arrival_sequence >= 1),  -- arrival order at the daemon, per target session. Delivery follows it exactly: a queue that delivered out of order would rewrite the conversation the sending session believes it had
  source_session_id  TEXT NOT NULL,   -- the sending session
  source_event_id    TEXT NOT NULL,   -- the send's own tool event on the SENDING session's log, which is where the message text already lives (session_events.content_payload holds tool-call arguments). No foreign key, for the reason the event log's own session_id carries none, and no body column: a second copy of the words would be a second record of them
  arrived_at         TEXT NOT NULL,
  PRIMARY KEY (target_session_id, arrival_sequence),
  UNIQUE (target_session_id, source_event_id)  -- one hold per send, so a re-delivery attempt after a restart queues nothing twice
) STRICT;

-- What each session waits on: one row per awaited session of one waiting call, so the call is
-- answered or woken at the first of them to finish or need the person, and still is after a restart.
CREATE TABLE session_waits (
  session_id          TEXT NOT NULL,   -- the waiting session
  tool_call_id        TEXT NOT NULL,   -- the provider's id of the call that waits
  awaited_session_id  TEXT NOT NULL,
  form                TEXT NOT NULL
                      CHECK (form IN ('held', 'answeredThenWoken')),  -- how the caller's provider waits: the call held open and answered with the awaited session's result, or answered at once and the waiting session woken with a new turn
  created_at          TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_call_id, awaited_session_id)
) STRICT;

CREATE INDEX idx_session_waits_awaited ON session_waits(awaited_session_id);  -- the calls a session's finish or its need of the person wakes

-- Each reminder a session set, kept until it fires, so one due while the daemon was down fires when
-- it is back, naming both when it was set and when it was due.
CREATE TABLE session_reminders (
  id          TEXT PRIMARY KEY,   -- minted, so two reminders set in one millisecond stay two
  session_id  TEXT NOT NULL,
  note        TEXT NOT NULL,      -- the session's own words for what to do when it wakes
  set_at      TEXT NOT NULL,
  due_at      TEXT NOT NULL       -- RFC 3339 UTC, ms precision, so text order is time order
) STRICT;

CREATE INDEX idx_session_reminders_due ON session_reminders(due_at);  -- the earliest due, which the scheduler's one timer is armed at, and those now due
CREATE INDEX idx_session_reminders_session ON session_reminders(session_id);
```

A run's token limit (`tokenLimit`, input and output together for one run) is `Unlimited` by default; the session's `Tokens per run` value is resolved onto each run at admission as a per-run `OrchestrationRunConfig` value and persisted durably as the `agent.run.queued` payload's `effectiveRunConfig` (Plan-013 D-013-5; api-payload `RunStateChangeEvent`), and enforcement rebuilds from that event field, never by re-merging session values that may have changed mid-run. The service ends a run `stopped` with `trigger: tokenLimit` at the first usage report past its limit, so one request can overshoot slightly, and the agent's next message starts a new run with a fresh count. Budget _accounting_ (tokens/cost consumed) has no **accumulator** table: the daemon's `BudgetAccountant` is an in-memory projection rebuilt from `usageTelemetry` + `agent.run.*` events (D-013-5). `provider_account_usage_turns` (in [Provider Account Tables (Plan-023)](local-sqlite-provider-account-tables.md)) is not a second accountant: it projects the same `usageTelemetry` events into one row per turn so the figures can be sliced by account, by day and by model, which a running total cannot be (Spec-025 §State And Data Implications).
