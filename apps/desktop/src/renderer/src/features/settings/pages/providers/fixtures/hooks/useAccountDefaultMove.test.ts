// Two `Set as default` presses in flight: only the newer press's reply is drawn, so an older one
// refused after the newer one landed cannot mark the page refused.

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { manualGate, type ManualGate } from "#test/helpers/held-calls.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { ACCOUNT_REGISTRY } from "../AccountsFixtureBody.test-support.js";
import type { ProviderAccountSetCurrentCall } from "../sign-in/flow.js";
import { useAccountDefaultMove } from "./useAccountDefaultMove.js";

const FIRST = "account-first" as ProviderAccountId;
const SECOND = "account-second" as ProviderAccountId;

it("draws the newest press's reply, not an older one that settles after it", async () => {
  const [account] = ACCOUNT_REGISTRY.phase === "read" ? ACCOUNT_REGISTRY.accounts : [];
  const gates = new Map<ProviderAccountId, ManualGate>();
  // The first press is refused and the second lands, each once the case lets it through.
  const setCurrent = vi.fn<ProviderAccountSetCurrentCall>(async ({ accountId }) => {
    const gate = manualGate();
    gates.set(accountId, gate);
    await gate.promise;
    if (accountId === FIRST) {
      throw new Error("That account is not signed in.");
    }
    return { account: { ...account!, isDefault: true }, movingSessions: [] };
  });
  const onMoved = vi.fn();
  const { result } = renderHook(() => useAccountDefaultMove(setCurrent, onMoved));

  act(() => {
    result.current.setAsDefault(FIRST);
  });
  act(() => {
    result.current.setAsDefault(SECOND);
  });
  await act(async () => {
    gates.get(SECOND)!.open();
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    gates.get(FIRST)!.open();
    await crossMacrotaskBoundary();
  });

  expect(result.current.move).toStrictEqual({ kind: "idle" });
  expect(onMoved).toHaveBeenCalledOnce();
});
