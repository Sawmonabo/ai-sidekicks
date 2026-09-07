// Minting an invitation: what the request is composed from, and what the one-time
// reveal does with what comes back.
//
// Every case drives the REAL fixture bridge, so the create call is parsed against the
// registered `InviteCreate` / `InviteCreateResponse` shapes on its way out and back —
// a request this console could not actually send is refused by the call door here
// rather than passing over a hand-built stub.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
  unscriptedScenario,
  withDaemonCall,
  type BridgeUnderTest,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { GrowthOutcome } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { settle as settleReactWork } from "../../core/settle.test-support.js";
import { CreateInvite } from "./CreateInvite.js";
import { DEFAULT_JOIN_MODE } from "./invite-draft.js";
import { SentInvites } from "./SentInvites.js";
import { INVITE_1, SESSION_ID, VIEWING_PARTICIPANT, invite } from "./sent-invites.test-support.js";

/** The invitation the scripted mint answers with. Branded UUID, like every wire id. */
const MINTED_INVITE_ID = "019b7910-0007-7000-8000-000000000001";

/** A plausible `v4.local` blob. Never rendered on its own — only inside the link. */
const MINTED_TOKEN = "v4.local.dGhpcy1pcy1ub3QtYS1yZWFsLXRva2Vu";

/** The host the scenario's node answers its control plane on. */
const CONTROL_PLANE_HOST = "sidekicks.example";

/** Seven days past the scenario's own frozen start, which is the default expiry. */
const DEFAULT_EXPIRY = "2026-01-08T10:05:00.000Z";

/** One day past it, which is the shortest the form offers. */
const SHORT_EXPIRY = "2026-01-02T10:05:00.000Z";

/**
 * A scenario that answers the mint with the expiry the caller asked for.
 *
 * Computed rather than fixed, because the reveal renders the reply's OWN expiry: a
 * scenario answering one constant would let a case pass over a surface that showed
 * the value it had asked for rather than the one it got back.
 */
function scenarioMinting(): ConsoleScenario {
  return {
    ...unscriptedScenario("collaboration-create-invite-test"),
    replies: [
      {
        call: "invite.create",
        resultFor: (request) => {
          const asked = request as { readonly expiresAt?: unknown };
          return {
            inviteId: MINTED_INVITE_ID,
            token: MINTED_TOKEN,
            expiresAt: typeof asked.expiresAt === "string" ? asked.expiresAt : DEFAULT_EXPIRY,
          };
        },
      },
    ],
  };
}

/** A scenario whose mint refuses with one registered wire code. */
function scenarioRefusingMint(code: string, message: string): ConsoleScenario {
  return {
    ...unscriptedScenario("collaboration-create-invite-refused-test"),
    replies: [{ call: "invite.create", refusal: { code, message } }],
  };
}

/**
 * The real fixture bridge, with the two growth reads this form takes served, and the
 * record of what it was asked.
 *
 * Through the shared call arm rather than a spy on the namespace: the console has one
 * seam for observing what reached the daemon, and a surface's test standing in for a
 * surface goes through the same door a surface does.
 */
function bridgeFor(
  scenario: ConsoleScenario,
  overrides: Parameters<typeof fixtureBridgeWithGrowth>[1] = {},
): BridgeUnderTest {
  return withDaemonCall(
    fixtureBridgeWithGrowth(scenario, {
      callerParticipantRead: growthServing({ participantId: VIEWING_PARTICIPANT }),
      controlPlaneHostRead: growthServing({ host: CONTROL_PLANE_HOST }),
      invitesList: growthServing([invite()]),
      ...overrides,
    }),
    // Every call is the scenario's own; this arm only records what went past.
    async (_recorded, passThrough) => await passThrough(),
  );
}

/** Let the reads, the mint, and the effects each schedules land. */
async function settle(): Promise<void> {
  await settleReactWork();
}

function sendControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".meridian-invite-create__send");
}

/** Press the send control and let the mint and the host read that follows it settle. */
async function pressSend(container: HTMLElement): Promise<void> {
  await act(async () => {
    sendControl(container)?.click();
    await crossMacrotaskBoundary();
  });
  await settle();
}

/** Choose one radio by the value the wire spells it with. */
function choose(container: HTMLElement, value: string): void {
  const control = container.querySelector<HTMLElement>(`[value="${value}"]`);
  if (control === null) {
    throw new Error(`no choice for ${value}`);
  }
  fireEvent.click(control);
}

/**
 * The host read held open, with the means to answer it later.
 *
 * The window these cases have to observe is the one between the press and the
 * composed link, and a read that answers immediately closes it before a case can
 * look. `settleable` in the coordinator's own suite is this shape for the daemon
 * arm; this is the growth arm's, and it is local because one surface reads this
 * operation.
 */
function heldHostRead(): {
  readonly read: () => Promise<GrowthOutcome<{ readonly host: string }>>;
  readonly answer: () => void;
} {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    read: async () => {
      await held;
      return { status: "served", value: { host: CONTROL_PLANE_HOST } };
    },
    answer: () => {
      release();
    },
  };
}

/** How many invitations actually reached the daemon. */
function mintsReaching(calls: readonly { readonly method: string }[]): number {
  return calls.filter((recorded) => recorded.method === "invite.create").length;
}

describe("creating an invitation — what the request is composed from", () => {
  it("names the participant the identity read answered with, and never a guess", async () => {
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    const minted = calls.find((recorded) => recorded.method === "invite.create");
    expect(minted?.params).toMatchObject({
      sessionId: SESSION_ID,
      inviter: VIEWING_PARTICIPANT,
    });
  });

  it("closes the send control while the identity read is still out", async () => {
    // The request's fourth member is missing until that read answers, so there is
    // nothing to compose — a control offered here would produce a refusal from
    // nowhere. Held open rather than refused, so the case observes the closed state.
    const { bridge } = bridgeFor(scenarioMinting(), {
      callerParticipantRead: async () => await new Promise(() => undefined),
    });
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();

    expect(sendControl(container)?.disabled).toBe(true);
    expect(container.textContent ?? "").toContain("Reading which participant this window is");
  });

  it("negative control: the send control IS open once that read answers", async () => {
    // Without this the case above would pass over a form whose control was closed
    // whatever the read did.
    const { container } = render(
      <CreateInvite
        bridge={bridgeFor(scenarioMinting()).bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
      />,
    );
    await settle();

    expect(sendControl(container)?.disabled).toBe(false);
  });

  it("renders the identity read's own refusal rather than a silent closed control", async () => {
    const { bridge } = bridgeFor(scenarioMinting(), {
      callerParticipantRead: growthRefusing("callerParticipantRead"),
    });
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();

    expect(container.textContent ?? "").toContain("wire-unregistered");
    expect(sendControl(container)?.disabled).toBe(true);
  });

  it("starts on the join mode the corpus fixes as the default", async () => {
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    // Untouched, the form sends `Spec-002 §Default Behavior`'s own value. Read off
    // the model module rather than spelled again here: a case restating the literal
    // would keep passing over a form that had drifted from the corpus and would then
    // be pinning the drift.
    await pressSend(container);
    expect(calls.at(-1)?.params).toMatchObject({ joinMode: DEFAULT_JOIN_MODE });
  });

  it("negative control: choosing another mode moves what is sent", async () => {
    // Without this the case above would pass over a form that ignored the choices and
    // sent the default whatever was picked.
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    choose(container, "viewer");
    await pressSend(container);

    expect(calls.at(-1)?.params).toMatchObject({ joinMode: "viewer" });
  });

  it("sends the expiry the chosen row names, measured on the console's own clock", async () => {
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();

    // The default is `Spec-002 §Default Behavior`'s seven days.
    await pressSend(container);
    expect(calls.at(-1)?.params).toMatchObject({ expiresAt: DEFAULT_EXPIRY });
  });

  it("negative control: choosing the shortest row moves that instant", async () => {
    // Without this the case above would pass over a form that ignored the picker and
    // sent the same instant whatever was chosen.
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    choose(container, "1d");
    await pressSend(container);

    expect(calls.at(-1)?.params).toMatchObject({ expiresAt: SHORT_EXPIRY });
  });
});

describe("creating an invitation — the one-time reveal", () => {
  it("composes the link from the host read and the token, and copies that", async () => {
    const { bridge } = bridgeFor(scenarioMinting());
    const copy = vi.spyOn(bridge.sidekicks.native, "copyToClipboard");
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    const link = `https://${CONTROL_PLANE_HOST}/invite/${MINTED_TOKEN}`;
    expect(container.textContent ?? "").toContain(link);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".meridian-invite-reveal__copy")?.click();
      await crossMacrotaskBoundary();
    });
    expect(copy).toHaveBeenCalledWith(link);
  });

  it("keeps the invitation on screen when the host read refuses, and says why", async () => {
    // The mint SUCCEEDED; what failed is the composition of the link. Hiding the
    // invitation would lose an identifier a person can still revoke by.
    const { bridge } = bridgeFor(scenarioMinting(), {
      controlPlaneHostRead: growthRefusing("controlPlaneHostRead"),
    });
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    const text = container.textContent ?? "";
    expect(text).toContain(MINTED_INVITE_ID);
    expect(text).toContain("wire-unregistered");
    expect(text).not.toContain(MINTED_TOKEN);
  });

  it("puts the invitation away only on a press, and cannot show the link again", async () => {
    const { container } = render(
      <CreateInvite
        bridge={bridgeFor(scenarioMinting()).bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
      />,
    );
    await settle();
    await pressSend(container);
    expect(container.textContent ?? "").toContain(MINTED_TOKEN);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".meridian-invite-reveal__done")?.click();
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(container.textContent ?? "").not.toContain(MINTED_TOKEN);
    expect(sendControl(container)).not.toBeNull();
  });
});

describe("creating an invitation — the mint and its link are one act", () => {
  it("holds the send control closed until the link is composed", async () => {
    // The token is returned exactly once and no later read can recover it, so the
    // press that mints it must stay closed until the composition that reveals it has
    // happened. Settling the mint on its own re-opened the control while the first
    // plaintext token was still waiting on the host read: a second press minted a
    // second invitation and the two continuations overwrote one another in the single
    // reveal slot, losing whichever lost the race.
    const host = heldHostRead();
    const { bridge, calls } = bridgeFor(scenarioMinting(), { controlPlaneHostRead: host.read });
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();

    await pressSend(container);
    expect(sendControl(container)?.disabled).toBe(true);
    await pressSend(container);

    host.answer();
    await settle();

    expect(mintsReaching(calls)).toBe(1);
    expect(container.textContent ?? "").toContain(
      `https://${CONTROL_PLANE_HOST}/invite/${MINTED_TOKEN}`,
    );
  });

  it("mints nothing while the host read is still out", async () => {
    // The ORDER is the guarantee rather than a nicety. Asked after the mint, a host
    // read that never answers leaves a real invitation minted whose one-time token
    // nothing on this window can still show — the ledger carries no token and the
    // create reply is the only place one ever appears. Asked first, there is no
    // token in existence until the act that reveals it can run to its end.
    const { bridge, calls } = bridgeFor(scenarioMinting(), {
      controlPlaneHostRead: async () => await new Promise(() => undefined),
    });
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    expect(mintsReaching(calls)).toBe(0);
    expect(sendControl(container)?.disabled).toBe(true);
  });

  it("negative control: a host read that answers lets exactly one mint through", async () => {
    // Without this the two cases above would pass over a form that never minted at
    // all, which is a closed control rather than a single-flight one.
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    expect(mintsReaching(calls)).toBe(1);
    expect(container.textContent ?? "").toContain(MINTED_TOKEN);
  });
});

describe("creating an invitation — what a refusal says", () => {
  it("offers the cap's only remedy and counts down against nothing", async () => {
    // `invite.pending_cap` is a concurrency cap: capacity frees when a holder
    // releases, so there is no reset instant and a timer would be invented.
    const { bridge } = bridgeFor(
      scenarioRefusingMint("invite.limit_exceeded", "Too many invitations are already waiting."),
    );
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    const text = container.textContent ?? "";
    expect(text).toContain("invite.limit_exceeded");
    expect(text).toContain("Too many invitations are already waiting.");
    expect(text).toContain("Revoke an invitation that is still waiting");
    expect(text).not.toMatch(/retry in|try again in|\d+\s*s left/iu);
  });

  it("names the person who can do it when only an owner may", async () => {
    const { bridge } = bridgeFor(
      scenarioRefusingMint("invite.permission_denied", "Only the session owner may issue invites."),
    );
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    expect(container.textContent ?? "").toContain("Only an owner of this session can invite");
  });

  it("negative control: a mint that settles renders no refusal at all", async () => {
    // Without this the two cases above would pass over a form that rendered a remedy
    // whatever the daemon answered.
    const { container } = render(
      <CreateInvite
        bridge={bridgeFor(scenarioMinting()).bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
      />,
    );
    await settle();
    await pressSend(container);

    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});

describe("creating an invitation — what the ledger beside it does", () => {
  it("re-reads the ledger once the mint has settled", async () => {
    // `InviteCreateResponse` carries no state and no join mode, so the row cannot be
    // folded in without composing two members the wire never sent.
    const invitesList = vi.fn(growthServing([invite({ inviteId: INVITE_1 })]));
    const { bridge } = bridgeFor(scenarioMinting(), { invitesList });
    const { container } = render(<SentInvites bridge={bridge} sessionId={SESSION_ID} />);
    await settle();
    expect(invitesList).toHaveBeenCalledTimes(1);

    await pressSend(container);

    expect(invitesList).toHaveBeenCalledTimes(2);
  });

  it("negative control: nothing else re-reads it", async () => {
    // Without this the case above would pass over a ledger that re-read on every
    // render — which would be the poll this console does not have.
    const invitesList = vi.fn(growthServing([invite({ inviteId: INVITE_1 })]));
    const { bridge } = bridgeFor(scenarioMinting(), { invitesList });
    const { container } = render(<SentInvites bridge={bridge} sessionId={SESSION_ID} />);
    await settle();
    choose(container, "collaborator");
    await settle();

    expect(invitesList).toHaveBeenCalledTimes(1);
  });
});
