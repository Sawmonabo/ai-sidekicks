# Session Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-001 — Session Core

```ts
// SessionCreate
interface SessionCreateRequest {
  clientIdempotencyKey: string; // a UUID
  // Where the new session works, bound in this same call, so no session exists unbound and its shape is
  // known from its first record.
  binding: SessionBinding;
  // The lead spelled out: its driver, model and effort, and its output speed where one was picked, as the
  // app chose them for a new session. A create names this, `leadDefinitionId`, or both; beside a
  // definition, it is the binding the definition runs on. It names no account: the daemon resolves it.
  lead?: SessionLead;
  // The saved definition this session's LEAD runs under: a request that spells its axes out in full
  // names none, and one naming a definition need not respell the axes the definition supplies. It is how
  // Try it starts a scratch session led by the definition under test, and it is the same daemon path a
  // workflow node and the cross-provider bridge already need — not a choose-your-lead surface. What it
  // resolved to comes back as the reply's `resolvedConfiguration` (`AgentResolvedConfiguration`, agent-definition-payloads.md §Plan-024).
  leadDefinitionId?: AgentDefinitionId;
  // A Try-it scratch session for the definition `leadDefinitionId` names. It requires that member and a
  // `chat` binding, so it has no repo. The daemon keeps at most one open scratch session per definition,
  // so a request for a definition that already has one returns that session instead of a second; the
  // session stays in the sessions list, named, until the person closes it.
  scratch?: true;
  // `New session in group`: the new session is filed in this group of its project. Only with a
  // `project` binding naming the group's project.
  groupId?: SessionGroupId;
}

// A chat names nothing more: the daemon makes the chat's managed workspace inside the create and registers
// it as a mount whose managed origin names this one chat. A project names the project's mount and where the
// session works in it — the project's own checkout (`bound-root`) or a worktree of its own
// (`provisioned-worktree`) — and the daemon checks, in the same step, that the picked root belongs to the
// project, the check `repo.workspaceBind` makes when a chat converts. A mount belongs to the machine,
// not to one session, so every project session names the project's one mount.
type SessionBinding =
  | { kind: "chat" }
  | { kind: "project"; repoMountId: RepoMountId; executionMode: ExecutionMode };
type SessionLead = Omit<AgentProviderBinding, "providerAccountId">;
interface SessionCreateResponse {
  sessionId: SessionId;
  shape: SessionShape;
  state: SessionState;
  // The binding the daemon resolved for the lead, the account among it: the same values the session's
  // `session.created` records.
  lead: AgentProviderBinding;
  // Present iff the request carried `leadDefinitionId`: the echo lets a caller render what it actually
  // got instead of re-reading the registry and assuming it has not moved (agent-definition-payloads.md §Plan-024).
  resolvedConfiguration?: AgentResolvedConfiguration;
}

// session.created payload (Spec-005 §Session Lifecycle). A session has exactly one main agent and that
// agent is born with the session rather than joined to it later, so this event is the creating record of
// that agent's row in the agents projection (`AgentListEntry`, `agent.list` in orchestration-payloads.md §Plan-013) and no attach event exists.
// It is also the one record of the session's shape at birth, of the session it was forked from, and of the
// definition a scratch session tries, so the session's row is rebuilt from events alone.
interface SessionCreatedPayload {
  sessionId: SessionId;
  shape: SessionShape;
  mainAgent: AgentListEntry; // the agent as `agent.list` describes it, one shape for one live agent
  // Present exactly on a forked session: the session it was forked from and the message it was forked
  // at. Parentage is recorded here and nowhere else (`session.fork` below).
  parent?: { sessionId: SessionId; anchorCursor: EventCursor };
  // Present exactly on a Try-it scratch session (`scratch` on SessionCreateRequest).
  scratchForDefinitionId?: AgentDefinitionId;
  actor?: DeviceId; // the device of the connection that created it
}

// SessionRead
interface SessionReadRequest {
  sessionId: SessionId;
}
interface SessionReadResponse {
  session: SessionRecord;
  // `earliest` is required: the position just before the oldest surviving row, where a reader with
  // no acknowledged cursor resumes (Plan-004 T4.1).
  transcriptCursors: { earliest: EventCursor; latest: EventCursor; acknowledged?: EventCursor };
}

// SessionSubscribe
interface SessionSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor; // catch up from just after this position, then follow
}
// The reply is the subscription's acknowledgment and nothing else; the events then arrive as
// `$/subscription/notify` frames keyed by `subscriptionId`. The daemon ends a stream with one
// `$/subscription/end` frame (`completed`, or `refused` with its error); a client ends one with
// `$/subscription/cancel`.
type SubscriptionId = string & { readonly __brand: "SubscriptionId" }; // allocated by the daemon per subscription
interface SessionSubscribeResponse {
  subscriptionId: SubscriptionId;
}
// Each notify's value. The daemon coalesces the session's events into one frame per 16 ms or 50
// events, whichever comes first, the window opening on the first event so nothing waits longer than it.
// A frame carries changes, never the whole transcript, oldest first, and every change carries its cursor.
// The daemon never waits for a subscriber: changes that do not fit are dropped for it and `dropped` rides
// the next frame that fits; the subscriber then repairs from the daemon's record by cursor, and past a gap
// of 1,024 events reads `session.read` and resumes from its latest cursor instead of filling. When a
// subscriber that fell behind has caught up, the daemon sends it one frame with no changes, carrying
// `dropped` and the newest cursor, so a session that goes quiet right after a drop still tells the
// subscriber it is behind.
interface SessionStreamFrame {
  changes: Array<{ cursor: EventCursor; event: EventEnvelope }>; // at most 50; EventEnvelope: session-event-payloads.md §Plan-004 — Session Event Taxonomy
  dropped?: true;
  // Present only on the frame with no changes, which always carries `dropped`: the newest cursor the
  // daemon holds for the session. A frame with changes carries no frame cursor.
  cursor?: EventCursor;
}

// A session's shape, decided by its BINDING and carried as a stored discriminator — the `shape` column on
// the session's row — never a mode flag on a request and never guessed from a path prefix
// ([ADR-030](../../decisions/030-two-session-shapes.md)). A `chat` session is bound to a daemon-owned,
// git-initialized managed workspace, one per session, at `<home>/.ai-sidekicks/workspaces/<session-id>`,
// a path the daemon makes and never takes from a caller. The daemon creates it inside `session.create`
// (and inside `session.fork` for a chat, whose fork gets a workspace of its own) and registers it as a
// mount whose managed origin names that one chat. It is deleted whole when the session is purged, kept
// when the session is archived, and skipped by the archive sweep. A `project` session is bound to a repo
// the person attached, which is defined against that mount's origin rather than against a folder
// existing. Converting a chat to a project copies the workspace's files into the attached repo and moves
// the shape IN PLACE with the session's history kept, which is why the shape is a member of the session
// record and not an immutable creation argument.
type SessionShape = "chat" | "project";

// Shared projection types
interface SessionRecord {
  id: SessionId;
  state: SessionState;
  shape: SessionShape;
  // The session's own name. Absent means untitled, which is the ordinary state: a surface listing an
  // untitled session shows its first message rather than a generated title, so no default is
  // materialized here.
  name?: string;
  // Whether the person muted this session's notifications (`session.mute` below). The same fact rides each
  // `session.list` entry.
  muted: boolean;
  // The working-folder move a run boundary will apply, or null when none is pending
  // (`session.setWorkingFolder` below); `worktreeId: null` targets the project's repo root.
  pendingWorkingFolder: { worktreeId: WorktreeId | null } | null;
  // The daemon-held composer store below: the whole unsent draft (empty when there is none) and the whole
  // staged set, so every device opens the same half-written message.
  draft: string;
  attachments: SessionAttachmentSummary[];
  // This session's OWN bound on how many steps one turn may take, absent where the person set none —
  // in which case the machine's own Runtime value applies, and where that is unset the turn is
  // unbounded and each provider does what it does on its own. What the bound does and how each
  // provider realizes it is Spec-003 §The Step Bound On A Turn's; it is not a budget, and reaching
  // it ends the turn and then the run, as run.interrupted with trigger "step_limit".
  maxStepsPerTurn?: number;
  // The address another session writes to when it messages this one — what the session inspector
  // offers as `Copy address`. It names the inbox the daemon holds for the session — one socket (a named
  // pipe on Windows) in Claude Code's socket directory, stable for the session's whole life; the daemon
  // forwards each frame to the live process and, while the session sleeps, takes the first frame, wakes
  // the session through Claude Code's resume and delivers the frame as the message. Present on every
  // session. No read of its own exists, deliberately — the one surface that shows it already reads this
  // snapshot, and a second verb would be a second source for one fact (Spec-014 §Sessions Talking To
  // Each Other).
  address: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Console session operations ----
// The verbs the session screen calls beside the three above. Payload owner: [Spec-001 §Interfaces And Contracts](../../specs/001-session-core.md#interfaces-and-contracts).

// SessionRename — session.rename. The name lives on the session record. `null` clears it, and the
// session's first-message title shows again, rather than writing an empty title, so a name is never
// the empty string. Renaming to the name the session already has writes nothing.
interface SessionRenameRequest {
  sessionId: SessionId;
  name: string | null;
}
interface SessionRenameResponse {
  sessionId: SessionId;
  name: string | null; // the name the session now holds; null when its first-message title shows
}

// SessionMaxStepsUpdate — session.maxStepsUpdate. Sets or clears THIS session's own bound on how many
// steps one turn may take. `null` clears the override and returns the session to the machine's own
// Runtime value; a number is a positive integer, and a number below 1 is refused. A session id the
// daemon does not hold is refused with `session.not_found` and nothing is appended. A change reaches
// the session's NEXT turn and never the turn in flight, which is why the reply echoes the stored
// override rather than any running turn's effective value. The machine-wide value is not written
// here — it belongs to the Runtime settings page (settings-payloads.md §Settings Surface Reads And Writes), so one number
// has one home on each side of the override.
interface SessionMaxStepsUpdateRequest {
  sessionId: SessionId;
  maxStepsPerTurn: number | null;
}
interface SessionMaxStepsUpdateResponse {
  sessionId: SessionId;
  maxStepsPerTurn?: number; // absent after a clear, the same shape the session record carries
}

// SessionSpendLimitUpdate / SessionTokensPerRunUpdate — session.spendLimitUpdate /
// session.tokensPerRunUpdate. Set or clear THIS session's own `Spend limit` and `Tokens per run`,
// which start at the Runtime settings page's values when the session is created. `null` is
// `Unlimited`, after which nothing stops or refuses on that limit. A spend limit is a non-negative
// integer of micro-dollars and a token limit a positive integer; anything else is refused, as is a
// session id the daemon does not hold (`session.not_found`), and nothing is appended. Saving a higher
// limit carries on the turn or run that limit stopped, as `Raise limit` does (Spec-014 §Budget
// Policies). Both answer with the budget state, served from the one budget-accountant accessor as the
// read is, so a reply and an immediately following `orchestration.budgetRead` carry the same figures.
interface SessionSpendLimitUpdateRequest {
  sessionId: SessionId;
  spendLimitUsdMicros: number | null;
}
interface SessionTokensPerRunUpdateRequest {
  sessionId: SessionId;
  tokensPerRun: number | null;
}

// SessionFork — session.fork. Mints a session of the SAME shape from a message anchor, carrying the
// transcript prefix up to and including that message with live timers settled and streams stopped in
// the copy, and carrying the parent's execution posture and tool set. A `project` fork lands on a
// new worktree cut off the parent's current one at its current commit; a `chat` fork stays a chat, with
// a managed workspace of its own, and involves no worktree. Parentage is recorded on the forked session's
// OWN session-created record (`SessionCreatedPayload.parent`) and NOT as a second event: one read of the
// new session answers where it came from, and the parent's own history is untouched.
interface SessionForkRequest {
  sessionId: SessionId;
  // The anchored message, addressed in the same cursor vocabulary session.subscribe and
  // transcript.read use. The fork carries every row up to and including this position.
  anchorCursor: EventCursor;
  // Absent leaves the fork untitled — the ordinary case, since the fork affordance asks for no name.
  name?: string;
  clientIdempotencyKey: string; // a UUID
}
// The minted session, of the parent's shape: a `project` fork names its new worktree, a `chat` fork has
// none.
type SessionForkResponse =
  | { sessionId: SessionId; shape: "project"; worktreeId: WorktreeId }
  | { sessionId: SessionId; shape: "chat" };

// SessionSetWorkingFolder — session.setWorkingFolder. ONE call requesting the move of a session's
// working folder to another of its project's worktrees, or back to the repo root. An idle session
// moves at once — same session, same history, new directory, and the live provider process
// reconnects there. A request made mid-run never refuses: the pending intent is recorded ON THE
// SESSION ROW rather than queued, and applies at the run boundary. Re-targeting to the current
// directory IS the cancel, and a later request SUPERSEDES the pending one rather than queuing behind
// it, so a session holds at most one pending move. Removing a worktree clears every pending move
// pointing at it and sweeps the sessions standing in it back to the repo root.
interface SessionSetWorkingFolderRequest {
  sessionId: SessionId;
  worktreeId: WorktreeId | null; // null targets the project's repo root
}
interface SessionSetWorkingFolderResponse {
  sessionId: SessionId;
  // `applied` — the session moved now, either because it was idle or because the request
  // re-targeted the current directory and thereby cleared a pending move. `pending` — a run was
  // live and the intent is recorded for the boundary. These two arms are what the composer strip
  // reads to draw either the new tree or `<current> → <target> when this run ends`.
  disposition: "applied" | "pending";
  worktreeId: WorktreeId | null;
}

// The daemon-held, SESSION-SCOPED composer store: the draft, its staged files, and the held review
// notes of gitflow-payloads.md §Plan-008. Daemon-held rather than window-held for one reason — a half-written
// message or review reaches the person's other devices, and Send needs no upload step because the
// file was already copied. Typed unsent text is NEVER written to renderer-local storage.

// SessionDraftUpdate — session.draftUpdate.
interface SessionDraftUpdateRequest {
  sessionId: SessionId;
  text: string; // the whole draft; an empty string clears it
}
interface SessionDraftUpdateResponse {
  sessionId: SessionId;
  updatedAt: string;
}

// SessionAttachmentAdd — session.attachmentAdd. Staging COPIES each file to the daemon and keeps the
// copy OUTSIDE the checkout, so a staged file survives a working-folder move and never appears in a
// diff. Several items at a time, at least one; a file item is a file, never a folder. The renderer holds
// only the `FilePathRef` token the platform's own chooser, a drop or a paste gave it
// ([Preload Bridge Contract](preload-bridge-contract.md)),
// and main's relay turns the token into the `path` the daemon copies, so a path reaches the daemon only
// from the main process or the command line; a pasted picture is a file too, written by main to a
// temporary file whose token it mints. Each accepted item is validated by the Plan-011 ingest pipeline —
// a picture is stored as it came, and that copy is the only one kept, shown and sent — and is addressed by its `ArtifactId` from then on, so the original path is never read again,
// which is also why a pasted or dropped file stages through this same operation rather than a second one.
interface SessionAttachmentAddRequest {
  sessionId: SessionId;
  items: SessionAttachmentItem[];
}
// `clientStagingId` is the client's own id for one item, a UUID, so a retried item is staged once: the
// daemon answers a repeated id with the item it already staged or refused.
type SessionAttachmentItem =
  | { kind: "file"; clientStagingId: string; path: string }
  // Preview's marks chip is staged by `preview.marksSend` (page-host-payloads.md §Page-Host Method Registry), never here.
  // One resource a tool server offers, picked from `session.mcpResourceList`. Its content is untrusted
  // and its `uri` is never used as a path.
  | { kind: "mcpResource"; clientStagingId: string; serverName: string; uri: string };
interface SessionAttachmentAddResponse {
  sessionId: SessionId;
  // The WHOLE staged set, so a client renders what the daemon holds instead of merging its own add.
  attachments: SessionAttachmentSummary[];
  // One entry per item not staged, so no item is dropped in silence. How many were taken is the
  // request's items less these.
  refused: SessionAttachmentRefusal[];
}
// One item the daemon did not stage, by the name the refusal line shows, and the limit it hit. The
// strip's line names the file and the cause; a failed copy reads
// `<name> was not attached · <cause>`.
interface SessionAttachmentRefusal {
  clientStagingId: string;
  name: string;
  cause:
    | {
        code: "session.attachment_refused";
        // count_limit: the message already carries as many files as the provider takes; folder: a
        // folder was offered; provider_takes_no_attachments; card_waiting: a card above the
        // composer waits on the person.
        reason: "count_limit" | "folder" | "provider_takes_no_attachments" | "card_waiting";
      }
    | {
        code: "session.attachment_refused";
        // The provider's own limit (a file larger than it takes) or its refusal of a picture.
        reason: "provider_refused";
        providerMessage: string; // the provider's own words, shown as given
      }
    | {
        code: "session.attachment_refused";
        // The copy to the daemon did not complete.
        reason: "copy_failed";
        detail: string; // the daemon's own cause, the text after `·` on the refusal line
      }
    // The free disk cannot hold the file even with nothing else being taken.
    | { code: "artifact.too_large"; availableBytes: number }
    // The file only waits on the files already being taken.
    | { code: "artifact.ingest_capacity_exhausted" };
}
// Every member is what the daemon found in the bytes it copied, never what the caller declared.
interface SessionAttachmentSummary {
  artifactId: ArtifactId;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}
interface SessionAttachmentRemoveRequest {
  sessionId: SessionId;
  artifactId: ArtifactId;
}
interface SessionAttachmentRemoveResponse {
  sessionId: SessionId;
  attachments: SessionAttachmentSummary[]; // the whole remaining set, the same reason as on add
}

// SessionMute / SessionUnmute — session.mute and session.unmute. Muting withholds this session's
// `Finished` and `Failed` notifications on every channel and every device — no banner, no web-address
// message, no email-digest line — and withdraws those of its banners still standing. `Waiting on you`, a
// workflow's Notify step, the bell's list and its count are untouched, so a mute never hides what waits
// on the person ([Plan-016](../../plans/016-notifications-and-attention-model.md#invariants) I-016-3).
// The daemon holds the mute, so every device sees it, and it has no timer. Muting a muted session appends
// nothing, and likewise unmuting an unmuted one.
// The request of every verb that acts on one session and takes nothing else: `session.archive`,
// `session.reactivate`, `session.close`, `session.pin`, `session.unpin`, `session.mute`,
// `session.unmute` and `session.restart`.
interface SessionTargetRequest {
  sessionId: SessionId;
}
// `{}`: the change is read from the event the verb appends, which every device folds. A verb that finds
// the session already in the state it asks for appends nothing and answers the same.
type SessionVerbResponse = Record<string, never>;

// session.pinned / session.unpinned / session.muted / session.unmuted payloads (Spec-005 §Session
// Lifecycle). Pinned rows sit in the order they were pinned, and the session row's `muted_at` is rebuilt
// from these events and goes with the session.
interface SessionMarkChangePayload {
  sessionId: SessionId;
  at: string; // ISO 8601
}

// session.advisor_changed payload. A Claude Code session's advisor is its own: copied from the
// app's default when the session is created, held with its other provider settings, and changed
// only by `/advisor <model>` or `/advisor off` in that session, each change one event; a later
// change to the default never reaches it. Every Claude Code process started for the session reads
// it at launch.
interface SessionAdvisorChangedPayload {
  sessionId: SessionId;
  advisorModel: string | null; // the advisor's model; null when the advisor is off
  at: string; // ISO 8601
}

// SessionSearch — session.search. One search over session titles, message text, tool calls, session
// group names and tags across every session the list holds, archived ones included, answering the
// palette's search box, with no cap on how many hits a person can reach: the answer comes a page at a
// time, every hit on some page. Results come grouped by session, each session by its best hit, in the
// index's ranked order. A session's hits stay on one page unless they alone overflow it; then that
// session fills the page and the next continues it under the same `sessionId`. The project, then
// session group, then session tree is the agents' `session_search` tool's alone.
interface SessionSearchRequest {
  query: string;
  afterCursor?: SessionSearchCursor; // opaque, the daemon's own; refused `session.search_cursor_unresolvable` when it names no page
  limit?: number; // hits per page, at most SESSION_SEARCH_PAGE_LIMIT_MAX (256), which is also the default
}
// A page's groups also fit one frame (PAGE_MAX_BYTES, transcript-payloads.md §Plan-010).
type SessionSearchResponse =
  | { groups: SessionSearchGroup[]; hasMore: true; nextCursor: SessionSearchCursor } // at least one group
  | { groups: SessionSearchGroup[]; hasMore: false };
interface SessionSearchGroup {
  sessionId: SessionId;
  name?: string; // absent for an untitled session, as on the session record
  hits: SessionSearchHit[]; // at least one
}
interface SessionSearchHit {
  // The message the hit sits in, in the cursor vocabulary `transcript.read` uses, so pressing the
  // hit lands the transcript on that message and loads whatever history that takes.
  cursor: EventCursor;
  line: string; // the line the match sits in
  matchRanges: SearchMatchRange[]; // at least one
}
// A matched stretch of `line`, in UTF-16 code units: `start` inclusive, `end` exclusive and after `start`.
interface SearchMatchRange {
  start: number;
  end: number;
}

// TranscriptSearch — transcript.search. The same search over one session's own rows, answering the
// session's find box, a page at a time. Hits come newest first, and `beforeCursor` continues from
// the previous page's `nextCursor`. `matchCount` counts the whole session, so the box's `N of M`
// speaks for all of it, and the box loads the history a hit sits in only when the person steps to
// it.
interface TranscriptSearchRequest {
  sessionId: SessionId;
  query: string;
  beforeCursor?: EventCursor;
  limit?: number; // at most TRANSCRIPT_READ_LIMIT_MAX (transcript-payloads.md §Plan-010)
}
// A continuing page carries at least one hit and the cursor to continue from. A page's hits also fit one
// frame (PAGE_MAX_BYTES, transcript-payloads.md §Plan-010).
type TranscriptSearchResponse =
  | { matchCount: number; hits: TranscriptSearchHit[]; hasMore: true; nextCursor: EventCursor }
  | { matchCount: number; hits: TranscriptSearchHit[]; hasMore: false };
interface TranscriptSearchHit {
  rowId: string;
  cursor: EventCursor; // the row's position, which a `transcript.read` around it loads from
  snippet: string; // the line the match sits in, at most a row summary's length
  // At least one, in UTF-16 code units of `snippet`; they run in order, never overlap, and sit inside it.
  matchRanges: SearchMatchRange[];
}

// ---- Groups, links and tags: the person's half ----
// The person places, relates and labels sessions as the agents do through `session_group` and
// `session_update` (Spec-014), on the same service and the same tables
// ([Spec-001 §Groups, Links And Tags](../../specs/001-session-core.md#groups-links-and-tags)). Each
// verb answers `{}` where nothing else is named, and a client reads the change from the live
// `session.list`.
type SessionGroupId = string & { readonly __brand: "SessionGroupId" }; // daemon-minted

// session.groupCreate — `New group…`: makes a session group in the session's project with this
// session in it, so no group is ever empty. A name another group of the project holds, ignoring
// case, is refused `session.group_name_taken`; a chat sits in no group and is refused
// `session.group_refused`.
interface SessionGroupCreateRequest {
  sessionId: SessionId;
  name: string;
}
interface SessionGroupCreateResponse {
  groupId: SessionGroupId;
}
// session.groupMove — `Move to group`, or a drag onto a group's row: moves the session into a group
// of its own project; `groupId` null takes it out among the project's loose sessions. A session is
// in at most one group, so a move into another group leaves the first; a group left with no session
// is removed.
interface SessionGroupMoveRequest {
  sessionId: SessionId;
  groupId: SessionGroupId | null;
}
// session.groupRename — `Rename group…`, or a double-click on the group's row. The same uniqueness
// as create, refused `session.group_name_taken`.
interface SessionGroupRenameRequest {
  groupId: SessionGroupId;
  name: string;
}
// session.groupUngroup — `Ungroup`: its sessions go back loose; nothing is archived or closed.
interface SessionGroupUngroupRequest {
  groupId: SessionGroupId;
}

// session.relatedList — the inspector's `Related` section: the sessions linked to this one, highest
// relevance first, read from the ranked list stored under the session's id. Live: the whole list
// again each time a link it depends on is re-scored.
interface SessionRelatedListRequest {
  sessionId: SessionId;
}
interface SessionRelatedListUpdate {
  sessionId: SessionId;
  related: Array<{
    sessionId: SessionId;
    name?: string; // absent for an untitled session
    // The strongest link's kind, which the row reads in words (`started by planner`,
    // `copy of builder`, `12 messages with review-bot`, `related to stripe-webhook (billing)`).
    kind: "started" | "copied_from" | "messaged" | "asked" | "mentioned" | "related";
    // True where this session is the link's source: it started, copied, messaged, asked or
    // mentioned the other, so the row reads `started planner` rather than `started by planner`.
    sessionIsSource: boolean;
    messageCount?: number; // on `messaged`: how many messages the two traded
    // true when the pair carries a `related` link, which `Unlink` removes; the event links stay
    removable: boolean;
  }>;
}
// session.linkAdd — `Link a session…`, the session picked through the `@` session picker: adds a
// `related` link between the two sessions, by id, so a rename changes nothing.
interface SessionLinkAddRequest {
  sessionId: SessionId;
  targetSessionId: SessionId;
}
// session.linkRemove — `Unlink` on a `related` row. A link the daemon wrote from an event records
// what happened and is refused `session.link_not_removable`.
interface SessionLinkRemoveRequest {
  sessionId: SessionId;
  targetSessionId: SessionId;
}

// session.tagAdd / session.tagRemove — the `Tags` line on the inspector's Identity: `Add tag` and a
// chip's remove control. A tag is matched ignoring case and nests with `/`; one holding a space, or
// empty, is refused `session.tag_refused` with nothing written.
interface SessionTagRequest {
  sessionId: SessionId;
  tag: string;
}
// session.tagList — the tags in use across every session, which `Add tag` suggests.
interface SessionTagListResponse {
  tags: string[];
}
```

### Session Method-Name Registry

The console's `session.*` operations beyond the [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase 3 rows registered in local-ipc-payloads.md §JSON-RPC Method-Name Registry, and beyond the lease verb and the flow-control signal registered in remote-control-payloads.md §Session Terminal-Control Method Registry. Names are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT`. These ride the **daemon JSON-RPC transport only**: a session's name, its working folder, its draft, its staged files and its mute are node-local state the terminal-owning daemon is the record authority for, so no control-plane tRPC sibling exists — the `repo.*` / `approval.*` posture. Method strings stay imperative and disjoint-by-form from the past-participle [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) durable event names (`session.renamed`, `session.goal_updated`, `session.muted`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.rename` | `mutation` | `SessionRenameRequest` | `SessionRenameResponse` |
| `session.fork` | `mutation` | `SessionForkRequest` | `SessionForkResponse` |
| `session.setWorkingFolder` | `mutation` | `SessionSetWorkingFolderRequest` | `SessionSetWorkingFolderResponse` |
| `session.maxStepsUpdate` | `mutation` | `SessionMaxStepsUpdateRequest` | `SessionMaxStepsUpdateResponse` |
| `session.spendLimitUpdate` | `mutation` | `SessionSpendLimitUpdateRequest` | `OrchestrationBudgetState` |
| `session.tokensPerRunUpdate` | `mutation` | `SessionTokensPerRunUpdateRequest` | `OrchestrationBudgetState` |
| `session.draftUpdate` | `mutation` | `SessionDraftUpdateRequest` | `SessionDraftUpdateResponse` |
| `session.attachmentAdd` | `mutation` | `SessionAttachmentAddRequest` | `SessionAttachmentAddResponse` |
| `session.attachmentRemove` | `mutation` | `SessionAttachmentRemoveRequest` | `SessionAttachmentRemoveResponse` |
| `session.mute` | `mutation` | `SessionTargetRequest` | `SessionVerbResponse` |
| `session.unmute` | `mutation` | `SessionTargetRequest` | `SessionVerbResponse` |
| `session.search` | `query` | `SessionSearchRequest` | `SessionSearchResponse` |
| `session.groupCreate` | `mutation` | `SessionGroupCreateRequest` | `SessionGroupCreateResponse` |
| `session.groupMove` | `mutation` | `SessionGroupMoveRequest` | `SessionVerbResponse` |
| `session.groupRename` | `mutation` | `SessionGroupRenameRequest` | `SessionVerbResponse` |
| `session.groupUngroup` | `mutation` | `SessionGroupUngroupRequest` | `SessionVerbResponse` |
| `session.relatedList` | `subscription` | `SessionRelatedListRequest` | `SessionRelatedListUpdate` (stream) |
| `session.linkAdd` | `mutation` | `SessionLinkAddRequest` | `SessionVerbResponse` |
| `session.linkRemove` | `mutation` | `SessionLinkRemoveRequest` | `SessionVerbResponse` |
| `session.tagAdd` | `mutation` | `SessionTagRequest` | `SessionVerbResponse` |
| `session.tagRemove` | `mutation` | `SessionTagRequest` | `SessionVerbResponse` |
| `session.tagList` | `query` | `EmptyPayload` | `SessionTagListResponse` |

`session.goalUpdate` and `session.goalClear` are registered in orchestration-payloads.md §Plan-013's method registry, where the goal's delivery contract lives, and are listed here only so the console's session surface reads whole in one place.

**Every search read goes over one index.** The palette's search box and a session's own find box are answered by ONE daemon search over session titles, message text, tool calls, session group names and tags, so the find box counts tool rows through it: `session.search`, the cross-session form, returns hits grouped by session, each hit carrying its own message anchor, in the index's own ranked order with no cap; `transcript.search`, the single-session form, pages that session's hits newest first and counts every match in the session, so the find box counts the whole session and loads the history a hit sits in only when the person steps to it. Both shapes are in the §Plan-001 block above. `transcript.search` sits in the `transcript` namespace with the session's other row reads and is registered in [§Transcript Method-Name Registry](./transcript-payloads.md#transcript-method-name-registry). The renderer walks no rows it does not hold, which is the whole reason the read is daemon-side. The index behind both is the daemon's own full-text index on Tantivy over session titles, message text, tool calls, session group names and tags, fed from the daemon's SQLite database through an outbox ([ADR-041](../../decisions/041-session-search-on-tantivy.md), [local-sqlite-schema §Session Search Index](../schemas/local-sqlite-schema.md#session-search-index)).

**A session's address mints no read.** The address another session writes to when it messages this one rides `SessionRecord` above, because the one surface that shows it — the inspector's `Copy address` — already reads that record, and a second verb would be a second source for one fact. It is the inbox the daemon holds for the session, present for the session's whole life. The two operations two sessions actually talk through are tools the daemon serves to the providers and are registered in orchestration-payloads.md §Plan-013's registry note, not here.

**`Copy link` and `sidekicks open <address>` mint no method.** A session's link is `sidekicks://session/<id>`, one form with one function that composes it and one that parses it in `packages/contracts`, and three places share it: the session's `Copy link` copies it as one plain line, main's link handler routes it, and `sidekicks open <address>` on the CLI hands it to the running app through the platform's own registered link type, so it adds no second path into the app and carries nothing the address does not. The link handler is in the main process ([Spec-021 §Main Process Responsibilities](../../specs/021-desktop-app-and-renderer.md#main-process-responsibilities)): it parses the link, drops a malformed one, and hands the renderer only the parsed `SessionId` through `window.subscribeToNavigationRequest`. No daemon wire surface is involved.
