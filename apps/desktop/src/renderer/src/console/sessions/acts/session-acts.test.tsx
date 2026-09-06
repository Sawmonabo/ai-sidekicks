// The three ways in, driven against the scenario that scripts all of them.
//
// Every case here runs on the real fixture bridge playing `bring-your-history`, which
// is what makes them worth having: a stub could answer anything, and what these
// assert is that the SCENARIO reaches each arm — the join that lands, the join that
// refuses, the import that runs to its terminal frame, and the import the node holds
// no reader for. Ratified rule 8 for this lane is exactly that claim.

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BRING_YOUR_HISTORY_SCENARIO } from "../../bridge/scenarios/bring-your-history.js";
import { JoinSessionForm } from "./JoinSessionForm.js";
import { ProviderImportPanel } from "./ProviderImportPanel.js";
import { fixtureBridgeWithGrowth } from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";

/** The session the scenario plays — the one identifier its join answers for. */
const JOINABLE_SESSION_ID = BRING_YOUR_HISTORY_SCENARIO.sessionId;

function bridge(): ConsoleBridge {
  return fixtureBridgeWithGrowth(BRING_YOUR_HISTORY_SCENARIO, {});
}

/** Type into one of a form's fields, the way a person does. */
function fill(container: HTMLElement, labelText: string, value: string): void {
  const field = [...container.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith(labelText),
  );
  const input = field?.querySelector("input");
  if (input === null || input === undefined) {
    throw new Error(`no field labelled ${labelText}`);
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit(container: HTMLElement): void {
  const form = container.querySelector("form");
  act(() => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** The refusal code the surface rendered, or `undefined` where it rendered none. */
function refusalCode(container: HTMLElement): string | undefined {
  // The code rides the wire-figure span inside the refusal, which is the markup
  // `InlineRefusal` actually emits — read off the real component rather than off a
  // class this file wishes existed.
  return (
    container.querySelector(".meridian-refusal .meridian-figure--wire")?.textContent ?? undefined
  );
}

describe("joining a session", () => {
  it("will not put a join with a field still empty, and says which", () => {
    const { container } = render(<JoinSessionForm bridge={bridge()} onJoined={() => undefined} />);

    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("Both the session and the handle are needed.");
  });

  it("navigates to the session the daemon answered with", async () => {
    const joined: string[] = [];
    const { container } = render(
      <JoinSessionForm
        bridge={bridge()}
        onJoined={(sessionId) => {
          joined.push(sessionId);
        }}
      />,
    );

    fill(container, "Session", JOINABLE_SESSION_ID);
    fill(container, "Your handle", "sam");
    submit(container);

    await waitFor(() => {
      expect(joined).toStrictEqual([JOINABLE_SESSION_ID]);
    });
  });

  it("renders the daemon's own refusal for an identifier that resolves to nothing", async () => {
    const joined: string[] = [];
    const { container } = render(
      <JoinSessionForm
        bridge={bridge()}
        onJoined={(sessionId) => {
          joined.push(sessionId);
        }}
      />,
    );

    fill(container, "Session", "019b78c9-0a80-7b31-9c40-4f0a0b6d9999");
    fill(container, "Your handle", "sam");
    submit(container);

    await waitFor(() => {
      expect(refusalCode(container)).toBe("session.not_found");
    });
    // And it did NOT navigate. A form that both refused and navigated would put a
    // person in a session the daemon just said does not exist.
    expect(joined).toStrictEqual([]);
  });

  it("offers nothing while the list is degraded, and names the cause", () => {
    const { container } = render(
      <JoinSessionForm
        bridge={bridge()}
        onJoined={() => undefined}
        blockedReason="Not while the session stream closed."
      />,
    );

    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.textContent).toContain("Not while the session stream closed.");
  });
});

describe("importing a provider session", () => {
  it("runs the subscription to its terminal frame and renders the producer's words", async () => {
    const { container } = render(<ProviderImportPanel growth={bridge().growth} />);

    fill(container, "Provider", "claude");
    fill(container, "What to read", "~/.claude/threads/one.jsonl");
    submit(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Ended");
    });
    expect(container.textContent).toContain("complete");
    expect(container.textContent).toContain("61");
  });

  it("refuses a provider this node holds no reader for, and subscribes to nothing", async () => {
    const { container } = render(<ProviderImportPanel growth={bridge().growth} />);

    fill(container, "Provider", "a-provider-nobody-reads");
    fill(container, "What to read", "~/somewhere");
    submit(container);

    await waitFor(() => {
      expect(refusalCode(container)).toBe("session.import_provider_unsupported");
    });
    // The begin never settled, so no import id exists and the progress line is absent
    // entirely — "nothing was asked" rather than an empty reading of a subscription.
    expect(container.querySelector(".meridian-session-import__progress")).toBeNull();
  });
});
