// The browser scenario — a session an agent is browsing in, and the artifacts
// that browsing produces.
//
// WHAT IT CAN SCRIPT, AND WHY THAT IS SO LITTLE ON THE PAGE SIDE. A scenario's
// beats are session events, and the browser namespace is unregistered
// (`Plan-023 §Console growth slate` rows 1, 2, and 4) — so there is no page-opened
// event type, no navigation event type, and no tool-call event type to script.
// Inventing one here would put a wire string in the fixture that no document owns,
// and the fixture's whole value is that it is shape-identical to something real.
// Navigation, the tool relay, and the dev-server chip therefore stay the growth
// port's refusal, which is the honest rendering of a console whose browser wire is
// not registered — and the day rows 1, 2, and 4 land, the page beats are appended
// here rather than a second scenario being minted.
//
// WHAT IT CAN SCRIPT ON THE ARTIFACT SIDE, WHICH IS THE POINT OF THE PANE. The
// browser's produced objects are not browser-shaped on the wire: a capture, a
// download, and a bundled asset set each land as an ORDINARY session artifact,
// which is exactly the one-pipeline rule the design section rests on — the browser
// is one more caller of a pipeline three other surfaces already use, so it inherits
// a registered event family instead of needing one of its own.
// `artifact.published` and `artifact.superseded` are registered Spec-006 types with
// the payload shape `{sessionId, artifactId?, runId?, diffArtifactId?, visibility?,
// state}`, so the rows below are wire-true today.
//
// WHERE THE ROW'S NAME, KIND, AND SIZE COME FROM, AND WHY THEY ARE NOT HERE. The
// design's density rule collapses a row to name, kind, and size — and none of the
// three is on the event. They live on the artifact MANIFEST, which the console
// reads through `artifactList` / `artifactRead`, both on the growth slate's
// artifact-CRUD row and both refusing today. So the split the fixture reproduces is
// the real one: the event carries identity, attribution, visibility, and state, and
// everything a person reads on the row's face is a refusal until that row lands.
// Scripting a name and a byte count into the payload here would have invented three
// members and hidden exactly the gap the growth port exists to show.
//
// REACHING THE THREE ARTIFACT STATES. `ArtifactState` is closed at `pending |
// published | superseded`, and the pane renders a different row for each: `pending`
// IS the design's loading state (an ingest in flight), `published` the settled row,
// `superseded` a retaken capture's predecessor. All three appear below, in the
// order a browsing session reaches them, so a surface cannot collapse two of them
// into one rendering and still look right against the fixture.
//
// WHAT REMAINS UNREACHABLE FROM A SCENARIO, STATED RATHER THAN QUIETLY MISSING.
// The section's degraded state (ingest capacity exhausted) and its five refusal
// codes are answers to a CALL, not facts on the log: they arrive as a rejected
// ingest, and `ScenarioReply` always resolves. They are reachable only through the
// growth port's refusal today, which is what the ingest trio returns.

import type { ConsoleScenario } from "../scenario.js";

export const BROWSER_SCENARIO_ID = "browser";

// Wire-declared UUIDs rather than readable placeholders: `wire-truth.ts` presents
// each beat to the strict contract layer as the whole envelope it claims to be,
// and an envelope whose session, actor, or run is not the UUID the contract
// declares is a beat no daemon could emit. `RunIdSchema` is the branded UUID the
// run-state projection parses every transition through, so a readable run id was
// refused at delivery rather than at authoring — the stream carried nothing and
// the pane read as a session with no run in it.
//
// The `id` on each beat below is the daemon's own opaque row id for that event.
// It is the member the hydrated-event read is keyed by, so it is written rather
// than omitted, and its tail is the beat's own log position, which is what a v7
// id minted one beat after another differs in anyway.
const SESSION_ID = "019b7b20-0280-75e5-8510-ada11a5a4444";

const HUMAN_PARTICIPANT_ID = "019b7b20-0280-79a4-8110-cca0117a0120";
const HUMAN_MEMBERSHIP_ID = "019b7b20-0280-7e3b-8110-cca0117a0121";
const AGENT_PARTICIPANT_ID = "019b7b20-0280-7a6e-8100-d1a4c1150022";
const RUN_ID = "019b7b20-0280-740e-8110-d1a4c1150044";

/**
 * The first capture, and the one a retake supersedes.
 *
 * Bound rather than repeated: three beats name it (the pending row, the settled
 * row, and the supersession), and three independent string literals could drift
 * with nothing to catch it — the supersession would then point at no row the pane
 * had ever shown, which reads as a missing feature rather than as a typo.
 */
const FIRST_CAPTURE_ARTIFACT_ID = "artifact-capture-staging-header";
const REPLACEMENT_CAPTURE_ARTIFACT_ID = "artifact-capture-staging-header-retake";

export const BROWSER_SCENARIO: ConsoleScenario = {
  id: BROWSER_SCENARIO_ID,
  label: "Browsing agent",
  purpose:
    "A session whose agent works in the embedded browser and leaves four artifacts behind — a capture mid-ingest, a settled capture, a download, and an asset bundle — reaching all three artifact states. The page beats are appended once the browser namespace, the tool relay, and the dev-server probe are registered.",
  sessionId: SESSION_ID,
  // Join order IS hue order (`Spec-023 §Console Design (Meridian)` rule 2), so a
  // screenshot baseline depends on this list. One person and one agent: the pane's
  // whole design question is what a human sees of what an agent is doing, and a
  // second agent would only add a hue.
  participantIdsInJoinOrder: [HUMAN_PARTICIPANT_ID, AGENT_PARTICIPANT_ID],
  startedAtIso: "2026-01-01T11:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150001",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        actorId: HUMAN_PARTICIPANT_ID,
        // The registered shape, verbatim: the new session's id plus the resolved
        // config and metadata, both open records the corpus names no key inside. A
        // session's name is read off `session.list`, and the lifecycle payload
        // carries no state transition — `session.activated` below is the separate
        // registered event that reaches `active`.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 40,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150002",
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "session.activated",
        occurredAt: "2026-01-01T11:05:00.040Z",
        actorId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          previousState: "provisioning",
          newState: "active",
          actor: HUMAN_PARTICIPANT_ID,
        },
      },
    },
    {
      atMs: 80,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150003",
        sessionId: SESSION_ID,
        sequence: 3,
        // The canonical first-joined event. `participant.joined` is not a
        // registered type — the `participant.*` family covers device reset,
        // export, and purge — so a fixture scripting it would be scripting a
        // string no consumer will ever receive.
        kind: "membership.created",
        occurredAt: "2026-01-01T11:05:00.080Z",
        actorId: HUMAN_PARTICIPANT_ID,
        // The registered membership shape: the membership row's own id, the
        // participant, the role from the closed role vocabulary, and the handle.
        payload: {
          membershipId: HUMAN_MEMBERSHIP_ID,
          participantId: HUMAN_PARTICIPANT_ID,
          role: "owner",
          identityHandle: "sawyer",
        },
      },
    },
    {
      atMs: 160,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150004",
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:05:00.160Z",
        // The person who attached the agent, not the agent: an agent does not
        // attach itself, and the envelope actor is who acted.
        actorId: HUMAN_PARTICIPANT_ID,
        // The full persona `Spec-006` registers for an attach, minus the optional
        // members this session does not set. `name` and not `displayName`: the
        // registered member is `name`, and the cast bar reads whatever the wire
        // spells.
        payload: {
          sessionId: SESSION_ID,
          agentId: AGENT_PARTICIPANT_ID,
          name: "Scout",
          driverName: "claude",
          modelId: "claude-sonnet-4-5",
          state: "ready",
          actor: HUMAN_PARTICIPANT_ID,
        },
      },
    },
    {
      atMs: 240,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150005",
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.queued",
        occurredAt: "2026-01-01T11:05:00.240Z",
        actorId: AGENT_PARTICIPANT_ID,
        // `previousState` is deliberately absent on the birth transition: the run
        // aggregate has no prior state, and no document names a value for it, so
        // the fixture omits the member rather than inventing one. Every later
        // transition below carries the real pair.
        payload: { sessionId: SESSION_ID, runId: RUN_ID, runVersion: 1, newState: "queued" },
      },
    },
    {
      atMs: 300,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150006",
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "run.starting",
        occurredAt: "2026-01-01T11:05:00.300Z",
        actorId: AGENT_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 2,
          previousState: "queued",
          newState: "starting",
        },
      },
    },
    {
      atMs: 320,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150007",
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "run.running",
        occurredAt: "2026-01-01T11:05:00.320Z",
        actorId: AGENT_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 3,
          previousState: "starting",
          newState: "running",
        },
      },
    },
    {
      atMs: 900,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150008",
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "artifact.published",
        occurredAt: "2026-01-01T11:05:00.900Z",
        actorId: AGENT_PARTICIPANT_ID,
        // THE LOADING ROW. A capture whose bytes are still crossing the ingest
        // pipeline: the manifest exists, the payload does not yet. The design's
        // "received bytes against the declared total" is the manifest's own
        // `size` against the ingest's progress, neither of which the event
        // carries — so the pane reads the STATE from here and the figures from
        // `artifactRead`, which refuses. Local-only, the documented default for a
        // newly ingested attachment.
        payload: {
          sessionId: SESSION_ID,
          artifactId: FIRST_CAPTURE_ARTIFACT_ID,
          runId: RUN_ID,
          visibility: "local-only",
          state: "pending",
        },
      },
    },
    {
      atMs: 1400,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150009",
        sessionId: SESSION_ID,
        sequence: 9,
        kind: "artifact.published",
        occurredAt: "2026-01-01T11:05:01.400Z",
        actorId: AGENT_PARTICIPANT_ID,
        // The same artifact id settling. Same id on purpose: a loading row that
        // becomes a settled row is one object, and a pane that keyed a new row
        // off this beat would show the capture twice.
        payload: {
          sessionId: SESSION_ID,
          artifactId: FIRST_CAPTURE_ARTIFACT_ID,
          runId: RUN_ID,
          visibility: "local-only",
          state: "published",
        },
      },
    },
    {
      atMs: 2000,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150010",
        sessionId: SESSION_ID,
        sequence: 10,
        kind: "artifact.published",
        occurredAt: "2026-01-01T11:05:02.000Z",
        actorId: AGENT_PARTICIPANT_ID,
        // A completed download. Indistinguishable from a capture on the wire —
        // which is the one-pipeline rule showing through, and the reason the
        // pane's overflow control filters by the session's browser rather than by
        // an artifact member naming the browser.
        payload: {
          sessionId: SESSION_ID,
          artifactId: "artifact-download-release-notes",
          runId: RUN_ID,
          visibility: "local-only",
          state: "published",
        },
      },
    },
    {
      atMs: 2600,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150011",
        sessionId: SESSION_ID,
        sequence: 11,
        kind: "artifact.published",
        occurredAt: "2026-01-01T11:05:02.600Z",
        actorId: AGENT_PARTICIPANT_ID,
        // The bundled asset set. The design types it `design`, and that
        // discriminator is a MANIFEST member rather than an event member, so it
        // is not scripted here — the row's kind arrives with the manifest read,
        // like its name and its size.
        payload: {
          sessionId: SESSION_ID,
          artifactId: "artifact-bundle-staging-assets",
          runId: RUN_ID,
          visibility: "shared",
          state: "published",
        },
      },
    },
    {
      atMs: 3200,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150012",
        sessionId: SESSION_ID,
        sequence: 12,
        kind: "artifact.published",
        occurredAt: "2026-01-01T11:05:03.200Z",
        actorId: AGENT_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          artifactId: REPLACEMENT_CAPTURE_ARTIFACT_ID,
          runId: RUN_ID,
          visibility: "local-only",
          state: "published",
        },
      },
    },
    {
      atMs: 3400,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150013",
        sessionId: SESSION_ID,
        sequence: 13,
        kind: "artifact.superseded",
        occurredAt: "2026-01-01T11:05:03.400Z",
        actorId: AGENT_PARTICIPANT_ID,
        // The retake lands first and the supersession follows, which is the order
        // a replacement actually happens in: superseding before the replacement
        // exists would leave a window with no current capture at all.
        payload: {
          sessionId: SESSION_ID,
          artifactId: FIRST_CAPTURE_ARTIFACT_ID,
          runId: RUN_ID,
          visibility: "local-only",
          state: "superseded",
        },
      },
    },
    {
      atMs: 3900,
      event: {
        id: "019b7b20-0280-7ea1-8110-e5e0d1150014",
        sessionId: SESSION_ID,
        sequence: 14,
        kind: "run.completed",
        occurredAt: "2026-01-01T11:05:03.900Z",
        actorId: AGENT_PARTICIPANT_ID,
        // The run reaches a terminal state, so the pane's chrome is exercised
        // against a finished run as well as a live one — a browser surface that
        // only ever renders `running` hides whatever it does when the agent stops.
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 4,
          previousState: "running",
          newState: "completed",
          completionKind: "task",
        },
      },
    },
  ],
  replies: [
    // The one read the scenario answers, instantly: nothing this family renders waits
    // on a reply. Its loading states are the in-flight capture row and the run that
    // stops, and both arrive as beats on the scenario clock.
    { call: "agent.list", result: { agents: [{ agentId: AGENT_PARTICIPANT_ID }] } },
  ],
};
