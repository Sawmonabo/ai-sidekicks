// Which row's device fan-out is open, and what that costs when the subject moves.
//
// THE TWO DEFECTS THESE CASES EXIST FOR. The open row was a mount-lifetime `useState`
// cell holding a participant id, and a participant id names somebody IN a session:
//
//   • A body re-addressed to another session kept the cell, so the fan-out read was
//     handed the session arrived at and the participant left behind — and that read is
//     owner/operator-only, so the console asked an authorization question about
//     somebody nobody in the new session had opened a row for.
//   • A presence refresh that dropped the open participant took their ROW with it, and
//     a row that is gone has no control left to close the panel under it — so the read
//     stayed subscribed to the presence stream and went on re-asking about somebody the
//     session no longer carried, for the rest of the visit.
//
// The cases drive the real body over a real fixture bridge, with the models leased from
// the family's own holder exactly as `MembersSection` leases them. What they read is
// what reached the WIRE — which fan-out was asked for, and how many subscriptions are
// still open — because a panel that is merely absent from the DOM is not the claim: the
// second defect was invisible on screen and expensive underneath it.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  withDaemonCall,
  withDaemonSubscribe,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { ConsoleBridge, GrowthPresenceDetail } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../../core/settle.test-support.js";
import type { SidebarSectionContext } from "../../seats/index.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import { CollaborationSessionModelHolder } from "../session-models.js";
import { MembersSectionBody } from "./MembersSectionBody.js";

/**
 * The two sessions and the two people, as branded-UUID-shaped strings.
 *
 * The call door parses both the request and the reply against the registered schema, so
 * a readable id is refused before it reaches the surface and every case would assert
 * against a refusal card rather than a roster.
 */
const FIRST_SESSION_ID = "019b7f10-0001-7000-8000-000000000001";
const SECOND_SESSION_ID = "019b7f10-0001-7000-8000-000000000002";
const PARTICIPANT_PRIYA = "019b7f10-0002-7000-8000-000000000001";
const PARTICIPANT_NOAH = "019b7f10-0002-7000-8000-000000000002";

/** One row of a presence reading, in the shape `presence.read` serves it. */
interface PresenceRow {
  readonly participantId: string;
  readonly state: string;
  readonly lastSeen: string;
}

const SEEN_AT = "2026-01-01T10:04:30.000Z";

function presenceRow(participantId: string): PresenceRow {
  return { participantId, state: "online", lastSeen: SEEN_AT };
}

/**
 * What each successive `presence.read` answers.
 *
 * A class rather than a captured `let`, per this package's state rule. The last scripted
 * roster stands for every read after it, so a case that refreshes more often than it
 * scripts sees a settled roster rather than an error.
 */
class ScriptedRosters {
  readonly #rosters: readonly (readonly PresenceRow[])[];
  #readCount = 0;

  public constructor(rosters: readonly (readonly PresenceRow[])[]) {
    this.#rosters = rosters;
  }

  public next(): readonly PresenceRow[] {
    const roster = this.#rosters[Math.min(this.#readCount, this.#rosters.length - 1)] ?? [];
    this.#readCount += 1;
    return roster;
  }
}

/** One fan-out the section actually asked for. */
interface RecordedDetailRead {
  readonly sessionId: string;
  readonly participantId: string;
}

/** Every device fan-out that reached the port, in the order it was asked. */
class DetailReadLog {
  readonly #reads: RecordedDetailRead[] = [];

  public record(request: unknown): void {
    const asked = request as { readonly sessionId?: unknown; readonly participantId?: unknown };
    this.#reads.push({
      sessionId: String(asked.sessionId),
      participantId: String(asked.participantId),
    });
  }

  public get reads(): readonly RecordedDetailRead[] {
    return this.#reads;
  }

  /** How many fan-outs were asked about that session. The absence claim, counted. */
  public countIn(sessionId: string): number {
    return this.#reads.filter((read) => read.sessionId === sessionId).length;
  }
}

/**
 * Daemon subscriptions opened and not yet released.
 *
 * The instrument the second defect needs and the DOM cannot give: a read whose row is
 * gone draws nothing either way, and what separates "closed" from "still asking" is
 * whether its subscription came back.
 */
class SubscriptionLedger {
  #liveCount = 0;

  public get liveCount(): number {
    return this.#liveCount;
  }

  public open(passThrough: () => Unsubscribe): Unsubscribe {
    this.#liveCount += 1;
    const release = passThrough();
    let isReleased = false;
    return () => {
      if (!isReleased) {
        isReleased = true;
        this.#liveCount -= 1;
      }
      release();
    };
  }
}

const FAN_OUT: GrowthPresenceDetail = {
  participantId: PARTICIPANT_PRIYA,
  aggregateState: "online",
  devices: [{ deviceId: "device-desk", state: "online", lastSeen: SEEN_AT }],
};

/** A scenario that scripts the channel read and leaves presence to the case's own arm. */
function membersScenario(): ConsoleScenario {
  return {
    id: "collaboration-members-detail-subject-test",
    label: "The members section, with presence answered per read",
    purpose: "Drives the open device panel across a subject change and a roster refresh.",
    sessionId: FIRST_SESSION_ID,
    participantIdsInJoinOrder: [],
    beats: [],
    replies: [{ call: "channel.list", result: { channels: [] } }],
    startedAtIso: "2026-01-01T10:05:00.000Z",
  };
}

/** Everything a case steers, over one real fixture bridge. */
interface SectionUnderTest {
  readonly bridge: ConsoleBridge;
  readonly detailReads: DetailReadLog;
  readonly subscriptions: SubscriptionLedger;
}

function sectionBridge(rosters: ScriptedRosters): SectionUnderTest {
  const detailReads = new DetailReadLog();
  const subscriptions = new SubscriptionLedger();
  const served = fixtureBridgeWithGrowth(membersScenario(), {
    participantPresenceDetailRead: growthAnswering<GrowthPresenceDetail>(async (request) => {
      detailReads.record(request);
      return Promise.resolve(FAN_OUT);
    }),
  });
  // Presence is answered here rather than scripted, because a scripted reply answers
  // every read the same way and what the second case is about is a roster that MOVED.
  const answered = withDaemonCall(served, async (call, passThrough) =>
    call.method === "presence.read"
      ? Promise.resolve({ participants: rosters.next() })
      : passThrough(),
  );
  return {
    detailReads,
    subscriptions,
    bridge: withDaemonSubscribe(answered.bridge, (passThrough) => subscriptions.open(passThrough)),
  };
}

function contextFor(bridge: ConsoleBridge, sessionStore: SessionStore): SidebarSectionContext {
  return {
    sessionStore,
    bridge,
    frameStore: new FrameStore(),
    openPane: () => undefined,
    isOpen: true,
  };
}

/** Let the section's debounced reads arm and land on the scenario's own frozen clock. */
async function settleReads(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
  });
  await settle();
}

/** Every row's disclosure control, in the order the roster draws them. */
function detailToggles(container: HTMLElement): readonly HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".meridian-roster-row__detail-toggle")];
}

/** Open the row at this position, and let the fan-out it asks for land. */
async function openRow(
  container: HTMLElement,
  bridge: ConsoleBridge,
  index: number,
): Promise<void> {
  const toggle = detailToggles(container)[index];
  if (toggle === undefined) {
    throw new Error(`no roster row at index ${String(index)}`);
  }
  act(() => {
    toggle.click();
  });
  await settleReads(bridge);
}

describe("the members section — an open device panel and the subject under it", () => {
  it("asks nothing about the open row after the body is re-addressed to another session", async () => {
    const seam = sectionBridge(new ScriptedRosters([[presenceRow(PARTICIPANT_PRIYA)]]));
    const holder = new CollaborationSessionModelHolder();
    const firstStore = new SessionStore({ sessionId: FIRST_SESSION_ID });
    const firstModels = holder.acquire(seam.bridge, firstStore).models;
    const mounted = render(
      <MembersSectionBody
        context={contextFor(seam.bridge, firstStore)}
        models={firstModels}
        selfParticipantId={undefined}
      />,
    );
    await settleReads(seam.bridge);
    await openRow(mounted.container, seam.bridge, 0);

    expect(seam.detailReads.countIn(FIRST_SESSION_ID)).toBe(1);
    expect(seam.detailReads.reads[0]?.participantId).toBe(PARTICIPANT_PRIYA);

    // The same person is on the second session's roster too, which is the case worth
    // holding: an id that survives the move is not merely stale, it silently resolves
    // to somebody and opens a panel nobody here asked for.
    const secondStore = new SessionStore({ sessionId: SECOND_SESSION_ID });
    const secondModels = holder.acquire(seam.bridge, secondStore).models;
    mounted.rerender(
      <MembersSectionBody
        context={contextFor(seam.bridge, secondStore)}
        models={secondModels}
        selfParticipantId={undefined}
      />,
    );
    await settleReads(seam.bridge);

    expect(seam.detailReads.countIn(SECOND_SESSION_ID)).toBe(0);
    expect(mounted.container.querySelector(".meridian-roster-row__detail")).toBeNull();
    expect(detailToggles(mounted.container)[0]?.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the panel and releases its read when a refresh drops the open participant", async () => {
    const seam = sectionBridge(
      new ScriptedRosters([
        [presenceRow(PARTICIPANT_PRIYA), presenceRow(PARTICIPANT_NOAH)],
        [presenceRow(PARTICIPANT_NOAH)],
      ]),
    );
    const holder = new CollaborationSessionModelHolder();
    const sessionStore = new SessionStore({ sessionId: FIRST_SESSION_ID });
    const lease = holder.acquire(seam.bridge, sessionStore);
    const mounted = render(
      <MembersSectionBody
        context={contextFor(seam.bridge, sessionStore)}
        models={lease.models}
        selfParticipantId={undefined}
      />,
    );
    await settleReads(seam.bridge);
    // The baseline is READ rather than stated: how many subscriptions one models set
    // opens is that set's business, and a number written here would be a second answer
    // to it. What this claims is the DELTA one open panel costs.
    const withNoPanelOpen = seam.subscriptions.liveCount;
    await openRow(mounted.container, seam.bridge, 0);

    expect(seam.detailReads.countIn(FIRST_SESSION_ID)).toBe(1);
    expect(seam.subscriptions.liveCount).toBe(withNoPanelOpen + 1);

    // Priya's membership ends. The roster re-reads on its own chokepoint and her row
    // goes — taking with it the only control that could have closed the panel.
    act(() => {
      lease.models.presenceRoster.refresh("participant-request");
    });
    await settleReads(seam.bridge);

    expect(detailToggles(mounted.container)).toHaveLength(1);
    expect(seam.subscriptions.liveCount).toBe(withNoPanelOpen);

    // And it stays released: a further presence signal re-reads the roster and asks
    // nothing more about the person who left.
    act(() => {
      lease.models.presenceRoster.refresh("participant-request");
    });
    await settleReads(seam.bridge);

    expect(seam.detailReads.countIn(FIRST_SESSION_ID)).toBe(1);
  });

  it("negative control: an open panel that keeps its row keeps its read", async () => {
    // Without this the two cases above would pass over a body that closed every panel
    // on every refresh, which would make the fan-out unreadable rather than correct.
    const seam = sectionBridge(new ScriptedRosters([[presenceRow(PARTICIPANT_PRIYA)]]));
    const holder = new CollaborationSessionModelHolder();
    const sessionStore = new SessionStore({ sessionId: FIRST_SESSION_ID });
    const lease = holder.acquire(seam.bridge, sessionStore);
    const mounted = render(
      <MembersSectionBody
        context={contextFor(seam.bridge, sessionStore)}
        models={lease.models}
        selfParticipantId={undefined}
      />,
    );
    await settleReads(seam.bridge);
    const withNoPanelOpen = seam.subscriptions.liveCount;
    await openRow(mounted.container, seam.bridge, 0);

    act(() => {
      lease.models.presenceRoster.refresh("participant-request");
    });
    await settleReads(seam.bridge);

    expect(mounted.container.querySelector(".meridian-roster-row__detail")).not.toBeNull();
    expect(detailToggles(mounted.container)[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(seam.subscriptions.liveCount).toBe(withNoPanelOpen + 1);
  });
});
