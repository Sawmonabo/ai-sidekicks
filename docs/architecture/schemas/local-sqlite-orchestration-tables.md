# Orchestration Tables (Plan-013)

The multi-agent orchestration tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

DDL per Plan-013 D-013-5. Posture per table: `run_links` and `agents` are events-canonical projections ([ADR-016](../../decisions/016-shared-event-sourcing-scope.md) Option B — rebuilt from `session_events`; never written except by the projector); `session_budgets` is row-canonical daemon configuration (the `queue_items` posture — mutated by wire method, not evented), and so are the session-messaging tables, the `agents.pending_switch` column (written before a switch is acknowledged, since no event records a switch being asked for) and `agent_tree_nodes` (written by the daemon alone when an agent starts and when it finishes), so none of them is rebuilt from the log.

```sql
-- Owner: Plan-013 (events-canonical projection of the run.queued orchestration-carrier fields — D-013-3)
CREATE TABLE run_links (
  parent_run_id     TEXT NOT NULL,
  child_run_id      TEXT NOT NULL,
  session_id        TEXT NOT NULL,                      -- session provenance (I-013-3): local and relay rebuild scope by session
  reached_by        TEXT NOT NULL
                    CHECK(reached_by IN ('provider_subagent', 'bridge_run', 'workflow_step')),   -- how the child was reached (D-013-12)
  created_at        TEXT NOT NULL,
  PRIMARY KEY (child_run_id),                       -- single-parent: a child run links to exactly one parent (one-shot run.queued linkage D-013-3)
  CHECK (parent_run_id <> child_run_id)             -- a run never parents itself
);

CREATE INDEX idx_run_links_parent ON run_links(parent_run_id); -- parent → children scans (orchestration.childRunLinkRead; the session's agent tree)
CREATE INDEX idx_run_links_session ON run_links(session_id);

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
  driver_name     TEXT NOT NULL,                        -- provider driver key (Plan-003 capability surface)
  model_id        TEXT NOT NULL,
  provider_account_id TEXT,                             -- D-013-17: the binding's own account, the Plan-023 `provider_accounts.account_id`
                                                        -- this agent spawns under; NULL = follow the provider's current account, whichever it
                                                        -- is when a run starts, so this agent follows the mark when it moves. Set only when
                                                        -- the binding itself names an account. The account a run landed on is carried on the
                                                        -- settling agent.provider_binding_changed event, beside the binding, and is never
                                                        -- written here, so a following agent is never silently pinned. The Spec-025 spawn gate reads it
  effort          TEXT,                                 -- D-013-17: reasoning effort, validated against the target
                                                        -- model's driver-reported `effortLevels` rather than a schema CHECK --
                                                        -- the valid set is per-model and provider-owned, so a CHECK here would
                                                        -- go stale against the provider rather than protect anything
  ultracode       INTEGER,                              -- D-013-17, Claude Code's Ultracode switch as last set: 0 or 1.
                                                        -- NULL = never set, so Claude Code's own default stands.
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
                                                        -- 'pending', switchId, appliesAt: 'turn_boundary'|'run_boundary',
                                                        -- interruptRequested, pendingAxes: {driverName?, modelId?, providerAccountId?,
                                                        -- effort?, outputSpeed?}, replacedSwitchId?} -- shared with the mutation reply and
                                                        -- the `pendingSwitch` member agent.list returns, so what a client was told and what
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
                                                        -- read 'turn_boundary'. pendingAxes carries TARGET VALUES and not axis names: at
                                                        -- the boundary the caller's request is gone, so the row must be sufficient to
                                                        -- apply the switch by itself. Two writers admit a switch: agent.configUpdate, for
                                                        -- the provider, model, effort and speed axes, and providerAccount.setCurrent, which
                                                        -- records a pending account switch on an agent following the moved mark whose
                                                        -- session cannot move in place at its next request. This is the ONE switch
                                                        -- acknowledged to a caller but not yet applied at its boundary; NULL = none.
                                                        -- Durable because the acknowledgment is a promise a restart must keep: startup
                                                        -- re-arms from this column instead of dropping the intent. A single nullable
                                                        -- column is what makes one-pending-per-agent structural -- a later switch from either
                                                        -- writer overwrites it (supersession, last writer wins) under the same row lock,
                                                        -- so a queue of half-wanted switches is unrepresentable. Holds the PENDING
                                                        -- binding only; the effective binding stays in the columns above and moves
                                                        -- there at application. Cleared by whichever terminal event settles the switch
                                                        -- (agent.provider_binding_changed / agent.provider_binding_change_failed, which leaves the
                                                        -- columns above untouched, so a switch that fails after it was accepted keeps the
                                                        -- agent on its previous binding) and by supersession
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_agents_session ON agents(session_id);

-- Owner: Plan-013 (row-canonical daemon configuration — queue_items posture, NOT evented; one row per session, written when the session is created from the Runtime settings' Spend limit and Tokens per run; mutated only via session.spendLimitUpdate and session.tokensPerRunUpdate — D-013-5)
CREATE TABLE session_budgets (
  session_id                    TEXT PRIMARY KEY,
  spend_limit_usd_micros        INTEGER,                        -- integer micro-dollars; NULL = `Unlimited`, the default; the session's `Spend limit` across every provider and account it uses (Spec-014 §Budget Policies)
  tokens_per_run                INTEGER,                        -- input and output tokens together for one run; NULL = `Unlimited`, the default; the session's `Tokens per run`
  updated_at                    TEXT NOT NULL,
  -- Each limit is NULL (no limit) or an integer the wire's limit verbs also check (D-013-5)
  CHECK (spend_limit_usd_micros IS NULL OR spend_limit_usd_micros >= 0),
  CHECK (tokens_per_run IS NULL OR tokens_per_run >= 1)
);

-- The daemon's own agent tree: one row per agent a provider starts inside a run (a Claude Code task,
-- a Codex child thread), written by the daemon alone when the agent starts and when it finishes and
-- never evented. After a daemon restart every child still running is re-attached by its id, and every
-- fan-out count is read from here.
CREATE TABLE agent_tree_nodes (
  run_id            TEXT NOT NULL,                  -- the run the agent was started in
  driver_name       TEXT NOT NULL,                  -- provider driver key, as on `agents`
  subagent_id       TEXT NOT NULL,                  -- the provider's own id for the agent, verbatim: the Claude Code task id or the
                                                    -- Codex thread id, which is also what a restart resumes it by
  parent_reference  TEXT,                           -- the provider's own parent link, verbatim: the Claude Code parent tool-call id or
                                                    -- the Codex parent thread id; NULL where the provider named none
  state             TEXT NOT NULL
                    CHECK(state IN ('running', 'completed', 'failed', 'interrupted', 'stopped')),
                    -- read from the agent's own update (the Claude Code task update, the Codex
                    -- child turn's frame), never from the lead's result
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, driver_name, subagent_id)   -- one row per agent: a second start for the same agent is refused
);

-- Two sessions trading messages. [Spec-014 §State And Data Implications](../../specs/014-multi-agent-orchestration.md#state-and-data-implications)
-- declares both of the tables below durable, session-scoped daemon state, because a daemon restart
-- mid-exchange must deliver what it was holding and must not forget which two sessions were talking.
-- The session directory those tables are read against is the daemon's `sessions` table (local-sqlite-schema.md §Session Directory),
-- and an address that moved with a restarted provider process is looked up again rather than remembered.
--
-- Neither table holds a message. The send and the arrival are the ordinary tool events of the two
-- sessions' own logs ([Spec-014 §Sessions Talking To Each Other](../../specs/014-multi-agent-orchestration.md#sessions-talking-to-each-other)),
-- which is where the words live; a queue row names the send it is holding and nothing else.
CREATE TABLE session_exchanges (
  session_id        TEXT NOT NULL,   -- the pair, held as ONE row with the two ids in ascending order
  peer_session_id   TEXT NOT NULL,   -- so the count below is one count for one exchange. Two rows for one pair would be two answers to "how many since the person last wrote", and each session's own row in the sessions list reads the peer it is not
  messages_since_user_wrote INTEGER NOT NULL DEFAULT 0
                    CHECK (messages_since_user_wrote >= 0),  -- what the exchange line on each session's row states, `talking to builder · 14`. Reset to zero when the person writes in either session; it is a fact on the row and never a limit, nothing of this runtime bounding how many messages two sessions trade
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, peer_session_id),
  CHECK (session_id < peer_session_id)  -- the canonical ordering that makes the pair one row. An interrupt taken on either session reads this row to reach the other, so the pair is what is stored and the direction of the last message is not
);

-- Every message addressed to a PAUSED session, in arrival order. The daemon holds them while the
-- session is paused and delivers them one at a time in this order when it continues; a row is deleted
-- when its message is delivered, so the table is empty whenever nothing is being held.
CREATE TABLE session_paused_message_queue (
  target_session_id  TEXT NOT NULL,   -- the paused session the message is addressed to
  arrival_sequence   INTEGER NOT NULL,  -- arrival order at the daemon, per target session. Delivery follows it exactly: a queue that delivered out of order would rewrite the conversation the sending session believes it had
  source_session_id  TEXT NOT NULL,   -- the sending session
  source_event_id    TEXT NOT NULL,   -- the send's own tool event on the SENDING session's log, which is where the message text already lives (session_events.content_payload holds tool-call arguments). No foreign key, for the reason the event log's own session_id carries none, and no body column: a second copy of the words would be a second record of them
  arrived_at         TEXT NOT NULL,
  PRIMARY KEY (target_session_id, arrival_sequence),
  UNIQUE (target_session_id, source_event_id)  -- one hold per send, so a re-delivery attempt after a restart queues nothing twice
);
```

A run's token limit (`tokenLimit`, input and output together for one run) is `Unlimited` by default; the session's `Tokens per run` value is resolved onto each run at admission as a per-run `OrchestrationRunConfig` value and persisted durably as the `run.queued` payload's `effectiveRunConfig` (Plan-013 D-013-5; api-payload `RunStateChangeEvent`), and enforcement rebuilds from that event field, never by re-merging session values that may have changed mid-run. The service stops a run at the first usage report past its limit, so one request can overshoot slightly. Budget _accounting_ (tokens/cost consumed) has no **accumulator** table: the daemon's `BudgetAccountant` is an in-memory projection rebuilt from `usage_telemetry` + `run.*` events (D-013-5). `provider_account_usage_turns` (in [Provider Account Tables (Plan-023)](local-sqlite-provider-account-tables.md)) is not a second accountant: it projects the same `usage_telemetry` events into one row per turn so the figures can be sliced by account, by day and by model, which a running total cannot be (Spec-025 §State And Data Implications).
