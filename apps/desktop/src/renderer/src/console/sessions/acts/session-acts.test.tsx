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
import {
  fixtureBridgeWithGrowth,
  growthServing,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { settle } from "../../core/settle.test-support.js";
import type { ConsoleBridge, GrowthImportProgress } from "../../bridge/index.js";

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

  it("does not navigate when the form went away before the join settled", async () => {
    const joined: string[] = [];
    const { container, unmount } = render(
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
    // The whole window the defect lives in, and it is reached by ORDERING rather than
    // by a scripted delay: nothing has awaited since the press, so the reply's
    // continuation cannot have run, and the form is torn down underneath it.
    unmount();
    await settle();

    // A settlement that navigated here would drag a person who had left this
    // destination into a workspace they are no longer asking for.
    expect(joined).toStrictEqual([]);
  });

  it("navigates when the same join settles under a form still on screen — the control", async () => {
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
    await settle();

    // Which is what makes the case above a claim about the unmount rather than about
    // a join that never settled at all.
    expect(joined).toStrictEqual([JOINABLE_SESSION_ID]);
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

  it("keeps the control refused while the progress stream is still reading", async () => {
    const stream = heldProgressStream();
    const growth = fixtureBridgeWithGrowth(BRING_YOUR_HISTORY_SCENARIO, {
      providerSessionImportSubscribe: growthServing(stream.handle),
    }).growth;
    const { container } = render(<ProviderImportPanel growth={growth} />);

    fill(container, "Provider", "claude");
    fill(container, "What to read", "~/.claude/threads/one.jsonl");
    submit(container);
    await settle();

    // The begin has answered — the id exists and the stream has spoken once — and the
    // import is nowhere near done. A control re-enabled here would let a second submit
    // replace the id and orphan this reading with nothing on screen reporting it.
    expect(container.textContent).toContain("7");
    expect(submitControl(container).disabled).toBe(true);
    expect(container.textContent).toContain("The last import is still being read.");

    stream.end();
    await settle();

    // And the moment the producer stops, the form is a form again.
    expect(container.textContent).toContain("Ended");
    expect(submitControl(container).disabled).toBe(false);
  });
});

/** The panel's own submit control, which is the last button its form carries. */
function submitControl(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button.meridian-session-import__submit");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the import panel rendered no submit control");
  }
  return button;
}

/**
 * A progress stream that speaks once and then stays open until the case ends it.
 *
 * The scenario's own stream runs to its terminal frame on its own, which is right for
 * the case above and wrong for this one: what is asserted here is the state BETWEEN
 * the first frame and the last, and a stream that walks itself puts that moment where
 * the runtime decides rather than where the case does.
 */
function heldProgressStream(): {
  readonly handle: { readonly events: AsyncIterable<GrowthImportProgress>; close: () => void };
  readonly end: () => void;
} {
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    end: (): void => {
      end();
    },
    handle: {
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<GrowthImportProgress> {
          yield { importId: "held-import", turnsSeen: 7, state: "reading" };
          await ended;
        },
      },
      close: (): void => {
        end();
      },
    },
  };
}
