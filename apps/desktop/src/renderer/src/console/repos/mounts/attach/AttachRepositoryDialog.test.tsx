// The attach dialog, driven against a roster that answers and then changes.
//
// WHAT THE MODEL SUITE CANNOT SAY. `attach-model.test.ts` proves the resolution; this
// file proves the dialog HANDS IT the roster on screen. The defect both cases were
// written for was never in either half — it was the wiring: the picker drew from the
// served reading and the button read the form, so the two answered one question twice.
// A model test passes with that wiring restored, and these do not.
//
// THE ROSTER IS SERVED BY AN ARM THIS SUITE OWNS rather than by the scenario, because
// both cases are about a roster CHANGING between two reads and a scenario's frames are
// pinned to its own clock. Every other seam is the real fixture bridge's, so a dialog
// that stopped reaching one would fail here rather than pass against a stub.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { advanceScenarioUntil } from "../../../bridge/scenario-runtime/scenario-clock.test-support.js";
import { AttachRepositoryDialog } from "./AttachRepositoryDialog.js";
import { rosterEntry } from "./attach-roster.test-support.js";

/** A path long enough to be a path and short enough to read in a failure. */
const TYPED_PATH = "/Users/dev/code/ai-sidekicks";

/** The frame that owes the roster a fresh read. Any `runtime_node.*` kind does. */
const ROSTER_FRAME_KIND = "runtime_node.offline";

/**
 * A bridge whose roster this suite decides, and can decide again.
 *
 * A spread over the REAL fixture bridge, which is `fixture-bridge.test-support.ts`'s
 * shape for driving one namespace: everything the dialog reaches other than this one
 * read — the clock the scheduler runs on, the daemon door the attach itself would take
 * — stays the fixture's, so a case here really does drive a bridge.
 */
class RosterUnderTest {
  #nodes: readonly RuntimeNodeRosterEntry[];
  readonly bridge: ConsoleBridge;

  public constructor(nodes: readonly RuntimeNodeRosterEntry[]) {
    this.#nodes = nodes;
    const fixture = createFixtureBridge({ scenario: REPOS_SCENARIO });
    this.bridge = {
      ...fixture,
      runtimeNodeRosterRead: async () =>
        await Promise.resolve({ status: "served", value: { nodes: [...this.#nodes] } }),
    };
  }

  /** What the next read answers with. The refresh itself is a frame, below. */
  public serve(nodes: readonly RuntimeNodeRosterEntry[]): void {
    this.#nodes = nodes;
  }
}

/** A store with a base state, which is what makes a later frame a frame and not history. */
function initialisedStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** Everything one case drives: the roster it serves, the store it refreshes through. */
interface OpenDialog {
  readonly roster: RosterUnderTest;
  readonly sessionStore: SessionStore;
}

/** Mount the dialog, open it the way a person does, and wait for the picker. */
async function openDialog(nodes: readonly RuntimeNodeRosterEntry[]): Promise<OpenDialog> {
  const roster = new RosterUnderTest(nodes);
  const sessionStore = initialisedStore();
  const { container } = render(
    <LiveAnnouncerProvider>
      <AttachRepositoryDialog
        bridge={roster.bridge}
        sessionStore={sessionStore}
        onAttached={() => undefined}
      />
    </LiveAnnouncerProvider>,
  );
  act(() => {
    container.querySelector<HTMLButtonElement>(".meridian-repo-attach__trigger")?.click();
  });
  await advanceScenarioUntil(roster.bridge, () => {
    expect(nodeRadios()).toHaveLength(nodes.length);
  });
  return { roster, sessionStore };
}

/** The picker's rows, off the document because the popup is portalled out of the card. */
function nodeRadios(): readonly HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(".meridian-repo-attach__nodes input")];
}

function radioFor(nodeId: string): HTMLInputElement {
  const radio = nodeRadios().find((candidate) => candidate.value === nodeId);
  if (radio === undefined) {
    throw new Error(`the picker offers no row for ${nodeId}`);
  }
  return radio;
}

function attachButton(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(".meridian-repo-attach__confirm");
  if (control === null) {
    throw new Error("the dialog rendered no Attach control");
  }
  return control;
}

/** What the dialog says under a shut control, or nothing where it says nothing. */
function blockedSentence(): string | undefined {
  return document.querySelector(".meridian-repo-attach__blocked")?.textContent ?? undefined;
}

function typePath(path: string): void {
  const field = document.querySelector<HTMLInputElement>(".meridian-repo-attach__path-input");
  if (field === null) {
    throw new Error("the dialog rendered no path field");
  }
  fireEvent.change(field, { target: { value: path } });
}

/**
 * Refresh the roster the way the session does: a watched frame, then the debounce.
 *
 * WAITS ON THE ROWS THE NEW ANSWER NAMES, and not merely on rows existing: the picker
 * is already drawing the previous answer when this is called, so a looser wait would
 * return before the second read had landed and every assertion after it would be about
 * the roster the case was replacing.
 */
async function refreshRosterTo(
  open: OpenDialog,
  nodes: readonly RuntimeNodeRosterEntry[],
  sequence: number,
): Promise<void> {
  open.roster.serve(nodes);
  open.sessionStore.applyBatch([
    eventOfKind(REPOS_SCENARIO.sessionId, ROSTER_FRAME_KIND, sequence),
  ]);
  const expected = nodes.map((node) => node.nodeId);
  await advanceScenarioUntil(open.roster.bridge, () => {
    expect(nodeRadios().map((radio) => radio.value)).toStrictEqual(expected);
  });
}

describe("the attach dialog — a session on one machine has no decision to make", () => {
  it("opens the control once a path is named, with no press on the sole node", async () => {
    // The state this fix was written for. The sole row rendered CHECKED off the served
    // roster while the verdict read a form that had never held the id, so a complete
    // form sat behind a shut control — and clicking an already-checked controlled radio
    // emits no change, so there was no press that could have opened it.
    await openDialog([rosterEntry({ nodeId: "node-only" })]);
    typePath(TYPED_PATH);

    expect(radioFor("node-only").checked).toBe(true);
    expect(attachButton().disabled).toBe(false);
    expect(blockedSentence()).toBeUndefined();
  });

  it("negative control: two nodes leave the control shut and say which choice is missing", async () => {
    // Without this, the case above would pass against a dialog that pre-picked whatever
    // came first — which is wrong exactly when the path is on the other machine.
    await openDialog([rosterEntry({ nodeId: "node-1" }), rosterEntry({ nodeId: "node-2" })]);
    typePath(TYPED_PATH);

    expect(nodeRadios().every((radio) => !radio.checked)).toBe(true);
    expect(attachButton().disabled).toBe(true);
    expect(blockedSentence()).toContain("node");
  });
});

describe("the attach dialog — a roster refresh that removes the chosen node", () => {
  it("clears the selection and shuts the control rather than sending a node that has gone", async () => {
    const open = await openDialog([
      rosterEntry({ nodeId: "node-1" }),
      rosterEntry({ nodeId: "node-2" }),
    ]);
    typePath(TYPED_PATH);
    fireEvent.click(radioFor("node-2"));
    expect(attachButton().disabled).toBe(false);

    await refreshRosterTo(open, [rosterEntry({ nodeId: "node-1" })], 1);

    // The defect: the form kept the obsolete id, the picker showed nothing checked, and
    // Attach stayed open over a node this session no longer has.
    expect(nodeRadios().every((radio) => !radio.checked)).toBe(true);
    expect(attachButton().disabled).toBe(true);
    expect(blockedSentence()).toContain("no longer on this session's roster");
  });

  it("negative control: a refresh that keeps the chosen node leaves the control open", async () => {
    // Without this, the case above would pass against a dialog that shut its control on
    // every refresh — which would make the roster's own re-read the thing that broke it.
    const open = await openDialog([
      rosterEntry({ nodeId: "node-1" }),
      rosterEntry({ nodeId: "node-2" }),
    ]);
    typePath(TYPED_PATH);
    fireEvent.click(radioFor("node-2"));

    await refreshRosterTo(
      open,
      [rosterEntry({ nodeId: "node-2" }), rosterEntry({ nodeId: "node-3", state: "degraded" })],
      1,
    );

    expect(radioFor("node-2").checked).toBe(true);
    expect(attachButton().disabled).toBe(false);
  });
});
