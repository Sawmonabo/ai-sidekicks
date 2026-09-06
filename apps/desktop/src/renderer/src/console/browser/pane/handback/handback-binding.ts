// Wiring the keyboard handback to the pane it protects.
//
// `Spec-023 §Console Design (Meridian)` 12.4 has two halves and `keyboard-handback.ts`
// owns the decisions in both: which chords MAY be claimed (the projection a host's
// mirror is built from) and what happens to one that was (the replay). What it
// deliberately does not own is the wire, because it has to be drivable from a test
// with no bridge in it. This module is that wire, and nothing else.
//
// THE MIRROR IS PUBLISHED, NOT POLLED. The chord set changes exactly when an operator
// rebinds a key, so the console's own keybinding surface is the trigger: the effect
// re-publishes when the projected chord list changes and at no other time. There is no
// interval here and there is nothing for one to do — a mirror that has not changed is
// a mirror the host already has.
//
// AND THE CHORD LIST IS THE REGISTRY'S OWN. `useKeybindingSurface` publishes the
// effective table — the shipped chords with this window's overrides applied — so the
// mirror is a projection of the one table the palette, the `when` grammar, and the
// keyboard page all read. A list assembled here would be the second source of truth
// 12.4's third rule forbids, and it would be wrong from the first rebinding.
//
// A CLAIMED CHORD IS REPLAYED ON THE PANE ROOT, which is what makes the handback
// behave like every other keystroke: the pane takes focus, the event is dispatched
// there, and it bubbles out through the same handlers a keystroke raised in this
// window would reach. Nothing is executed here, and no command is looked up.

import { useEffect, useMemo } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { normalizeWireRejection, type ConsoleRefusal } from "../../../core/index.js";
import { consoleKeybindingOverrides, useKeybindingSurface } from "../../../palette/index.js";
import { HOST_CHORD_PLATFORM } from "../../../primitives/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import type { ChordDescriptor } from "./chord-claim.js";
import { KeyboardHandback, type ChordReplayOutcome } from "./keyboard-handback.js";
import type { BrowserPaneRejectionFallback } from "../pane-refusals.js";

/** The subsystem name every refusal this module raises itself carries. */
const HANDBACK_BINDING_REFUSAL_ORIGIN = "browser-keyboard-handback";

/** What a broken handback subscription refuses under, where it carries no code. */
const HANDBACK_SUBSCRIPTION_FALLBACK: BrowserPaneRejectionFallback = {
  code: "handback-subscription-failed",
  detail:
    "Keystrokes claimed from the page are no longer reaching this window, so an application chord pressed inside the page does nothing. Closing the pane and opening it again starts a new subscription.",
};

/** What a mirror publish that never answered says, where it carries no code. */
const MIRROR_PUBLISH_FALLBACK: BrowserPaneRejectionFallback = {
  code: "chord-mirror-publish-failed",
  detail:
    "The console's chords could not be published to the page host, so no application chord is claimed from the page. Every keystroke reaches the page instead, which is the safe direction.",
};

/** The subscription's own outcome type, and the stream read out of it. */
type AcceleratorOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["browserSubscribeAccelerators"]>
>;
type AcceleratorStream = Extract<AcceleratorOutcome, { readonly status: "served" }>["value"];

/** What the pane knows about its handback: the mirror it published, and any refusal. */
export interface HandbackBinding {
  /** The chords the mirror carries, or `undefined` while the registry is unreadable. */
  readonly mirrorChords: readonly string[] | undefined;
  /** The newest refusal from either half, or `undefined` where neither refused. */
  readonly refusal: ConsoleRefusal | undefined;
  /** How many claimed chords have been replayed into this window. */
  readonly replayCount: number;
}

/**
 * Publish this pane's chord mirror and replay whatever comes back.
 *
 * The pane root is taken as a ref rather than an element because the replay happens
 * long after the mount that produced it, and a captured element would be the one the
 * first render had.
 */
export function useKeyboardHandbackBinding(
  bridge: ConsoleBridge,
  paneId: string,
  paneRootRef: React.RefObject<HTMLElement | null>,
): HandbackBinding {
  const surface = useKeybindingSurface(consoleKeybindingOverrides);
  const installedChords = useMemo(
    (): readonly string[] => surface.bindings.map((binding) => binding.chord),
    [surface],
  );
  const handback = useMemo(
    () =>
      new KeyboardHandback({
        readInstalledChords: () => installedChords,
        platform: HOST_CHORD_PLATFORM,
      }),
    [installedChords],
  );
  const mirrorChords = useMemo(() => handback.mirrorChords(), [handback]);
  // The mirror travels as one string, so an effect keyed on it re-publishes exactly
  // when the projected set changes rather than on every render that rebuilt the array.
  const mirrorKey = mirrorChords === undefined ? "" : mirrorChords.join(" ");
  const { value: refusal, publish: publishRefusal } = useSubjectScopedState<
    ConsoleRefusal | undefined
  >(bridge, paneId, () => undefined);
  const { value: replayCount, publish: publishReplayCount } = useSubjectScopedState(
    bridge,
    paneId,
    () => 0,
  );

  useEffect(() => {
    if (mirrorKey.length === 0) {
      // 12.4's degraded arm: unreadable defaults to the page. Nothing is published,
      // so the host claims nothing and every keystroke reaches the page. An empty
      // projection takes the same path, because a mirror holding no chord claims none.
      return;
    }
    // The count belongs to the mirror that is being replaced, and it is reset WITH it.
    // `handback` is re-minted whenever the chord table changes, and the new object
    // starts its own tally at zero — so a count left standing here would show the old
    // window's total against a new mirror until the next claimed chord overwrote it,
    // which is a number about a mirror that is gone.
    publishReplayCount(0);
    let cancelled = false;
    void bridge.growth.browserPublishChordMirror({ paneId, chords: mirrorKey.split(" ") }).then(
      (outcome) => {
        if (!cancelled && outcome.status === "unavailable") {
          publishRefusal(outcome);
        }
      },
      (failure: unknown) => {
        if (!cancelled) {
          publishRefusal(
            normalizeWireRejection(
              HANDBACK_BINDING_REFUSAL_ORIGIN,
              failure,
              MIRROR_PUBLISH_FALLBACK,
            ),
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, mirrorKey, paneId, publishRefusal, publishReplayCount]);

  useEffect(() => {
    let stream: AcceleratorStream | undefined;
    let cancelled = false;
    const closeStream = (): void => {
      const acquired = stream;
      stream = undefined;
      acquired?.close();
    };
    void (async () => {
      try {
        const outcome = await bridge.growth.browserSubscribeAccelerators({ paneId });
        if (cancelled) {
          if (outcome.status === "served") {
            outcome.value.close();
          }
          return;
        }
        if (outcome.status === "unavailable") {
          publishRefusal(outcome);
          return;
        }
        stream = outcome.value;
        for await (const chord of stream.events) {
          if (cancelled) {
            return;
          }
          const replayOutcome = replayClaimedChord(handback, chord, paneRootRef.current);
          if (replayOutcome === undefined) {
            continue;
          }
          if (replayOutcome.status === "refused") {
            publishRefusal(replayOutcome.refusal);
          } else {
            // The count is READ off the handback rather than tallied here: that object
            // already keeps one, and a second tally would be a copy of a number whose
            // owner is one call away.
            publishReplayCount(handback.replayCount);
          }
        }
        closeStream();
      } catch (failure) {
        closeStream();
        if (!cancelled) {
          publishRefusal(
            normalizeWireRejection(
              HANDBACK_BINDING_REFUSAL_ORIGIN,
              failure,
              HANDBACK_SUBSCRIPTION_FALLBACK,
            ),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [bridge, handback, paneId, paneRootRef, publishRefusal, publishReplayCount]);

  return { mirrorChords, refusal, replayCount };
}

/**
 * Decide one handed-back keystroke and replay it, or leave it alone.
 *
 * `undefined` for two different nothings, and neither is a swallowed failure. A chord
 * the console does not claim is a chord the page keeps, which is the whole point of
 * the projection. A chord that arrives with no pane root is one whose pane is not
 * mounted — the window it would be replayed into is gone, so there is no keystroke to
 * deliver and nobody to tell. Exported so the decision and the replay can be driven
 * together from a test without a subscription.
 */
export function replayClaimedChord(
  handback: KeyboardHandback,
  chord: ChordDescriptor,
  paneRoot: HTMLElement | null,
): ChordReplayOutcome | undefined {
  if (!handback.decide(chord).claimed) {
    return undefined;
  }
  if (paneRoot === null) {
    return undefined;
  }
  return handback.replay(chord, paneRoot);
}
