// A definition handed over from the settings page, arriving at the session's form.
//
// THE REGISTER'S OWN SUITE BESIDE THIS ONE ANSWERS WHAT AN OFFER IS. What it cannot
// answer is whether the other end exists: an offer nothing claims is a press that did
// nothing, and the failure is silent — the person navigates to their session, opens
// the attach form by hand, and finds it exactly as they left it.
//
// SO THIS DRIVES THE REAL COLUMN. The claim depends on three things meeting — the
// window's handoff, the session the column is scoped to, and the definition read the
// picker is drawn from — and each of those is a seam between two modules that a test
// against the hook alone would supply itself.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "../../agent-console/agent-console.test-support.js";
import {
  HeldAttachDaemon,
  bridgeCalling,
  disposeOpenedModels,
  modelsOver,
} from "../../agent-console/agent-binding-column.test-support.js";
import { AgentBindingColumn } from "../../agent-console/AgentBindingColumn.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { attachHandoffFor } from "./attach-handoff.js";

afterEach(disposeOpenedModels);

/** The session `modelsOver` scopes a column to, so an offer names the right one. */
const SESSION_ID = "session-9";

/** The definition the scripted registry answers with. */
const DEFINITION_ID = "definition-1";

/** Mount the real column over a bridge, letting both of its reads land. */
async function mountedColumn(bridge: ConsoleBridge): Promise<void> {
  render(<AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />);
  await settleReads(bridge);
}

/** The attach dialog, or `null` where the column drew none. */
function attachDialog(): HTMLElement | null {
  return document.querySelector(".meridian-attach__popup");
}

/** Whether the picker is showing the named definition as the chosen one. */
function isDefinitionChosen(): boolean {
  return (
    document.querySelector(".meridian-attach__definition-button")?.getAttribute("aria-pressed") ===
    "true"
  );
}

describe("attaching from the definitions page — the session's form claims the offer", () => {
  it("opens the attach form on the offered definition", async () => {
    const bridge = bridgeCalling(new HeldAttachDaemon());
    attachHandoffFor(bridge).offer({
      sessionId: SESSION_ID,
      definitionId: DEFINITION_ID,
      definitionName: "Reviewer",
    });

    await mountedColumn(bridge);

    expect(attachDialog()).not.toBeNull();
    expect(isDefinitionChosen()).toBe(true);
  });

  it("spends the offer, so the form does not re-open on it later", async () => {
    const bridge = bridgeCalling(new HeldAttachDaemon());
    const handoff = attachHandoffFor(bridge);
    handoff.offer({
      sessionId: SESSION_ID,
      definitionId: DEFINITION_ID,
      definitionName: "Reviewer",
    });

    await mountedColumn(bridge);

    expect(handoff.standingOffer).toBeUndefined();
  });

  it("negative control: with no offer standing, the form stays shut", async () => {
    // Without this, both cases above would pass over a column that opened its attach
    // form on mount for everybody.
    const bridge = bridgeCalling(new HeldAttachDaemon());

    await mountedColumn(bridge);

    expect(attachDialog()).toBeNull();
  });

  it("negative control: an offer made for another session opens nothing here", async () => {
    // An agent joins a session. A form that honoured an offer naming a different one
    // would put the agent somewhere nobody asked for.
    const bridge = bridgeCalling(new HeldAttachDaemon());
    const handoff = attachHandoffFor(bridge);
    handoff.offer({
      sessionId: "session-elsewhere",
      definitionId: DEFINITION_ID,
      definitionName: "Reviewer",
    });

    await mountedColumn(bridge);

    expect(attachDialog()).toBeNull();
    // And it is still standing, because this session had no business spending it.
    expect(handoff.standingOffer?.sessionId).toBe("session-elsewhere");
  });

  it("opens nothing for a definition the registry no longer carries, and drops the offer", async () => {
    // Deleted between the press and the arrival. Opening a form pointed at a record
    // that is gone would be worse than opening none, and an offer kept alive over it
    // would try again every time the definition read moved.
    const bridge = bridgeCalling(new HeldAttachDaemon());
    const handoff = attachHandoffFor(bridge);
    handoff.offer({
      sessionId: SESSION_ID,
      definitionId: "definition-deleted",
      definitionName: "Gone",
    });

    await mountedColumn(bridge);

    expect(attachDialog()).toBeNull();
    expect(handoff.standingOffer).toBeUndefined();
  });
});
