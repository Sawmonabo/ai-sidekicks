// The runs a session holds, as a surface can honestly know them.
//
// `RunList` renders snapshots and reads none: its own header says the registered
// workflow registry has no run enumeration at all, so the rows have always had to
// reach it from a caller. This hook is that caller's read, and it goes through the
// growth port for exactly the reason the header gives — the enumeration is a wire
// nobody has registered, the port is where an unregistered wire is asked for
// honestly, and a live bridge refuses it by name rather than answering with
// something invented.
//
// THE READ IS SESSION-SCOPED, for `../definitions/definition-directory.ts`'s reason and one of its
// own: a run belongs to a session, so a caller with no session in scope has no
// question to put rather than a narrower one. That is `unasked`, and rendering it as
// an empty list would assert that this context holds no runs — a claim about the
// daemon nothing established.
//
// ONE READ PER MOUNT, AND NO POLLING. A directory refreshing itself on a timer is a
// second source of truth beside the event stream, and the cheapest way to hold two
// answers to one question is to keep asking it. Navigating back remounts and
// re-reads, which is the moment a person expects a fresh list.
//
// AND A SECOND LIFETIME FOR A SURFACE THAT DOES NOT REMOUNT. "Navigating back remounts"
// is the runs surface's own reading and it is true of the runs surface: a person reaches
// that list by going to it. It is false of the pinned card above a channel's timeline,
// which is mounted for as long as somebody is reading the conversation — which is the
// whole time the run it names is advancing, parking, completing, or failing. So this
// module holds two lifetimes over ONE read: {@link useWorkflowRunDirectory} for a
// surface whose arrival is its refresh, and {@link useLiveWorkflowRunDirectory} for one
// that has to stay current where it stands. One request builder, one state vocabulary,
// two answers to how long an answer stays good — never two implementations of the read.
//
// WHAT THE LIVE ONE REFRESHES ON, AND WHY IT IS NOT A WORKFLOW EVENT. It declares NO
// triggering event kinds, and that is a measured claim rather than an omission: no
// `workflow.*` type is registered in the session-event census at all, which is why
// `bridge/growth-port/growth-prerequisites.ts` carries the registration as an unmet
// prerequisite of the workflow slate row. There is therefore no kind the session store
// folds and no name `daemon.subscribe` would be served for, and a set naming one would
// be a subscription that silently never fires — the exact hole
// `bridge/daemon/session-event-streams.ts` exists to keep out. What is left is the
// window-scoped half of the refresh substrate, which is what a reading no registered
// signal bears on is entitled to. The day that registration lands, the kinds go in the
// set below and nothing else here moves.
//
// THE FOUR STATES ARE FOUR FACTS AND NO OTHERS — nobody could ask, a read is in
// flight, an answer came back (possibly with no runs, which is a real answer), and
// the read refused. Collapsing any two is the conflation the five kinds of nothing
// exist to prevent.
//
// THE READ IS SETTLED RATHER THAN MERELY AWAITED. Two different failures reach this
// hook and both are refusals a person should read: the port's own
// `wire-unregistered` outcome, and a DAEMON refusal, which the scripted-reply seam
// throws verbatim rather than folding into the outcome union — deliberately, so a
// fixture never paraphrases a daemon's `{code, message}` into a growth vocabulary.
// A hook that attached only a fulfilment handler would leave the second one
// unhandled and the surface reading forever. `readings/read-settlement.ts` turns every ending
// into one value, so what arrives here is an answer or a refusal and never a promise
// nobody is waiting on — and the refusal's `origin` is what still says which of the
// two authors raised it.

// The ENTRY the port answers with, which is the bridge's declaration rather than the
// list projection's. A hook that retyped the answer would be asserting a shape the
// wire never promised, and the projection accepts what the bridge sends because it is
// the reader, not the source. `WorkflowRunListEntry` and not the run READ's snapshot:
// the enumeration carries each run's definition name and that definition's newest
// version id, which is what lets a row read as more than an id and lets the frozen
// pin be an inequality rather than a guess.
import { useCallback } from "react";

import {
  consoleClockFor,
  useSettledGrowthRead,
  type ConsoleBridge,
  type GrowthPort,
  type SettledReadRefusal,
  type WorkflowRunListEntry,
} from "../../bridge/index.js";
import {
  PushDrivenRead,
  servedGrowthValueOrRaise,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  subjectReadStart,
  useSubjectScopedResource,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
  type SubjectRead,
  type SubjectScopedDisposal,
} from "../../store/index.js";

/** What this read looks like once it has an answer, either kind. */
type SettledRunDirectory =
  | { readonly status: "served"; readonly runs: readonly WorkflowRunListEntry[] }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * What a runs surface knows about the runs this session holds, at one moment.
 *
 * Four states and no others, and the two unsettled ones are the shared shape rather
 * than a third spelling of it: `store/subject-read-start.ts` owns what a subject-keyed
 * read starts as, so this hook and the two beside it cannot drift about which frame is
 * allowed to claim nobody asked, or about which frame is allowed to hold the previous
 * bridge's answer.
 */
export type WorkflowRunDirectoryState = SubjectRead<SettledRunDirectory>;

/**
 * Read every run one session holds, once, for as long as the caller is mounted.
 *
 * The effect is keyed on the port and the session id: the port is minted once per
 * bridge and is stable for the life of a window, so a re-render never re-reads,
 * while a bridge swapped underneath — the fixture's scenario switch — and a move to
 * a different session both do.
 *
 * THE STATE IS HELD AGAINST THE PORT AND THE SESSION IT IS ABOUT, so either change is
 * settled during the render that brings it rather than in the effect after the commit.
 * Before that, a mounted list committed one frame of `unasked` under a session it had
 * already asked about — which the runs surface draws as an assertion that this context
 * holds no runs — and, across a move from one session to another, kept the previous
 * session's rows renderable under the new session's name. The port is the subject
 * because the fixture's scenario switch replaces the bridge and keeps the session id,
 * so a session-only holder committed the previous scenario's runs under the new one.
 */
export function useWorkflowRunDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowRunDirectoryState {
  return useSettledGrowthRead<
    Awaited<ReturnType<GrowthPort["workflowRunList"]>>,
    WorkflowRunDirectoryState
  >(growth, sessionId, (subject) => readRuns(growth, subject), {
    unsettled: subjectReadStart,
    settled: (settlement) =>
      settlement.status === "served"
        ? { status: "served", runs: settlement.value.runs }
        : { status: "unavailable", refusal: settlement },
  }).value;
}

/**
 * The enumeration, or no question at all.
 *
 * The request carries a required session id, so a caller with no session in scope has
 * nothing to ask rather than a narrower thing — which is what `unasked` is, and why
 * the absence is answered here where the request is built rather than inferred from
 * the key one family down.
 */
function readRuns(
  growth: GrowthPort,
  sessionId: string | undefined,
): ReturnType<GrowthPort["workflowRunList"]> | undefined {
  return sessionId === undefined ? undefined : growth.workflowRunList({ sessionId });
}

/** Names this read in a refusal the call itself did not name. */
const LIVE_RUN_DIRECTORY_ORIGIN = "workflow-run-directory";

/**
 * The enumeration kept current for a surface that stays where it is.
 *
 * A class rather than a hook body: it owns a subscription handle and a scheduler and
 * has a teardown, and `apps/desktop/AGENTS.md` puts stateful logic in a class with
 * private fields. It IS the trigger target rather than holding one beside it, so the
 * substrate's four moments and this read's own refresh are one object with one
 * identity — `collaboration/invites/use-pending-invites.ts`' shape, and the property
 * that keeps a re-render from re-firing the mount read.
 *
 * IT OPENS NO SUBSCRIPTION, and the empty `subscribe` is the same claim
 * `triggeringEventKinds` makes from the other side: there is no registered signal for
 * this answer to listen to. What the seat still supplies is everything else it owns —
 * one read per burst on the refresh chokepoint, no stale reply winning, no flicker back
 * to the unread frame while a refresh is in flight, and a terminal dispose.
 */
class LiveWorkflowRunDirectory implements ReadTriggerTarget {
  /** No registered session-event kind bears on this reading. See the module header. */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #read: PushDrivenRead<readonly WorkflowRunListEntry[] | undefined>;

  public constructor(bridge: ConsoleBridge, sessionId: string | undefined) {
    this.#read = new PushDrivenRead<readonly WorkflowRunListEntry[] | undefined>({
      clock: consoleClockFor(bridge),
      origin: LIVE_RUN_DIRECTORY_ORIGIN,
      read: async () => {
        const enumeration = readRuns(bridge.growth, sessionId);
        return enumeration === undefined
          ? undefined
          : servedGrowthValueOrRaise(await enumeration).runs;
      },
      subscribe: () => () => undefined,
    });
  }

  /**
   * The read itself, for the one binding that subscribes to it.
   *
   * Handed out rather than mirrored: `usePushDrivenRead` is the seat's own React
   * binding and re-implementing it around a forwarded `state` getter would be a second
   * external-store adapter for one model.
   */
  public get read(): PushDrivenRead<readonly WorkflowRunListEntry[] | undefined> {
    return this.#read;
  }

  public requestRead(reason: RefreshReason): void {
    this.#read.refresh(reason);
  }

  public dispose(): void {
    this.#read.dispose();
  }

  public get isDisposed(): boolean {
    return this.#read.isDisposed;
  }
}

/**
 * The live directory's disposal, as one module-level object.
 *
 * Minted once rather than in a render body, because the resource seam holds `dispose`
 * and `isClosed` on dependencies of their own and a fresh literal each pass would
 * restart the lifetime beneath it.
 */
const LIVE_RUN_DIRECTORY_DISPOSAL: SubjectScopedDisposal<LiveWorkflowRunDirectory> = {
  dispose: (directory) => {
    directory.dispose();
  },
  isClosed: (directory) => directory.isDisposed,
};

/**
 * Read every run one session holds, and keep reading it for as long as the caller is
 * mounted.
 *
 * The bridge rather than the port, because the clock is the bridge's: under the fixture
 * the scenario's frozen clock is the only clock this renderer reads, and a read that
 * armed its debounce on the platform clock would never fall due in a story.
 *
 * The state is held against the bridge and the session, exactly as
 * {@link useWorkflowRunDirectory}'s is: either moving is a different question, and the
 * resource seam disposes the previous one during the render that brings the new one.
 */
export function useLiveWorkflowRunDirectory(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
): WorkflowRunDirectoryState {
  const openDirectory = useCallback(
    () => new LiveWorkflowRunDirectory(bridge, sessionId),
    [bridge, sessionId],
  );
  const { value: directory } = useSubjectScopedResource(
    bridge,
    sessionId,
    openDirectory,
    LIVE_RUN_DIRECTORY_DISPOSAL,
  );
  // The mount read is the substrate's own `subscribe` moment rather than a `start()`
  // beside it, so a mounted card asks exactly once and the window coming back is the
  // second reason it ever asks.
  useWindowReadTriggers(directory);
  return liveDirectoryState(usePushDrivenRead(directory.read), sessionId);
}

/**
 * The live read's three arms, read as the four states every runs surface narrows on.
 *
 * ONE VOCABULARY AND NOT TWO. The pinned card and the runs list ask one question, and a
 * second settlement shape for the live lifetime would be two answers to it — so the
 * push-driven arms are projected onto the shape this module already publishes rather
 * than published beside it. `undefined` on the loaded arm is the read that had no
 * session to ask about, which is `unasked` and never an empty run list.
 */
function liveDirectoryState(
  state: PushDrivenReadState<readonly WorkflowRunListEntry[] | undefined>,
  sessionId: string | undefined,
): WorkflowRunDirectoryState {
  if (state.kind === "failed") {
    return { status: "unavailable", refusal: { ...state.refusal, status: "unavailable" } };
  }
  const runs = state.kind === "loaded" ? state.value : undefined;
  return runs === undefined ? subjectReadStart(sessionId) : { status: "served", runs };
}
