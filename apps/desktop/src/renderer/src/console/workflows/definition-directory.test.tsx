// The enumeration has four endings and more than one page, and a surface has to be
// able to tell all of it apart.
//
// The settlement cases drive a REAL growth port — the fixture's over a scenario that
// scripts what the case is about, or the refusing one — rather than a promise shaped
// like one. The paging cases cannot: the scenario engine matches a scripted reply on
// the call name alone, so one scenario can serve exactly one page and a second is
// unscriptable there. They therefore answer from the real port with one method
// replaced, the shape `frame/session-directory.test.tsx` already uses to count reads
// — the value returned is still the registered one, so a page this fixture serves is
// a page the wire could send.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort, growthUnavailable } from "../bridge/growth-port.js";
import type { ConsoleScenario, ScenarioReply } from "../bridge/scenario.js";
import type { WireErrorEnvelope } from "../../../../shared/wire-errors.js";
import type { WorkflowDefinitionRow } from "./DefinitionsBrowser.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectoryState,
} from "./definition-directory.js";

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";
const PROBE_PARTICIPANT_ID = "019b7a12-0280-79a4-8110-cca0117a0401";

/** The continuation token the first page below hands back. */
const SECOND_PAGE_CURSOR = "definitions-page-2";

/** The refusal the scenario below scripts, in the envelope a daemon sends. */
const SCRIPTED_DAEMON_REFUSAL: WireErrorEnvelope = {
  code: "workflow.session_not_found",
  message: "No session with that id is open on this node.",
};

/** One settled page, derived from the port's own answer rather than restated. */
type SettledDefinitionPage = Awaited<ReturnType<GrowthPort["workflowDefinitionList"]>>;

function definition(id: string): WorkflowDefinitionRow {
  return {
    id,
    name: `Definition ${id}`,
    scope: "session",
    scopeRef: PROBE_SESSION_ID,
    latestVersionNumber: 1,
    latestWorkflowVersionId: `${id}-version-1`,
    contentHash: `b3:${id}`,
    resolvesAtThisContext: false,
    createdAt: "2026-01-01T10:00:00.000Z",
  };
}

/**
 * A scenario answering the enumeration one way, and playing no beats.
 *
 * No beats: this hook never reads the event stream, and beats would have to be held to
 * the wire-truth layer for facts no case here asserts.
 */
function scenarioAnsweringTheEnumeration(replies: readonly ScenarioReply[]): ConsoleScenario {
  return {
    id: "definition-directory-probe",
    label: "Definition directory probe",
    purpose: "Answers the definition enumeration one way, so one settlement is observable.",
    sessionId: PROBE_SESSION_ID,
    participantIdsInJoinOrder: [PROBE_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T12:00:00.000Z",
    beats: [],
    replies,
  };
}

/** The real port with the enumeration answered per cursor, and nothing else changed. */
function pagedGrowthPort(
  answerFor: (cursor: string | undefined) => SettledDefinitionPage,
): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowDefinitionList: async (request) => answerFor(request.cursor),
  };
}

/** Two pages, the first handing back the cursor that reaches the second. */
function twoPagePort(secondPageIds: readonly string[] = ["third", "fourth"]): GrowthPort {
  return pagedGrowthPort((cursor) =>
    cursor === undefined
      ? {
          status: "served",
          value: {
            definitions: [definition("first"), definition("second")],
            nextCursor: SECOND_PAGE_CURSOR,
          },
        }
      : { status: "served", value: { definitions: secondPageIds.map(definition) } },
  );
}

function DirectoryProbe(props: {
  readonly growth: GrowthPort;
  readonly sessionId: string | undefined;
  readonly onObserve: (directory: WorkflowDefinitionDirectory) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowDefinitionDirectory(props.growth, props.sessionId));
  return <></>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function observeDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowDefinitionDirectory[] {
  const observed: WorkflowDefinitionDirectory[] = [];
  render(
    <DirectoryProbe
      growth={growth}
      sessionId={sessionId}
      onObserve={(directory) => {
        observed.push(directory);
      }}
    />,
  );
  return observed;
}

function latest(observed: readonly WorkflowDefinitionDirectory[]): WorkflowDefinitionDirectory {
  const directory = observed.at(-1);
  if (directory === undefined) {
    throw new Error("the probe never rendered, so there is nothing to read");
  }
  return directory;
}

function lastState(
  observed: readonly WorkflowDefinitionDirectory[],
): WorkflowDefinitionDirectoryState {
  return latest(observed).state;
}

function definitionIds(state: WorkflowDefinitionDirectoryState): readonly string[] {
  return state.status === "served" ? state.definitions.map((row) => row.id) : [];
}

/** Press the continuation the surface would offer, and let its page settle. */
async function continueReading(observed: readonly WorkflowDefinitionDirectory[]): Promise<void> {
  await act(async () => {
    latest(observed).continueReading();
    await Promise.resolve();
  });
}

describe("useWorkflowDefinitionDirectory — one read, four answers", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where no session is in scope", () => {
    // `unasked` and never `reading`: a spinner over an address that names no session
    // would promise an answer that is never coming.
    expect(lastState(observeDirectory(createRefusingGrowthPort(), undefined)).status).toBe(
      "unasked",
    );
  });

  it("starts as a read in flight and settles on what the scenario serves", async () => {
    // A scenario that scripts nothing is served EMPTY rather than refused: an
    // enumeration has an empty form and it is a real answer about this context.
    const growth = createFixtureBridge({ scenario: scenarioAnsweringTheEnumeration([]) }).growth;

    const observed = observeDirectory(growth, PROBE_SESSION_ID);
    // The state after the mount and before the answer. The first observation is the
    // pre-effect `unasked` default, which says nothing about what the hook asked.
    expect(lastState(observed).status).toBe("reading");

    await settle();
    // The control for the refusal cases below: a hook that refused every read would
    // satisfy them and would replace every served answer with a refusal too.
    expect(lastState(observed).status).toBe("served");
  });

  it("settles a scripted daemon refusal as unavailable, carrying the wire's own code", async () => {
    // The negative control is the assertion itself: over the `.then`-only hook this
    // read replaced, the rejection was unhandled and the last state observed here was
    // `reading` — permanently, for the life of the window.
    const observed = observeDirectory(
      createFixtureBridge({
        scenario: scenarioAnsweringTheEnumeration([
          { call: "workflow.definitionList", refusal: SCRIPTED_DAEMON_REFUSAL },
        ]),
      }).growth,
      PROBE_SESSION_ID,
    );

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).toBe(SCRIPTED_DAEMON_REFUSAL.code);
      expect(settled.refusal.detail).toBe(SCRIPTED_DAEMON_REFUSAL.message);
    }
    expect(observed.map((directory) => directory.state.status)).not.toContain("served");
  });

  it("carries the port's own refusal when no wire is registered", async () => {
    const observed = observeDirectory(createRefusingGrowthPort(), PROBE_SESSION_ID);

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      // The refusal names who owes the wire. A boolean here would leave the surface to
      // invent the sentence, which is how two answers to one question start.
      expect(settled.refusal.code).toBe("wire-unregistered");
      expect(settled.refusal.detail).toContain("Not checked");
    }
  });
});

describe("useWorkflowDefinitionDirectory — the pages beyond the first", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the daemon's cursor and appends the page it reaches, in order", async () => {
    // The negative control for the whole continuation: over the hook that discarded
    // `nextCursor` this list stopped at two rows with nothing on screen saying there
    // were more — the definitions past the first page were unreachable, not unshown.
    const observed = observeDirectory(twoPagePort(), PROBE_SESSION_ID);
    await settle();
    expect(definitionIds(lastState(observed))).toStrictEqual(["first", "second"]);

    await continueReading(observed);

    expect(definitionIds(lastState(observed))).toStrictEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("marks the continuation in flight, distinctly from the first read", async () => {
    // A wait ON pages already held is a different fact from a wait FOR the first page:
    // the rows stay on screen through one and there are none to show through the other.
    const observed = observeDirectory(twoPagePort(), PROBE_SESSION_ID);
    await settle();

    act(() => {
      latest(observed).continueReading();
    });

    const inFlight = lastState(observed);
    expect(inFlight.status).toBe("served");
    if (inFlight.status === "served") {
      expect(inFlight.continuation).toStrictEqual({
        status: "reading",
        cursor: SECOND_PAGE_CURSOR,
      });
      // The rows held are not withdrawn while the next page arrives.
      expect(definitionIds(inFlight)).toStrictEqual(["first", "second"]);
    }
    await settle();
  });

  it("holds no cursor once the daemon serves a page without one", async () => {
    const observed = observeDirectory(twoPagePort(), PROBE_SESSION_ID);
    await settle();

    await continueReading(observed);

    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.continuation).toStrictEqual({ status: "exhausted" });
    }
  });

  it("negative control: a single-page answer offers no continuation at all", async () => {
    // Without this, a hook that reported `available` unconditionally would pass every
    // case above — and a surface would render a control that fetched one page forever.
    const observed = observeDirectory(
      pagedGrowthPort(() => ({ status: "served", value: { definitions: [definition("only")] } })),
      PROBE_SESSION_ID,
    );

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.continuation).toStrictEqual({ status: "exhausted" });
    }
  });

  it("keeps the pages already held when a continuation is refused", async () => {
    const observed = observeDirectory(
      pagedGrowthPort((cursor) =>
        cursor === undefined
          ? {
              status: "served",
              value: {
                definitions: [definition("first"), definition("second")],
                nextCursor: SECOND_PAGE_CURSOR,
              },
            }
          : growthUnavailable("workflowDefinitionList"),
      ),
      PROBE_SESSION_ID,
    );
    await settle();

    await continueReading(observed);

    const settled = lastState(observed);
    // The whole directory is NOT unavailable: the rows on screen were served and are
    // still true, and withdrawing them would be the console withdrawing a list the
    // daemon never withdrew.
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(definitionIds(settled)).toStrictEqual(["first", "second"]);
      expect(settled.continuation.status).toBe("unavailable");
      if (settled.continuation.status === "unavailable") {
        expect(settled.continuation.refusal.code).toBe("wire-unregistered");
        // The cursor survives the refusal, so the same ask is what a person retries.
        expect(settled.continuation.cursor).toBe(SECOND_PAGE_CURSOR);
      }
    }
  });

  it("never shows one definition twice when two pages overlap", async () => {
    // The wire guarantees no disjointness a console may rely on: a definition authored
    // between two reads shifts the window. A row rendered twice is also two React
    // children carrying one key.
    const observed = observeDirectory(twoPagePort(["second", "third"]), PROBE_SESSION_ID);
    await settle();

    await continueReading(observed);

    expect(definitionIds(lastState(observed))).toStrictEqual(["first", "second", "third"]);
  });
});
