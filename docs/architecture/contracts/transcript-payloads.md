# Transcript Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-010 — Transcript And Reasoning

Every paged transcript reply is bounded by the frame it becomes (Plan-010 Phase 1). A JSON-RPC reply leaves the daemon as one message of the frame codec, its JSON capped at `MAX_MESSAGE_BYTES`, and a message over the cap is not a failed request: the framer refuses to emit it and the **connection closes** ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)). A row-count ceiling does not bound that — a `TranscriptEventRow` carries free-form fields at `EVENT_FIELD_MAX_LEN`, and JSON encoding expands a control character to a six-byte escape, so 256 contract-valid rows exceed the cap several times over before `payload`, which this contract does not bound at all. So each of the paged members — `TranscriptReadResponse.entries`, `TranscriptChildRunExpandResponse.entries`, and `TranscriptReasoningReadResponse.reasoningEntries` — carries a byte budget (`PAGE_MAX_BYTES` in `crates/sidekicks-contracts/src/jsonrpc/page.rs`, the budget every paged reply shares — one reply's size less room for the envelope, the echoed id and a continuation cursor — declared apart from `MAX_MESSAGE_BYTES` ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)) and under it, because it bounds what one reply costs the desktop to decode and draw and one message's time on the relay, so a page never grows with the transport; its figure is set from its first measurement against those two costs). `TranscriptReadResponse.runs` rides in the same frame as its `entries`, so the rows are held to the budget left beside the facts the reply carries, and the daemon counts a page against the budget left beside the facts of every run its stretch names, which the kept rows' facts never exceed. A producer stops at whichever of the row limit and the byte budget trips first, and all these replies discriminate on `hasMore` so a caller can always continue. **The row limit that binds is the CALLER'S** (Plan-010 Phase 1): `TranscriptReadRequest.limit` is optional and a response schema never sees the request, so `entries` is schema-bounded only at the global `TRANSCRIPT_READ_LIMIT_MAX` and a read for ten rows answering with two hundred and fifty-six parses — a client sizing a viewport, a budget, or a render pass from the window it asked for is handed a larger one with nothing on the reply saying the request was not honored. The effective ceiling is therefore resolved per request — the caller's `limit` where it supplied one, the same global constant where it did not, which stays the default and the schema bound — and enforced at the daemon binder beside the request-scope checks, the only layer holding both numbers. `TranscriptChildRunExpandRequest` declares no `limit`, so its ceiling is that constant, stated on the same binder so one rule covers both paged reads. **The budget bounds aggregation and never bounds a page below one entry** (Plan-010 Phase 1): a continuing arm requires at least one entry — a page promising more and delivering none re-offers the same cursor forever while reading like progress — so where the first candidate alone exceeds the budget the producer pages that single entry and the reply is refused **for its size** at the response boundary, naming the member and its measured bytes on an error frame the substrate can deliver, rather than the page-fill helper returning a bare zero whose only representable answer is the empty continuing page the schema refuses. A **terminal** arm carries no such floor: an empty final page is the honest answer to a continuation whose cursor already sat at the end and to a filtered read that matched nothing. A `session.event.subscribe` frame is cut by the same budget, each change charged with its event and its piece's body, never below one change, and the stream reads the next frame at once; an event that blows a frame by itself is an oversized event payload, and bounding it is an event-envelope and framer decision rather than one a Plan-010 page budget may make on their behalf.

```ts
// `transcript.read`. A cursor is a position in the log, and the cursor an event carries is the
// position right after it: afterCursor answers the events after its position and beforeCursor those
// before it, the event carrying that cursor among them, so a page before a window's head and the
// stream after it meet with nothing missed or repeated. aroundCursor names one row by its cursor
// and answers the window around it, the way a message list reads `around` one message: that row, up
// to half the limit before it and the rest after it, read from that position on both sides and
// never from the whole log, so one read both lands a link on its row and says whether the row
// exists. No row standing at that cursor (one a skipped range left out, or a position the log never
// held) refuses the read with `transcript.row.notFound`; a session the daemon does not hold keeps
// `session.notFound`. The budget keeps the nearest rows on each side and never cuts the anchor, and
// the page continues as a beforeCursor page does: nextCursor toward the start, and the rows after
// it read with afterCursor at its newest row's cursor. aroundCursor stands alone: a request naming
// it with afterCursor or beforeCursor is refused.
interface TranscriptReadRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  beforeCursor?: EventCursor;
  aroundCursor?: EventCursor;
  limit?: number;
}
// hasMore is the discriminant, not a flag beside an optional. The continuing arm REQUIRES
// nextCursor: a window promising more rows and supplying no way to ask for them leaves the caller
// re-reading the same window or giving up, and both lose rows the session holds (Spec-011
// §Interfaces And Contracts, "cursor-based continuation"). The terminal arm PERMITS one and never
// requires it — the two members answer different questions, and a client that has just read to the
// end and now resumes session.event.subscribe from exactly there needs that position. The
// continuing arm's nextCursor must ADVANCE past the request's cursor (Plan-010 Phase 1): a page
// promising more that moves no cursor reads like progress while the client re-asks from the same
// position and loops. So a continuing page holds at least one row, with one exception: an event
// that stands as no row (a task-list call) is passed over, and a read passes over at most a fixed
// number of stretches of them, each its limit long, so one request never projects the whole log;
// past that cap the page continues EMPTY, its nextCursor after the last event it passed over, and
// the client reads on from there. The terminal arm keeps no floor — an empty final page is the
// honest answer to an exhausted continuation and to a filtered read that matched nothing. entries
// is additionally bounded by PAGE_MAX_BYTES less the bytes of runs (see this section's opening
// note). runs carries the facts of each run the entries name, folded over the whole log, one per
// run and no other: a run named twice would leave a client to choose, a fact no entry names is a
// run the window never shows, and an entry whose run has none would draw its header from nothing.
// The schema refuses each of the three. A row stands at the first piece of a reply or of
// reasoning the provider sent in pieces, its body the pieces joined, so every read counts rows and
// never pieces, and a cursor at a later piece lands on its row. joinedThrough is the newest event
// the page's rows joined their pieces through: the client opens its stream at the earliest one it
// holds and places a piece it already read by its offset in its row. An unbounded forward read's
// last page ends at the head, so its nextCursor never sits before a piece the page joined; a
// forward read bounded by beforeCursor ends at its bound.
type TranscriptReadResponse =
  | {
      entries: TranscriptReadRow[];
      runs: TranscriptRunFacts[];
      hasMore: true;
      nextCursor: EventCursor;
      joinedThrough: EventCursor;
    }
  | {
      entries: TranscriptReadRow[];
      runs: TranscriptRunFacts[];
      hasMore: false;
      nextCursor?: EventCursor;
      joinedThrough?: EventCursor; // absent only on a session with no readable event
    };

// One run's facts as a window serves them
// (`crates/sidekicks-contracts/src/transcript/run_facts.rs`): who acts for it, the account it is
// billed to, the state it last entered and whether a rewind came after that state, folded over the
// run's own events through foldedThroughSequence. The daemon folds the whole log, and a client
// folds what its stream delivers onto what it was served, so a run whose naming row lies outside
// the window still reads whole. A run's own events are those whose payload names it as runId; an
// intervention's targetRunId and a person's message steering it are not.
interface TranscriptRunFacts {
  runId: RunId;
  // who the run's first event naming anyone names, wire-verbatim, at EVENT_FIELD_MAX_LEN
  actor?: string;
  // as the run's creation (agent.run.queued) named it
  admittedProviderAccountId?: ProviderAccountId;
  // the newest agent.run.<state> type the run entered, kept across a rewind
  stateEventType?: RunStateEventType;
  isRewound: boolean; // whether an agent.run.rolledBack came after stateEventType
  foldedThroughSequence: number; // an event at or below it is already in the facts
}

interface TranscriptEventRowBase {
  id: string;
  sessionId: SessionId;
  sequence: number;
  // The position the session's stream delivers this event at, opaque and relayed verbatim, so a
  // link naming a message by its cursor finds the row however the row was read.
  cursor: EventCursor;
  // open on three arms; PINNED on the rollback-boundary arm, and refused as "runLifecycle" on the
  // general arm
  category: EventCategory;
  type: string;
  actor?: string;
  timestamp: string;
  childRunSummary?: ChildRunSummary; // if this is a summarized child-run row
  // Present, with at least one entry, on a tool call's row that left out one or more patches: the
  // row draws like one whose patch traveled, and `transcript.patch.list` fetches every left-out
  // patch of the call in one read.
  omittedPatches?: TranscriptOmittedPatch[];
  // The row's body, read for the whole window in one statement beside its events. Absent on a row a
  // client projects from a stream change, which carries no body; required on a TranscriptReadRow.
  content?: TranscriptRowContent;
  payload: Record<string, unknown>;
}
// A body travels with its row up to TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES, 32 KiB of JSON; a larger
// one comes back as its size alone, which `transcript.body.read` reads in full. A page therefore
// holds many rows even when every body sits at the ceiling, and one huge output never crowds its
// neighbors out of a page. Chat services size a single message in the same range (a few thousand
// characters recommended, 40,000 before a message is cut, 65,535 bytes for a whole event), so a
// reply of ordinary length travels whole. The daemon reads a large body's size, never its bytes.
type BlockCutFailure = "stalled" | "overPage";
type TranscriptRowContent =
  // blockStarts: on a prose body, the body's block starts as UTF-16 offsets into the text drawn
  // with its escape sequences left out, each a little-endian u32, sent as an attachment and charged
  // against the page budget with the JSON. A row whose reply is still arriving carries only the
  // starts no later text can move. blockCutFailure: why a prose body's cut failed, in place of its
  // starts; a failed cut fails that row alone.
  | {
      status: "available";
      body: string;
      contentLength?: number;
      blockStarts?: Uint8Array;
      blockCutFailure?: BlockCutFailure;
    }
  | { status: "unavailable"; reason: HydratedContentUnavailableReason }
  // The body's size in bytes, its bytes left out; transcript.body.read reads it whole.
  | { status: "large"; contentLength: number };
interface TranscriptOmittedPatch {
  path: string;
  oldPath?: string; // a file the call moved: its old path, `path` being its new one
  size: number; // the patch's size in bytes
}

// the non-run arm: carries no run attribution structurally — the projector stamps kind from the
// event family, so a run-scoped family can never arrive on this arm. The arm additionally REFUSES
// category: "runLifecycle" (Plan-010 Phase 1): all-or-none attribution is enforced by arm
// SELECTION, so a row whose kind was stamped wrong never reaches the run arm and its missing triple
// is never checked — it would arrive as a legitimately attribution-free general row. Every Spec-005
// §Run Lifecycle type is run-scoped (the state transitions share a payload shape carrying a
// required runId; the non-state rows each re-list it), so the refusal costs no correct projection.
// The refusal is THREE-LEGGED, not category alone (Plan-010 Phase 1): category is decisive only for
// runLifecycle, so the arm also refuses a canonical type in the census of Spec-005 types whose
// registered payload names a run unconditionally, and — for the types whose run identity is
// registered OPTIONAL (every artifactPublication and agentOutput type, the agentOutput run
// being absent on a voice call's spoken answer, the usageTelemetry and approvalFlow types not
// listed by name below, approval.rule.revoked among them, the agent.queueItem types,
// user.message.sent and question.asked), which no type-level test can decide — a payload naming a
// run under either registered spelling, runId or the intervention family's targetRunId. The census
// takes the runLifecycle, toolActivity and interactiveRequest members from Plan-004's per-category
// arrays rather than transcribing them, so a type added to those categories joins it without an
// edit here; the usageTelemetry and approvalFlow types whose payload requires a run are listed by
// name.
type TranscriptEntry = TranscriptEventRowBase & { kind: "general" };

type RunScopedTranscriptEntry = TranscriptEventRowBase & {
  // literal discriminator — row.kind narrowing is structural, never a probe of the free-form type:
  // string
  kind: "run";
  // run identity — with position + epoch, the REQUIRED all-or-none attribution triple the
  // agent.run.rolledBack live client rule keys on, never dug out of payload (CP-002-13): arm
  // selection is by kind, so a run-scoped row missing any of the three fails ITS arm's parse — the
  // malformed-row test — and can never fall through to the general arm
  runId: RunId;
  // the row's projection-resolved originating run position (Plan-002 T3.15's uniform row-to-turn
  // assignment); the live rule compares it against the agent.run.rolledBack boundary's carried
  // targetPosition (sequence is the session event sequence, never a run position)
  position: number;
  // the row's projection-resolved execution epoch (Plan-002 T3.15's row-to-turn assignment: the
  // stamped sourceEpoch on late rows, the operation association's epoch on in-time
  // content-asynchronous rows, the run's current epoch at emission otherwise); position alone can
  // never recover the epoch, since re-execution reuses ordinals
  epoch: number;
  // present exactly when the row's turn is superseded, absence = current — projection-computed from
  // Plan-002 T3.15's exported supersededTurns(runId); deliberately single-field: the marker's run
  // identity and source epoch ARE the containing row's runId + epoch, so no duplicated fields exist
  // to disagree and live marking (the row plus the boundary cutoff) is identical to catch-up
  // marking by construction; targetPosition = the superseding rollback's rewind cutoff — the first
  // accepted rollback in the run's lineage, at the row's epoch or later, that rewound the surviving
  // history containing the row (a later rollback below an earlier retained prefix supersedes the
  // inherited rows; a row ranks superseded when position exceeds the run's effective cutoff for its
  // epoch — the minimum cutoff among accepted rollbacks at epoch >= the row's); identical on
  // TranscriptRead and on live delivery, rows delivered after a boundary arriving with the marker
  // already projection-computed — per Spec-011 §Required Behavior
  superseded?: { targetPosition: number };
  // Where a projection echoes canonical keys into payload, they must AGREE with the outer triple
  // (Plan-010 Phase 1 — I-010-3's no-second-source rule reaching the payload): payload run identity
  // under either spelling (runId, targetRunId) must equal this row's runId, and payload sourceEpoch
  // / sourcePosition must equal this row's epoch / position. Echoing stays OPTIONAL and absence
  // passes; only disagreement is refused, because consumers filter and mark superseded on the outer
  // triple while the row's detail and provenance read the payload, so a row stating two
  // attributions is filed under one turn and sourced from another. The run-identity half binds
  // every arm carrying an outer runId.
};

type TranscriptRollbackBoundary = Omit<TranscriptEventRowBase, "category" | "type" | "payload"> & {
  kind: "rollbackBoundary"; // literal discriminator
  // pinned with `type`, and for the same reason (Plan-010 Phase 1): agent.run.rolledBack is
  // registered under one category and no other, so leaving this open on the one arm whose event
  // type is closed would leave the half that can still disagree — and a renderer grouping or
  // filtering by category would file the rewind cutoff under the wrong family
  category: "runLifecycle";
  runId: RunId; // the rewound run
  position: number; // the boundary row's own originating position
  epoch: number; // the epoch the rollback rewound
  // an earlier boundary row is itself superseded when a later rollback cuts below it — same
  // single-field marker semantics as the run arm
  superseded?: { targetPosition: number };
  type: "agent.run.rolledBack";
  // validated into the typed shape (defined in run-control-payloads.md §Plan-002 — Queue Steer
  // Pause Resume) at projection, so the live client rule reads a typed targetPosition — never an
  // unsafe cast; an entry failing that validation is a projection defect surfaced at emission,
  // never delivered untyped. Delivery is visibility-resolved: the boundary reaches every
  // subscription holding any row of the affected run, so a subscriber holding that run's rows
  // always receives the cutoff. Outer attribution and payload cannot disagree: the boundary arm's
  // garde check requires runId === payload.runId, sessionId === payload.sessionId, and position ===
  // payload.targetPosition (the boundary row ranks at the confirmed rewind floor — which is why a
  // later rollback below it supersedes it), so a conflicting boundary fails parse as a projection
  // defect, never delivered. The `Omit` on the base is the TypeScript notation for what the Rust
  // arm does (`crates/sidekicks-contracts/src/transcript/row.rs`): each arm of the internally
  // tagged row enum repeats the base's members through the contract's one `macro_rules!` and
  // declares its own `category`, `type` and `payload`, so this arm's `payload` is the typed
  // `AgentRunRolledBackEvent`, never the base's open map beside it, and its `type` narrows the
  // base's free-form string to one literal.
  payload: AgentRunRolledBackEvent;
};

// the row union, genuinely discriminated on the literal kind: the contracts' internally tagged enum
// selects the arm by kind (rollbackBoundary | run | general), each arm refusing unknown fields
// (`deny_unknown_fields`), and consumers narrow structurally on row.kind — never probing type:
// string, never casting
type TranscriptEventRow = TranscriptRollbackBoundary | RunScopedTranscriptEntry | TranscriptEntry;
// A row as a read returns it, every arm with its body required: TranscriptReadResponse.entries and
// TranscriptChildRunExpandResponse.entries are both TranscriptReadRow, and the `TranscriptReadRow`
// type parses it.
type TranscriptReadRow = TranscriptEventRow & { content: TranscriptRowContent };

// The run stamp a session.event.subscribe change carries for an event of a run (Plan-010 T2.4): the
// same position, epoch and superseded marker the event's transcript.read row carries, because the
// daemon computes both from one projection fold. A client marks the rows it already holds when a
// agent.run.rolledBack boundary arrives: a held row of that run at the rollback's epoch or an
// earlier one is superseded above the lowest cut of every rollback of the run at its epoch or
// later, the rule the daemon's fold applies (on clients `addSupersedingCut` in
// `packages/contracts/src/transcript/turn-attribution.ts`, hand-written TypeScript held to the
// daemon's Rust fold by one shared case table).
type TranscriptRunStamp = {
  position: number;
  epoch: number;
  superseded?: { targetPosition: number };
};

// The incompleteness marker (Plan-010 T1.2). Spec-011 §Fallback Behavior requires that a child run
// whose detail fetch fails "remains visible and marked incomplete rather than disappearing";
// without the mark, the only signal of incompleteness would be a low eventCount, which is
// indistinguishable from a child run that genuinely did little. Every cause is a term the corpus
// already owns — none is minted here:
// this daemon's own expansion read failed — Spec-011 §Fallback Behavior's own naming of the
// condition ("if a child-run detail fetch fails"). Transient: a retry may succeed.
type ChildRunIncompleteCause = "detailFetchFailed";
// Deliberately NOT reused: RepoMountHealth "unreachable" (scoped to filesystem mounts, whose own
// contract warns against overloading it across axes).
type ChildRunCompleteness =
  | { state: "complete" }
  | {
      state: "incomplete";
      cause: ChildRunIncompleteCause; // required on this arm only
      // ISO-8601, daemon clock — when the cause was observed. Required because the cause is
      // transient: a consumer deciding whether to retry, and a renderer deciding whether to age the
      // notice, both need to know how old the reading is. A cause with no time is unactionable.
      observedAt: string;
    };

interface ChildRunSummary {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  // on the incomplete arm this is a LOWER BOUND — the count this daemon currently holds, not the
  // child run's true total, which by definition it cannot know
  eventCount: number;
  // REQUIRED, not optional: an absent marker would be a third state meaning "probably fine", and
  // Spec-011 §Fallback Behavior's rule is that incompleteness is STATED, never inferred from a
  // small count.
  completeness: ChildRunCompleteness;
  // runId !== parentRunId (Plan-010 Phase 1): a run that is its own parent makes the
  //   run-lineage graph cyclic, and every consumer of that graph walks it — the renderer nests a
  //   child under its parent, Spec-014's one-layer nesting rule is checked against the chain, and
  //   cost attribution sums along it. Refused once at the parse boundary rather than defended
  //   against separately at every walk. TranscriptChildRunExpandResponse carries the same refusal
  //   on the same pair.
}

// `transcript.reasoning.read`
// No member names a person (api-payload-contracts.md §Authenticated Principal And Authorization
// Model: no person in a request body), and the request type refuses unknown fields
// (`deny_unknown_fields`): a caller that sends one is refused, not silently stripped.
interface TranscriptReasoningReadRequest {
  runId: RunId;
  // continuation position, the same opaque cursor the sibling reads take (Plan-010 Phase 1) — a
  // reasoning entry is projected from the run's events, so its resume position is an event
  // position, and one namespace spelling its cursor two ways would make a client hold two kinds of
  // bookmark for one surface
  afterCursor?: EventCursor;
}
type TranscriptReasoningReadResponse =
  // Availability is a discriminated union: an open shape — available: boolean with free optionals —
  // would serialize the available / unavailable cases identically, leaving Spec-011 §Acceptance
  // Criteria's distinguish-the-cases requirement unrepresentable. The available state is the one
  // that PAGES, so it is the one that splits on hasMore ( Plan-010 Phase 1) — the same continuation
  // rule TranscriptReadResponse carries, nested inside the availability discriminant so a paged
  // reply is not a state of its own. reasoningEntries is non-empty ON THE CONTINUING ARM ONLY
  // (Plan-010 Phase 1). A zero-entry available page claims a reasoning surface exists and then
  // shows nothing, which renders identically to unavailable while asserting the opposite — true of
  // a FIRST read, and false of a continuation whose afterCursor already sat at the end of the
  // surface, which unavailable would misstate. The schema cannot separate the two, because only the
  // request separates them: it carries the half it can see (the continuing arm, which is the arm
  // that can loop a client on a repeated cursor) and the daemon binder carries the first-page half,
  // beside the request-scope checks, under Plan-010 I-010-13. An entry joins one row's consecutive
  // pieces, up to 16,384 characters, and names that row (`rowId`); `sequence` is its last piece's.
  | {
      availability: "available"; // normalized reasoning present
      // required on this arm only, non-empty (continuing arm), bounded by PAGE_MAX_BYTES
      reasoningEntries: Array<{
        sequence: number;
        rowId: string;
        content: string;
        timestamp: string;
      }>;
      hasMore: true;
      nextCursor: EventCursor;
    }
  | {
      availability: "available";
      // may be EMPTY on this arm — see the note above; a first read answering empty is refused at
      // the binder
      reasoningEntries: Array<{
        sequence: number;
        rowId: string;
        content: string;
        timestamp: string;
      }>;
      hasMore: false;
      nextCursor?: EventCursor;
    }
  // the run surfaced no reasoning; no entries — the client draws no reasoning row and no
  // placeholder for it (I-010-7)
  | { availability: "unavailable" };
// The contracts' Rust type (T1.3) is an internally tagged enum on availability with closed arms:
// entries on the unavailable arm or an `available: boolean` member fail parse — no tolerant
// fallback arm.

// `transcript.childRun.expand`
interface TranscriptChildRunExpandRequest {
  runId: RunId; // child run to expand
  // continuation position (Plan-010 Phase 1) — named to match the sibling reads rather than a bare
  // `cursor`: one namespace, one name for the position a caller resumes from
  afterCursor?: EventCursor;
}
// Discriminated on hasMore exactly as TranscriptReadResponse is, and for the same reason: a child
// run is not inherently smaller than a session window — a long-running subagent produces more rows
// than fit one frame — so the expansion needs the same continuation, on the same two arms, with the
// same rule about which of them may carry a cursor — and the same advancing cursor on the
// continuing arm, empty only past the same cap of stretches passed over, for the same reason: a
// child run's expansion loops a client on a repeated cursor exactly as a session read does. Two further rules the schema enforces (Plan-010 Phase 1): every entry that
// carries a run identity must carry THIS run's (the general arm is exempt, having none — a
// session-scoped row inside a child's window is context, not misattribution), and runId !==
// parentRunId, since a run that is its own parent makes the lineage graph cyclic and every walk of
// it — nesting, one-layer-depth checking, cost attribution — non-terminating. The rows are the
// run's own events, the interventions on it and its own children's creation rows, each of which
// names its child's run and carries a summary naming this run as parent, which the schema admits.
// A run the daemon does not hold is refused `agent.run.notFound`, a run with no parent
// `agent.run.notChild`. joinedThrough is as on TranscriptReadResponse.
type TranscriptChildRunExpandResponse = {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  entries: TranscriptReadRow[]; // bounded by PAGE_MAX_BYTES as well as by the row cap
} & (
  | { hasMore: true; nextCursor: EventCursor; joinedThrough: EventCursor }
  | { hasMore: false; nextCursor?: EventCursor; joinedThrough?: EventCursor }
);

// `transcript.body.read`: a row's large body (the `large` arm of its `content`) or whole output,
// read only when the row's control is pressed (`Show full output`, with its size), and the whole a
// copy from the row lifts. `rowId` is the row's `id`, the id of the event it renders. A session id
// the daemon does not hold is refused with `session.notFound`; a row id the session does not hold
// is refused with `transcript.row.notFound` at `-31000`, the code an anchored transcript.read
// answers for a row that does not stand, so it never reads like a row that carries no body.
interface TranscriptBodyReadRequest {
  sessionId: SessionId;
  rowId: string;
  // Where the part starts: a UTF-8 byte offset into the body, always on a code-point boundary; 0
  // when absent. An offset inside a character or past the body's end is refused on this path.
  offset?: number;
}
// `status` is the discriminant. `contentLength` is echoed from the stored event, never recomputed
// from `body`. `absent` is the one reason: the row never carried a body. Each reply is bounded by
// PAGE_MAX_BYTES, as a `range` selection on artifact.read bounds its window: a body longer than one
// frame holds comes back whole in consecutive parts. `offset` echoes where this part starts and
// `nextOffset` is where the next one starts, null on the last part; the client reads from
// `nextOffset` until it is null and joins the parts.
type HydratedContentUnavailableReason = "absent";
type TranscriptBodyReadResponse =
  | {
      status: "available";
      body: string; // this part of the body
      offset: number;
      nextOffset: number | null;
      contentLength?: number;
      // On a prose body, the block starts that fall in this part, as UTF-16 offsets into the
      // whole drawn body, charged with the part against one page; or why the cut failed, on every
      // part.
      blockStarts?: Uint8Array;
      blockCutFailure?: BlockCutFailure;
    }
  | { status: "unavailable"; reason: HydratedContentUnavailableReason };

// `transcript.patch.list`: every patch one tool call did not carry, in one read,
// so a call with several missing files is drawn from one reply and looks exactly like a call whose
// patches traveled; the rows it fills are the ones the projection marks with `omittedPatches`.
interface TranscriptPatchListRequest {
  sessionId: SessionId;
  toolCallId: string;
  // Where the part starts: the left-out file's index in the call's `omittedPatches` order and a
  // UTF-8 byte offset into its patch or raw text, on a code-point boundary; the first file's start
  // when absent.
  cursor?: TranscriptPatchCursor;
}
interface TranscriptPatchCursor {
  fileIndex: number;
  offset: number;
}
// One entry per left-out file: its patch with the lines it adds and removes, or why it cannot be
// read: `absent` when no patch came, `unreadable` when the provider sent one in a form this
// version cannot read, which carries the text as sent, `rawPatch`, paged as a patch is, and
// `damaged` for a file the log cannot read whole, the file answered in its place and the read going
// on to the next. A file the call moved is named by its new path, its old one in `oldPath`. Each
// reply is bounded by PAGE_MAX_BYTES as well: patches longer than one frame holds come back in
// consecutive parts, as transcript.body.read's body does. A part holds the files from `cursor` on,
// its first entry's patch starting at `cursor.offset` and its last one's ending where `next`
// starts; `next` is null on the last part, and the client joins the pieces of one file in order.
type TranscriptPatchFile =
  | { path: string; oldPath?: string; patch: string; additions: number; deletions: number }
  | { path: string; oldPath?: string; unavailable: "absent" }
  | { path: string; oldPath?: string; unavailable: "unreadable"; rawPatch: string }
  | { path: string; oldPath?: string; unavailable: "damaged" };
interface TranscriptPatchListResponse {
  files: TranscriptPatchFile[];
  next: TranscriptPatchCursor | null;
}

// `transcript.path.resolve`: the candidate paths a reply's prose holds (bare,
// in backticks or `@`-prefixed, with or without `:line` or `:line:col`), resolved against the
// session's own workspace so the screen draws a link only for a real file inside it. A session id
// the daemon does not hold is refused with `session.notFound`.
interface TranscriptPathResolveRequest {
  sessionId: SessionId;
  paths: string[]; // as written in the reply
}
interface TranscriptPathResolveResponse {
  // One entry per requested path, in request order. `file` is null unless the path, normalized and
  // with its links followed, names a real file inside the workspace, so a path that names nothing
  // or leaves the workspace answers null and reveals nothing about what lies outside.
  paths: Array<{
    path: string;
    file: { path: string /* in the workspace */; line?: number; column?: number } | null;
  }>;
}

// ---- What the working line reads: two per-turn subscriptions ----
// Both are per-turn live readings rather than projections of the log, and both are DERIVED from
// frames the provider already sends — neither adds a provider request and neither is polled.

// agent.turn.usage.subscribe — the tokens RECEIVED this turn. It starts at zero when the turn
// starts and steps up ONCE PER MODEL ROUND, never per word: each round adds the provider's own
// output count for that round — the output figure of Claude Code's per-message usage, and the
// `last` figure of Codex's token-usage notification — and the turn's figure is their sum. Reasoning
// is inside that count and is never added to it; the figure is never an iteration count and never a
// difference of two running totals, so the working line's reading means the same thing on every
// provider. It holds across a pause and stops at the turn's end; it is the only live token figure
// on the session screen, and the context ring, the cost receipt and a child's own tokens are
// different facts that keep their own surfaces. The request of both `agent.turn.*` subscriptions:
// the run whose current turn it follows.
interface AgentTurnSubscribeRequest {
  sessionId: SessionId;
  runId: RunId;
}
interface TurnUsageUpdate {
  runId: RunId;
  turnId: string;
  // Cumulative for this turn, not a delta: a subscriber that joins mid-turn reads the true figure
  // rather than having to sum what it missed.
  tokensReceived: number;
}

// agent.turn.task.subscribe — the agent's own task list for this turn, in the agent's own order.
// The driver folds Claude Code's task-list tool calls and Codex's plan-updated notification into
// one list; the daemon turns Codex's plan updates on per session, because the provider leaves them
// off by default. The list is the turn's: it goes when the turn is interrupted and returns with the
// next turn's list.
interface TurnTasksUpdate {
  runId: RunId;
  turnId: string;
  // The WHOLE list per emission, in the agent's order, because a provider replaces its list rather
  // than patching it and a subscriber must never compose two halves into an order neither sent.
  tasks: Array<{ text: string; state: "notStarted" | "inProgress" | "done" }>;
}

// ---- An agent's question ----
// Claude Code and Codex each stop a turn to ask by their own mechanism, with one record: the daemon
// turns a held Claude Code question request or a Codex user-input request into ONE question record
// the screen renders and ONE call answers. It holds either request open with NO timer, rebuilds the
// card on a reload and on the person's other devices, and the first answer settles it everywhere. A
// question is an attention entry exactly as an approval is. Codex's NON-WAITING question has a
// question record too, which the daemon writes beside the message item the question arrived in,
// with `isAgentWaiting: false`: the record stays unanswered until the ordinary message answering it
// is taken, when the daemon marks it answered, so the working line's question count drops on every
// device. It raises no card of its own and no bell entry; pressing the working line's question
// count opens the card on it. The answered mark is the answering turn's `user.message.sent` row
// whose `answersQuestionId?` names the question it answers: the message `question.resolve` writes
// for a held question, and the taken message for a non-waiting one. A question no message names is
// unanswered.

// question.asked — the record the screen renders, registered in Spec-005's `interactiveRequest`
// category, which owns the name and the census. A tool server's question and a workflow step
// waiting for a chat reply become the same record.
type QuestionId = string & { readonly __brand: "QuestionId" }; // daemon-minted
interface QuestionAskedPayload {
  questionId: QuestionId;
  sessionId: SessionId;
  // Exactly one of the two names what is waiting: an agent's or a tool server's question names the
  // agent's run; a workflow step waiting for a chat reply names its wait, the durable id that ties
  // the wait to its workflow run, its step and its session, so the first answer through either door
  // settles it.
  runId?: RunId;
  waitId?: string; // a UUID
  // On a run's question only: `open` is answerable at once, its run waiting on it; `waitingForRun`
  // was asked while its run waits on something else, so it is recorded waiting, shown greyed under
  // `Waiting for the run`, and opens in the order the run's questions came once the run reads
  // running. A workflow step's question is open at once and carries none.
  state?: "open" | "waitingForRun";
  // False only on a question the agent does not wait for (Codex's `agentMessage` item carrying
  // `questions` with `delivery: "async"`): the run keeps running and no card of its own is raised.
  isAgentWaiting: boolean;
  // The questions an agent, a tool server or a workflow wrote, stored as plain text like every
  // other column. They are all here, one per page in order, so paging needs no further read and
  // typed text survives paging both ways; their count is the page count. At least one.
  questions: Array<{
    // The short chip beside the eyebrow: the agent's own header, a tool server's name, or a
    // workflow's name; absent where there is none.
    header?: string;
    // The question itself, and the agent's own heading shown as the summary line only where it sent
    // one.
    text: string;
    heading?: string;
    // The question's own helper line, drawn faint under its text, where it sent one.
    description?: string;
    options: Array<{
      label: string;
      description?: string;
      // Present only where the provider attached a preview to the option, which one provider does
      // and the other does not; absence means the provider attached none.
      preview?: string;
    }>;
    // True where the provider marked the question as taking several answers, which decides whether
    // the rows are boxes or single-choice marks. One provider marks every question this way and the
    // other marks it per question, so the flag is the provider's reading and never a console
    // default.
    severalAnswers: boolean;
    // True where the provider marked the question secret: the card then shows a masked field and NO
    // option rows, so a secret question carries no options; the value is never written into the
    // flow, and the person's turn afterwards records only that a secret was answered.
    secret: boolean;
    // `required` comes only from a tool server's form; `default`, `minimum` and `maximum`
    // come from a tool server's form or a Claude Code number question. Each is present only
    // where its source sets it.
    // Whether the form must have this field answered.
    required?: boolean;
    // The answer the field starts from: the label of the option it preselects (several labels on a
    // field of several picks), or a typed field's value in its own type. A label is always one of
    // the question's own options.
    default?: string | number | boolean | string[];
    // A number field's smallest and largest value; the smallest is never above the largest.
    minimum?: number;
    maximum?: number;
    // How far the arrow keys move a number field, and a short unit drawn as a suffix inside it,
    // where the question sets them.
    step?: number;
    unit?: string;
    // A text field's faint hint while it is empty, where the question sets one.
    placeholder?: string;
  }>;
}

// question.opened — a question that waited for its run opened, its run now waiting on it, in the
// write that moves the run from running to wait on it, so its card is no longer greyed.
interface QuestionOpenedPayload {
  sessionId: SessionId;
  questionId: QuestionId;
}

// question.canceled — an open question, or one waiting for its run, ended unanswered; the card
// closes on a reload and on every device, and no `user.message.sent` is written.
interface QuestionCanceledPayload {
  sessionId: SessionId;
  questionId: QuestionId;
  // Its turn was interrupted, its provider withdrew the request, or its run ended, a restart of
  // the background service among the ways a run ends.
  reason: "interrupted" | "withdrawn" | "runEnded";
}

// question.resolve — one call answers every page. Per question the answer is exactly one of: the
// picked labels, typed text, a secret, or a skip — which is why the arms are a closed union rather
// than four optional members. A secret is delivered to the provider and NEVER stored: it reaches no
// event payload, no artifact and no projection. The person's turn is written as an ordinary message
// record with the secret masked.
type QuestionAnswer =
  | { kind: "picked"; labels: string[] } // at least one
  | { kind: "typed"; text: string }
  | { kind: "secret"; value: string }
  | { kind: "skipped" };
interface QuestionResolveRequest {
  questionId: QuestionId;
  // One entry per question, in the record's own order. Every question is answered together when the
  // last page is answered, so a partial list is refused rather than half-applied.
  answers: QuestionAnswer[];
}
interface QuestionResolveResponse {
  questionId: QuestionId;
  // The record is the receipt: a question that has been answered cannot be answered again, and a
  // second call reads this state rather than re-applying.
  state: "answered" | "canceled";
}
```

## Transcript Method-Name Registry

Plan-010's transcript surface is exposed as the `transcript.*` methods below, registered by Plan-010 (T1.4 registers the strings against the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out — the `repoMount.*` / `approval.*` precedent). These methods ride the **daemon JSON-RPC transport only**: the transcript is a daemon-local projection over the session event log per [ADR-016](../../decisions/016-shared-event-sourcing-scope.md), and no control-plane route sibling exists in V1. Method names follow the [wire-name grammar](./local-ipc-payloads.md#wire-name-grammar).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `transcript.read` | `query` | `TranscriptReadRequest` | `TranscriptReadResponse` |
| `transcript.reasoning.read` | `query` | `TranscriptReasoningReadRequest` | `TranscriptReasoningReadResponse` |
| `transcript.childRun.expand` | `query` | `TranscriptChildRunExpandRequest` | `TranscriptChildRunExpandResponse` |
| `transcript.body.read` | `query` | `TranscriptBodyReadRequest` | `TranscriptBodyReadResponse` |
| `transcript.patch.list` | `query` | `TranscriptPatchListRequest` | `TranscriptPatchListResponse` |
| `transcript.search` | `query` | `TranscriptSearchRequest` | `TranscriptSearchResponse` |
| `transcript.path.resolve` | `query` | `TranscriptPathResolveRequest` | `TranscriptPathResolveResponse` |
| `agent.turn.usage.subscribe` | `subscription` | `AgentTurnSubscribeRequest` | `SubscribeAckResponse`, then `TurnUsageUpdate` frames |
| `agent.turn.task.subscribe` | `subscription` | `AgentTurnSubscribeRequest` | `SubscribeAckResponse`, then `TurnTasksUpdate` frames |
| `question.resolve` | `mutation` | `QuestionResolveRequest` | `QuestionResolveResponse` |

`agent.turn` and `question` are two further registered namespaces on this same transport. They sit here rather than under `transcript` because a namespace names the thing it is about: the two subscriptions are readings of ONE TURN that end with it, while `transcript.*` reads the session's whole flow, and a question is a record with its own lifecycle rather than a row. Neither `agent.turn.*` subscription is polled, and no `question.ask` exists to register — the record is minted by the daemon from the provider's own held request, a tool server's question or a workflow step's wait, never by a client.

The `transcript` `query` rows are idempotent reads; `transcript.search`'s shapes sit with `session.search` in the session-payloads.md §Plan-001 block. The transcript's live rows ride the session's one stream, `session.event.subscribe`; the daemon drops nothing for a client that falls behind, and a client further behind than the threshold of [Spec-006 §Required Behavior](../../specs/006-local-ipc-and-daemon-control.md#required-behavior) is told so on a frame with no changes and takes a snapshot read; a client that reconnects re-opens the stream with `afterCursor` at the last position it kept. All request/response shapes are the interfaces defined directly above; the Rust types live in `crates/sidekicks-contracts/src/transcript/` (T1.1–T1.3), the generated TypeScript in `packages/contracts/src/transcript/`, per the api-payload-contracts.md §Source-of-Truth Policy.
