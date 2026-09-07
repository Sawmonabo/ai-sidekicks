// A refused claim names who has the shell — from the refusal's own field, or not at all.
//
// `Spec-023 §Console Design (Meridian)` 8.8 asks the refusal to name the holder with a
// manual retry, and the only admissible source is the member the refusing side sent:
// `error-contracts.md` registers `holderParticipantId` on this code's structured
// context, in two positions for the two envelope shapes. So there are four cases and
// two of them are negative controls — a refusal carrying no holder gains no invented
// sentence, and the served state's own holder is not borrowed to fill the gap, which
// is the mistake a surface makes when it "knows" who was holding it a moment ago.

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { TERMINAL_SCENARIO, TERMINAL_SCENARIO_CAST } from "../../bridge/scenarios/terminal.js";
import { OTHER_PARTICIPANT, VIEWER_PARTICIPANT } from "./lease-model.test-support.js";
import { claimControl, leaseState, renderLease } from "./LeaseLine.test-support.js";

/** The registered code a claim takes when somebody else holds the shell. */
const CONTROL_HELD_BY_OTHER = "pty.control_held_by_other";

const REFUSAL_SENTENCE = "Another participant holds the write lease for this session.";

/** A bridge whose claim rejects with the rejection a case hands it. */
function bridgeRejecting(rejection: unknown): ConsoleBridge {
  const base = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      terminalAcquireWriteLease: () => Promise.reject(rejection),
    },
  };
}

/** The JSON-RPC envelope's own position for the structured context. */
function jsonRpcRejection(fields: Readonly<Record<string, unknown>>): unknown {
  return {
    code: -32603,
    message: REFUSAL_SENTENCE,
    data: { type: CONTROL_HELD_BY_OTHER, fields },
  };
}

/** The flat envelope's own position for the same context. */
function flatRejection(details: Readonly<Record<string, unknown>>): unknown {
  return { code: CONTROL_HELD_BY_OTHER, message: REFUSAL_SENTENCE, details };
}

async function claimAndRead(rejection: unknown): Promise<string> {
  const { container } = renderLease(
    leaseState({ holding: "unheld", holderVouching: "vouched" }),
    bridgeRejecting(rejection),
  );
  fireEvent.click(claimControl(container));
  await waitFor(() => {
    expect(container.textContent).toContain(REFUSAL_SENTENCE);
  });
  return container.textContent ?? "";
}

describe("a refused claim and the holder it names (8.8)", () => {
  it("names the holder by id from the JSON-RPC envelope's structured context", async () => {
    const text = await claimAndRead(jsonRpcRejection({ holderParticipantId: VIEWER_PARTICIPANT }));
    expect(text).toContain(VIEWER_PARTICIPANT);
    expect(text).toContain("Ask them to release the shell, then claim it again.");
  });

  it("reads the same member off the flat envelope's own position", async () => {
    const text = await claimAndRead(flatRejection({ holderParticipantId: VIEWER_PARTICIPANT }));
    expect(text).toContain(VIEWER_PARTICIPANT);
  });

  it("uses the wheel's display name where it admitted that participant", async () => {
    const text = await claimAndRead(jsonRpcRejection({ holderParticipantId: OTHER_PARTICIPANT }));
    // The mark for this participant carries no display name, so the id renders and
    // the sentence is the one that says which id it is showing.
    expect(text).toContain("Held by");
    expect(text).toContain(OTHER_PARTICIPANT);
  });

  it("negative control: a refusal that named nobody gains no holder sentence", async () => {
    const text = await claimAndRead(jsonRpcRejection({}));
    expect(text).toContain(REFUSAL_SENTENCE);
    expect(text).not.toContain("Ask them to release the shell");
  });

  it("negative control: a member that is not a string names nobody", async () => {
    const text = await claimAndRead(jsonRpcRejection({ holderParticipantId: 7 }));
    expect(text).not.toContain("Ask them to release the shell");
  });

  it("reaches the holder line from the shipped scenario, through no hand-built rejection", async () => {
    // The case the five above cannot make. Each of them replaces the lease call with a
    // rejection this file composed, so together they prove the READER and say nothing
    // about whether any scenario can drive it — and until the two lease operations
    // joined the fixture's served set, none could: the refusing port answered by name
    // and no script was ever consulted, so this component was reachable from no
    // scenario, no screenshot, and no bridge-driven test. Here the bridge is the
    // fixture's own, unmodified, playing the scenario the selector opens.
    const { container } = renderLease(
      leaseState({ holding: "unheld", holderVouching: "vouched" }),
      createFixtureBridge({ scenario: TERMINAL_SCENARIO }),
    );
    fireEvent.click(claimControl(container));
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Ask them to release the shell, then claim it again.",
      );
    });
    expect(container.textContent).toContain(CONTROL_HELD_BY_OTHER);
    expect(container.textContent).toContain(TERMINAL_SCENARIO_CAST.collaborator);
  });

  it("negative control: it does not read the holder off the flat envelope's root", async () => {
    // The corpus registers the flat envelope's context at `details`. A reader that
    // guessed a shared prefix would find this and name a holder the wire did not put
    // in the position the contract names.
    const text = await claimAndRead({
      code: CONTROL_HELD_BY_OTHER,
      message: REFUSAL_SENTENCE,
      holderParticipantId: VIEWER_PARTICIPANT,
    });
    expect(text).not.toContain("Ask them to release the shell");
  });
});
