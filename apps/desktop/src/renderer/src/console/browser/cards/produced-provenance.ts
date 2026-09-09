// Which of the session's artifacts came out of the browser — the shelf's provenance.
//
// WHY THIS IS NOT THE CARD REGISTER, WHICH IS WHAT IT REPLACED. `captured-objects.ts`
// holds a card per capture THIS window took through the pane's own control, and the
// shelf used that register as its provenance: an artifact id absent from it was not
// browser output. Four whole classes of browser producer are absent from it by
// construction — an agent's capture, a completed download, a bundled asset set, and a
// capture started from the composer's attach row — because none of them is an act this
// renderer performs, and a fifth is absent by accident: the register is held per
// component instance, so everything the browser produced before a pane remount left it
// too. Their `artifact.*` beats are valid and were dropped, and the shelf then reported
// that nothing had been produced.
//
// AND WHY THE WIRE HAS TO ANSWER IT. `Spec-006 §Artifact and Diff Publication
// (artifact_publication)` types the family `{sessionId, artifactId?, runId?,
// diffArtifactId?, visibility?, state}` and the relay's additive members, and
// `docs/architecture/contracts/api-payload-contracts.md` §ArtifactManifest carries the
// producer only as `createdBy` — the publishing PARTICIPANT. Neither names a producing
// surface, an origin, or a pane, so no fold over the log can tell this session's
// capture from a repository attachment published beside it, and a fold that admitted
// every readable beat would list one under "Produced objects". The daemon is the only
// party that sees every browser producer, because every one of them enters the ingest
// pipeline through it, so the membership question is asked of the daemon and the state
// question is asked of the log.
//
// AND THE READ IS PUSH-DRIVEN, WHICH IS WHAT A MOUNT-SCOPED ONE COULD NOT BE. The
// answer is provenance, which does not change for an artifact once the object exists —
// but WHICH artifacts exist does, every time the browser produces another one. A read
// performed once when the pane mounted therefore covered exactly the objects that
// already existed: the agent capture taken a minute later, the download that completed
// while the person was reading, the asset bundle a tool wrote — each one's `artifact.*`
// beat reached the shelf's fold and was dropped, because the ledger the fold checks
// membership against had never heard of the id. So the ledger is re-read when one of
// those beats arrives, through `seats/read/push-driven-read.ts` and therefore through
// `store/read/refresh-scheduler.ts`'s one refresh scheduler: a burst of four produced objects in
// one transition costs one re-read, and nothing here arms a timer of its own.
//
// THE SIGNAL IS THE FOLD'S OWN KIND SET, and that is deliberate rather than
// convenient. `produced-objects.ts` declares which beats change what the shelf shows,
// and this module refreshes on exactly those: a second list here would be a shelf that
// folded a kind it never refreshed for, or refreshed for a kind it then dropped. The
// beat itself is not read — it cannot be, since the payload names no producing surface
// — so it is a signal and never a source, and the answer to "is this one ours" still
// comes from the daemon.
//
// AND THE WINDOW'S OWN CAPTURES ARE UNIONED IN RATHER THAN WAITED FOR. A capture taken
// here answers with the artifact id it minted, so this window knows that object is
// browser output the instant the act returns — before any later read could say so. The
// union is the fallback the reviewer's rule names: the wire where the wire answers, the
// pane's own capture correlation where it has not yet.

import { useCallback, useEffect, useMemo } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleClock } from "../../core/index.js";
import {
  PushDrivenRead,
  servedGrowthValueOrRaise,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "../../seats/index.js";
import {
  subscribeToSessionEventKinds,
  useSubjectScopedResource,
  type SessionStore,
  type SubjectScopedDisposal,
} from "../../store/index.js";
import {
  PRODUCED_ARTIFACT_EVENT_KINDS,
  producedObjectArtifactId,
  type ProducedObjectCard,
} from "./produced-objects.js";

/** Named in a refusal, so a failed read says which read failed. */
const BROWSER_PROVENANCE_ORIGIN = "browser-produced-artifacts";

/** Every artifact id the daemon named as this session's browser output. */
type ProducedArtifactLedger = PushDrivenRead<readonly string[]>;

/**
 * How the holder ends a ledger read, and how it reads one that already ended.
 *
 * A terminal disposal rather than a release, because `dispose` is what the model
 * documents it as and it is terminal by that contract: a disposed read answers
 * `start()` with nothing at all. The reading is what lets the holder re-mint for
 * React's second mount instead of committing the corpse the first mount's teardown
 * left. Declared at module level so both members keep one identity across every
 * render.
 */
const PROVENANCE_READ_DISPOSAL: SubjectScopedDisposal<ProducedArtifactLedger> = {
  dispose: disposeProvenanceRead,
  isClosed: isProvenanceReadClosed,
};

function disposeProvenanceRead(read: ProducedArtifactLedger): void {
  read.dispose();
}

function isProvenanceReadClosed(read: ProducedArtifactLedger): boolean {
  return read.isDisposed;
}

/**
 * The daemon's ledger for one session, refreshed by the beats the shelf folds.
 *
 * A pane with no session behind it still gets a model — a hook cannot be conditional
 * — and that model subscribes to nothing and is never started, so it holds the unread
 * arm for as long as the pane has no session. That is the honest reading: the question
 * was never put, which is not the same as being told the browser produced nothing.
 */
export function createBrowserProvenanceRead(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore | undefined;
  readonly clock: ConsoleClock;
}): ProducedArtifactLedger {
  const { bridge, sessionStore, clock } = options;
  return new PushDrivenRead<readonly string[]>({
    clock,
    origin: BROWSER_PROVENANCE_ORIGIN,
    read: async () => {
      if (sessionStore === undefined) {
        return [];
      }
      const answer = servedGrowthValueOrRaise(
        await bridge.growth.browserProducedArtifacts({ sessionId: sessionStore.sessionId }),
      );
      return answer.artifactIds;
    },
    // The beats the shelf's own fold reads, and only those. The beat is a SIGNAL —
    // its payload names no producing surface, so it cannot say whether the artifact
    // it is about came out of this browser — and the daemon answers that.
    subscribe:
      sessionStore === undefined
        ? () => () => undefined
        : (onChangeSignal) =>
            subscribeToSessionEventKinds(
              sessionStore,
              PRODUCED_ARTIFACT_EVENT_KINDS,
              onChangeSignal,
            ),
  });
}

/**
 * Every produced object the shelf may list, keyed by artifact id.
 *
 * ONE MAP AND NOT A SET BESIDE ONE, because the shelf's two questions are answered
 * per row and it reads them from the same place: WHICH objects are browser output, and
 * what this window can say about each. A key with a `capture` or `download` card is an
 * object this window made and can draw in full; a key with the `named` arm is one the
 * daemon named and this window did not make, so the log is everything known about it.
 *
 * The `named` arm is what lets the ledger ride the map the shelf already takes. It
 * carries an artifact id and nothing else on purpose: inventing a media type or a byte
 * length for an object this window never touched is exactly the fabrication the
 * identity row exists to avoid.
 */
export function useBrowserProducedObjects(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
  locallyProduced: ReadonlyMap<string, ProducedObjectCard>,
): ReadonlyMap<string, ProducedObjectCard> {
  // Resolved inside the resource's own `open`, which runs once per subject, for the
  // reason `geometry-binding.ts` resolves it the same way: the live arm of
  // `consoleClockFor` MINTS, so reading it in a render body would hand this
  // `dispose()`-bearing model a fresh clock identity on every pass.
  const openLedger = useCallback(
    () => createBrowserProvenanceRead({ bridge, sessionStore, clock: consoleClockFor(bridge) }),
    [bridge, sessionStore],
  );
  const { value: ledgerRead } = useSubjectScopedResource(
    bridge,
    sessionStore?.sessionId ?? "",
    openLedger,
    PROVENANCE_READ_DISPOSAL,
  );
  useEffect(() => {
    if (sessionStore === undefined) {
      return;
    }
    // In an effect and not in the render body: `start` opens a subscription and puts
    // a call on the wire, and a render React discards must do neither.
    ledgerRead.start();
  }, [ledgerRead, sessionStore]);

  const state = usePushDrivenRead(ledgerRead);
  return useMemo(
    () => joinProducedObjects(ledgerSetOf(state), locallyProduced),
    [state, locallyProduced],
  );
}

/**
 * The ledger as a membership set, or nothing where the daemon has not answered.
 *
 * BOTH UNSETTLED ARMS READ AS UNANSWERED, and that is the whole of the rule an empty
 * set would break. An empty set is the daemon saying the browser produced nothing;
 * `not-loaded` is a read still in flight and `failed` is a build where the wire is not
 * registered at all, and publishing "nothing produced" for either would put a claim in
 * front of a person that nothing established.
 */
function ledgerSetOf(
  state: PushDrivenReadState<readonly string[]>,
): ReadonlySet<string> | undefined {
  return state.kind === "loaded" ? new Set(state.value) : undefined;
}

/**
 * The union, as a pure reduction so a test can drive it without a bridge.
 *
 * THE LOCAL CARDS WIN ON A SHARED KEY, and that is the only ordering that can be
 * right: both sides agree the object is browser output, and one of them additionally
 * knows its media type, its stored byte length, and which act made it.
 */
export function joinProducedObjects(
  ledger: ReadonlySet<string> | undefined,
  locallyProduced: ReadonlyMap<string, ProducedObjectCard>,
): ReadonlyMap<string, ProducedObjectCard> {
  const joined = new Map<string, ProducedObjectCard>();
  for (const artifactId of ledger ?? []) {
    joined.set(artifactId, { kind: "named", props: { artifactId } });
  }
  for (const card of locallyProduced.values()) {
    joined.set(producedObjectArtifactId(card), card);
  }
  return joined;
}
