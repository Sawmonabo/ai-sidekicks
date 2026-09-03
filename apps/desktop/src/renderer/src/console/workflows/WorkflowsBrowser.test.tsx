// What the surface wears for each of the enumeration's answers.
//
// The mapping is this component's whole job — one outcome in, one chrome and one set
// of groups out — so every case drives the REAL growth port and reads the rendered
// markup, rather than asserting against the props it happened to pass down.
//
// The refusal case is the one worth stating twice. A refusal attached to each group
// left every group rendering the refusal AND `No <scope> definitions` under it, which
// turns one failed read into three asserted empty results; the served-empty case
// beside it is what makes that assertion bite, because it shows those very lines are
// exactly what a real empty answer renders.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type GrowthPort } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { ChatStartSlot } from "./ChatStartSlot.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";
import type { WorkflowDefinitionRow } from "./DefinitionsBrowser.js";

// Spied, never replaced, `ConsoleRoot.test.tsx`'s instrument: the start slot carries
// no body anywhere in this repository, so what the browser handed it reaches no
// rendered markup and there is no other way to read it back. The real wrapper still
// renders, which is why the reserved area is still assertable beside it.
vi.mock(import("./ChatStartSlot.js"), { spy: true });

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** The continuation token the paged case below hands back. */
const SECOND_PAGE_CURSOR = "definitions-page-2";

/** One definition, as the enumeration carries it. */
const SERVED_DEFINITION: WorkflowDefinitionRow = {
  id: "release-checklist",
  name: "Release checklist",
  scope: "session",
  scopeRef: PROBE_SESSION_ID,
  latestVersionNumber: 3,
  latestWorkflowVersionId: "release-checklist-version-3",
  contentHash: "b3:0f1e2d",
  resolvesAtThisContext: true,
  createdAt: "2026-01-01T10:00:00.000Z",
};

/** One settled page, derived from the port's own answer rather than restated. */
type SettledDefinitionPage = Awaited<ReturnType<GrowthPort["workflowDefinitionList"]>>;

/** The real port answering the enumeration one way, and nothing else changed. */
function portAnswering(page: SettledDefinitionPage): GrowthPort {
  return { ...createRefusingGrowthPort(), workflowDefinitionList: async () => page };
}

/**
 * The browser under the announcer its one caller mounts it inside.
 *
 * The destination renders it within the window's live announcer, and the browser now
 * speaks its own settlement, so a harness without one would be testing a mount the
 * console does not make — `useAnnounce` throws outside its provider rather than
 * falling silently back to a region invented at the moment something spoke.
 */
function renderBrowser(growth: GrowthPort): HTMLElement {
  return render(
    <LiveAnnouncerProvider>
      <WorkflowsBrowser growth={growth} sessionId={PROBE_SESSION_ID} />
    </LiveAnnouncerProvider>,
  ).container;
}

/** The browser again, with a handle for re-rendering the same element. */
function renderBrowserTwice(growth: GrowthPort): {
  readonly container: HTMLElement;
  readonly rerender: () => void;
} {
  const element = (
    <LiveAnnouncerProvider>
      <WorkflowsBrowser growth={growth} sessionId={PROBE_SESSION_ID} />
    </LiveAnnouncerProvider>
  );
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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function scopeHeadings(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-workflow__scope-heading")].map(
    (heading) => heading.textContent ?? "",
  );
}

/**
 * The "there is none" line each SCOPE GROUP rendered.
 *
 * Scoped to the groups rather than to the surface, because the surface also mounts the
 * reserved conversational-start slot, whose own absence is a true statement about a
 * body no plan has authored yet and has nothing to do with what the read found.
 */
function emptyGroupTitles(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-workflow__scope .meridian-nothing--empty")].map(
    (nothing) => nothing.textContent ?? "",
  );
}

describe("the workflows browser — what one outcome becomes on screen", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a refused enumeration as one refusal, with no group claiming to be empty", async () => {
    const container = renderBrowser(createRefusingGrowthPort());

    await settle();

    expect(container.textContent).toContain("wire-unregistered");
    // No groups at all. The read produced no list to group, and a group rendered under
    // a refusal asserts an answer about its scope that the daemon never gave.
    expect(scopeHeadings(container)).toStrictEqual([]);
    expect(emptyGroupTitles(container)).toStrictEqual([]);
  });

  it("renders a served empty enumeration as three named groups that say so", async () => {
    // The control that makes the case above bite: these are the very lines the old
    // mapping rendered underneath the refusal, so their absence there is a real
    // difference rather than a component that renders nothing in both states.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [] } }),
    );

    await settle();

    expect(scopeHeadings(container)).toStrictEqual(["session", "project", "shared"]);
    expect(emptyGroupTitles(container).join(" ")).toContain("No session definitions.");
  });

  it("reads as a wait for every scope while the first page is in flight", async () => {
    // One read serves all three scopes, so a wait DOES belong to all three — which is
    // the axis on which a refusal differs, and why only one of them distributes.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [] } }),
    );

    expect(container.querySelectorAll(".meridian-nothing--not-loaded")).toHaveLength(3);
    expect(emptyGroupTitles(container)).toStrictEqual([]);

    await settle();
  });

  it("shows the rows a served page carried", async () => {
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [SERVED_DEFINITION] } }),
    );

    await settle();

    expect(container.textContent).toContain("Release checklist");
  });
});

describe("the workflows browser — the handle to the next page", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers the continuation while the daemon hands back a cursor", async () => {
    const container = renderBrowser(
      portAnswering({
        status: "served",
        value: { definitions: [SERVED_DEFINITION], nextCursor: SECOND_PAGE_CURSOR },
      }),
    );

    await settle();

    expect(container.querySelector(".meridian-definitions-continuation button")?.textContent).toBe(
      "Show more definitions",
    );
  });

  it("negative control: no cursor, no control", async () => {
    // Absent, not disabled. Without this the case above would pass over a browser that
    // offered the handle unconditionally, and pressing it would re-read one page.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [SERVED_DEFINITION] } }),
    );

    await settle();

    expect(container.querySelector(".meridian-definitions-continuation")).toBeNull();
  });
});

describe("the workflows browser — the session it hands the conversational start", () => {
  afterEach(() => {
    cleanup();
    // By name rather than `clearAllMocks`, so a case reads only the render it made.
    vi.mocked(ChatStartSlot).mockClear();
  });

  /** The sessions the port was actually asked about, in the order it was asked. */
  function recordingPort(readSessions: string[]): GrowthPort {
    return {
      ...createRefusingGrowthPort(),
      workflowDefinitionList: async (request) => {
        readSessions.push(request.sessionId);
        return { status: "served", value: { definitions: [] } };
      },
    };
  }

  it("hands the start the same session it read the enumeration under", async () => {
    const readSessions: string[] = [];
    renderBrowser(recordingPort(readSessions));

    await settle();

    // Both halves off the real thing: the left is what the port was asked, the right
    // is what the mount received. A browser that dropped the session would still read
    // the enumeration and hand the start nothing, and only the right half would move.
    expect(readSessions).toStrictEqual([PROBE_SESSION_ID]);
    expect(vi.mocked(ChatStartSlot).mock.calls[0]?.[0]).toStrictEqual({
      sessionId: PROBE_SESSION_ID,
    });
  });

  it("hands over the same nothing it read under, where no session is in scope", async () => {
    // A bare rail address puts no question — the enumeration's request carries a
    // required session id — and the mount is told exactly that rather than being
    // handed a key that was quietly dropped.
    const readSessions: string[] = [];
    render(
      <LiveAnnouncerProvider>
        <WorkflowsBrowser growth={recordingPort(readSessions)} sessionId={undefined} />
      </LiveAnnouncerProvider>,
    );

    await settle();

    expect(readSessions).toStrictEqual([]);
    expect(vi.mocked(ChatStartSlot).mock.calls[0]?.[0]).toStrictEqual({ sessionId: undefined });
  });

  it("negative control: the wrapper really rendered, so the cases above are not vacuous", async () => {
    // The spy would record a call for a mount that was composed and never rendered.
    // This reads the wrapper's own reserved copy off the markup instead.
    const container = renderBrowser(recordingPort([]));

    await settle();

    expect(container.textContent ?? "").toContain("the composer's own affordance");
  });
});

describe("what the definitions browser says out loud", () => {
  afterEach(() => {
    cleanup();
  });

  it("announces the enumeration's settlement once, with what it read", async () => {
    // The list lands without moving focus, so before this a screen reader heard which
    // session came into scope and that the RUNS list had settled, and never that the
    // definition list had.
    const { container, rerender } = renderBrowserTwice(
      portAnswering({ status: "served", value: { definitions: [SERVED_DEFINITION] } }),
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
