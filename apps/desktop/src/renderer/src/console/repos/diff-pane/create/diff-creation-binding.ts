// How the diff pane holds its creation controller, and nothing about the creation.
//
// SPLIT FROM THE CONTROLLER ON `prepare-binding.ts`'S SEAM, and for its reasons: the
// class beside this one collaborates with the bridge and owns what a resolution and a
// mint publish; this module collaborates with React's rendering lifecycle and owns when
// a controller is opened, armed, and ended. They meet at one object.
//
// KEYED BY THE SUBJECT AND NOT BY THE PANE, which is what makes a diff survive a pane
// the deck re-mounts and what stops one pane's change set appearing in another's: the
// key is `diffCreateSubjectKey`, so the two id spaces a diff can be opened over cannot
// collide even if the daemon ever minted one string in both.
//
// THE SESSION STORE IS THE AXIS NO KEY CARRIES, which is `store/session-store-rebind.ts`'s
// rule and is applied by the hook underneath rather than restated here.

import { useCallback, useEffect, useMemo } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import { useActController, type SessionStore } from "../../../store/index.js";
import type { ComparedStates } from "../patch-parse.js";
import { diffCreateSubjectKey, type DiffCreateSubject } from "./diff-create-subject.js";
import { DiffArtifactCreationController } from "./diff-creation-controller.js";
import type { DiffCreationReading } from "./diff-creation-model.js";

/** What the hook hands the form: the reading, and the three things it can ask for. */
export interface DiffCreationBinding {
  readonly reading: DiffCreationReading;
  /**
   * The identity of the controller behind this binding, for state that must die with it.
   *
   * TYPED `object` SO A SURFACE SCOPES TO IT AND NEVER REACHES THROUGH IT, which is
   * `prepare-binding.ts`'s own reason: the two refs a person typed belong to the subject
   * they were typed for, and a plain register would carry them across a re-mint the pane
   * never remounts through — leaving a base and a head above a controller that has
   * resolved a different subject.
   */
  readonly controllerIdentity: object;
  /** Mint a diff between two named states, and read its payload back. */
  readonly createDiff: (comparedStates: ComparedStates) => void;
  /** Ask what this diff would be attributed to again, after a refused resolution. */
  readonly retryResolution: () => void;
  /** Put the act half back to idle, so a second create does not meet the first's arm. */
  readonly clearAct: () => void;
}

/** Bind one subject's diff creation to the pane that opened over it. */
export function useDiffCreation(
  bridge: ConsoleBridge,
  subject: DiffCreateSubject,
  sessionStore: SessionStore,
): DiffCreationBinding {
  // THE CLOCK COMES FROM THE BRIDGE, on `repo-mounts-binding.ts`'s reason: one window,
  // one time base. Memoised because the real arm mints a fresh clock per call and a new
  // object every render would re-mint the controller beneath it.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { controller, reading } = useActController(
    bridge,
    diffCreateSubjectKey(subject),
    sessionStore,
    () => new DiffArtifactCreationController({ bridge, subject, sessionStore, clock }),
  );
  useEffect(() => {
    controller.start();
  }, [controller]);
  const createDiff = useCallback(
    (comparedStates: ComparedStates) => {
      void controller.createDiff(comparedStates);
    },
    [controller],
  );
  const retryResolution = useCallback(() => {
    controller.retryResolution();
  }, [controller]);
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, controllerIdentity: controller, createDiff, retryResolution, clearAct };
}
