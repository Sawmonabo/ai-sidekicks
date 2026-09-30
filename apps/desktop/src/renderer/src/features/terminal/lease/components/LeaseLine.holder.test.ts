// The holding line: every state the fold can settle into, and the sentence each renders. The
// lease state is a value here, since `lease-model.test.ts` holds the fold to the wire. Bridges
// and the render call come from `LeaseLine.test-support.tsx`; the take call is
// `LeaseLine.take-shell.test.tsx` and the identity gate is `LeaseLine.device-identity.test.ts`.

import { describe, expect, it } from "vitest";

import { TERMINAL_LEASE_HOLDERS, UNREAD_TERMINAL_LEASE } from "../lease-model.js";
import { leaseState, renderLease } from "./LeaseLine.test-support.js";
import {
  COMMAND_ID,
  OTHER_DEVICE_ID,
  RUN_ID,
  THIS_DEVICE_ID,
} from "../lease-model.test-support.js";

describe("the holding line — every state the fold settles into", () => {
  it("says the lease has not been read, which is not the lease being free", () => {
    const { container } = renderLease(UNREAD_TERMINAL_LEASE);
    expect(container.textContent).toContain("Not checked");
    expect(container.textContent).toContain("The lease has not been read.");
    expect(container.textContent).not.toContain("Nobody holds the shell.");
  });

  it("renders a free lease as an explicit unheld state", () => {
    const { container } = renderLease(leaseState({ holding: "unheld" }));
    expect(container.textContent).toContain("Free");
    expect(container.textContent).toContain("Nobody holds the shell.");
  });

  it("says a hold this device does not have is held elsewhere, and names nobody", () => {
    // The shell belongs to one person, so a hold this device lacks is another of their devices;
    // the identifier the wire sent is not rendered.
    const { container } = renderLease(
      leaseState({
        holding: "held-by-another-device",
        holderDeviceId: OTHER_DEVICE_ID,
      }),
    );
    expect(container.textContent).toContain("Held");
    expect(container.textContent).toContain("The shell is held from another device.");
    expect(container.textContent).not.toContain(OTHER_DEVICE_ID);
    // Negative control for the run's line below: every other holding draws its chip.
    expect(container.querySelector(".meridian-chip")).not.toBeNull();
  });

  it("tells the holding device it may type, and offers no control at all", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-this-device",
        holderDeviceId: THIS_DEVICE_ID,
      }),
    );
    expect(container.textContent).toContain("You hold it");
    expect(container.textContent).toContain("You may type into the shared shell.");
    // The self-take is not reachable from the lease line, so there is no transition to animate
    // and no release control.
    expect(container.querySelector(".meridian-lease-line__take")).toBeNull();
  });

  it("reads the design's sentence alone, with no chip, when a run holds the shell", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-run",
        holderDeviceId: THIS_DEVICE_ID,
        holderRunId: RUN_ID,
        holderCommandId: COMMAND_ID,
      }),
    );
    // The sentence alone, with no chip beside it.
    expect(container.textContent).toContain("Running command holds the shell.");
    expect(container.querySelector(".meridian-chip")).toBeNull();
    // The run's machine is the holding device, and that may be this one; the line
    // still never tells it that it may type.
    expect(container.textContent).not.toContain("You may type into the shared shell.");
  });

  it("says the lease is unreadable when a transition arrived this build cannot read", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        unreadTransition: {
          reason: "auto_released_quota_exhausted",
        },
      }),
    );
    expect(container.textContent).toContain("Unread transition");
    expect(container.textContent).toContain("The console cannot read where the shell is held.");
    // The reason travels verbatim and in mono, because it is a wire string the
    // operator pastes into a search rather than prose this console wrote.
    expect(container.textContent).toContain("auto_released_quota_exhausted");
    // The two sentences that would be lies here: nobody said the lease is free, and
    // nobody said this device may type.
    expect(container.textContent).not.toContain("Nobody holds the shell.");
    expect(container.textContent).not.toContain("You may type into the shared shell.");
  });

  it("says it plainly when the unread transition named no reason at all", () => {
    const { container } = renderLease(
      leaseState({
        holding: "unrecognized-transition",
        unreadTransition: {
          reason: undefined,
        },
      }),
    );
    expect(container.textContent).toContain("this build cannot read");
    // No dangling "The wire called it ." where there was nothing to name.
    expect(container.textContent).not.toContain("The wire called it");
  });

  it("negative control: every holding renders its own sentence", () => {
    // Counted off the closed set, so a holding added without a sentence fails here.
    const sentences = new Set(
      (
        [
          UNREAD_TERMINAL_LEASE,
          leaseState({ holding: "unheld" }),
          leaseState({
            holding: "held-by-another-device",
            holderDeviceId: OTHER_DEVICE_ID,
          }),
          leaseState({
            holding: "held-by-this-device",
            holderDeviceId: THIS_DEVICE_ID,
          }),
          leaseState({
            holding: "held-by-run",
            holderDeviceId: THIS_DEVICE_ID,
            holderRunId: RUN_ID,
            holderCommandId: COMMAND_ID,
          }),
          leaseState({
            holding: "unrecognized-transition",
            unreadTransition: {
              reason: "auto_released_quota_exhausted",
            },
          }),
        ] as const
      ).map((state) => renderLease(state).container.textContent),
    );
    expect(sentences.size).toBe(TERMINAL_LEASE_HOLDERS.length);
  });
});
