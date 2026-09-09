// The roster and the registry, held equal in BOTH directions.
//
// Two families answer "is this method a write": `bridge/` classifies every registered
// method in `daemon-method-classification.ts`, which the call door refuses on, and
// `store/shell/shell-mutation-block.ts` carries the roster the render side disables
// controls from. The store family sits BELOW the bridge on the console DAG and may
// not import it, so the two answers are two literals — and two literals about one set
// drift. This suite is what keeps them from drifting, and it checks both directions:
// a roster member the registry does not classify as a record is a control disabled
// for a write that does not exist, and a record the roster omits is a write that
// stays live through an outage with its control still offering itself.
//
// It compares VALUES the two modules export, not source text: the classification's
// own totality over the registry is a compile-time claim the annotation makes, and
// what a runtime check adds is the pairing.

import {
  DAEMON_METHOD_KINDS,
  RECORD_DAEMON_METHODS,
  isRecordDaemonMethod,
} from "./daemon-method-classification.js";
import { CONSOLE_DAEMON_METHODS } from "./daemon-reply-registry.js";
import { MUTATING_DAEMON_METHODS, isMutatingDaemonMethod } from "../../store/index.js";

describe("the record classification covers the registry", () => {
  it("classifies every method the registry binds, and nothing else", () => {
    expect(Object.keys(DAEMON_METHOD_KINDS).toSorted()).toStrictEqual(
      [...CONSOLE_DAEMON_METHODS].toSorted(),
    );
  });

  it("answers false for a method the registry does not bind", () => {
    // A name that reaches no wire through this console has no write for the
    // supervisor block to close, so the door lets the registry refuse it instead.
    expect(isRecordDaemonMethod("session.read")).toBe(false);
    expect(isRecordDaemonMethod("")).toBe(false);
  });
});

describe("the roster IS the registry's record set", () => {
  it("names every record the registry binds", () => {
    const unrostered = RECORD_DAEMON_METHODS.filter((method) => !isMutatingDaemonMethod(method));

    expect(unrostered).toStrictEqual([]);
  });

  it("names nothing the registry does not bind as a record", () => {
    const unregistered = MUTATING_DAEMON_METHODS.filter((method) => !isRecordDaemonMethod(method));

    expect(unregistered).toStrictEqual([]);
  });

  it("leaves every read off the roster", () => {
    const reads = CONSOLE_DAEMON_METHODS.filter((method) => DAEMON_METHOD_KINDS[method] === "read");

    expect(reads.filter((method) => isMutatingDaemonMethod(method))).toStrictEqual([]);
    // The complement is non-empty, so the assertion above is not vacuously true.
    expect(reads.length).toBeGreaterThan(0);
  });
});
