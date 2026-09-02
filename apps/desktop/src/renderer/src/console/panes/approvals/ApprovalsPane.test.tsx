// The pane, mounted over the real fixture bridge.
//
// Three of §7.6's rules only exist at this level, because each is a property of the
// COMPOSITION rather than of any card: that the pending / history split is a
// rendering of one unfiltered read (so history drops nothing), that the four read
// phases stay four different answers, and that an arriving decision is announced
// without taking a caret out of someone's hands.
//
// Everything is driven through the shipped `createFixtureBridge` and the shipped
// scenarios. The one thing this file constructs itself is the pane context, which
// is the seat the frame would hand a mounted pane.

import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApprovalsPane } from "./ApprovalsPane.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import { COMPOSER_SCENARIO } from "../../bridge/scenarios/composer.js";
import { DraftStore, MemoryPersistenceAdapter, UiStateStore } from "../../persistence/index.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";

function paneContext(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
): ConsolePaneContext {
  return {
    kind: "approvals",
    entity: undefined,
    paneId: "pane-approvals",
    bridge,
    frameStore: new FrameStore(),
    sessionStore,
    uiStateStore: new UiStateStore({ adapter: new MemoryPersistenceAdapter() }),
    draftStore: new DraftStore(),
    focusHue: undefined,
  };
}

function boundStore(sessionId = "session-approvals"): SessionStore {
  const store = new SessionStore({ sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return store;
}

/** Let every settled promise and effect land. */
async function flush(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Fire the reader's trailing debounce on the fixture's frozen clock, then settle. */
async function settle(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(REFRESH_DEBOUNCE_MS);
  });
  await flush();
}

async function mountPane(scenario = APPROVALS_SCENARIO): Promise<ConsoleBridge> {
  const bridge = createFixtureBridge({ scenario });
  const context = paneContext(bridge, boundStore(scenario.sessionId));
  await act(async () => {
    render(<ApprovalsPane {...context} />);
  });
  return bridge;
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("an unbound pane", () => {
  it("says it is unbound rather than reporting an empty queue", async () => {
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    await act(async () => {
      render(<ApprovalsPane {...paneContext(bridge, undefined)} />);
    });
    expect(screen.getByText("This pane is not bound to a session.")).not.toBeNull();
    // Negative control on the whole surface: nothing was read, so no section that
    // could be mistaken for an answer is rendered.
    expect(screen.queryByRole("region", { name: "Waiting on a decision" })).toBeNull();
  });
});

describe("the four phases of one read", () => {
  it("shows the read in flight before the scheduler fires", async () => {
    await mountPane();
    // Not "nothing needs a decision": the read has not answered, and the two are
    // different next moves for whoever is looking at it.
    expect(screen.getAllByText("Reading the approval queue.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing needs a decision.")).toBeNull();
  });

  it("renders the daemon's refusal when the read is refused", async () => {
    // The composer scenario scripts neither approval read, so the fixture rejects
    // — which is what makes the refusal arm reachable rather than hypothetical.
    const bridge = await mountPane(COMPOSER_SCENARIO);
    await settle(bridge);
    expect(screen.getAllByText("reply-unscripted").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing needs a decision.")).toBeNull();
  });
});

describe("one unfiltered read, rendered in two places", () => {
  it("splits the answered read into what is waiting and what is decided", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const waiting = within(section("Waiting on a decision")).getAllByRole("article");
    const history = within(section("Decision history")).getAllByRole("article");
    // Six records in the scenario: the two pending ones wait, the other four are
    // history. Every record appears in exactly one list, which is what makes the
    // split a rendering rather than a filter.
    expect(waiting).toHaveLength(2);
    expect(history).toHaveLength(4);
  });

  it("labels every state the read returned and drops none of them", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const history = section("Decision history");
    for (const phrase of ["Approved", "Rejected", "Expired", "Canceled"]) {
      expect(within(history).getByText(phrase)).not.toBeNull();
    }
    // Negative control: the terminal states are in HISTORY and not in the queue, so
    // "drops nothing" is not passing because everything landed in one bucket.
    expect(within(section("Waiting on a decision")).queryByText("Approved")).toBeNull();
  });

  it("routes a permission-kind ask to the ask card and an ordinary one to the plain card", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const waiting = section("Waiting on a decision");
    // The ask card is the only one that names the expiry outcome, so its presence
    // is the routing, and exactly one of the two pending records took it.
    expect(within(waiting).getAllByText(/the run continues/u)).toHaveLength(1);
  });

  it("states the wait-for-all barrier over the group rather than grouping cards", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getByText(/approved only if all of them are approved/u)).not.toBeNull();
    // No card claims membership of a set: the read carries no grouping key, and a
    // fabricated one would assert a dependency the wire never reported.
    expect(within(waiting).queryByText(/barrier/iu)).toBeNull();
  });
});

describe("standing permissions ride the same pane", () => {
  it("lists the rules the read returned, revoked ones included", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const permissions = section("Standing permissions");
    expect(within(permissions).getAllByRole("listitem")).toHaveLength(3);
    expect(within(permissions).getByText(/grantor.s membership changed/u)).not.toBeNull();
  });
});

describe("arrival is announced, and focus is not stolen", () => {
  it("announces the waiting decision in an assertive region", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const live = document.querySelector('[aria-live="assertive"]');
    expect(live?.textContent).toContain("decisions are waiting");
  });

  it("leaves focus where it was when the composer did not hold it", async () => {
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    const bridge = await mountPane();
    await settle(bridge);
    // A person reading a diff, or mid-sentence in a field this pane knows nothing
    // about, keeps their caret — the announcement is the whole notification.
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe("the sections whose wire this pane does not open", () => {
  it("renders the execution boundary as unknown rather than guessing one", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    expect(
      within(section("Execution boundary")).getByText("Execution boundary unknown"),
    ).not.toBeNull();
  });

  it("says the daemon-hosted tool registry has not been read", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    expect(
      within(section("Daemon-hosted tools")).getByText(
        "The daemon-hosted tool registry has not been read.",
      ),
    ).not.toBeNull();
  });
});

describe("the session goal", () => {
  it("renders the goal reading with no control, because no role was read", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).getByText("No goal set")).not.toBeNull();
    // Eligibility is never derived: an unread role is treated exactly as read-only.
    expect(within(goal).queryByRole("button")).toBeNull();
  });
});

// A queue that GROWS, which the shipped scenarios cannot do: a scripted reply is
// looked up per call and answers the same rows every time, so the case that matters
// here — a card arriving while older ones are already on screen — is only reachable
// against a stub whose answer changes between reads.
class ScriptedApprovalReads {
  #admitsThird = false;

  /** Let the next read carry the arriving record. */
  public admitThird(): void {
    this.#admitsThird = true;
  }

  public reply(): unknown {
    const shown = this.#admitsThird ? WAITING_APPROVAL_IDS : WAITING_APPROVAL_IDS.slice(0, 2);
    return { requests: shown.map(waitingRecord) };
  }
}

const WAITING_APPROVAL_IDS = [
  "019b7a33-3300-7f01-8210-d1a4c1150601",
  "019b7a33-3300-7f01-8220-d1a4c1150602",
  "019b7a33-3300-7f01-8230-d1a4c1150603",
] as const;

function waitingRecord(approvalRequestId: string): Record<string, string> {
  return {
    approvalRequestId,
    category: "file_write",
    state: "pending",
    requestedBy: "019b7a33-3300-7a6e-8110-d1a4c1150501",
    requestedScope: "run",
  };
}

function stubApprovalsBridge(reads: ScriptedApprovalReads): ConsoleBridge {
  const clock = new ManualClock();
  return {
    sidekicks: {
      daemon: {
        call: async (method: string): Promise<unknown> => {
          if (method === "approval.ruleList") {
            return { rules: [] };
          }
          if (method === "approval.projectionRead") {
            return reads.reply();
          }
          throw { code: "reply-unscripted", message: `nothing scripts ${method}` };
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    source: "fixture",
    // Shaped so the frozen-clock helper above drives this stub unchanged: the reader
    // resolves its clock off the scenario engine, and the tier has exactly one way
    // to move time.
    scenarioEngine: { clock, advance: (deltaMs: number) => clock.advance(deltaMs) },
  } as unknown as ConsoleBridge;
}

/** A composer holding focus, which is the precondition the focus rule is gated on. */
function composerHoldingFocus(): HTMLElement {
  const composer = document.createElement("div");
  composer.className = "meridian-composer";
  const field = document.createElement("button");
  composer.append(field);
  document.body.append(composer);
  field.focus();
  return composer;
}

describe("focus lands in the card that arrived", () => {
  it("focuses the arriving record's own action, not the first one on the page", async () => {
    const reads = new ScriptedApprovalReads();
    const bridge = stubApprovalsBridge(reads);
    await act(async () => {
      render(<ApprovalsPane {...paneContext(bridge, boundStore())} />);
    });
    await settle(bridge);
    const waiting = within(section("Waiting on a decision")).getAllByRole("article");
    expect(waiting).toHaveLength(2);

    const composer = composerHoldingFocus();
    reads.admitThird();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle(bridge);

    const arrived = WAITING_APPROVAL_IDS[2];
    const focusedCard = document.activeElement?.closest("[data-approval-id]");
    expect(focusedCard?.getAttribute("data-approval-id")).toBe(arrived);
    // The negative control on the selector this replaces: the first action in DOM
    // order belongs to a card that was already on screen, so a document-wide query
    // would have taken the caret to a request the announcement did not name.
    expect(document.querySelector(".meridian-approval-card__action")).not.toBe(
      document.activeElement,
    );
    composer.remove();
  });
});
