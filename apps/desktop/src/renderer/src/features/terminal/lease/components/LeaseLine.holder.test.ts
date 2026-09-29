// The holding line — every state the fold can settle into, and the sentence each one
// renders.
//
// The lease STATE is a value here rather than a fold from a scenario, because
// `lease-model.test.ts` already holds the fold to the wire and this file's subject is
// what each state RENDERS. Its bridges and its render call come from
// `LeaseLine.test-support.tsx`, which every suite in this split shares.
//
// The take CALL is `LeaseLine.take-shell.test.tsx`, and the one gate on the control — this
// device's identity — is `LeaseLine.device-identity.test.ts`.

import { describe, expect, it } from "vitest";

import { TERMINAL_LEASE_HOLDERS, UNREAD_TERMINAL_LEASE } from "../lease-model.js";
import { leaseState, renderLease } from "./LeaseLine.test-support.js";
import { OTHER_DEVICE_ID, THIS_DEVICE_ID } from "../lease-model.test-support.js";

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
    // The shell belongs to the one person using this machine, so a hold this device
    // does not have is one of their other devices. The identifier the wire sent is not
    // rendered: it answers a question nobody asked with a value nobody can act on.
    const { container } = renderLease(
      leaseState({
        holding: "held-by-another-device",
        holderUserId: OTHER_DEVICE_ID,
      }),
    );
    expect(container.textContent).toContain("Held");
    expect(container.textContent).toContain("The shell is held from another device.");
    expect(container.textContent).not.toContain(OTHER_DEVICE_ID);
  });

  it("tells the holding device it may type, and offers no control at all", () => {
    const { container } = renderLease(
      leaseState({
        holding: "held-by-this-device",
        holderUserId: THIS_DEVICE_ID,
      }),
    );
    expect(container.textContent).toContain("You hold it");
    expect(container.textContent).toContain("You may type into the shared shell.");
    // The idempotent self-take is not reachable from the lease line, so there is no
    // transition for it to animate; and there is no release control to hand back with.
    expect(container.querySelector(".meridian-lease-line__take")).toBeNull();
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
    // Counted off the closed set rather than written down, so a sixth holding added
    // without a sentence of its own fails here instead of quietly reading like one
    // of the five.
    const sentences = new Set(
      (
        [
          UNREAD_TERMINAL_LEASE,
          leaseState({ holding: "unheld" }),
          leaseState({
            holding: "held-by-another-device",
            holderUserId: OTHER_DEVICE_ID,
          }),
          leaseState({
            holding: "held-by-this-device",
            holderUserId: THIS_DEVICE_ID,
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
