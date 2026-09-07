// What the page host is holding after the console's chord table moves.
//
// `Spec-023 §Console Design (Meridian)` 12.4's mirror is published and never polled,
// which makes every publish this binding skips a decision about what the host goes on
// claiming. Three states separate a correct skip from a silent one, and only the
// middle one distinguishes the two readings:
//
//   • a window whose chord table has claimable chords, which owes a publication — the
//     positive control, without which the other two pass over a binding that publishes
//     nothing at all;
//   • the same window after its last claimable chord is UNBOUND, which owes an empty
//     publication: the host is still holding the previous mirror, so it goes on
//     claiming those chords from the page while this renderer's projection no longer
//     holds them to replay — the keystroke reaches neither the page nor the console;
//   • a window that never had one, which owes nothing, because a host nobody has
//     published to claims nothing already.
//
// THE CHORDS COME FROM THE REAL TABLE. `useKeyboardHandbackBinding` reads the
// console's own keybinding surface — 12.4's third rule is that the mirror is a
// projection of the one table the palette, the `when` grammar, and the keyboard page
// all read — so these cases move that table through its own store rather than handing
// the hook a list, which would be a test of a seam the production path does not have.

import { useRef } from "react";

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { consoleKeybindingOverrides } from "../../../palette/index.js";
import { DEFAULT_TEST_PANE_ID, fixtureBrowserBridge } from "../BrowserPane.test-support.js";
import { useKeyboardHandbackBinding } from "./handback-binding.js";

/** Every mirror this window's host was handed, in the order it was handed them. */
type PublishedMirrors = readonly (readonly string[])[];

/**
 * A bridge whose chord-mirror publish is SERVED and recorded.
 *
 * The fixture port answers this operation with its unregistered-wire refusal, which
 * every case here would read as "the host was told nothing" — indistinguishable from
 * the skip these cases are about. So the served arm is scripted, and what it records
 * is the chord list itself rather than a call count: an empty publication and a
 * skipped one differ by exactly that list.
 */
function chordMirrorRecordingBridge(published: (readonly string[])[]): ConsoleBridge {
  const base = fixtureBrowserBridge();
  return {
    ...base,
    growth: {
      ...base.growth,
      browserPublishChordMirror: async (request) => {
        published.push(request.chords);
        return { status: "served" as const, value: undefined };
      },
    },
  };
}

/**
 * The pane's half of the handback, with no pane around it.
 *
 * A probe rather than a `BrowserPane` mount, because what these cases move is the
 * WINDOW's chord table: the pane's chrome, viewport, and navigation subscription are
 * every other suite's subject and would only decide how long this one waits.
 */
function HandbackProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
}): React.JSX.Element {
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  useKeyboardHandbackBinding(props.bridge, props.paneId, paneRootRef);
  return <div ref={paneRootRef} />;
}

/** Mount the binding and let its publish settle. */
async function mountHandback(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    render(<HandbackProbe bridge={bridge} paneId={DEFAULT_TEST_PANE_ID} />);
  });
}

/**
 * Take every chord off this window's keyboard, the way an operator would.
 *
 * `unbind` and not `resetAll`: a reset restores the chords the console SHIPS, which
 * is the opposite of the state these cases need. The ids are read before the first
 * write because each one recomposes the effective table this loop is walking.
 */
async function unbindEveryChord(): Promise<void> {
  const commandIds = consoleKeybindingOverrides.surface.bindings.map(
    (binding) => binding.commandId,
  );
  await act(async () => {
    for (const commandId of commandIds) {
      await consoleKeybindingOverrides.unbind(commandId);
    }
  });
}

/** The chords this window ships with, so a case can say the table was not empty. */
function shippedChordCount(): number {
  return consoleKeybindingOverrides.surface.bindings.length;
}

afterEach(async () => {
  // The override store is this window's, and a window under a test file is the module
  // graph: a case that left the keyboard empty would hand the next one a table it
  // never chose.
  await consoleKeybindingOverrides.resetAll();
});

describe("browser pane chord mirror — what the host is left holding", () => {
  it("publishes this window's claimable chords when the pane opens", async () => {
    const published: (readonly string[])[] = [];
    expect(shippedChordCount()).toBeGreaterThan(0);

    await mountHandback(chordMirrorRecordingBridge(published));

    const mirrors: PublishedMirrors = published;
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]?.length).toBeGreaterThan(0);
  });

  it("publishes an empty mirror when the last claimable chord is unbound", async () => {
    const published: (readonly string[])[] = [];
    await mountHandback(chordMirrorRecordingBridge(published));
    expect(published).toHaveLength(1);

    await unbindEveryChord();

    // The LAST publication and not a count: each unbind shrinks the projection and is
    // published on its own, which is the binding working. What separates the two
    // readings is where the sequence ENDS — on the empty mirror that tells the host to
    // claim nothing, or on the one-chord mirror it was left holding.
    //
    // This is the line that goes red on a binding that skips a publish whenever the
    // new projection is empty: the host keeps a mirror this window no longer has the
    // chords to replay, so a claimed keystroke reaches neither the page nor the
    // console.
    const mirrors: PublishedMirrors = published;
    expect(mirrors.length).toBeGreaterThan(1);
    expect(mirrors.at(-1)).toStrictEqual([]);
  });

  it("publishes nothing for a window that never had a claimable chord", async () => {
    // The negative control. Without it the case above is satisfied by a binding that
    // publishes on every pass, which would hand an empty mirror to every host that
    // has never been told anything — a wire call per pane for a state the host is
    // already in, and the 12.4 skip deleted rather than corrected.
    await unbindEveryChord();
    const published: (readonly string[])[] = [];

    await mountHandback(chordMirrorRecordingBridge(published));

    expect(published).toStrictEqual([]);
  });
});
