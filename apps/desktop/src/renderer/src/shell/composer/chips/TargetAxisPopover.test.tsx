// The axis popover, driven through the rail that arms everything behind it.
//
// MOUNTED AS THE RAIL AND NOT AS THE POPOVER ALONE, because every claim here is about
// a seam the popover does not hold: the catalog read, the mutation latch, and the
// roster reading whose pending clause moves on the answer. A suite that rendered the
// component over hand-built holders would be asserting that props reach props.
//
// The bridge is the shipped composer fixture, whose scenario answers the three calls
// this surface makes; a case that is about a different answer spreads over that bridge
// and replaces one growth member, which is the shape `agent-binding-read.test.tsx`
// states — the clock, the scenario, and every other seam stay the fixture's.

import { fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  type AgentRosterEntry,
  type ConsoleBridge,
  type GrowthPort,
} from "../../../console/bridge/index.js";
import { withDaemonCall } from "../../../console/bridge/fixture/call-plane/bridge.test-support.js";
import { settleScriptedRead } from "../../../console/bridge/readings/scheduled-read.test-support.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenario/composer/composer.js";
import {
  AGENT_IMPLEMENTER,
  RUN_ID,
  SESSION_ID,
} from "../../../console/bridge/scenario/composer/identifiers.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../console/core/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { FrameStore, SessionStore, type ConsoleEntity } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { ComposerChipRail } from "./ComposerChipRail.js";

/** Where the composer is addressed when the deck is showing the fixture's agent. */
const AGENT_PANE: ConsolePaneAddress = {
  kind: "agent-console",
  entity: { kind: "agent", id: AGENT_IMPLEMENTER },
};

/** Where it is addressed when the deck is showing the session's own channel. */
const CHANNEL_PANE: ConsolePaneAddress = {
  kind: "timeline",
  entity: { kind: "channel", id: `${SESSION_ID}-main` },
};

/** The trigger's accessible name, which is the act rather than the axis vocabulary. */
const TRIGGER_NAME = "Change provider axes";

/** One roster row for the fixture's agent, with whatever the case is about on it. */
function rosterRow(overrides: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    config: { providerAccountId: "acct-claude-team" },
    ...overrides,
  };
}

/**
 * A store holding the fixture's agent on a live run, seeded through `initialise`.
 *
 * The run's state decides the address: without a run the composer resolves to the
 * channel path and every provider-bound case would be asserting the wrong arm.
 */
function seededSessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  const entities: readonly ConsoleEntity[] = [
    { kind: "agent", id: AGENT_IMPLEMENTER, body: { name: "Implementer" } },
    {
      kind: "run",
      id: RUN_ID,
      state: "running",
      touchedAt: "2026-01-01T11:06:00.000Z",
      body: { agentId: AGENT_IMPLEMENTER },
    },
  ];
  store.initialise({ cursor: 0, entities, participantJoinLog: [] });
  return store;
}

interface MountedRail {
  readonly bridge: ConsoleBridge;
  readonly container: HTMLElement;
  readonly findByName: RenderResult["findByRole"];
  readonly queryByName: RenderResult["queryByRole"];
}

/** Mount the rail over the fixture and let its opening reads land. */
async function mountRail(
  options: {
    readonly focusedPane?: ConsolePaneAddress;
    readonly growth?: Partial<GrowthPort>;
  } = {},
): Promise<MountedRail> {
  const fixture = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const bridge: ConsoleBridge =
    options.growth === undefined
      ? fixture
      : { ...fixture, growth: { ...fixture.growth, ...options.growth } };
  const rendered = render(
    <ComposerChipRail
      sessionStore={seededSessionStore()}
      bridge={bridge}
      draftStore={
        new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT, restartNoticePending: false })
      }
      frameStore={new FrameStore()}
      route={{ kind: "workspace", sessionId: SESSION_ID }}
      focusedPane={options.focusedPane ?? AGENT_PANE}
    />,
  );
  await settleScriptedRead(bridge);
  return {
    bridge,
    container: rendered.container,
    findByName: rendered.findByRole,
    queryByName: rendered.queryByRole,
  };
}

/** Open the popover and wait for its chunk to arrive. The form is not in the entry graph. */
async function openAxisForm(mounted: MountedRail): Promise<HTMLElement> {
  fireEvent.click(await mounted.findByName("button", { name: TRIGGER_NAME }));
  return await waitFor(() => {
    const form = document.querySelector<HTMLElement>(".meridian-switch");
    if (form === null) {
      throw new Error("the axis form has not mounted yet");
    }
    return form;
  });
}

/** Edit the one axis this suite can move without opening a listbox of its own. */
function editPayingAccount(form: HTMLElement, value: string): void {
  const accountField = form.querySelector<HTMLInputElement>(".meridian-axis-field__text");
  if (accountField === null) {
    throw new Error("the form drew no provider-account field");
  }
  fireEvent.change(accountField, { target: { value } });
}

/** The form's two submit actions, in the order it draws them. */
function submitActions(form: HTMLElement): readonly HTMLButtonElement[] {
  return [...form.querySelectorAll<HTMLButtonElement>(".meridian-switch__apply")];
}

describe("the target chip's axis popover — opened, loaded, and dispatched", () => {
  it("loads the form only once a press asks for it", async () => {
    const mounted = await mountRail();

    // The negative control rides the same case: before the press the form's own
    // markup is nowhere in the document, which is what the loader buys — the chunk
    // is not on the graph of a session that never opens one.
    expect(document.querySelector(".meridian-switch")).toBeNull();

    const form = await openAxisForm(mounted);

    expect(form.querySelectorAll(".meridian-axis-field").length).toBeGreaterThan(0);
  });

  it("names its control by the act it performs", async () => {
    const mounted = await mountRail();

    expect(mounted.queryByName("button", { name: TRIGGER_NAME })).not.toBeNull();
  });

  it("offers no axis control at all while the composer is addressed at a channel", async () => {
    const mounted = await mountRail({ focusedPane: CHANNEL_PANE });

    // No agent is addressed, so there are no axes — a different state from the three
    // the reach vocabulary carries, and the chip says nothing about any of them.
    expect(mounted.queryByName("button", { name: TRIGGER_NAME })).toBeNull();
    expect(mounted.container.textContent).not.toContain("Axes not read");
    expect(mounted.container.textContent).not.toContain("Axis change not offered");
  });

  it("says the change is not reachable on a build carrying no such operation", async () => {
    const fixture = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
    // Rebuilt without the member rather than deleted from it: the port's members are
    // readonly, and this arm is about there being nothing to ask rather than about a
    // call that answers a refusal.
    const withoutAxisMutation = Object.fromEntries(
      Object.entries(fixture.growth).filter(([operationId]) => operationId !== "agentConfigUpdate"),
    ) as GrowthPort;
    const rendered = render(
      <ComposerChipRail
        sessionStore={seededSessionStore()}
        bridge={{ ...fixture, growth: withoutAxisMutation }}
        draftStore={
          new DraftStore({
            maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
            restartNoticePending: false,
          })
        }
        frameStore={new FrameStore()}
        route={{ kind: "workspace", sessionId: SESSION_ID }}
        focusedPane={AGENT_PANE}
      />,
    );

    expect(rendered.container.textContent).toContain("Axis change not offered");
    // Fail-closed: a press that reaches no call is never offered, not even disabled.
    expect(rendered.queryByRole("button", { name: TRIGGER_NAME })).toBeNull();
  });

  it("submits one update and refuses the second while the first is outstanding", async () => {
    const submitted: unknown[] = [];
    let releasePending: (() => void) | undefined;
    const mounted = await mountRail({
      growth: {
        agentConfigUpdate: async (request) => {
          submitted.push(request);
          await new Promise<void>((resolve) => {
            releasePending = resolve;
          });
          return { status: "served", value: { switch: { status: "pending" } } };
        },
      },
    });
    const form = await openAxisForm(mounted);
    editPayingAccount(form, "acct-claude-research");

    const [applyAtBoundary] = submitActions(form);
    fireEvent.click(applyAtBoundary as HTMLButtonElement);
    fireEvent.click(applyAtBoundary as HTMLButtonElement);

    // The latch is synchronous, so the second press never reaches the wire — and the
    // form says why rather than leaving a dead control under a busy cursor.
    expect(submitted).toHaveLength(1);
    await waitFor(() => {
      expect(document.body.textContent).toContain("already outstanding");
    });
    releasePending?.();
  });

  it("moves the pending clause on the daemon's answer rather than on the press", async () => {
    // The roster answers without a pending switch until the mutation has been
    // acknowledged, so a chip that marked one on the local press would show the
    // clause here on the first read and this case would pass for the wrong reason.
    const pendingSwitch = {
      switchId: "switch-composer-1",
      appliesAt: "run_boundary",
      interruptRequested: false,
      pendingAxes: [{ axis: "providerAccountId", value: "acct-claude-research" }],
    };
    const submitted: unknown[] = [];
    const mounted = await mountRail({
      growth: {
        agentList: async () => ({
          status: "served",
          value: {
            agents: [submitted.length === 0 ? rosterRow() : rosterRow({ pendingSwitch })],
          },
        }),
        agentConfigUpdate: async (request) => {
          submitted.push(request);
          return { status: "served", value: { switch: { status: "pending" } } };
        },
      },
    });
    const form = await openAxisForm(mounted);
    editPayingAccount(form, "acct-claude-research");

    expect(mounted.container.textContent).not.toContain("Switch applies at the next run");
    fireEvent.click(submitActions(form)[0] as HTMLButtonElement);
    await settleScriptedRead(mounted.bridge);

    expect(submitted).toHaveLength(1);
    await waitFor(() => {
      expect(mounted.container.textContent).toContain("Switch applies at the next run");
    });
  });

  it("names a failed switch on the chip and inside the open form", async () => {
    const mounted = await mountRail({
      growth: {
        agentConfigUpdate: async () => ({
          status: "served",
          value: { switch: { status: "failed", reason: "account_unavailable" } },
        }),
      },
    });
    const form = await openAxisForm(mounted);
    editPayingAccount(form, "acct-claude-research");
    fireEvent.click(submitActions(form)[0] as HTMLButtonElement);

    await waitFor(() => {
      expect(mounted.container.textContent).toContain("Switch failed");
    });
    // The reason is the wire's own word, carried verbatim rather than paraphrased,
    // and the form says the same thing in its own sentence.
    expect(mounted.container.textContent).toContain("account_unavailable");
    expect(document.body.textContent).toContain("did not switch");
  });

  it("re-reads the binding on a reply that named no switch at all", async () => {
    // `switch` is OPTIONAL on the reply — absent on a pure rename or rebind — and the
    // re-read effect keyed on the MEMBER, so exactly those replies left the chip on
    // the pre-switch binding until an unrelated trigger happened to fire. It keys on
    // the ROUND now: the daemon answered, so the binding it answered about has moved.
    let rosterReads = 0;
    const mounted = await mountRail({
      growth: {
        agentList: async () => {
          rosterReads += 1;
          return await Promise.resolve({ status: "served", value: { agents: [rosterRow()] } });
        },
        agentConfigUpdate: async () => ({ status: "served", value: {} }),
      },
    });
    const form = await openAxisForm(mounted);
    editPayingAccount(form, "acct-claude-research");
    const beforeApply = rosterReads;

    fireEvent.click(submitActions(form)[0] as HTMLButtonElement);
    await settleScriptedRead(mounted.bridge);

    expect(beforeApply).toBeGreaterThan(0);
    await waitFor(() => {
      expect(rosterReads).toBe(beforeApply + 1);
    });
    // And the form reports the answered round rather than standing blank.
    expect(document.body.textContent).toContain("named no switch");
  });

  it("keeps the refusal on the chip once the popover has been dismissed", async () => {
    // THE ONE OUTCOME A MUTATION SURFACE MAY NOT HAVE. The refusal reached only the
    // form's own `refusal` prop, and the popup is portalled with no `keepMounted` —
    // base-ui unmounts it on an outside click or Escape. So a participant who pressed
    // Apply and clicked back into the message line to keep typing met a chip showing
    // the pre-switch binding, no failure, and no code, while the daemon had refused.
    const mounted = await mountRail({
      growth: {
        agentConfigUpdate: async () => {
          throw new Error("the daemon refused the move");
        },
      },
    });
    const form = await openAxisForm(mounted);
    editPayingAccount(form, "acct-claude-research");
    fireEvent.click(submitActions(form)[0] as HTMLButtonElement);
    await waitFor(() => {
      expect(document.body.textContent).toContain("the daemon refused the move");
    });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => {
      expect(document.querySelector(".meridian-switch")).toBeNull();
    });

    // The chip is what is still on screen, so the chip is where the answer has to be.
    const refusal = mounted.container.querySelector(".meridian-refusal");
    expect(refusal).not.toBeNull();
    expect(refusal?.textContent).toContain("read-failed");
    expect(mounted.container.textContent).toContain("the daemon refused the move");
    // Rule 4's third clause, which the wire never carries: what to do next.
    expect(mounted.container.textContent).toContain("Open the axis control and submit again");
  });

  it("negative control: a round that was never refused puts no failure on the chip", async () => {
    // Without this the case above would pass over a chip that rendered a refusal
    // unconditionally, which is a worse defect than the silence it replaced.
    const mounted = await mountRail({
      growth: {
        agentConfigUpdate: async () => ({
          status: "served",
          value: { switch: { status: "pending" } },
        }),
      },
    });
    const form = await openAxisForm(mounted);
    editPayingAccount(form, "acct-claude-research");
    fireEvent.click(submitActions(form)[0] as HTMLButtonElement);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => {
      expect(document.querySelector(".meridian-switch")).toBeNull();
    });

    expect(mounted.container.querySelector(".meridian-refusal")).toBeNull();
    expect(mounted.container.textContent).not.toContain("Axis change not applied");
  });

  it("renders the catalog's refusal with the way back the form holds no stream for", async () => {
    // The catalog announces no change on any wire, so a refusal is terminal without a
    // control that asks again — and the form owns no stream, so the reopen has to
    // come from the rail that armed the read.
    const { bridge } = withDaemonCall(
      createFixtureBridge({ scenario: COMPOSER_SCENARIO }),
      async (call, passThrough) => {
        if (call.method === "driver.listModels") {
          throw new Error("the node did not answer the model catalog");
        }
        return passThrough();
      },
    );
    const rendered = render(
      <ComposerChipRail
        sessionStore={seededSessionStore()}
        bridge={bridge}
        draftStore={
          new DraftStore({
            maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
            restartNoticePending: false,
          })
        }
        frameStore={new FrameStore()}
        route={{ kind: "workspace", sessionId: SESSION_ID }}
        focusedPane={AGENT_PANE}
      />,
    );
    await settleScriptedRead(bridge);
    fireEvent.click(await rendered.findByRole("button", { name: TRIGGER_NAME }));

    const refusal = await waitFor(() => {
      const card = document.querySelector<HTMLElement>(".meridian-refusal--card");
      if (card === null) {
        throw new Error("the refused catalog rendered no refusal");
      }
      return card;
    });
    expect(refusal.querySelector("button")?.textContent).toBe("Try again");
    // The reason is the read's own, carried rather than replaced by a house sentence.
    expect(refusal.textContent).toContain("driver.listModels");
    // The negative control: a refused catalog draws no axis controls at all, so
    // nothing on screen invites an edit the form could not vouch for.
    expect(document.querySelector(".meridian-axis-field")).toBeNull();
  });
});
