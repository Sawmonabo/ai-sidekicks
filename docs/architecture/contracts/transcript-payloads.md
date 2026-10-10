# Transcript Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-010 — Transcript And Reasoning

Every paged transcript reply is bounded by the frame it becomes (Plan-010 Phase 1). A JSON-RPC reply leaves the daemon inside one `Content-Length`-framed body, and a body over `MAX_MESSAGE_BYTES` is not a failed request: the framer refuses to emit it and the **connection closes** ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)). A row-count ceiling does not bound that — a `TranscriptEventRow` carries free-form fields at `EVENT_FIELD_MAX_LEN` plus a 4 KiB `summary`, and `JSON.stringify` expands a control character to a six-byte escape, so 256 contract-valid rows exceed the cap several times over before `payload`, which this contract does not bound at all. So each of the paged members — `TranscriptReadResponse.entries`, `ChildRunExpandResponse.entries`, and `ReasoningSurfaceReadResponse.reasoningEntries` — carries a byte budget (`PAGE_MAX_BYTES` in `packages/contracts/src/jsonrpc/page.ts`, the budget every paged reply shares — a 1,000,000-byte reply less a reserve for the envelope and the reply's non-paged members — declared apart from the 4 MB `MAX_MESSAGE_BYTES` and under it), a producer stops at whichever of the row limit and the byte budget trips first, and all these replies discriminate on `hasMore` so a caller can always continue. **The row limit that binds is the CALLER'S** (Plan-010 Phase 1): `TranscriptReadRequest.limit` is optional and a response schema never sees the request, so `entries` is schema-bounded only at the global `TRANSCRIPT_READ_LIMIT_MAX` and a read for ten rows answering with two hundred and fifty-six parses — a client sizing a viewport, a budget, or a render pass from the window it asked for is handed a larger one with nothing on the reply saying the request was not honored. The effective ceiling is therefore resolved per request — the caller's `limit` where it supplied one, the same global constant where it did not, which stays the default and the schema bound — and enforced at the daemon binder beside the request-scope checks, the only layer holding both numbers. `ChildRunExpandRequest` declares no `limit`, so its ceiling is that constant, stated on the same binder so one rule covers both paged reads. **The budget bounds aggregation and never bounds a page below one entry** (Plan-010 Phase 1): a continuing arm requires at least one entry — a page promising more and delivering none re-offers the same cursor forever while reading like progress — so where the first candidate alone exceeds the budget the producer pages that single entry and the reply is refused **for its size** at the response boundary, naming the member and its measured bytes on an error frame the substrate can deliver, rather than the page-fill helper returning a bare zero whose only representable answer is the empty continuing page the schema refuses. A **terminal** arm carries no such floor: an empty final page is the honest answer to a continuation whose cursor already sat at the end and to a filtered read that matched nothing. The budget does not reach a live event on `session.subscribe`, which is a single event on its own frame: an event that blows a frame by itself is an oversized event payload, and bounding it is an event-envelope and framer decision rather than one a Plan-010 page budget may make on their behalf.

```ts
// TranscriptRead. A cursor is a position in the log, and the cursor an event carries is the position
// right after it: afterCursor answers the events after its position and beforeCursor those before it,
// the event carrying that cursor among them, so a page before a window's head and the stream after it
// meet with nothing missed or repeated.
interface TranscriptReadRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  beforeCursor?: EventCursor;
  limit?: number;
}
// hasMore is the discriminant, not a flag beside an optional. The continuing arm REQUIRES nextCursor:
// a window promising more rows and supplying no way to ask for them leaves the caller re-reading the
// same window or giving up, and both lose rows the session holds (Spec-011 §Interfaces And Contracts,
// "cursor-based continuation"). The terminal arm PERMITS one and never requires it — the two members
// answer different questions, and a client that has just read to the end and now resumes session.subscribe
// from exactly there needs that position.
// The continuing arm additionally requires entries to be NON-EMPTY (Plan-010 Phase 1):
// a page promising more and delivering none advances no cursor while reading like progress, so the
// client re-asks from the same position and loops. The terminal arm keeps no floor — an empty final
// page is the honest answer to an exhausted continuation and to a filtered read that matched nothing.
// entries is additionally bounded by PAGE_MAX_BYTES (see this section's opening note).
type TranscriptReadResponse =
  | { entries: TranscriptReadRow[]; hasMore: true; nextCursor: EventCursor }
  | { entries: TranscriptReadRow[]; hasMore: false; nextCursor?: EventCursor };

interface TranscriptEventRowBase {
  id: string;
  sessionId: SessionId;
  sequence: number;
  // The position the session's stream delivers this event at, opaque and relayed verbatim, so a link
  // naming a message by its cursor finds the row however the row was read.
  cursor: EventCursor;
  category: EventCategory; // open on three arms; PINNED on the rollback-boundary arm, and refused as "run_lifecycle" on the general arm
  type: string;
  actor?: string;
  summary: string; // human-readable summary
  timestamp: string;
  childRunSummary?: ChildRunSummary; // if this is a summarized child-run row
  // Present, with at least one entry, on a tool call's row that left out one or more patches: the
  // row draws like one whose patch traveled, and `transcript.patchRead` fetches every left-out
  // patch of the call in one read.
  omittedPatches?: TranscriptOmittedPatch[];
  // The row's body, read for the whole window in one statement beside its events. Absent on a row a
  // client projects from a stream change, which carries no body; required on a TranscriptReadRow.
  content?: TranscriptRowContent;
  payload: Record<string, unknown>;
}
// A body travels with its row up to TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES, 32 KiB of JSON; a larger
// one comes back as its size alone, which `transcript.bodyRead` reads in full. A page therefore
// holds many rows even when every body sits at the ceiling, and one huge output never crowds its
// neighbors out of a page. Chat services size a single message in the same range (a few thousand
// characters recommended, 40,000 before a message is cut, 65,535 bytes for a whole event), so a
// reply of ordinary length travels whole. The daemon reads a large body's size, never its bytes.
type TranscriptRowContent =
  | { status: "available"; body: string; contentLength?: number; contentTruncated?: true }
  | { status: "unavailable"; reason: HydratedContentUnavailableReason }
  // The body's size in bytes, its bytes left out; contentTruncated echoed as on the available arm,
  // so a cut output still says it was cut.
  | { status: "large"; contentLength: number; contentTruncated?: true };
interface TranscriptOmittedPatch {
  path: string;
  size: number; // the patch's size in bytes
}

type TranscriptEntry = TranscriptEventRowBase & { kind: "general" }; // the non-run arm: carries no run attribution structurally — the projector stamps kind from the event family, so a run-scoped family can never arrive on this arm. The arm additionally REFUSES category: "run_lifecycle" (Plan-010 Phase 1): all-or-none attribution is enforced by arm SELECTION, so a row whose kind was stamped wrong never reaches the run arm and its missing triple is never checked — it would arrive as a legitimately attribution-free general row. Every Spec-005 §Run Lifecycle type is run-scoped (the state transitions share a payload shape carrying a required runId; the non-state rows each re-list it), so the refusal costs no correct projection. The refusal is THREE-LEGGED, not category alone (Plan-010 Phase 1): category is decisive only for run_lifecycle, so the arm also refuses a canonical type in the census of Spec-005 types whose registered payload names a run unconditionally, and — for the types whose run identity is registered OPTIONAL (every artifact_publication and assistant_output type, the assistant_output run being absent on a voice call's spoken answer, the usage_telemetry and approval_flow types not listed by name below, approval.rule_revoked among them, the queue_item types, user.message and question.asked), which no type-level test can decide — a payload naming a run under either registered spelling, runId or the intervention family's targetRunId. The census takes the run_lifecycle, tool_activity and interactive_request members from Plan-004's per-category arrays rather than transcribing them, so a type added to those categories joins it without an edit here; the usage_telemetry and approval_flow types whose payload requires a run are listed by name.

type RunScopedTranscriptEntry = TranscriptEventRowBase & {
  kind: "run"; // literal discriminator — row.kind narrowing is structural, never a probe of the free-form type: string
  runId: RunId; // run identity — with position + epoch, the REQUIRED all-or-none attribution triple the run.rolled_back live client rule keys on, never dug out of payload (CP-002-13): arm selection is by kind, so a run-scoped row missing any of the three fails ITS Zod arm — the malformed-row test — and can never fall through to the general arm
  position: number; // the row's projection-resolved originating run position (Plan-002 T3.15's uniform row-to-turn assignment); the live rule compares it against the run.rolled_back boundary's carried targetPosition (sequence is the session event sequence, never a run position)
  epoch: number; // the row's projection-resolved execution epoch (T3.16's row attribution: the stamped sourceEpoch on late rows, the operation association's epoch on in-time content-asynchronous rows, the run's current epoch at emission otherwise); position alone can never recover the epoch, since re-execution reuses ordinals
  superseded?: { targetPosition: number }; // present exactly when the row's turn is superseded, absence = current — projection-computed from Plan-002 T3.15's exported supersededTurns(runId); deliberately single-field: the marker's run identity and source epoch ARE the containing row's runId + epoch, so no duplicated fields exist to disagree and live marking (the row plus the boundary cutoff) is identical to catch-up marking by construction; targetPosition = the superseding rollback's rewind cutoff — the first accepted rollback in the run's lineage, at the row's epoch or later, that rewound the surviving history containing the row (a later rollback below an earlier retained prefix supersedes the inherited rows; a row ranks superseded when position exceeds the run's effective cutoff for its epoch — the minimum cutoff among accepted rollbacks at epoch >= the row's); identical on TranscriptRead and on live delivery, rows delivered after a boundary arriving with the marker already projection-computed — per Spec-011 §Required Behavior
  // Where a projection echoes canonical keys into payload, they must AGREE with the outer triple
  // (Plan-010 Phase 1 — I-010-3's no-second-source rule reaching the payload): payload run
  // identity under either spelling (runId, targetRunId) must equal this row's runId, and payload
  // sourceEpoch / sourcePosition must equal this row's epoch / position. Echoing stays OPTIONAL and
  // absence passes; only disagreement is refused, because consumers filter and mark superseded on the
  // outer triple while the row's detail and provenance read the payload, so a row stating two
  // attributions is filed under one turn and sourced from another. The run-identity half binds every
  // arm carrying an outer runId.
};

type TranscriptRollbackBoundary = Omit<TranscriptEventRowBase, "category" | "type" | "payload"> & {
  kind: "rollback_boundary"; // literal discriminator
  category: "run_lifecycle"; // pinned with `type`, and for the same reason (Plan-010 Phase 1): run.rolled_back is registered under one category and no other, so leaving this open on the one arm whose event type is closed would leave the half that can still disagree — and a renderer grouping or filtering by category would file the rewind cutoff under the wrong family
  runId: RunId; // the rewound run
  position: number; // the boundary row's own originating position
  epoch: number; // the epoch the rollback rewound
  superseded?: { targetPosition: number }; // an earlier boundary row is itself superseded when a later rollback cuts below it — same single-field marker semantics as the run arm
  type: "run.rolled_back";
  payload: RunRolledBackEvent; // validated into the typed shape (defined in run-control-payloads.md §Plan-002 — Queue Steer Pause Resume) at projection, so the live client rule reads a typed targetPosition — never an unsafe cast; an entry failing that validation is a projection defect surfaced at emission, never delivered untyped. Delivery is visibility-resolved: the boundary reaches every subscription holding any row of the affected run, so a subscriber holding that run's rows always receives the cutoff. Outer attribution and payload cannot disagree: the boundary arm's schema refines runId === payload.runId, sessionId === payload.sessionId, and position === payload.targetPosition (the boundary row ranks at the confirmed rewind floor — which is why a later rollback below it supersedes it), so a conflicting boundary fails parse as a projection defect, never delivered. The `Omit` on the base is load-bearing rather than stylistic (`packages/contracts/src/transcript/row.ts`): a plain `TranscriptEventRowBase &` intersection would type `payload` as `Record<string, unknown> & RunRolledBackEvent`, which no `RunRolledBackEvent`-typed value satisfies (an interface carries no implicit index signature) and which `RunRolledBackEventSchema` cannot be annotated against — the typed payload this comment promises would be unconstructible. `type` is Omitted for the same reason it is re-declared: this arm narrows the base's free-form string to one literal.
};

type TranscriptEventRow = TranscriptRollbackBoundary | RunScopedTranscriptEntry | TranscriptEntry; // the row union, genuinely discriminated on the literal kind: the contracts Zod discriminatedUnion selects the arm by kind (rollback_boundary | run | general), each arm validates strictly, and consumers narrow structurally on row.kind — never probing type: string, never casting
// A row as a read returns it, every arm with its body required: TranscriptReadResponse.entries and
// ChildRunExpandResponse.entries are both TranscriptReadRow, and TranscriptReadRowSchema parses it.
type TranscriptReadRow = TranscriptEventRow & { content: TranscriptRowContent };

// The run stamp a session.subscribe change carries for an event of a run (Plan-010 T2.4): the same
// position, epoch and superseded marker the event's transcript.read row carries, because the daemon
// computes both from one projection fold. A client marks the rows it already holds when a
// run.rolled_back boundary arrives: a held row of that run at the rollback's epoch or an earlier one
// is superseded above the lowest cut of every rollback of the run at its epoch or later, the rule the
// daemon's fold applies (`addSupersedingCut` in `packages/contracts/src/transcript/turn-attribution.ts`).
type TranscriptRunStamp = {
  position: number;
  epoch: number;
  superseded?: { targetPosition: number };
};

// The incompleteness marker (Plan-010 T1.2). Spec-011 §Fallback Behavior requires that a child run whose detail fetch fails "remains
// visible and marked incomplete rather than disappearing"; without the mark,
// the only signal of incompleteness would be a low eventCount, which is indistinguishable from a child run
// that genuinely did little. Every cause is a term the corpus
// already owns — none is minted here:
type ChildRunIncompleteCause = "detail_fetch_failed"; // this daemon's own expansion read failed — Spec-011 §Fallback Behavior's own
//   naming of the condition ("if a child-run detail fetch fails"). Transient: a retry may succeed.
// Deliberately NOT reused: RepoMountHealth "unreachable" (scoped to filesystem mounts, whose own
// contract warns against overloading it across axes).
type ChildRunCompleteness =
  | { state: "complete" }
  | {
      state: "incomplete";
      cause: ChildRunIncompleteCause; // required on this arm only
      observedAt: string; // ISO-8601, daemon clock — when the cause was observed. Required because the
      //   cause is transient: a consumer deciding whether to retry, and a renderer
      //   deciding whether to age the notice, both need to know how old the reading is. A cause with no
      //   time is unactionable.
    };

interface ChildRunSummary {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  eventCount: number; // on the incomplete arm this is a LOWER BOUND — the count this daemon currently
  //   holds, not the child run's true total, which by definition it cannot know
  completeness: ChildRunCompleteness; // REQUIRED, not optional: an absent marker would be a third state
  //   meaning "probably fine", and Spec-011 §Fallback Behavior's rule is that incompleteness is STATED,
  //   never inferred from a small count.
  // runId !== parentRunId (Plan-010 Phase 1): a run that is its own parent makes the
  //   run-lineage graph cyclic, and every consumer of that graph walks it — the renderer nests a child
  //   under its parent, Spec-014's one-layer nesting rule is checked against the chain, and cost
  //   attribution sums along it. Refused once at the parse boundary rather than defended against
  //   separately at every walk. ChildRunExpandResponse carries the same refusal on the same pair.
}

// ReasoningSurfaceRead
// No member names a person (api-payload-contracts.md §Authenticated Principal And Authorization Model: no person in a request
// body), and the Zod arm is strict: a caller that sends one is refused, not silently stripped.
interface ReasoningSurfaceReadRequest {
  runId: RunId;
  afterCursor?: EventCursor; // continuation position, the same opaque cursor the sibling reads take (Plan-010 Phase 1) — a reasoning entry is projected from the run's events, so its resume position is an event position, and one namespace spelling its cursor two ways would make a client hold two kinds of bookmark for one surface
}
type ReasoningSurfaceReadResponse =
  // Availability is a discriminated union: an open shape — available: boolean with free optionals —
  // would serialize the available / unavailable cases identically, leaving Spec-011
  // §Acceptance Criteria's distinguish-the-cases requirement unrepresentable.
  // The available state is the one that PAGES, so it is the one that splits on hasMore (
  // Plan-010 Phase 1) — the same continuation rule TranscriptReadResponse carries, nested inside
  // the availability discriminant so a paged reply is not a state of its own.
  // reasoningEntries is non-empty ON THE CONTINUING ARM ONLY (Plan-010 Phase 1).
  // A zero-entry available page claims a reasoning surface exists and then shows nothing, which renders
  // identically to unavailable while asserting the opposite — true of a FIRST read, and false of a
  // continuation whose afterCursor already sat at the end of the surface, which unavailable
  // would misstate. The schema cannot separate the two, because only the
  // request separates them: it carries the half it can see (the continuing arm, which is the arm that
  // can loop a client on a repeated cursor) and the daemon binder carries the first-page half, beside
  // the request-scope checks, under Plan-010 I-010-13.
  | {
      availability: "available"; // normalized reasoning present
      reasoningEntries: Array<{ sequence: number; content: string; timestamp: string }>; // required on this arm only, non-empty (continuing arm), bounded by PAGE_MAX_BYTES
      hasMore: true;
      nextCursor: EventCursor;
    }
  | {
      availability: "available";
      reasoningEntries: Array<{ sequence: number; content: string; timestamp: string }>; // may be EMPTY on this arm — see the note above; a first read answering empty is refused at the binder
      hasMore: false;
      nextCursor?: EventCursor;
    }
  | { availability: "unavailable" }; // the run surfaced no reasoning; no entries — the client renders the unavailability placeholder from the state itself (I-010-7: absence never renders as nothing)
// The contracts Zod schema (T1.3) is a discriminatedUnion on availability with strict arms: entries on the
// unavailable arm or an `available: boolean` member fail parse — no tolerant fallback arm.

// ChildRunExpand
interface ChildRunExpandRequest {
  runId: RunId; // child run to expand
  afterCursor?: EventCursor; // continuation position (Plan-010 Phase 1) — named to match the sibling reads rather than a bare `cursor`: one namespace, one name for the position a caller resumes from
}
// Discriminated on hasMore exactly as TranscriptReadResponse is, and for the same reason: a child
// run is not inherently smaller than a session window — a long-running subagent produces more rows
// than fit one frame — so the expansion needs the same continuation, on the same two arms, with the
// same rule about which of them may carry a cursor — and the same non-empty floor on the continuing
// arm, for the same reason: a child run's expansion loops a client on a repeated cursor exactly as
// a session read does. Two further rules the schema enforces (Plan-010 Phase 1): every entry that
// carries a run identity must carry THIS run's (the general arm is exempt, having none — a
// session-scoped row inside a child's window is context, not misattribution), and runId !==
// parentRunId, since a run that is its own parent makes the lineage graph cyclic and every walk of
// it — nesting, one-layer-depth checking, cost attribution — non-terminating.
type ChildRunExpandResponse = {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  entries: TranscriptReadRow[]; // bounded by PAGE_MAX_BYTES as well as by the row cap
} & ({ hasMore: true; nextCursor: EventCursor } | { hasMore: false; nextCursor?: EventCursor });

// TranscriptBodyRead — transcript.bodyRead. A row's large body (the `large` arm of its `content`) or
// whole output, read only when the row's control is pressed (`Show full output`, with its size),
// and the whole a copy from the row lifts.
// `rowId` is the row's `id`, the id of the event it renders. A session id the daemon does not hold
// is refused with `session.not_found`; a row id the session does not hold is refused on the `rowId`
// path, so it never reads like a row that carries no body.
interface TranscriptBodyReadRequest {
  sessionId: SessionId;
  rowId: string;
}
// `status` is the discriminant. `contentLength` and `contentTruncated` are echoed from the stored
// event, never recomputed from `body`, so a body kept as a prefix still says how long the whole
// was. `absent` is the one reason: the row never carried a body. `body` is bounded by
// PAGE_MAX_BYTES, so one that would not ride a frame is a failed read.
type HydratedContentUnavailableReason = "absent";
type TranscriptBodyReadResponse =
  | { status: "available"; body: string; contentLength?: number; contentTruncated?: true }
  | { status: "unavailable"; reason: HydratedContentUnavailableReason };

// TranscriptPatchRead — transcript.patchRead. Every patch one tool call did not carry, in one read,
// so a call with several missing files is drawn from one reply and looks exactly like a call whose
// patches traveled; the rows it fills are the ones the projection marks with `omittedPatches`.
interface TranscriptPatchReadRequest {
  sessionId: SessionId;
  toolCallId: string;
}
// One entry per left-out file: its patch, or why it cannot be read. `files` is bounded by
// PAGE_MAX_BYTES as well.
type TranscriptPatchFile =
  | { path: string; patch: string }
  | { path: string; unavailable: HydratedContentUnavailableReason };
interface TranscriptPatchReadResponse {
  files: TranscriptPatchFile[];
}

// TranscriptPathResolve — transcript.pathResolve. The candidate paths a reply's prose holds (bare,
// in backticks or `@`-prefixed, with or without `:line` or `:line:col`), resolved against the
// session's own workspace so the screen draws a link only for a real file inside it. A session id
// the daemon does not hold is refused with `session.not_found`.
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
// Both are per-turn live readings rather than projections of the log, and both are DERIVED from frames
// the provider already sends — neither adds a provider request and neither is polled.

// turn.usage — the tokens RECEIVED this turn. It starts at zero when the turn starts and steps up ONCE
// PER MODEL ROUND, never per word: each round adds the provider's own output count for that round — the
// output figure of Claude Code's per-message usage, and the `last` figure of Codex's token-usage
// notification — and the turn's figure is their sum. Reasoning is inside that count and is never added to
// it; the figure is never an iteration count and never a difference of two running totals, so the working
// line's reading means the same thing on both providers. It holds across a pause and stops at the turn's
// end; it is the only live token figure on the session screen, and the context ring, the cost receipt and
// a child's own tokens are different facts that keep their own surfaces.
// The request of both `turn.*` subscriptions: the run whose current turn it follows.
interface TurnSubscribeRequest {
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

// turn.tasks — the agent's own task list for this turn, in the agent's own order. The driver folds
// Claude Code's task-list tool calls and Codex's plan-updated notification into one list; the daemon
// turns Codex's plan updates on per session, because the provider leaves them off by default. The list
// is the turn's: it goes when the turn is interrupted and returns with the next turn's list.
interface TurnTasksUpdate {
  runId: RunId;
  turnId: string;
  // The WHOLE list per emission, in the agent's order, because a provider replaces its list rather
  // than patching it and a subscriber must never compose two halves into an order neither sent.
  tasks: Array<{ text: string; state: "not_started" | "in_progress" | "done" }>;
}

// ---- An agent's question ----
// Both providers can stop a turn to ask, with different mechanisms and one record: the daemon turns
// a held Claude Code question request or a Codex user-input request into ONE question record the
// screen renders and ONE call answers. It holds either request open with NO timer, rebuilds the
// card on a reload and on the person's other devices, and the first answer settles it everywhere. A
// question is an attention entry exactly as an approval is. Codex's NON-WAITING question has a
// question record too, which the daemon writes beside the message item the question arrived in,
// with `isAgentWaiting: false`: the record stays unanswered until the ordinary message answering it
// is taken, when the daemon marks it answered, so the working line's question count drops on every
// device. It raises no card of its own and no bell entry; pressing the working line's question
// count opens the card on it. The answered mark is the answering turn's `user.message` row whose
// `answersQuestionId?` names the question it answers: the message `question.resolve` writes for a
// held question, and the taken message for a non-waiting one. A question no message names is
// unanswered.

// question.asked — the record the screen renders, registered in Spec-005's `interactive_request`
// category, which owns the name and the census. A tool server's question and a workflow step waiting for
// a chat reply become the same record.
type QuestionId = string & { readonly __brand: "QuestionId" }; // daemon-minted
interface QuestionAskedPayload {
  questionId: QuestionId;
  sessionId: SessionId;
  // Exactly one of the two names what is waiting: an agent's or a tool server's question names the
  // agent's run; a workflow step waiting for a chat reply names its wait, the durable id that ties the
  // wait to its workflow run, its step and its session, so the first answer through either door settles it.
  runId?: RunId;
  waitId?: string; // a UUID
  // False only on a question the agent does not wait for (Codex's `agentMessage` item carrying
  // `questions` with `delivery: "async"`): the run keeps running and no card of its own is raised.
  isAgentWaiting: boolean;
  // The questions an agent, a tool server or a workflow wrote, stored as plain text like every
  // other column. They are all here, one per page in order, so paging needs no further read and
  // typed text survives paging both ways; their count is the page count. At least one.
  questions: Array<{
    // The short chip beside the eyebrow: the agent's own header, a tool server's name, or a workflow's
    // name; absent where there is none.
    header?: string;
    // The question itself, and the agent's own heading shown as the summary line only where it sent
    // one.
    text: string;
    heading?: string;
    options: Array<{
      label: string;
      description?: string;
      // Present only where the provider attached a preview to the option, which one provider does and
      // the other does not; absence means the provider attached none.
      preview?: string;
    }>;
    // True where the provider marked the question as taking several answers, which decides whether the
    // rows are boxes or single-choice marks. One provider marks every question this way and the other
    // marks it per question, so the flag is the provider's reading and never a console default.
    severalAnswers: boolean;
    // True where the provider marked the question secret: the card then shows a masked field and NO
    // option rows, so a secret question carries no options; the value is never written into the flow, and the person's turn afterwards records
    // only that a secret was answered.
    secret: boolean;
  }>;
}

// question.resolve — one call answers every page. Per question the answer is exactly one of: the picked
// labels, typed text, a secret, or a skip — which is why the arms are a closed union rather than four
// optional members. A secret is delivered to the provider and NEVER stored: it reaches no event payload,
// no artifact and no projection. The person's turn is written as an ordinary message record with the
// secret masked.
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
  // The record is the receipt: a question that has been answered cannot be answered again, and a second
  // call reads this state rather than re-applying.
  state: "answered" | "canceled";
}
```

## Transcript Method-Name Registry

Plan-010's transcript surface is exposed as the `transcript.*` methods below, registered by Plan-010 (T1.4 registers the strings against the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out — the `repo.*` / `approval.*` precedent). These methods ride the **daemon JSON-RPC transport only**: the transcript is a daemon-local projection over the session event log per [ADR-016](../../decisions/016-shared-event-sourcing-scope.md), and no tRPC sibling exists in V1. Method tails are camelCase per the convention the Approval Method-Name Registry records.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `transcript.read` | `query` | `TranscriptReadRequest` | `TranscriptReadResponse` |
| `transcript.reasoningSurfaceRead` | `query` | `ReasoningSurfaceReadRequest` | `ReasoningSurfaceReadResponse` |
| `transcript.childRunExpand` | `query` | `ChildRunExpandRequest` | `ChildRunExpandResponse` |
| `transcript.bodyRead` | `query` | `TranscriptBodyReadRequest` | `TranscriptBodyReadResponse` |
| `transcript.patchRead` | `query` | `TranscriptPatchReadRequest` | `TranscriptPatchReadResponse` |
| `transcript.search` | `query` | `TranscriptSearchRequest` | `TranscriptSearchResponse` |
| `transcript.pathResolve` | `query` | `TranscriptPathResolveRequest` | `TranscriptPathResolveResponse` |
| `turn.usage` | `subscription` | `TurnSubscribeRequest` | `TurnUsageUpdate` (stream) |
| `turn.tasks` | `subscription` | `TurnSubscribeRequest` | `TurnTasksUpdate` (stream) |
| `question.resolve` | `mutation` | `QuestionResolveRequest` | `QuestionResolveResponse` |

`turn` and `question` are two further registered roots on this same transport. They sit here rather than under `transcript` because a namespace names the thing it is about: the two subscriptions are readings of ONE TURN that end with it, while `transcript.*` reads the session's whole flow, and a question is a record with its own lifecycle rather than a row. Neither `turn.*` subscription is polled, and no `question.ask` exists to register — the record is minted by the daemon from the provider's own held request, a tool server's question or a workflow step's wait, never by a client.

The `transcript` `query` rows are idempotent reads; `transcript.search`'s shapes sit with `session.search` in the session-payloads.md §Plan-001 block. The transcript's live rows ride the session's one stream, `session.subscribe`; a client that fell behind re-opens it with `afterCursor` at the last position it kept, and past a gap of 1,024 events takes a snapshot read. All request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/src/transcript/` (T1.1–T1.3) per the api-payload-contracts.md §Source-of-Truth Policy.
