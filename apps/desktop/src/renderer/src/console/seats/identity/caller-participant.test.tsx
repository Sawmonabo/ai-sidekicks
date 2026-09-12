// The one composition of "which participant is this window", driven through a render.
//
// What this file holds is what the SEAT adds and not what it composes. Whether an
// identity read is asked once per subject is `growth-read.test.tsx`'s, and whether a
// settled identity belongs to the store it was read against is
// `store/session/caller-identity.test.tsx`'s. What is only true here is that the
// adapter three view families used to write out — port outcome in, identifier or
// refusal out — is wired to the real port on both arms, and that the store-bound hook
// asks under the session its store names.
//
// THE REFUSAL IS ASSERTED BY IDENTITY AND NOT BY SHAPE. The whole point of the
// narrowing is that a refusal travels back untouched: a re-minted one would carry the
// same fields and lose the operation and the slate row the port put on it, and only an
// identity comparison can tell those apart.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { growthUnavailable, type ConsoleBridge } from "../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { SessionStore } from "../../store/index.js";
import { callerParticipantIdentityFrom, useCallerIdentityFor } from "./caller-participant.js";

/** The port's own refusal for this operation, built by the module that mints them. */
const IDENTITY_REFUSED = growthUnavailable("callerParticipantRead");

interface AskLedger {
  readonly sessionIds: string[];
}

/**
 * A bridge that answers the one operation under test, and records what it was asked.
 *
 * A double for the PORT and not for the narrowing behind it: what the seat does with an
 * outcome is the module under test, and the fixture bridge's own answers are driven by
 * the fixture's suite. The refusing arms come from the real refusal minters, so nothing
 * here writes a refusal shape of its own.
 */
function bridgeAnswering(
  ledger: AskLedger,
  answer: (sessionId: string) => Promise<unknown>,
): ConsoleBridge {
  return {
    growth: {
      callerParticipantRead: async (request: { readonly sessionId: string }) => {
        ledger.sessionIds.push(request.sessionId);
        return await answer(request.sessionId);
      },
    },
  } as unknown as ConsoleBridge;
}

/** A store, which is the subject the store-bound read holds its answer against. */
function emptyStore(sessionId: string): SessionStore {
  const store = new SessionStore({ sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

/** The store-bound arm, flattened the same way. */
function StoreBoundProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly store: SessionStore;
}): React.JSX.Element {
  const caller = useCallerIdentityFor(props.bridge, props.store);
  const detail =
    caller.status === "read"
      ? caller.participantId
      : caller.status === "refused"
        ? caller.refusal.code
        : "";
  return <span data-testid="store-bound">{`${caller.status}|${detail}`}</span>;
}

describe("the caller-participant narrowing", () => {
  it("answers the identifier on the served arm", () => {
    expect(
      callerParticipantIdentityFrom({
        status: "served",
        value: { participantId: "participant-1" },
      }),
    ).toBe("participant-1");
  });

  it("hands the port's own refusal back untouched on the refusing arm", () => {
    expect(callerParticipantIdentityFrom(IDENTITY_REFUSED)).toBe(IDENTITY_REFUSED);
  });
});

describe("the store-bound read", () => {
  it("asks the port under the store's own session", async () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, async () =>
      Promise.resolve({ status: "served", value: { participantId: "participant-1" } }),
    );
    const { getByTestId } = render(
      <StoreBoundProbe bridge={bridge} store={emptyStore("session-7")} />,
    );
    await act(crossMacrotaskBoundary);
    expect(ledger.sessionIds).toStrictEqual(["session-7"]);
    expect(getByTestId("store-bound").textContent).toBe("read|participant-1");
  });

  it("carries the port's refusal rather than a bare absence", async () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, async () => Promise.resolve(IDENTITY_REFUSED));
    const { getByTestId } = render(
      <StoreBoundProbe bridge={bridge} store={emptyStore("session-7")} />,
    );
    await act(crossMacrotaskBoundary);
    expect(getByTestId("store-bound").textContent).toBe(`refused|${IDENTITY_REFUSED.code}`);
  });
});
