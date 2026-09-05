// The pane, mounted over the real fixture bridge.
//
// The three rules this pane's own header states only exist at this level, because
// each is a property of the COMPOSITION rather than of any card: that the pending / history split is a
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
import {
  createFixtureBridge,
  type ApprovalRecord,
  type ConsoleBridge,
  type ParsedRows,
} from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import { COMPOSER_SCENARIO } from "../../bridge/scenarios/composer.js";
import { DraftStore, MemoryPersistenceAdapter, UiStateStore } from "../../persistence/index.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import { type ConsoleScenario } from "../../bridge/scenario.js";
import { type PaneContextOf } from "../pane-chrome.js";

function paneContext(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
): PaneContextOf<"approvals"> {
  return {
    // No `entity` member: the approvals pane is session-scoped, and its arm of the
    // address union carries none.
    kind: "approvals",
    paneId: "pane-approvals",
    linkedSourcePaneId: undefined,
    bridge,
    frameStore: new FrameStore(),
    sessionStore,
    uiStateStore: new UiStateStore({ adapter: new MemoryPersistenceAdapter() }),
    draftStore: new DraftStore(),
    focusHue: undefined,
  };
}

/**
 * A store bound to a session, carrying the scenario's own roster.
 *
 * The roster is seeded because the caller's ROLE is a lookup in it: the fixture
 * answers which participant this window is, and the role that identity resolves to
 * lives in the session's participant partition. A store with an empty roster would
 * make every role-gated control render closed for a reason nothing checked, which is
 * exactly the state the goal controls used to be pinned in.
 */
function boundStore(scenario: ConsoleScenario | undefined = APPROVALS_SCENARIO): SessionStore {
  const store = new SessionStore({ sessionId: scenario?.sessionId ?? "session-approvals" });
  const rolesByParticipantId = scenario?.membershipRoleByParticipantId ?? {};
  store.initialise({
    cursor: 0,
    entities: Object.entries(rolesByParticipantId).map(([participantId, role]) => ({
      kind: "participant",
      id: participantId,
      body: { role },
    })),
    participantJoinLog: Object.keys(rolesByParticipantId),
  });
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
  const context = paneContext(bridge, boundStore(scenario));
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

  it("names the run each waiting request was raised by", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const waiting = section("Waiting on a decision");
    // `runId` is required on every registered row, so every card can say it — and
    // which run raised a request is the first thing anyone answering one asks.
    expect(within(waiting).getAllByText("Raised by run")).toHaveLength(2);
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
  it("offers the control to the owner this window is", async () => {
    // The scenario says which participant this window is and the store's roster
    // says that participant is an owner, so the goal contract's own eligibility
    // resolves — rather than every caller being pinned in the unknown-role arm.
    const bridge = await mountPane();
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).getByText("No goal set")).not.toBeNull();
    expect(within(goal).getByRole("button", { name: "Set a goal" })).not.toBeNull();
  });

  it("offers no control to a viewer, and says nothing about a refusal", async () => {
    const viewerScenario: ConsoleScenario = {
      ...APPROVALS_SCENARIO,
      membershipRoleByParticipantId: {
        ...APPROVALS_SCENARIO.membershipRoleByParticipantId,
        ...(APPROVALS_SCENARIO.viewingParticipantId === undefined
          ? {}
          : { [APPROVALS_SCENARIO.viewingParticipantId]: "viewer" as const }),
      },
    };
    const bridge = await mountPane(viewerScenario);
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).getByText("No goal set")).not.toBeNull();
    expect(within(goal).queryByRole("button")).toBeNull();
  });

  it("holds the unknown-role arm while the identity read is in flight", async () => {
    // Before the read settles the role is not known, and an unknown role is
    // treated exactly as read-only. Asserted on the first commit rather than after
    // the flush, which is the interval a hook that kept a previous answer would
    // have rendered a control in.
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    render(<ApprovalsPane {...paneContext(bridge, boundStore())} />);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).queryByRole("button")).toBeNull();
    await flush();
  });

  it("says why the control is missing when the identity read refuses", async () => {
    // A scenario naming no viewer leaves the question unasked rather than answered
    // emptily, so the fixture refuses it — and the card renders that refusal's own
    // code instead of looking read-only for no stated reason.
    const { viewingParticipantId, ...anonymousScenario } = APPROVALS_SCENARIO;
    expect(viewingParticipantId).not.toBeUndefined();
    const bridge = await mountPane(anonymousScenario);
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).queryByRole("button")).toBeNull();
    expect(within(goal).getByText("wire-unregistered")).not.toBeNull();
  });

  it("negative control: the control is not offered to everyone", async () => {
    // Without this, a card wired to a constant `true` would pass the owner case
    // above and hand a viewer the same controls.
    const viewerScenario: ConsoleScenario = {
      ...APPROVALS_SCENARIO,
      membershipRoleByParticipantId: {
        ...APPROVALS_SCENARIO.membershipRoleByParticipantId,
        ...(APPROVALS_SCENARIO.viewingParticipantId === undefined
          ? {}
          : { [APPROVALS_SCENARIO.viewingParticipantId]: "runtime contributor" as const }),
      },
    };
    const bridge = await mountPane(viewerScenario);
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).queryByRole("button", { name: "Set a goal" })).toBeNull();
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

  public reply(): ParsedRows<ApprovalRecord> {
    const shown = this.#admitsThird ? WAITING_APPROVAL_IDS : WAITING_APPROVAL_IDS.slice(0, 2);
    return { rows: shown.map(waitingRecord), unreadableCount: 0 };
  }
}

const WAITING_APPROVAL_IDS = [
  "019b7a33-3300-7f01-8210-d1a4c1150601",
  "019b7a33-3300-7f01-8220-d1a4c1150602",
  "019b7a33-3300-7f01-8230-d1a4c1150603",
] as const;

/**
 * One waiting record, in the shape the CONSOLE holds — `approvalRequestId` and
 * `requestedScope`, not the reply's `id` and `scope`.
 *
 * The read's own narrowing performs that rename, and it is deliberate: the resolve
 * REQUEST names the same value `approvalRequestId`, and `scope` on the reply is what
 * was asked for rather than what was granted. A case constructing the wire spelling
 * here would be standing in for a read that had not run.
 */
function waitingRecord(id: string): ApprovalRecord {
  return {
    approvalRequestId: id,
    runId: "019b7a33-3300-740e-8110-d1a4c1150511",
    requestedBy: "019b7a33-3300-7a6e-8110-d1a4c1150501",
    category: "file_write",
    requestedScope: "run",
    resourceDescriptor: { path: "packages/contracts/src/approval.ts" },
    state: "pending",
    createdAt: "2026-01-01T13:30:00.900Z",
    updatedAt: "2026-01-01T13:30:00.900Z",
  };
}

/**
 * Anything the stub port can answer the projection read with.
 *
 * The console's OWN reading of that read — rows it could decode, beside a count of
 * the ones it could not — rather than a wire-shaped reply, because that is what the
 * growth port answers with and because the claim under test is what the PANE renders
 * for a partial read. A case that handed in raw rows would be re-deciding which of
 * them are readable, which is `approval-records.test.ts`'s subject and not this
 * file's.
 */
interface ApprovalProjectionSource {
  readonly reply: () => ParsedRows<ApprovalRecord>;
}

/**
 * A bridge whose approvals reads answer from this suite rather than from a scenario.
 *
 * The growth port is spread over the refusing one, which is the console's shape for
 * standing in for a single operation: an arm this suite does not name refuses by name
 * instead of being absent, so a pane reaching for one renders a refusal rather than
 * failing on `undefined`.
 */
function stubApprovalsBridge(reads: ApprovalProjectionSource): ConsoleBridge {
  const clock = new ManualClock();
  return {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => undefined,
        subscribe: () => () => undefined,
      },
    },
    growth: {
      ...createRefusingGrowthPort(),
      approvalProjectionRead: async () => ({ status: "served", value: reads.reply() }),
      approvalRuleList: async () => ({
        status: "served",
        value: { rows: [], unreadableCount: 0 },
      }),
    },
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

// An answered read whose records this build cannot decode. Reachable only against a
// stub: every shipped scenario answers rows the parser reads, which is what those
// fixtures are for.
async function mountOverReply(reply: ParsedRows<ApprovalRecord>): Promise<ConsoleBridge> {
  const bridge = stubApprovalsBridge({ reply: () => reply });
  await act(async () => {
    render(<ApprovalsPane {...paneContext(bridge, boundStore())} />);
  });
  await settle(bridge);
  return bridge;
}

describe("an empty list never hides what could not be read", () => {
  it("says the read was partial rather than that nothing needs a decision", async () => {
    await mountOverReply({ rows: [], unreadableCount: 3 });
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getByText("Part of this read could not be decoded.")).not.toBeNull();
    expect(within(waiting).getByText(/\b3\b/u)).not.toBeNull();
    // The negative control on the branch this replaces: the reassuring empty state
    // used to render here, and it must not, because requests may be waiting.
    expect(within(waiting).queryByText("Nothing needs a decision.")).toBeNull();
  });

  it("renders the served empty set unchanged when nothing was unreadable", async () => {
    await mountOverReply({ rows: [], unreadableCount: 0 });
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getByText("Nothing needs a decision.")).not.toBeNull();
    expect(within(waiting).queryByText("Part of this read could not be decoded.")).toBeNull();
  });

  it("keeps the list and the warning together when both are true", async () => {
    await mountOverReply({ rows: [waitingRecord(WAITING_APPROVAL_IDS[0])], unreadableCount: 1 });
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getAllByRole("article")).toHaveLength(1);
    expect(within(waiting).getByText(/could not read/u)).not.toBeNull();
  });
});
