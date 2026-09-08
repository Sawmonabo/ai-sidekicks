// What the registry read settles on, and what survives a seam that REJECTS.
//
// Two claims, and the second is the one that was wrong. The read is a growth-port
// call, and a growth call can finish four ways rather than two: served, refused, and
// — off the scripted-reply seam today and off the live seam the day the wire lands —
// thrown, carrying the daemon's own envelope verbatim. This module used to catch that
// with a bare `catch` and substitute a fixed `call-rejected` refusal, so a session
// that had gone away reached the surface as a generic seam failure with no remedy and
// no escalation keyed to it. `settleGrowthRead` is the console's one answer to that
// and it keeps the daemon's code, which is what the first describe asserts.
//
// The second describe is about the entry the contract registers, read through the
// real hook rather than restated: the row's disclosure panel names the tool's
// ARGUMENTS, and `workflow_start` is the shape that proves it — the panel used to
// list the schema's keywords, so neither `definitionName` nor `scope` appeared under
// the trigger that says "Input schema".

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../../../core/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { CallbackTools } from "./CallbackTools.js";
import { useCallbackToolRegistry } from "./callback-tool-registry.js";

const SESSION_ID = "session-callback-tool-registry";

/** The refusal a daemon that lost the session throws off this seam. */
const SESSION_GONE = refuse(
  "approvals",
  "session.not_found",
  "No session with that id is open on this node.",
);

/** The surface, mounted over one bridge and settled. */
function CallbackToolsProbe(props: { readonly bridge: ConsoleBridge }): React.JSX.Element {
  const registry = useCallbackToolRegistry(props.bridge, SESSION_ID);
  return <CallbackTools capability="declared" registry={registry} />;
}

async function mountSettled(bridge: ConsoleBridge): Promise<void> {
  render(<CallbackToolsProbe bridge={bridge} />);
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/**
 * Press the row's disclosure.
 *
 * The panel is unmounted while the disclosure is closed — which is the row's own
 * rule, and the reason a collapsed schema costs a reader nothing — so a case that
 * asserts about its contents has to open it the way a person does.
 */
async function openTheSchema(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Input schema" }));
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/** Each argument line's text, with the requirement marker spaced off the name. */
function argumentRows(): readonly string[] {
  return [...document.querySelectorAll(".meridian-callback-tools__schema-keys li")].map((row) =>
    [...row.children].map((part) => part.textContent).join(" "),
  );
}

describe("a read that rejected keeps what the other side said", () => {
  it("carries the daemon's own code rather than a fixed seam failure", async () => {
    await mountSettled(
      fixtureBridgeWithGrowth(unscriptedScenario("callback-tool-registry-rejects"), {
        callbackToolRegistryRead: async () => {
          await Promise.resolve();
          throw new ConsoleRefusalError(SESSION_GONE);
        },
      }),
    );

    // The code the remedy table is keyed on, and the sentence the daemon wrote. A
    // substituted `call-rejected` has no remedy row, so the operator's next move and
    // the frame escalation both disappear with it.
    expect(screen.getByText(SESSION_GONE.code)).not.toBeNull();
    expect(screen.getByText(SESSION_GONE.detail)).not.toBeNull();
  });

  it("negative control: the fixed seam-failure code reaches the surface nowhere", async () => {
    // Without this the case above would pass over a surface that rendered BOTH.
    await mountSettled(
      fixtureBridgeWithGrowth(unscriptedScenario("callback-tool-registry-rejects-control"), {
        callbackToolRegistryRead: async () => {
          await Promise.resolve();
          throw new ConsoleRefusalError(SESSION_GONE);
        },
      }),
    );

    expect(screen.queryByText("call-rejected")).toBeNull();
  });

  it("settles a rejection that carries no refusal rather than staying in flight", async () => {
    await mountSettled(
      fixtureBridgeWithGrowth(unscriptedScenario("callback-tool-registry-throws"), {
        callbackToolRegistryRead: async () => {
          await Promise.resolve();
          throw new Error("the bridge closed mid-read");
        },
      }),
    );

    // A read that failed is not a read still coming: the not-loaded absence would
    // promise an answer that is never arriving.
    expect(screen.queryByText("Reading the daemon-hosted tool registry.")).toBeNull();
    expect(screen.getByText(/the bridge closed mid-read/u)).not.toBeNull();
  });
});

describe("the entry the contract registers", () => {
  it("names the tool's arguments under the disclosure, required first and marked", async () => {
    // The fixture serves no registry read, so this is the withheld arm — which is
    // exactly the arm the shipped registry entry rides today.
    await mountSettled(createFixtureBridge({ scenario: unscriptedScenario("callback-tools") }));

    expect(screen.getByText("workflow_start")).not.toBeNull();

    await openTheSchema();

    expect(argumentRows()).toStrictEqual(["definitionName required", "scope"]);
  });

  it("negative control: the schema's own keywords are named nowhere", async () => {
    // Without this the case above would pass over a panel that listed the keywords
    // AND the arguments, which is the defect with the fix laid beside it.
    await mountSettled(
      createFixtureBridge({ scenario: unscriptedScenario("callback-tools-control") }),
    );

    await openTheSchema();

    for (const keyword of ["type", "properties", "required", "additionalProperties"]) {
      expect(argumentRows()).not.toContain(keyword);
    }
  });
});
