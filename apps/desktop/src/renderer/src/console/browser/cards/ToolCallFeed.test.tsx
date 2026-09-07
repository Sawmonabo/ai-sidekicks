// The tool-call feed's four arms, each of which says a different thing.
//
// Three of them are absences and they are deliberately NOT interchangeable: "nothing
// has been relayed" is not "the relay finished" and neither is "no agent has called a
// page tool". A component that folded any two would tell a person the agent is idle
// when the truth is that this window stopped being told.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { ToolCallFeed } from "./ToolCallFeed.js";
import type { RelayedToolCall, ToolCallReading } from "./tool-call-relay.js";

const RELAYED_CALL: RelayedToolCall = {
  toolCallId: "call-1",
  toolName: "browser_navigate",
  argumentsJson: '{"url":"https://example.test/"}',
  owningRunLabel: "Run 3",
};

function renderFeed(reading: ToolCallReading): void {
  render(<ToolCallFeed reading={reading} />);
}

describe("the pane's tool-call feed", () => {
  it("says nothing has been relayed, and does not claim the agent is idle", () => {
    renderFeed({ kind: "reading" });
    expect(screen.getByText("Tool calls not relayed")).toBeTruthy();
    expect(screen.queryByText("No tool calls yet")).toBeNull();
  });

  it("says the relay finished where the producer ended", () => {
    renderFeed({ kind: "ended" });
    expect(screen.getByText("Relay finished")).toBeTruthy();
    expect(screen.queryByText("Tool calls not relayed")).toBeNull();
  });

  it("renders the refusal it was handed rather than an absence", () => {
    renderFeed({
      kind: "refused",
      scope: "whole-answer",
      refusal: refuse("browser-tool-relay", "tool-relay-failed", "The relay stopped."),
    });
    expect(screen.getByText(/The relay stopped\./)).toBeTruthy();
    expect(screen.queryByText("No tool calls yet")).toBeNull();
  });

  it("says no call has been made where the relay is live and empty", () => {
    renderFeed({ kind: "served", calls: [] });
    expect(screen.getByText("No tool calls yet")).toBeTruthy();
  });

  it("renders a relayed call as awaiting adjudication, deriving no outcome", () => {
    renderFeed({ kind: "served", calls: [RELAYED_CALL] });
    expect(screen.getByText("browser_navigate")).toBeTruthy();
    expect(screen.getByText("Run 3")).toBeTruthy();
  });
});
