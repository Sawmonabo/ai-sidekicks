// Minting an invitation: what the request is composed from, and what the one-time
// reveal does with what comes back.
//
// Every case drives the REAL fixture bridge, so the create call is parsed against the
// registered `InviteCreate` / `InviteCreateResponse` shapes on its way out and back —
// a request this console could not actually send is refused by the call door here
// rather than passing over a hand-built stub.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  growthRefusing,
  growthServing,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import { quietShell } from "../shell-condition.test-support.js";
import { CreateInvite } from "./CreateInvite.js";
import {
  CONTROL_PLANE_HOST,
  DEFAULT_EXPIRY,
  MINTED_INVITE_ID,
  MINTED_TOKEN,
  SHORT_EXPIRY,
  bridgeFor,
  choose,
  heldHostRead,
  mintsReaching,
  pressSend,
  scenarioMinting,
  scenarioRefusingMint,
  sendControl,
  settle,
} from "./create-invite.test-support.js";
import { DEFAULT_JOIN_MODE } from "./invite-draft.js";
import { SentInvites } from "./SentInvites.js";
import { INVITE_1, SESSION_ID, VIEWING_PARTICIPANT, invite } from "./sent-invites.test-support.js";

describe("creating an invitation — what the request is composed from", () => {
  it("names the participant the identity read answered with, and never a guess", async () => {
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
        frameStore={quietShell()}
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
    );
    await settle();

    expect(container.textContent ?? "").toContain("wire-unregistered");
    expect(sendControl(container)?.disabled).toBe(true);
  });

  it("starts on the join mode the corpus fixes as the default", async () => {
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
    );
    await settle();
    choose(container, "viewer");
    await pressSend(container);

    expect(calls.at(-1)?.params).toMatchObject({ joinMode: "viewer" });
  });

  it("sends the expiry the chosen row names, measured on the console's own clock", async () => {
    const { bridge, calls } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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

  it("mints nothing when the host read refuses, and says why on the send control", async () => {
    // The link is `https://<host>/invite/<token>` and the token comes back exactly
    // once, so an invitation minted under a host this console could not read is a row
    // in the ledger nobody can ever send. The read happens BEFORE the mint, so the
    // refusal is known while nothing has been spent: the act refuses whole, the
    // ledger is not told anything was created, and the control re-opens to try again.
    const onMinted = vi.fn();
    const { bridge, calls } = bridgeFor(scenarioMinting(), {
      controlPlaneHostRead: growthRefusing("controlPlaneHostRead"),
    });
    const { container } = render(
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        frameStore={quietShell()}
        onMinted={onMinted}
      />,
    );
    await settle();
    await pressSend(container);

    expect(mintsReaching(calls)).toBe(0);
    expect(onMinted).not.toHaveBeenCalled();
    const text = container.textContent ?? "";
    expect(text).toContain("wire-unregistered");
    expect(text).not.toContain(MINTED_INVITE_ID);
    expect(text).not.toContain(MINTED_TOKEN);
    expect(sendControl(container)?.disabled).toBe(false);
  });

  it("puts the invitation away only on a press, and cannot show the link again", async () => {
    const { container } = render(
      <CreateInvite
        bridge={bridgeFor(scenarioMinting()).bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
      <CreateInvite
        bridge={bridge}
        sessionId={SESSION_ID}
        onMinted={() => undefined}
        frameStore={quietShell()}
      />,
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
        frameStore={quietShell()}
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
    const { container } = render(
      <SentInvites bridge={bridge} sessionId={SESSION_ID} frameStore={quietShell()} />,
    );
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
    const { container } = render(
      <SentInvites bridge={bridge} sessionId={SESSION_ID} frameStore={quietShell()} />,
    );
    await settle();
    choose(container, "collaborator");
    await settle();

    expect(invitesList).toHaveBeenCalledTimes(1);
  });
});
