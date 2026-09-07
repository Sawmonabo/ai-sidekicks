// A mint that succeeded and a link that could not be composed, and the one act that
// still closes the gap between them.
//
// `InviteCreateResponse` hands the plaintext token back exactly once and only its
// hash is persisted, so a host read that refuses AFTER the mint is not a failed
// press: the invitation is real, it is in the ledger, and the one string that
// composes its link exists in this process and nowhere else. These cases pin what
// that costs if the token is dropped — an invitation nobody can ever send — and what
// the retry is allowed to do about it: ask the HOST again, never mint again.
//
// The cast is `create-invite.test-support.ts`, shared with the form's own suite.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { growthRefusing } from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { GrowthOutcome } from "../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { CreateInvite } from "./CreateInvite.js";
import {
  CONTROL_PLANE_HOST,
  MINTED_INVITE_ID,
  MINTED_TOKEN,
  bridgeFor,
  mintsReaching,
  pressSend,
  scenarioMinting,
  settle,
} from "./create-invite.test-support.js";
import { SESSION_ID } from "./sent-invites.test-support.js";

/** The link the composed arm renders, spelled the way `Spec-002 §Invite Delivery` does. */
const COMPOSED_LINK = `https://${CONTROL_PLANE_HOST}/invite/${MINTED_TOKEN}`;

/** What one host read answers. */
type HostRead = (request: unknown) => Promise<GrowthOutcome<{ readonly host: string }>>;

/**
 * A host read that refuses the first time and serves every time after it.
 *
 * The shape the whole thread is about: the mint's own read refuses — leaving a real
 * invitation whose link this console could not write — and the retry's read answers.
 * `held` is for the case that has to observe the window WHILE that second read is
 * out; without one it answers immediately.
 */
function hostRefusingThenServing(held?: Promise<void>): HostRead {
  const refuse = growthRefusing("controlPlaneHostRead");
  let reads = 0;
  return async (request) => {
    reads += 1;
    if (reads === 1) {
      return await refuse(request);
    }
    await held;
    return { status: "served", value: { host: CONTROL_PLANE_HOST } };
  };
}

/** Press the retry the refused arm offers, and let its read land. */
async function pressRetry(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".meridian-invite-reveal__retry")?.click();
    await crossMacrotaskBoundary();
  });
  await settle();
}

/** Mint one invitation against the given host read, and hand back what it produced. */
async function mintWith(hostRead: HostRead): Promise<{
  readonly container: HTMLElement;
  readonly calls: readonly { readonly method: string }[];
}> {
  const { bridge, calls } = bridgeFor(scenarioMinting(), { controlPlaneHostRead: hostRead });
  const { container } = render(
    <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
  );
  await settle();
  await pressSend(container);
  return { container, calls };
}

describe("creating an invitation — a link the host read could not compose", () => {
  it("keeps the token and composes the link from it when a retry is answered", async () => {
    const { container, calls } = await mintWith(hostRefusingThenServing());

    // The invitation is on screen and the link is not — and the token is not either,
    // which is the point: it is HELD, never rendered on its own.
    expect(container.textContent ?? "").toContain(MINTED_INVITE_ID);
    expect(container.textContent ?? "").toContain("wire-unregistered");
    expect(container.textContent ?? "").not.toContain(MINTED_TOKEN);

    await pressRetry(container);

    expect(container.textContent ?? "").toContain(COMPOSED_LINK);
    // And the retry asked the HOST again rather than minting a second invitation for
    // one intent, which would leave the first standing in the ledger against a person
    // who was only asking for the link they had already been promised.
    expect(mintsReaching(calls)).toBe(1);
  });

  it("asks the host once however many times the retry is pressed", async () => {
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const hostRead = vi.fn(hostRefusingThenServing(held));
    const { container } = await mintWith(hostRead);
    expect(hostRead).toHaveBeenCalledTimes(1);

    // Synchronous on purpose: the second press lands while the first read is still
    // out, which is the only moment a second one could be sent.
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-invite-reveal__retry")?.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-invite-reveal__retry")?.click();
    });
    expect(hostRead).toHaveBeenCalledTimes(2);

    answer();
    await settle();
    expect(container.textContent ?? "").toContain(COMPOSED_LINK);
  });

  it("negative control: a host that answers the first time offers no retry at all", async () => {
    // Without this the cases above would pass over a reveal that rendered a retry
    // beside every link, which is a control offered against nothing.
    const { bridge } = bridgeFor(scenarioMinting());
    const { container } = render(
      <CreateInvite bridge={bridge} sessionId={SESSION_ID} onMinted={() => undefined} />,
    );
    await settle();
    await pressSend(container);

    expect(container.querySelector(".meridian-invite-reveal__retry")).toBeNull();
    expect(container.textContent ?? "").toContain(COMPOSED_LINK);
  });
});
