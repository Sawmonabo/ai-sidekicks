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
// THE READ IS SESSION-KEYED AND RUNS ONCE PER SESSION, never on a timer and never per
// render. Its answer is provenance, which does not change for an artifact once the
// object exists; what does change is the state each has reached, and that arrives on
// the log the shelf is already folding.
//
// AND THE WINDOW'S OWN CAPTURES ARE UNIONED IN RATHER THAN WAITED FOR. A capture taken
// here answers with the artifact id it minted, so this window knows that object is
// browser output the instant the act returns — before any later read could say so. The
// union is the fallback the reviewer's rule names: the wire where the wire answers, the
// pane's own capture correlation where it has not yet.

import { useEffect, useMemo } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import { producedObjectArtifactId, type ProducedObjectCard } from "./produced-objects.js";

/** What the daemon has said, where it has said anything. Absent is "not answered". */
type ProducedArtifactLedger = ReadonlySet<string> | undefined;

/** No answer yet, and the same identity every time so a re-seed publishes nothing new. */
const UNREAD_LEDGER: ProducedArtifactLedger = undefined;

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
  sessionId: string | undefined,
  locallyProduced: ReadonlyMap<string, ProducedObjectCard>,
): ReadonlyMap<string, ProducedObjectCard> {
  const { value: ledger, publish } = useSubjectScopedState<ProducedArtifactLedger>(
    bridge,
    sessionId ?? "",
    () => UNREAD_LEDGER,
  );

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const outcome = await bridge.growth.browserProducedArtifacts({ sessionId });
        if (cancelled || outcome.status === "unavailable") {
          // A refused read leaves the ledger unanswered rather than empty. An empty
          // set is the daemon saying the browser produced nothing, and publishing one
          // here would put that claim in front of a person on a build where the wire
          // is simply not registered.
          return;
        }
        publish(new Set(outcome.value.artifactIds));
      } catch {
        // The same reading as the refusal above: a call that never answered has said
        // nothing about what the browser produced.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, publish, sessionId]);

  return useMemo(() => joinProducedObjects(ledger, locallyProduced), [ledger, locallyProduced]);
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
