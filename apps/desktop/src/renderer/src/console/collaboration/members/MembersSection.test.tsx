// What the sidebar's two sections actually put on screen.
//
// Each section is a composition, and the property worth asserting is that it is a
// composition of MORE THAN ONE body: the roster answers who is here, the
// membership ledger answers on what terms, and a section that rendered only the
// first would answer half the question the sidebar's own label asks. Driven
// through the real seat registry rather than by rendering the component directly,
// because what the sidebar mounts is the descriptor's renderer and that is the
// path a regression would take.
//
// BOTH SECTIONS ARE DRIVEN FROM HERE, through the one registry harness below. They
// are two descriptors over one holder and one session store, and the degraded cases
// at the foot of this file assert the same rule of each of them — a second file
// would be a second copy of the harness, which is the duplication this package's
// own scaffolding rule forbids.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import {
  sidebarSectionRegistry,
  type SidebarSectionContext,
  type SidebarSectionId,
} from "../../seats/index.js";
import { registerCollaborationSections } from "../sections.js";

/**
 * The session id both section reads send over the wire.
 *
 * A UUID rather than a readable string, because the call door parses the REQUEST
 * against the registered schema before it sends and `sessionId` is a branded UUID
 * scalar — a readable id is refused as `request-unsendable`, both reads settle on
 * the refusal arm instead of the served one, and the degraded line the cases below
 * assert lives only in the served body.
 */
const SESSION_ID = "019b7910-0005-7000-8000-000000000001";

function bridgeForSection(): ConsoleBridge {
  return createFixtureBridge({
    scenario: {
      id: "collaboration-members-section-test",
      label: "The members section, with nothing scripted",
      purpose: "Drives the section body the sidebar mounts.",
      sessionId: SESSION_ID,
      participantIdsInJoinOrder: [],
      beats: [],
      // Both section reads are scripted, and both answer with an empty set. The
      // degraded line lives in each body's SETTLED arm, so a scenario that scripted
      // neither would leave both sections rendering a refusal card, where no
      // transition of the store's flag could show at all.
      replies: [
        { call: "presence.read", result: { participants: [] } },
        { call: "channel.list", result: { channels: [] } },
      ],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  });
}

/** One mounted section, and the store and bridge its context was built over. */
interface MountedSection {
  readonly container: HTMLElement;
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
}

function renderSection(id: SidebarSectionId): MountedSection {
  registerCollaborationSections();
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  const bridge = bridgeForSection();
  const context: SidebarSectionContext = {
    sessionStore,
    bridge,
    openPane: () => undefined,
    isOpen: true,
  };
  const renderSectionBody = sidebarSectionRegistry.descriptorFor(id)?.render;
  expect(renderSectionBody).toBeDefined();
  return {
    container: render(<>{renderSectionBody?.(context)}</>).container,
    sessionStore,
    bridge,
  };
}

describe("the members section's bodies", () => {
  it("renders the roster and the membership ledger, in that order", () => {
    const { container } = renderSection("members");
    const roster = container.querySelector(".meridian-roster");
    const memberships = container.querySelector(".meridian-members");
    expect(roster).not.toBeNull();
    expect(memberships).not.toBeNull();
    // `DOCUMENT_POSITION_FOLLOWING` — the ledger comes after the roster, which is
    // the order the two questions are asked in.
    expect(roster?.compareDocumentPosition(memberships as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("carries the sent-invite ledger inside the membership ledger", () => {
    const { container } = renderSection("members");
    expect(container.querySelector(".meridian-members .meridian-invites")).not.toBeNull();
  });

  it("negative control: the channels section carries neither", () => {
    // Without this, the two cases above would pass over a registry that rendered
    // one body into every section it holds.
    const { container } = renderSection("channels");
    expect(container.querySelector(".meridian-members")).toBeNull();
    expect(container.querySelector(".meridian-roster")).toBeNull();
  });
});

/** The line each section renders while the store says its projection is behind. */
const DEGRADED_LINE_SELECTOR: Readonly<Record<string, string>> = {
  members: ".meridian-roster__degraded",
  channels: ".meridian-channels__degraded",
};

/**
 * Mount a section and let its own read settle.
 *
 * The settle is what makes the cases below say what they claim. Every section opens
 * on the `not-loaded` absence — the models are leased from a mount effect and the
 * read is armed on the refresh chokepoint's debounce after that — and the degraded
 * line lives in the settled body, so a case that marked the store degraded before
 * then would be asserting over a body that had not been rendered yet and could not
 * tell a subscription from a coincidence.
 *
 * The frozen clock is advanced rather than waited on, because under the fixture the
 * scenario's clock is the only clock this renderer reads.
 */
async function sectionWithItsReadSettled(id: SidebarSectionId): Promise<MountedSection> {
  const mounted = renderSection(id);
  await act(async () => {
    mounted.bridge.scenarioEngine?.advance(500);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
  expect(mounted.container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  return mounted;
}

describe("a degraded transition that settles no read", () => {
  it.each(["members", "channels"] as const)(
    "raises and clears the %s warning on the store's own transition",
    async (id) => {
      // The defect: both sections sampled `snapshot().degradedCause` in a render
      // body and subscribed only to their own model, so a store entering its
      // degraded state without that read settling — a sequence gap in an unrelated
      // partition, a closed subscription — moved the flag and re-rendered nothing.
      // The warning stayed absent, and after a re-pull it stayed on screen.
      const { container, sessionStore } = await sectionWithItsReadSettled(id);
      const selector = DEGRADED_LINE_SELECTOR[id] ?? "";
      expect(container.querySelector(selector)).toBeNull();

      act(() => {
        sessionStore.markDegraded("subscription-closed");
      });
      expect(container.querySelector(selector)).not.toBeNull();

      act(() => {
        // The re-pull, which is the one thing that clears the sticky flag.
        sessionStore.initialise({ cursor: 1, entities: [], participantJoinLog: [] });
      });
      expect(container.querySelector(selector)).toBeNull();
    },
  );

  it.each(["members", "channels"] as const)(
    "negative control: the %s warning is absent while nothing has degraded",
    async (id) => {
      // Without this, the case above would pass over a section that rendered its
      // warning unconditionally — which would tell a person their view is behind
      // for the whole life of every healthy session.
      const { container } = await sectionWithItsReadSettled(id);
      expect(container.querySelector(DEGRADED_LINE_SELECTOR[id] ?? "")).toBeNull();
    },
  );
});
