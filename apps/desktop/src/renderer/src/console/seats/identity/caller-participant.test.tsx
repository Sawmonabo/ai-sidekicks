// The one composition of "which participant is this window", driven through a render.
//
// What this file holds is what the SEAT adds and not what it composes. Whether an
// identity read is asked once per subject is `growth-read.test.tsx`'s, and whether a
// settled identity is looked up in the store it was read against is
// `store/hooks.caller-membership-role.test.tsx`'s. What is only true here is that the
// adapter three view families used to write out — port outcome in, identifier or
// refusal out — is wired to the real port on both arms, and that the identity-only hook
// answers without a roster, which is why it exists beside the chained one.
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
import {
  CALLER_PARTICIPANT_ORIGIN,
  callerParticipantIdentityFrom,
  useCallerMembershipRoleFor,
  useCallerParticipantIdentity,
} from "./caller-participant.js";

/** The port's own refusal for this operation, built by the module that mints them. */
const IDENTITY_REFUSED = growthUnavailable("callerParticipantRead");

/** What a rejection looks like when the bridge never reaches the daemon. */
const TRANSPORT_FAILURE = new Error("the bridge never answered");

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

/** A store with no roster at all: the identity chain must still settle its own half. */
function emptyStore(sessionId: string): SessionStore {
  const store = new SessionStore({ sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

/** The identity arm, flattened so a case reads as one assertion. */
function IdentityProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
}): React.JSX.Element {
  const identity = useCallerParticipantIdentity(props.bridge, props.sessionId);
  const detail =
    identity === undefined
      ? "asking"
      : identity.status === "read"
        ? identity.participantId
        : `${identity.refusal.origin}/${identity.refusal.code}`;
  return <span data-testid="identity">{detail}</span>;
}

/** The role arm, flattened the same way. */
function RoleProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly store: SessionStore;
}): React.JSX.Element {
  const caller = useCallerMembershipRoleFor(props.bridge, props.store);
  const detail =
    caller.status === "read"
      ? `${caller.participantId}:${caller.role ?? "no-role"}`
      : caller.status === "refused"
        ? caller.refusal.code
        : "";
  return <span data-testid="role">{`${caller.status}|${detail}`}</span>;
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

describe("the identity-only read", () => {
  it("is the not-yet-answered absence before the port answers", () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, () => new Promise(() => undefined));
    const { getByTestId } = render(<IdentityProbe bridge={bridge} sessionId="session-1" />);
    expect(getByTestId("identity").textContent).toBe("asking");
  });

  it("answers the participant with no roster in the store to look one up in", async () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, async (sessionId) =>
      Promise.resolve({ status: "served", value: { participantId: `caller-of-${sessionId}` } }),
    );
    const { getByTestId } = render(<IdentityProbe bridge={bridge} sessionId="session-1" />);
    await act(crossMacrotaskBoundary);
    expect(getByTestId("identity").textContent).toBe("caller-of-session-1");
    expect(ledger.sessionIds).toStrictEqual(["session-1"]);
  });

  it("carries the port's refusal rather than reporting a bare absence", async () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, async () => Promise.resolve(IDENTITY_REFUSED));
    const { getByTestId } = render(<IdentityProbe bridge={bridge} sessionId="session-1" />);
    await act(crossMacrotaskBoundary);
    expect(getByTestId("identity").textContent).toBe(
      `${IDENTITY_REFUSED.origin}/${IDENTITY_REFUSED.code}`,
    );
  });

  it("names this read as the origin when the call produced no outcome at all", async () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, () => Promise.reject(TRANSPORT_FAILURE));
    const { getByTestId } = render(<IdentityProbe bridge={bridge} sessionId="session-1" />);
    await act(crossMacrotaskBoundary);
    expect(getByTestId("identity").textContent).toContain(`${CALLER_PARTICIPANT_ORIGIN}/`);
  });

  it("asks nothing at all where there is no session to ask about", () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, async () => Promise.resolve(IDENTITY_REFUSED));
    const { getByTestId } = render(<IdentityProbe bridge={bridge} sessionId={undefined} />);
    expect(getByTestId("identity").textContent).toBe("asking");
    expect(ledger.sessionIds).toStrictEqual([]);
  });
});

describe("the role-chained read", () => {
  it("asks the port under the store's own session and settles the identity half", async () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, async () =>
      Promise.resolve({ status: "served", value: { participantId: "participant-1" } }),
    );
    const { getByTestId } = render(<RoleProbe bridge={bridge} store={emptyStore("session-7")} />);
    await act(crossMacrotaskBoundary);
    expect(ledger.sessionIds).toStrictEqual(["session-7"]);
    expect(getByTestId("role").textContent).toBe("read|participant-1:no-role");
  });

  it("carries the port's refusal through the chain rather than an unknown role", async () => {
    const ledger: AskLedger = { sessionIds: [] };
    const bridge = bridgeAnswering(ledger, async () => Promise.resolve(IDENTITY_REFUSED));
    const { getByTestId } = render(<RoleProbe bridge={bridge} store={emptyStore("session-7")} />);
    await act(crossMacrotaskBoundary);
    expect(getByTestId("role").textContent).toBe(`refused|${IDENTITY_REFUSED.code}`);
  });
});
