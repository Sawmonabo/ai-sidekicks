// The card's identity and lifecycle half: what the roster reply says about the agent's own row
// rather than its binding, which `AgentBindingCard.test.tsx` covers.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentBindingCard } from "./AgentBindingCard.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";
import { agentEntry } from "./agent-binding-column.test-support.js";

const ATTACHED_AT = "2026-03-04T08:15:00.000Z";

const RUNNING = agentEntry();

describe("agent card — the row's own lifecycle", () => {
  it("says when the roster row was created", () => {
    // `createdAt` is on `AgentListEntry`; without it a roster gives no way to tell a new agent
    // from one that has been in the session since it opened.
    const { container } = render(
      <AgentBindingCard agent={{ ...RUNNING, createdAt: ATTACHED_AT }} />,
    );

    const created = container.querySelector(".meridian-agent-card__created");
    expect(created?.textContent ?? "").toContain(formatDateTime(ATTACHED_AT));
    // The formatted reading hides nothing: the exact wire value rides `title`.
    expect(created?.querySelector(".meridian-figure--wire")?.getAttribute("title")).toBe(
      ATTACHED_AT,
    );
  });

  it("keeps the instant out of the effective binding line", () => {
    // The effective line's members are all provider axes; an instant among them would read as
    // one more axis of the binding.
    const { container } = render(
      <AgentBindingCard agent={{ ...RUNNING, createdAt: ATTACHED_AT }} />,
    );

    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).not.toContain(formatDateTime(ATTACHED_AT));
    expect(container.querySelector(".meridian-agent-card__head")?.textContent ?? "").toContain(
      formatDateTime(ATTACHED_AT),
    );
  });
});
