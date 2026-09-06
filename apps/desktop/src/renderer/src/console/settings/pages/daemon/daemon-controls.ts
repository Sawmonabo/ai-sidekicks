// The local-runtime page's reads and its two controls.
//
// SPLIT FROM THE PAGE for the reason its neighbours are: what is here owns
// lifetimes — a read that must not be answered by a stale reply, and two dispatches
// whose refusal has to reach the surface — and the page owns markup. The two fail
// differently and are read by different people.
//
// THE SUPERVISOR STATE IS NOT READ HERE. It arrives on the page's own context, from
// the one subscription the frame keeps live for the window. A page that re-read it
// would be a second answer to "is the runtime up", free to disagree with the chip in
// the corner of the same window.
//
// WHAT IS READ HERE is the one fact the subscription does not carry: the daemon's own
// reported status line and the version it is running. That read is not registered on
// any bridge namespace, so it goes through the growth port and refuses by name where
// the build does not carry it.

import { useCallback, useEffect } from "react";

import type { GrowthPort } from "../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { useSubjectScopedState } from "../../../store/index.js";

/** What the daemon says about itself, once it has been asked. */
export interface DaemonStatus {
  readonly state: string;
  readonly version: string;
}

/** The read's three phases. `reading` is the seed; the other two are settlements. */
export type DaemonStatusReading =
  | { readonly phase: "reading" }
  | { readonly phase: "read"; readonly status: DaemonStatus }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Read the daemon's own status line once per port.
 *
 * `useSubjectScopedState` rather than a bare `useState`, because the answer is scoped
 * to the port that produced it: a window whose bridge is swapped — which the fixture
 * does on a scenario change — must not keep rendering the previous port's answer, and
 * the publisher this hook hands back is bound to the visit that dispatched the read,
 * so a reply that arrives after a swap is dropped instead of overwriting a newer one.
 */
export function useDaemonStatus(growth: GrowthPort): DaemonStatusReading {
  const read = useSubjectScopedState<DaemonStatusReading>(growth, "daemon-status", () => ({
    phase: "reading",
  }));
  const { publish } = read;
  useEffect(() => {
    void (async () => {
      const outcome = await growth.daemonStatusRead({});
      publish(
        outcome.status === "served"
          ? { phase: "read", status: outcome.value }
          : { phase: "refused", refusal: outcome },
      );
    })();
  }, [growth, publish]);
  return read.value;
}

/** Which of the two controls was pressed. Closed, because the page offers two. */
export type DaemonControl = "stop" | "restart";

/** What a dispatched control settled as, or `undefined` while none has been. */
export type DaemonControlSettlement =
  | { readonly control: DaemonControl; readonly outcome: "sent" }
  | {
      readonly control: DaemonControl;
      readonly outcome: "refused";
      readonly refusal: ConsoleRefusal;
    };

/**
 * Dispatch one control and report what came back.
 *
 * `sent` AND NOT `done`, deliberately. Neither operation reports the state it
 * produced — a stop that was accepted is not a runtime that has stopped — and the
 * supervisor's next report is what says so. The settlement here says only that the
 * console asked and was not refused, which is the whole of what the call answers.
 */
export function useDaemonControl(
  growth: GrowthPort,
  onSettled: (settlement: DaemonControlSettlement) => void,
): (control: DaemonControl) => void {
  return useCallback(
    (control: DaemonControl) => {
      void (async () => {
        const outcome =
          control === "stop" ? await growth.daemonStop({}) : await growth.daemonRestart({});
        onSettled(
          outcome.status === "served"
            ? { control, outcome: "sent" }
            : { control, outcome: "refused", refusal: outcome },
        );
      })();
    },
    [growth, onSettled],
  );
}
