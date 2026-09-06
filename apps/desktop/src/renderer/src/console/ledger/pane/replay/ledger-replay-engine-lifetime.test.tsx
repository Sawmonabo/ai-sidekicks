// What the replay engine leaves armed on the clock when the walk under it is replaced.
//
// A DIFFERENT INSTRUMENT FROM THE WALK SUITE NEXT DOOR, which is why this is its own
// file: `ledger-replay-window.test.ts` asks what a walk is DOING and reads it off the
// hook's own published position, while this asks what is left ARMED ON THE CLOCK —
// a question no reading of the hook's result can answer, because an orphaned engine
// is by definition one no render holds any more.
//
// THE ENGINE IS A RESOURCE AND A RENDER BODY MINTS IT. `openEngine` constructs a
// `ReplayEngine` and, for a walk that was playing when its projection moved, resumes
// it — which arms a timeout on the console clock. A `useMemo` cannot close one: a memo
// whose dependencies changed DROPS the value it was holding and runs no cleanup, and a
// render React invokes and throws away really ran that body too. Both leaks are real
// and they are different, so they are two cases:
//
//   • A FOLD CHANGE replaces the walk on a committed render. The engine it replaced
//     goes on firing `onPositionChange` at a dock that is reading the new one, and the
//     scrubber jumps between the two on alternating frames.
//   • A DISCARDED PASS mints one that no commit ever saw, which no effect can reach
//     to close. `StrictMode` is what drives that here — React invokes the render body
//     a second time and discards the first result, which is exactly a pass that ran
//     and never committed, produced deterministically rather than raced for.
//
// `useSubjectScopedResource` closes both, and the frozen clock's own armed-work count
// is what proves it.

import { act, render } from "@testing-library/react";
import { StrictMode, useMemo, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useConsoleClock } from "../../../bridge/index.js";
import { ReplayEngine } from "../../structure/index.js";
import {
  useLedgerReplay,
  type LedgerReplayInputs,
  type LedgerReplayState,
} from "./ledger-replay-window.js";
import {
  CHAPTER_RUN_ID,
  ONE_ROW_MS,
  chapteredLog,
  fixtureBridgeOnFrozenClock,
  underBridge,
} from "./ledger-replay.test-support.js";
import { foldChapterHeaders } from "../feed/ledger-chapter-fold.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";

/** What both probes take, so a claim and its foil run the identical script. */
interface ReplayProbeProps {
  readonly inputs: LedgerReplayInputs;
  /**
   * Handed the live replay on every render, or nothing for an arm that has none.
   *
   * How the script reaches the controls: a walk has to be PLAYING before a fold
   * change can carry it, and only the real hook publishes a way to start one.
   */
  readonly onRendered: (replay: LedgerReplayState | undefined) => void;
}

/** The real hook, holding its engine through the substrate under test. */
function LedgerReplayProbe(props: ReplayProbeProps): ReactElement {
  const replay = useLedgerReplay(props.inputs);
  props.onRendered(replay);
  return <output>{replay.position.state}</output>;
}

/**
 * The arrangement this hook replaced: the engine held by a `useMemo` keyed on the
 * window.
 *
 * NOT a stand-in for `useLedgerReplay` — it answers no question about a walk, and no
 * claim here is read off it. It is a foil for the ONE line C-F3 changed: it mints the
 * REAL `ReplayEngine` on the REAL console clock in the same render body, resumes it
 * exactly as `openEngine` resumes a carried walk, and holds it the one way that can
 * neither close a replaced value nor a discarded one. Without it a flat count above
 * would prove only that this script never armed anything.
 */
function MemoHeldEngineProbe(props: ReplayProbeProps): ReactElement {
  const clock = useConsoleClock();
  const { ledgerWindow } = props.inputs;
  const engine = useMemo(() => {
    const mintedEngine = new ReplayEngine({
      clock,
      rows: ledgerWindow.rows.map((row) => ({ rowId: row.id, occurredAt: row.timestamp })),
    });
    // Parked and resumed, which is the state a fold change carries across — and
    // resuming is what arms the timeout an orphan then keeps forever.
    mintedEngine.scrubTo(ONE_ROW_MS);
    mintedEngine.play();
    return mintedEngine;
  }, [clock, ledgerWindow]);
  props.onRendered(undefined);
  return <output>{engine.position().state}</output>;
}

describe("the replay engine's lifetime across a walk it does not survive", () => {
  /**
   * Mount at the shut window with a walk playing, then disclose the chapter.
   *
   * ONE loaded log under both folds, which is what makes the disclosure a fold change
   * rather than an admitted event: only a walk whose LOG did not move is carried
   * across at the position it held, and only a carried walk resumes — which is the
   * one thing that arms work at mint time.
   *
   * The reading is taken TWICE, so every claim is that the count did not move rather
   * than that it holds some number a reader would have to trust.
   */
  function armedWorkAcrossAFoldChange(
    Probe: (props: ReplayProbeProps) => ReactElement,
    options: { readonly underStrictMode: boolean },
  ): { readonly beforeDisclosure: number; readonly afterDisclosure: number } {
    const { bridge, clock } = fixtureBridgeOnFrozenClock();
    const loadedWindow: LedgerWindowModel = deriveLedgerWindow(chapteredLog(), false);
    const shut = foldChapterHeaders(loadedWindow, new Set<string>()).window;
    const open = foldChapterHeaders(loadedWindow, new Set([CHAPTER_RUN_ID])).window;
    let latestReplay: LedgerReplayState | undefined;
    const treeAt = (ledgerWindow: LedgerWindowModel): ReactElement => {
      const probe: ReactNode = (
        <Probe
          inputs={{ ledgerWindow, loadedWindow }}
          onRendered={(replay) => {
            latestReplay = replay;
          }}
        />
      );
      return underBridge(
        bridge,
        options.underStrictMode ? <StrictMode>{probe}</StrictMode> : probe,
      );
    };

    const view = render(treeAt(shut));
    // A no-op on the foil, which mints its engine already playing. Both arms reach
    // the same state by the shortest route each has.
    act(() => {
      latestReplay?.scrub(ONE_ROW_MS);
      latestReplay?.play();
    });
    const beforeDisclosure = clock.pendingCount;

    act(() => {
      view.rerender(treeAt(open));
    });
    const afterDisclosure = clock.pendingCount;
    view.unmount();
    return { beforeDisclosure, afterDisclosure };
  }

  it("closes the engine a fold change replaced", () => {
    const { beforeDisclosure, afterDisclosure } = armedWorkAcrossAFoldChange(LedgerReplayProbe, {
      underStrictMode: false,
    });

    // Non-vacuity first: the committed walk really is playing, so a flat count is a
    // disposal rather than a script that armed nothing on either render.
    expect(beforeDisclosure).toBeGreaterThan(0);
    expect(afterDisclosure).toBe(beforeDisclosure);
  });

  it("negative control: a memo drops the replaced engine and it stays armed", () => {
    const { beforeDisclosure, afterDisclosure } = armedWorkAcrossAFoldChange(MemoHeldEngineProbe, {
      underStrictMode: false,
    });

    expect(beforeDisclosure).toBeGreaterThan(0);
    expect(afterDisclosure).toBeGreaterThan(beforeDisclosure);
  });

  it("arms no work a render React threw away left behind", () => {
    const { beforeDisclosure, afterDisclosure } = armedWorkAcrossAFoldChange(LedgerReplayProbe, {
      underStrictMode: true,
    });

    // One engine is armed and exactly one, both before the disclosure and after it,
    // even though the render body minted two each time.
    expect(beforeDisclosure).toBe(1);
    expect(afterDisclosure).toBe(1);
  });

  it("negative control: a memo leaves the discarded twin of every pass armed", () => {
    const { beforeDisclosure, afterDisclosure } = armedWorkAcrossAFoldChange(MemoHeldEngineProbe, {
      underStrictMode: true,
    });

    // Two per pass rather than one, which is the orphan stated as a count.
    expect(beforeDisclosure).toBeGreaterThan(1);
    expect(afterDisclosure).toBeGreaterThan(beforeDisclosure);
  });

  it("answers the holder's re-mint question from the engine, across its own disposal", () => {
    // WHY THIS CASE IS IN THIS FILE. The double-mount claim above holds only because
    // the resource holder can ask a value it has ALREADY closed whether it is closed —
    // React's committed cleanup disposes, and the effect then re-runs against what it
    // just closed. That reading is the engine's own. This mount used to keep a
    // `WeakSet` of the engines it had disposed, which was a second record of a fact the
    // object already had and one only this file could consult.
    //
    // Minted exactly as `openEngine` mints one, resumed the way a carried walk is, so
    // the arming the reading is held against is the arming the hook really performs.
    const { clock } = fixtureBridgeOnFrozenClock();
    const loadedWindow: LedgerWindowModel = deriveLedgerWindow(chapteredLog(), false);
    const engine = new ReplayEngine({
      clock,
      rows: loadedWindow.rows.map((row) => ({ rowId: row.id, occurredAt: row.timestamp })),
    });
    engine.scrubTo(ONE_ROW_MS);
    engine.play();
    expect(engine.isDisposed).toBe(false);
    expect(clock.pendingCount).toBe(1);

    engine.dispose();
    expect(engine.isDisposed).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });
});
