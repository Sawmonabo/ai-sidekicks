// The card's identity-and-lifecycle half, which is a different subject from its
// binding half and now has its own file.
//
// `AgentCard.test.tsx` is about keeping the EFFECTIVE line apart from the PENDING
// one — five suites, all of them about the provider axes. This is about what the
// roster reply says regarding the agent's own row rather than its binding, which is
// exactly the distinction the card draws by putting the instant in the head instead
// of on the effective line. Splitting it out also keeps that file inside the module
// budget rather than pushing it past it with an unrelated sixth suite.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentCard } from "./AgentCard.js";
import { formatDateTime } from "../primitives/index.js";
import type { AgentRosterEntry } from "../bridge/index.js";

const ATTACHED_AT = "2026-03-04T08:15:00.000Z";

const RUNNING: AgentRosterEntry = {
  agentId: "agent-scout",
  name: "Scout",
  state: "ready",
  driverName: "claude",
  modelId: "claude-sonnet",
};

describe("agent card — the row's own lifecycle", () => {
  it("says when the roster row was created", () => {
    // Carried on `AgentRosterEntry` and rendered nowhere, so a roster of several
    // agents gave no way to tell the one attached this morning from the one that has
    // been in the session since it opened.
    const { container } = render(<AgentCard agent={{ ...RUNNING, createdAt: ATTACHED_AT }} />);

    const created = container.querySelector(".meridian-agent-card__created");
    expect(created?.textContent ?? "").toContain(formatDateTime(ATTACHED_AT));
    // The formatted reading hides nothing: the exact wire value rides `title`.
    expect(created?.querySelector(".meridian-figure--wire")?.getAttribute("title")).toBe(
      ATTACHED_AT,
    );
  });

  it("keeps the instant out of the effective binding line", () => {
    // The effective line's members are all provider axes. An instant sitting among
    // them would read as one more axis of the binding rather than as a fact about
    // the row, which is why it shares the head with the state chip instead.
    const { container } = render(<AgentCard agent={{ ...RUNNING, createdAt: ATTACHED_AT }} />);

    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).not.toContain(formatDateTime(ATTACHED_AT));
    expect(container.querySelector(".meridian-agent-card__head")?.textContent ?? "").toContain(
      formatDateTime(ATTACHED_AT),
    );
  });

  it("negative control: a roster row carrying no instant prints no created line", () => {
    // Without this, the cases above would pass over a card that stamped every agent
    // with an instant the console had invented.
    const { container } = render(<AgentCard agent={RUNNING} />);

    expect(container.querySelector(".meridian-agent-card__created")).toBeNull();
    expect(container.textContent ?? "").toContain("Scout");
  });
});
