// What the definitions browser says out loud, on each arm and on the arm that used to
// be silent.
//
// The list lands without moving focus, so a settlement nobody can see has to be spoken
// or it did not happen. Three of these cases press the continuation and read what was
// said after it, which is what makes this the suite that owns the two-page port: the
// paging suite next door asks only whether the control is offered.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { growthUnavailable, type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { LiveAnnouncer } from "../primitives/live-announcer.js";
import type { WorkflowDefinitionRow } from "./definitions/definition-rows.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";
import {
  PROBE_SESSION_ID,
  SECOND_PAGE_CURSOR,
  definition,
  browserUnderAnnouncer,
  portAnswering,
  renderBrowser,
  settle,
  type SettledDefinitionPage,
} from "./WorkflowsBrowser.test-support.js";

/** A second definition, so a continuation that lands moves the count it reports. */
const SECOND_PAGE_DEFINITION: WorkflowDefinitionRow = {
  ...definition(),
  id: "deploy-checklist",
  name: "Deploy checklist",
  latestWorkflowVersionId: "deploy-checklist-version-3",
};

/** The browser again, with a handle for re-rendering the same element. */
function renderBrowserTwice(growth: GrowthPort): {
  readonly container: HTMLElement;
  readonly rerender: () => void;
} {
  const element = browserUnderAnnouncer(growth, PROBE_SESSION_ID);
  const { container, rerender } = render(element);
  return {
    container,
    rerender: () => {
      rerender(element);
    },
  };
}

/** What the window's polite live region is holding. */
function politeAnnouncement(container: HTMLElement): string {
  const region = container.querySelector<HTMLElement>('[data-live-region="polite"]');
  if (region === null) {
    throw new Error("no polite live region was mounted");
  }
  return region.textContent ?? "";
}

/**
 * The browser over an announcer whose every utterance is recorded.
 *
 * THE SENTENCES AND NOT THE REGION'S TEXT, because two of the claims below turn on
 * whether the browser SPOKE — and the announcer sheds a message identical to the one
 * it is already holding, so a second utterance of the same count leaves the region
 * reading exactly what a silent browser leaves it reading. The spy calls through, so
 * the region is still driven by the real announcer for the cases that read it.
 */
function renderBrowserRecordingSpeech(growth: GrowthPort): {
  readonly container: HTMLElement;
  readonly spokenSentences: readonly string[];
} {
  const announcer = new LiveAnnouncer({ clock: new ManualClock() });
  const spokenSentences: string[] = [];
  const speak = announcer.announce;
  vi.spyOn(announcer, "announce").mockImplementation((message, politeness) => {
    spokenSentences.push(message);
    speak(message, politeness);
  });
  const { container } = render(
    <LiveAnnouncerProvider announcer={announcer}>
      <WorkflowsBrowser growth={growth} sessionId={PROBE_SESSION_ID} />
    </LiveAnnouncerProvider>,
  );
  return { container, spokenSentences };
}

/**
 * A port whose first page hands back a cursor and whose second settles as given.
 *
 * The scenario engine matches a scripted reply on the call name alone, so a second
 * page is unscriptable there; this answers per cursor from the real port, the shape
 * `definition-directory.test.tsx` already uses.
 */
function twoPagePort(secondPage: SettledDefinitionPage): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowDefinitionList: async (request) =>
      request.cursor === undefined
        ? {
            status: "served",
            value: { definitions: [definition()], nextCursor: SECOND_PAGE_CURSOR },
          }
        : secondPage,
  };
}

/** Press "Show more definitions", without letting the page it asks for settle. */
function pressContinuation(container: HTMLElement): void {
  const control = container.querySelector<HTMLButtonElement>(
    ".meridian-definitions-continuation button",
  );
  if (control === null) {
    throw new Error("the browser offered no continuation to press");
  }
  act(() => {
    control.click();
  });
}

describe("what the definitions browser says out loud", () => {
  afterEach(() => {
    cleanup();
  });

  it("announces the enumeration's settlement once, with what it read", async () => {
    // The list lands without moving focus, so before this a screen reader heard which
    // session came into scope and that the RUNS list had settled, and never that the
    // definition list had.
    const { container, rerender } = renderBrowserTwice(
      portAnswering({ status: "served", value: { definitions: [definition()] } }),
    );

    await settle();

    expect(politeAnnouncement(container)).toBe("Definitions visible from this session: 1.");

    rerender();
    await settle();

    // Negative control: the same settlement re-rendered says nothing further. A repeat
    // would talk over the surface it just described.
    expect(politeAnnouncement(container)).toBe("Definitions visible from this session: 1.");
  });

  it("announces the refusal's own sentence when the enumeration refuses", async () => {
    const container = renderBrowser(createRefusingGrowthPort());

    await settle();

    // The daemon's own sentence, carried rather than paraphrased into an apology of
    // the console's own — which is the refusal's `detail`, the same member the banner
    // beside it renders.
    expect(politeAnnouncement(container)).toContain("is not registered on this build yet");
  });

  it("says nothing while a continuation is in flight, and the new count once it lands", async () => {
    // Pressing the control leaves the pages `served` and moves the CONTINUATION to
    // `reading`, which is a fresh state object carrying the old count — so the
    // settlement hook spoke that count again as a completed read, before the page it
    // was announcing had answered.
    const probe = renderBrowserRecordingSpeech(
      twoPagePort({ status: "served", value: { definitions: [SECOND_PAGE_DEFINITION] } }),
    );
    await settle();
    expect(probe.spokenSentences).toStrictEqual(["Definitions visible from this session: 1."]);

    pressContinuation(probe.container);

    expect(probe.spokenSentences).toStrictEqual(["Definitions visible from this session: 1."]);

    await settle();

    expect(probe.spokenSentences).toStrictEqual([
      "Definitions visible from this session: 1.",
      "Definitions visible from this session: 2.",
    ]);
  });

  it("announces a refused continuation with the refusal's own sentence", async () => {
    // The arm that was silent entirely: this function handed back the count for every
    // `served` directory, so the refusal appeared beside the rows and was spoken
    // nowhere — and a person who cannot see the surface was told the list had settled
    // at the size it had before they asked for more.
    const probe = renderBrowserRecordingSpeech(
      twoPagePort(growthUnavailable("workflowDefinitionList")),
    );
    await settle();
    pressContinuation(probe.container);
    await settle();

    // The SENTENCE and not the region, because the announcer holds the first message
    // for its own deadline and releases the queued second on the clock — which is its
    // behaviour and its test, not this browser's.
    expect(probe.spokenSentences.at(-1)).toContain("is not registered on this build yet");
  });

  it("negative control: a continuation that settles served says the count and not a refusal", async () => {
    // Without this, the case above passes for a browser that announced a refusal
    // whenever a continuation settled at all.
    const probe = renderBrowserRecordingSpeech(
      twoPagePort({ status: "served", value: { definitions: [SECOND_PAGE_DEFINITION] } }),
    );
    await settle();
    pressContinuation(probe.container);
    await settle();

    expect(probe.spokenSentences.at(-1)).toBe("Definitions visible from this session: 2.");
  });

  it("says nothing at all while the read is still in flight", async () => {
    // The third arm, and the one a settlement-keyed announcement most easily gets
    // wrong: `reading` is not a settlement, and announcing it would promise a result
    // and then never correct it if the read refused.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [] } }),
    );

    expect(politeAnnouncement(container)).toBe("");

    await settle();
  });
});
