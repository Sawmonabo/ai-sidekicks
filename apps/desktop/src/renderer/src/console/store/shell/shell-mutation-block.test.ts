// What the shell's condition means for a control, asserted arm by arm.
//
// This vocabulary is the console's answer to "may I send this", and every surface that
// disables a control reads it. Two properties carry the whole design and both are
// asserted here against their own controls: exactly the mutating methods are blocked
// and no others, and silence is not an outage.
//
// WHICH METHODS ARE MUTATING IS ASSERTED TWICE, on purpose and against two different
// things. The tuple is pinned here, where a reader meets it; holding it against the
// daemon's own `mutating: true` registrations is review's half, and it is the half a
// literal in a test cannot check — it would just be the same claim written down again.

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
  it("is exactly the record methods the registry binds", () => {
    // NOT A CENSUS OF SHIPPED HANDLERS, and never was: a verb the console can call
    // before the daemon carries a handler for it is unregistered, never read-only.
    // The authority is the corpus registration — every registered method's own
    // `query` / `mutation` cell — mirrored on the bridge side by
    // the `kind` column on `bridge/daemon/daemon-reply-registry.ts`'s own rows, which
    // the call door refuses on. This literal is the render side's copy, because
    // `store/` sits below `bridge/` on the console DAG and cannot import it; the two
    // are held equal in both directions by that registry's own suite.
    //
    // `session.join` is a durable act the daemon PROXIES to the control plane, which
    // is why the reply registry binds it as a record: a durable act is no less durable
    // for having been forwarded.
    expect([...MUTATING_DAEMON_METHODS]).toEqual([
      "run.queueCreate",
      "run.queueCancel",
      "run.pause",
      "run.resume",
      "run.intervene",
      "driver.interruptRun",
      "driver.compactContext",
      "driver.respondToRequest",
      "repo.attach",
      "repo.workspaceBind",
      "repo.executionModeSelect",
      "repo.executionRootPrepare",
      "repo.ephemeralClonePrepare",
      "repo.ephemeralCloneDispose",
      "repo.worktreeRetire",
      "session.create",
      "session.join",
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
      // The collaboration plane's read.
      "channel.list",
      // The repo plane's four reads, beside the seven writes that are not.
      "repo.mountRead",
      "repo.workspaceList",
      "repo.worktreeReuseCheck",
      "repo.worktreeStatusRead",
      // The queue's read, beside the create and the cancel that are not.
      "run.queueList",
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

  it("closes the roster act the daemon proxies, and only while it is closed", () => {
    // NAMED RATHER THAN LEFT TO THE LOOP ABOVE, because this is the act the daemon
    // only forwards, and the session surfaces disable their controls from exactly this
    // seam. A regression that dropped it from the tuple would leave the loop above
    // passing over a smaller set and say nothing at all.
    const offline = stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined });
    const stopped = stateWith({ kind: "stopped" });
    const connected = stateWith({ kind: "connected" });

    for (const method of ["session.join"]) {
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
