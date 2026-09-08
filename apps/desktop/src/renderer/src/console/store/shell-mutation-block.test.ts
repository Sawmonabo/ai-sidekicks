// What the shell's condition means for a control, asserted arm by arm.
//
// This vocabulary is the console's answer to "may I send this", and every surface that
// disables a control reads it. Two properties carry the whole design and both are
// asserted here against their own controls: exactly the mutating methods are blocked
// and no others, and silence is not an outage.
//
// WHICH METHODS ARE MUTATING IS ASSERTED TWICE, on purpose and against two different
// things. The tuple is pinned here, where a reader meets it; and
// `test/console/architecture/daemon-mutating-registrations.test.ts` holds it against
// the daemon's own `mutating: true` registrations, which is the half a literal in a
// test cannot check — it would just be the same claim written down again.

import { describe, expect, it } from "vitest";

import { UNREPORTED_SHELL_STATE } from "./shell-state.js";
import {
  MUTATING_DAEMON_METHODS,
  isMutatingDaemonMethod,
  shellBlockForMethod,
  shellMutationBlock,
} from "./shell-mutation-block.js";
import { REPORTED_CONNECTIONS, stateWith } from "./shell-state.test-support.js";

describe("the mutating method set", () => {
  it("is exactly the nine the corpus registers mutating", () => {
    // Six of them are the handlers the daemon has shipped. The other three are
    // registered mutating by their own plane's contract and have no handler yet —
    // which is why the set is not a census of what has landed: an unregistered verb
    // the console can already call is unregistered, never read-only.
    //
    // `membership.update` and `invite.revoke` are two of those three, and they are
    // here because they are durable acts the daemon PROXIES to the control plane. The
    // reply registry's `CHANGES_A_RUN` table answers a different question about them —
    // whether a call moves a run — and says so in its own words while calling them
    // "mutations all the same" that "change the session's own roster".
    expect([...MUTATING_DAEMON_METHODS]).toEqual([
      "session.create",
      "session.join",
      "membership.update",
      "invite.revoke",
      "driver.interruptRun",
      "driver.applyIntervention",
      "driver.respondToRequest",
      "driver.compactContext",
      "providerAccount.probe",
    ]);
  });

  it("does not claim a read is mutating — the control", () => {
    // These stay live through every outage, and the whole read-only design is wrong
    // if one of them is caught in the predicate.
    for (const method of [
      "session.read",
      "session.subscribe",
      "presence.read",
      "presence.subscribe",
      "driver.listCapabilities",
      "driver.listModels",
      "driver.listModes",
      "driver.listProviderCommands",
      "driver.subscribeEvents",
      "daemon.hello",
      // The account plane's own read, beside the probe that is not one.
      "providerAccount.list",
    ]) {
      expect(isMutatingDaemonMethod(method), method).toBe(false);
    }
  });
});

describe("shellMutationBlock", () => {
  it("blocks nothing before anything has been reported", () => {
    // Silence is not an outage. Treating it as one would disable every mutating
    // control in every shipped window, which is the renderer deriving an eligibility
    // nobody told it.
    expect(shellMutationBlock(UNREPORTED_SHELL_STATE)).toBeUndefined();
  });

  it("blocks nothing while connected", () => {
    expect(shellMutationBlock(stateWith({ kind: "connected" }))).toBeUndefined();
  });

  it("names a cause on every other arm, and never an empty one", () => {
    for (const connection of REPORTED_CONNECTIONS) {
      if (connection.kind === "connected") {
        continue;
      }
      const block = shellMutationBlock(stateWith(connection));
      expect(block, connection.kind).toBeDefined();
      expect(block?.code.length ?? 0, connection.kind).toBeGreaterThan(0);
      expect(block?.detail.length ?? 0, connection.kind).toBeGreaterThan(0);
    }
  });

  it("carries the attempt count into the reconnecting cause", () => {
    const block = shellMutationBlock(
      stateWith({ kind: "reconnecting", attempt: 3, attemptLimit: 5 }),
    );
    expect(block?.detail).toContain("attempt 3 of 5");
  });

  it("tells a stopped runtime apart from an unreachable one", () => {
    // Folding the two would report a runtime somebody turned off as one that could
    // not be reached, which sends a person looking for a fault that is not there.
    expect(shellMutationBlock(stateWith({ kind: "stopped" }))?.code).toBe("shell-stopped");
    expect(
      shellMutationBlock(stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined }))
        ?.code,
    ).toBe("shell-offline");
  });
});

describe("shellBlockForMethod", () => {
  it("blocks every mutating method while the shell is offline", () => {
    const offline = stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined });
    for (const method of MUTATING_DAEMON_METHODS) {
      expect(shellBlockForMethod(offline, method), method).toBeDefined();
    }
  });

  it("leaves reads live through the same outage — the control", () => {
    const offline = stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined });
    expect(shellBlockForMethod(offline, "session.read")).toBeUndefined();
    expect(shellBlockForMethod(offline, "driver.subscribeEvents")).toBeUndefined();
  });

  it("closes the two roster acts the daemon proxies, and only while it is closed", () => {
    // NAMED RATHER THAN LEFT TO THE LOOP ABOVE, because these two are the pair whose
    // classification the reply registry's run-change table answers `false` for — a
    // different question — and the collaboration surfaces disable their controls from
    // exactly this seam. A regression that dropped them from the tuple would leave the
    // loop above passing over a smaller set and say nothing at all.
    const offline = stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined });
    const stopped = stateWith({ kind: "stopped" });
    const connected = stateWith({ kind: "connected" });

    for (const method of ["membership.update", "invite.revoke"]) {
      expect(shellBlockForMethod(offline, method)?.code, method).toBe("shell-offline");
      expect(shellBlockForMethod(stopped, method)?.code, method).toBe("shell-stopped");
      // ADMITTED OTHERWISE, which is the half a blanket block would also satisfy: a
      // console that closed these controls whatever the shell said would pass every
      // assertion above.
      expect(shellBlockForMethod(connected, method), method).toBeUndefined();
      expect(shellBlockForMethod(UNREPORTED_SHELL_STATE, method), method).toBeUndefined();
    }
  });
});
