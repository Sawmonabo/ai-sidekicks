// The console's own body for the human-form slot, over the wait the fixture parks.
//
// WHAT THESE CASES ARE ABOUT. That a phase parked on a person is ANSWERABLE from the
// pane that shows it: the prompt the run read carried is on screen, the schema draws
// its controls, a schema outside the drawn set opens the JSON editor rather than a
// refusal, the press composes the registered submit with the revision the form was
// composed against, and every refusal — the daemon's, the port's, and this surface's
// own — renders as itself.
//
// THE MOUNT IS DERIVED FROM THE FIXTURE, never written out. `humanFormMountFor` is what
// the pane resolves a wait through, so a mount built by hand here would keep passing the
// day the run read stopped carrying a prompt or a schema — which is exactly the state
// this lane closed. The negative control at the end asserts the fixture really does
// carry both, so the first case cannot be vacuous.
//
// THE PORT IS THE CONSOLE'S OWN. The refusing port and the fixture bridge, spread with
// the one operation a case is about — the idiom `run-control-dispatch.test-support.tsx`
// states: a stand-in would agree with whatever the hook did with it, and the
// unregistered-wire arm in particular is only meaningful because it is the refusal the
// real port composes.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SidekicksBridgeProvider } from "../../../../bridge/BridgeProvider.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
  type GrowthPort,
} from "../../../../bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../../../../bridge/scenarios/workflows.js";
import { WORKFLOWS_PARKED_RUN } from "../../../../bridge/scenarios/workflow-fixture-runs.js";
import type { WireErrorEnvelope } from "../../../../core/index.js";
import { settle } from "../../../workflows-probe.test-support.js";
import { humanFormMountFor } from "../human-form-selection.js";
import { HumanFormSlot } from "./HumanFormSlot.js";
import type { HumanFormMount } from "./human-form-mount.js";

afterEach(() => {
  cleanup();
});

/** The refusal a daemon raises on a submission composed against a stale revision. */
const STALE_REVISION_REFUSAL: WireErrorEnvelope = {
  code: "workflow.form_revision_stale",
  message: "Somebody else answered this phase first; re-read the form before answering.",
};

/** What one case asked the port, and the bridge the slot read it through. */
interface SubmitProbe {
  readonly bridge: ConsoleBridge;
  readonly requests: Parameters<GrowthPort["workflowHumanFormSubmit"]>[0][];
}

/**
 * The fixture bridge with its submit replaced by one the case can watch or refuse.
 *
 * Built ONCE per case rather than inside a render: the dispatch holds its outcome
 * against the port's own identity, so a port composed on each render would re-seed that
 * state every time React re-rendered the form.
 */
function bridgeWatchingSubmits(refusal?: WireErrorEnvelope): SubmitProbe {
  const fixture = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const requests: Parameters<GrowthPort["workflowHumanFormSubmit"]>[0][] = [];
  const growth: GrowthPort = {
    ...fixture.growth,
    workflowHumanFormSubmit: async (request) => {
      requests.push(request);
      if (refusal !== undefined) {
        // Thrown rather than returned: a scripted daemon refusal rejects, and the live
        // seam will reject with the same shape once the wire lands.
        throw refusal;
      }
      return {
        status: "served",
        value: {
          phaseId: request.phaseId,
          phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
          outputCount: 1,
          submittedAt: "2026-01-01T10:02:00.000Z",
        },
      };
    },
  };
  return { bridge: { ...fixture, growth }, requests };
}

/** One submit the case settles by hand, and what it was asked. */
interface HeldSubmit extends SubmitProbe {
  readonly serve: () => void;
}

/**
 * A bridge whose submit stays in flight until the case settles it.
 *
 * The window between the press and the answer is where the waiting state and the
 * single-flight refusal both live, and a port that answered on the calling turn would
 * close it before either could be observed — `run-control-dispatch.test-support.tsx`'s
 * reading, at this family's other dispatch.
 */
function bridgeHoldingSubmits(): HeldSubmit {
  const fixture = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const requests: Parameters<GrowthPort["workflowHumanFormSubmit"]>[0][] = [];
  let serveHeld: (() => void) | undefined;
  const growth: GrowthPort = {
    ...fixture.growth,
    workflowHumanFormSubmit: async (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        serveHeld = () => {
          resolve({
            status: "served",
            value: {
              phaseId: request.phaseId,
              phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
              outputCount: 2,
              submittedAt: "2026-01-01T10:03:00.000Z",
            },
          });
        };
      });
    },
  };
  return { bridge: { ...fixture, growth }, requests, serve: () => serveHeld?.() };
}

/** The fixture's own waiting phase, resolved the way the run pane resolves it. */
function fixtureWaitMount(): HumanFormMount {
  const wait = WORKFLOWS_PARKED_RUN.phaseStates
    .map((phase) => humanFormMountFor(WORKFLOWS_PARKED_RUN.workflowRunId, phase))
    .find((mount) => mount !== undefined);
  if (wait === undefined) {
    throw new Error("the workflows fixture parks no addressable phase on a person");
  }
  return wait;
}

/** The slot with the shell inside it, under a bridge the case supplies. */
function renderSlot(mount: HumanFormMount | undefined, bridge?: ConsoleBridge): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider
      bridge={bridge ?? createFixtureBridge({ scenario: WORKFLOWS_SCENARIO })}
    >
      <HumanFormSlot phase={mount} />
    </SidekicksBridgeProvider>,
  );
  return container;
}

/** Press the one act the form offers. */
function pressSubmit(): void {
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
}

describe("a waiting phase is answerable where the pane shows it", () => {
  it("renders the prompt the run read carried and the controls its schema draws", () => {
    const container = renderSlot(fixtureWaitMount());
    expect(container.querySelector(".meridian-schema-answer__prompt")?.textContent).toBe(
      fixtureWaitMount().prompt,
    );
    // The three drawn kinds this fixture's schema names, read as controls rather than
    // as text: a form that rendered its schema as prose would pass a text assertion.
    expect(screen.getByLabelText(/Decision/u).tagName).toBe("SELECT");
    expect(screen.getByLabelText(/Notes/u).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText(/Post the outcome to the channel/u)).toHaveProperty(
      "type",
      "checkbox",
    );
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("opens the JSON editor for a schema outside the drawn set, and never a refusal", () => {
    // A.4's rule, at the surface a person actually meets: anything the mapper cannot
    // draw is answered as JSON with the mapper's own reason above it.
    const container = renderSlot({ ...fixtureWaitMount(), inputSchema: { type: "string" } });
    expect(container.querySelector(".meridian-schema-raw")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit answer" })).not.toBeNull();
  });

  it("says so where the run reported the park and not the question", () => {
    // The additive-optional arm: a daemon below the contract revision reports the wait
    // and carries no schema, so there is nothing to compose an answer against. Absent,
    // not disabled — the control is not offered at all.
    const { inputSchema: _unsent, ...withoutTheSchema } = fixtureWaitMount();
    const container = renderSlot(withoutTheSchema);
    expect(container.querySelector(".meridian-schema-form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("stands the reserved shell where no phase is waiting on a person", () => {
    const container = renderSlot(undefined);
    expect(container.querySelector(".meridian-schema-answer")).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});

describe("the press composes the registered submit", () => {
  it("carries the run, the phase and the revision the form was composed against", async () => {
    const probe = bridgeWatchingSubmits();
    const mount = fixtureWaitMount();
    renderSlot(mount, probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([
      {
        workflowRunId: mount.workflowRunId,
        phaseId: mount.phaseId,
        fields: {},
        // The fixture's fresh attempt reads `0`, which is the value a falsy
        // discriminator would drop and the one the daemon adjudicates against.
        expectedRevision: 0,
      },
    ]);
  });

  it("carries a revision of one where that is what the phase reported", async () => {
    // The negative control on the case above: without it, a submit that hardcoded the
    // zero every fixture wait carries would pass it. This mount is the same wait after
    // an accepted submission, which is the state a retry is composed against.
    const probe = bridgeWatchingSubmits();
    renderSlot({ ...fixtureWaitMount(), formRevision: 1 }, probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.expectedRevision).toBe(1);
  });

  it("settles on what the daemon answered", async () => {
    const probe = bridgeWatchingSubmits();
    renderSlot(fixtureWaitMount(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(screen.getByText(/The daemon recorded this answer/u)).not.toBeNull();
  });
});

describe("every refusal renders as the refusal it is", () => {
  it("renders the daemon's own code and sentence for a stale revision", async () => {
    const probe = bridgeWatchingSubmits(STALE_REVISION_REFUSAL);
    const container = renderSlot(fixtureWaitMount(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    // The daemon's message is the primary text, verbatim: it is the only account of
    // what happened to an answer somebody had already typed.
    expect(screen.getByText(STALE_REVISION_REFUSAL.message)).not.toBeNull();
    expect(container.textContent ?? "").toContain(STALE_REVISION_REFUSAL.code);
  });

  it("renders the port's own refusal where the wire is unregistered", async () => {
    // The build's true answer rather than a simulated success: the fixture serves the
    // run read and settles no mutation, so the press reaches the port and the port says
    // what it says. A mount site that composed its own sentence here would be asserting
    // a wire fact nobody checked.
    const container = renderSlot(fixtureWaitMount());
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
  });

  it("refuses an answer that is not a set of named values without spending a call", async () => {
    const probe = bridgeWatchingSubmits();
    const container = renderSlot(
      { ...fixtureWaitMount(), inputSchema: { type: "string" } },
      probe.bridge,
    );
    const editor = container.querySelector("textarea");
    if (editor === null) {
      throw new Error("the raw arm rendered no editor");
    }
    // Legal JSON and an illegal answer: the request's `fields` is an object, and an
    // array cast into it would be rejected after the round trip rather than before it.
    fireEvent.change(editor, { target: { value: "[1, 2]" } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toStrictEqual([]);
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
  });

  it("negative control: the same editor with an object answer does spend one", async () => {
    // Without this, the case above would pass over a form that never called the port at
    // all — including one whose submit control did nothing.
    const probe = bridgeWatchingSubmits();
    const container = renderSlot(
      { ...fixtureWaitMount(), inputSchema: { type: "string" } },
      probe.bridge,
    );
    const editor = container.querySelector("textarea");
    if (editor === null) {
      throw new Error("the raw arm rendered no editor");
    }
    fireEvent.change(editor, { target: { value: '{"decision":"approve"}' } });
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests.at(0)?.fields).toStrictEqual({ decision: "approve" });
  });
});

describe("an answer that is still with the daemon", () => {
  it("says so beside the control, and settles on the reply when it comes", async () => {
    const held = bridgeHoldingSubmits();
    const container = renderSlot(fixtureWaitMount(), held.bridge);
    await act(async () => {
      pressSubmit();
    });

    // Waiting on a round trip rather than working something out: the not-loaded shape
    // and not the computing one.
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();

    await act(async () => {
      held.serve();
    });
    await settle();

    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(screen.getByText(/2 outputs came of it/u)).not.toBeNull();
  });

  it("refuses a second press out loud rather than sending the answer twice", async () => {
    // The revision token refuses a duplicate at the far end, and a form that let one
    // through would report a stale-revision failure for an answer given once.
    const held = bridgeHoldingSubmits();
    const container = renderSlot(fixtureWaitMount(), held.bridge);
    await act(async () => {
      pressSubmit();
    });
    await act(async () => {
      pressSubmit();
    });

    expect(held.requests).toHaveLength(1);
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();

    // And the key goes back, so the next press after the answer lands is not refused.
    await act(async () => {
      held.serve();
    });
    await settle();
    await act(async () => {
      pressSubmit();
    });

    expect(held.requests).toHaveLength(2);
  });
});

describe("the mount the cases are driven from is the wire's own", () => {
  it("negative control: the fixture's waiting phase really carries a prompt and a schema", () => {
    // Without this, the first case would hold over a run read that carried neither —
    // the state this lane closed, where the form had nothing to draw and the slot said
    // the feature was unbuilt.
    const mount = fixtureWaitMount();
    expect(typeof mount.prompt).toBe("string");
    expect(mount.inputSchema).not.toBeUndefined();
    expect(mount.formRevision).toBe(0);
  });
});
