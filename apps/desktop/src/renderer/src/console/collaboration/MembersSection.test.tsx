// What the sidebar's members section actually puts on screen.
//
// The section is a composition, and the property worth asserting is that it is a
// composition of MORE THAN ONE body: the roster answers who is here, the
// membership ledger answers on what terms, and a section that rendered only the
// first would answer half the question the sidebar's own label asks. Driven
// through the real seat registry rather than by rendering the component directly,
// because what the sidebar mounts is the descriptor's renderer and that is the
// path a regression would take.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { SessionStore } from "../store/index.js";
import {
  sidebarSectionRegistry,
  type SidebarSectionContext,
  type SidebarSectionId,
} from "../seats/index.js";
import { registerCollaborationSections } from "./sections.js";

const SESSION_ID = "session-members-section";

function contextForSection(): SidebarSectionContext {
  return {
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    bridge: createFixtureBridge({
      scenario: {
        id: "collaboration-members-section-test",
        label: "The members section, with nothing scripted",
        purpose: "Drives the section body the sidebar mounts.",
        sessionId: SESSION_ID,
        participantIdsInJoinOrder: [],
        beats: [],
        replies: [],
        startedAtIso: "2026-01-01T10:05:00.000Z",
      },
    }),
    openPane: () => undefined,
    isOpen: true,
  };
}

function renderSection(id: SidebarSectionId): HTMLElement {
  registerCollaborationSections();
  const renderSectionBody = sidebarSectionRegistry.descriptorFor(id)?.render;
  expect(renderSectionBody).toBeDefined();
  return render(<>{renderSectionBody?.(contextForSection())}</>).container;
}

describe("the members section's bodies", () => {
  it("renders the roster and the membership ledger, in that order", () => {
    const container = renderSection("members");
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
    const container = renderSection("members");
    expect(container.querySelector(".meridian-members .meridian-invites")).not.toBeNull();
  });

  it("negative control: the channels section carries neither", () => {
    // Without this, the two cases above would pass over a registry that rendered
    // one body into every section it holds.
    const container = renderSection("channels");
    expect(container.querySelector(".meridian-members")).toBeNull();
    expect(container.querySelector(".meridian-roster")).toBeNull();
  });
});
