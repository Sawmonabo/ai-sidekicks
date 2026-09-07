// The browser tier: three settings claims a real engine decides and happy-dom cannot.
//
// The settings family grew two confirming acts and one credential field in this wave,
// and each of the three rests on a behaviour the unit tier's DOM does not implement.
// A unit-tier copy of any case below would go green over the exact shape it exists to
// refuse, which is what puts them here rather than beside their components.
//
//   • FOCUS IS A REAL RING. happy-dom's `focus()` moves `document.activeElement` to
//     anything, and it runs no sequential-focus navigation at all — `{Tab}` there
//     moves nothing. So both halves of a modal claim (the initial focus is the
//     cautious control; the ring cannot leave the popup) are unfalsifiable in that
//     engine and decided in this one.
//   • AN UNCONTROLLED INPUT'S VALUE IS THE ENGINE'S. The token field is deliberately
//     never React state: it is read from a ref inside the submit handler and cleared
//     in the same block. Whether that clear is what a person's browser then holds is a
//     question about the engine's editing pipeline, and typing here goes through it.
//   • A `<p>` RE-PARENTS ITS CHILDREN. Base UI draws `AlertDialog.Description` as a
//     paragraph, and Chromium's parser hoists flow content out of one. The restart
//     note is spans and text for that reason, and this is where that holds or does not
//     — a note that grew a `<div>` would still read correctly in a tolerant DOM while
//     the real one moved it out of the accessible description entirely.

import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { userEvent } from "vitest/browser";

import { pressKeys } from "../console-harness.js";

import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
import { SETTINGS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/settings.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import {
  bridgeAnswering,
  degradedStatus,
  openRecoveryConfirmation,
  overriddenPolicy,
  renderSettledPage,
  stuckInspection,
  FAILED_RUN_ID,
  SESSION_ID,
  STALLED_RUN_ID,
} from "../../../src/renderer/src/console/settings/pages/diagnostics/diagnostics-page.test-support.js";
import { TokenRegistrationForm } from "../../../src/renderer/src/console/settings/pages/provider-accounts/shell/TokenRegistrationForm.js";
import {
  bridgeReporting,
  openRestartConfirmation,
  renderSettled as renderUpdatesBlock,
  restartDialog,
} from "../../../src/renderer/src/console/settings/pages/application/updates/updates-block.test-support.js";
import {
  runEntity,
  sessionStoreHolding,
} from "../../../src/renderer/src/console/settings/settings-page-mount.test-support.js";

/** The popup every settings confirmation draws itself into. It is portalled. */
const CONFIRMATION_SELECTOR = ".meridian-confirm";

/** The confirming act inside it, as opposed to the cancel beside it. */
const CONFIRM_SELECTOR = ".meridian-confirm__confirm";

/** The description Base UI renders as a paragraph. */
const CONFIRMATION_BODY_SELECTOR = ".meridian-confirm__body";

/** A secret no fixture, scenario, or component copy could produce by accident. */
const TYPED_TOKEN = "zzq-never-echoed-token-8213";

/** The open confirmation, or a failure naming the surface that did not open one. */
function openConfirmation(): HTMLElement {
  const dialog = document.body.querySelector<HTMLElement>(CONFIRMATION_SELECTOR);
  if (dialog === null) {
    throw new Error("no settings confirmation is open");
  }
  return dialog;
}

describe("browser — the diagnostics recovery confirmation holds the focus ring", () => {
  /**
   * The page with a degraded node and a run the inspection suspects has stalled.
   *
   * The store is not optional here: the prompt is addressed to ONE run, and the page
   * picks which from the session's own run partition — mounted without one there is
   * no subject, so no prompt, and every case below would fail on an absent dialog
   * rather than on the focus claim it is written for.
   */
  async function renderDiagnostics(): Promise<HTMLElement> {
    const { bridge } = bridgeAnswering({
      status: degradedStatus(),
      stall: stuckInspection("2026-01-01T07:40:00.000Z"),
      policy: overriddenPolicy(),
    });
    return await renderSettledPage(
      bridge,
      sessionStoreHolding(SESSION_ID, [
        runEntity(STALLED_RUN_ID, "running"),
        runEntity(FAILED_RUN_ID, "failed"),
      ]),
    );
  }

  it("opens on the cautious control, never on the act itself", async () => {
    const container = await renderDiagnostics();
    await openRecoveryConfirmation(container, "Interrupt");
    const dialog = openConfirmation();

    // The ring is inside the popup — the modal took it — and it is NOT on the button
    // that performs the act. `primitives/ConfirmationDialog.tsx` states this as the
    // property every surface that confirms must not drift on: the cancel is the
    // dialog's default, so a person who answers by reflex declines rather than
    // interrupts a run.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(dialog.querySelector(CONFIRM_SELECTOR));
  });

  it("keeps the ring inside the popup across a full tab cycle", async () => {
    const container = await renderDiagnostics();
    await openRecoveryConfirmation(container, "Interrupt");
    const dialog = openConfirmation();

    // Enough presses to leave any dialog this component can draw: it renders a fixed
    // two acts, so six forward stops walk the trap round more than twice.
    for (let press = 0; press < 6; press += 1) {
      await pressKeys("{Tab}");
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    // And backwards, which is the direction a trap implemented as "wrap at the last
    // stop" gets wrong: shift-tabbing off the first control escapes it.
    for (let press = 0; press < 6; press += 1) {
      await pressKeys("{Shift>}{Tab}{/Shift}");
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("negative control: tabbing actually moves the ring inside this engine", async () => {
    // Without this, the containment claim above would pass over an engine that never
    // moved focus at all — which is precisely what the unit tier does.
    const container = await renderDiagnostics();
    await openRecoveryConfirmation(container, "Interrupt");
    const dialog = openConfirmation();

    const opened = document.activeElement;
    const stops = [...dialog.querySelectorAll("button")];
    expect(stops.length).toBeGreaterThan(1);
    await pressKeys("{Tab}");
    expect(document.activeElement).not.toBe(opened);
    expect(stops).toContain(document.activeElement);
  });
});

describe("browser — the provider-account token field is write-only in the engine", () => {
  /** The registration form over the shipped fixture, mounted as a window mounts it. */
  function renderRegistrationForm(): HTMLElement {
    const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
    const { container } = render(
      <SidekicksBridgeProvider bridge={bridge}>
        <LiveAnnouncerProvider>
          <TokenRegistrationForm bridge={bridge} />
        </LiveAnnouncerProvider>
      </SidekicksBridgeProvider>,
    );
    document.body.append(container);
    return container;
  }

  /** The token input, by the label the form gives it rather than by position. */
  function tokenFieldIn(container: HTMLElement): HTMLInputElement {
    const label = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.textContent === "Non-interactive token",
    );
    const field = label === undefined ? null : container.querySelector(`#${label.htmlFor}`);
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("the registration form rendered no non-interactive token field");
    }
    return field;
  }

  /** Fill the form the way a person does, then press its submit. */
  async function typeAndSubmit(container: HTMLElement): Promise<void> {
    const label = container.querySelector<HTMLInputElement>('input[type="text"]');
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (label === null || submit === null) {
      throw new Error("the registration form rendered no label field or no submit");
    }
    // A real label is typed because the field is `required`: this engine refuses to
    // submit a form with an empty required control, so a case that skipped it would
    // assert about a submit that never happened.
    // Inside `act`, because these are real events: the state they cause settles after
    // the promise resolves rather than before it, which React reports as an act
    // warning and a case observes as a tree one render behind.
    await act(async () => {
      await userEvent.fill(label, "A machine account");
      await userEvent.fill(tokenFieldIn(container), TYPED_TOKEN);
      await userEvent.click(submit);
      await crossMacrotaskBoundary();
    });
  }

  it("masks the value at the field rather than anywhere above it", () => {
    const container = renderRegistrationForm();
    const field = tokenFieldIn(container);
    expect(field.type).toBe("password");
    // Autofill would put the value back on a later mount, which is the one way a
    // write-only field acquires a value nobody typed into it.
    expect(field.autocomplete).toBe("off");
  });

  it("holds nothing after the submit that sent it", async () => {
    const container = renderRegistrationForm();
    await typeAndSubmit(container);

    // The engine's own value, after its own editing pipeline ran: the handler read the
    // ref, put it on the request, and cleared the input in the same block, so what is
    // left in the field a person is looking at is nothing.
    expect(tokenFieldIn(container).value).toBe("");
    // And the attribute, which is the other half: a `value` written into the markup
    // would survive a re-render even with the property cleared.
    expect(tokenFieldIn(container).getAttribute("value")).toBeNull();
  });

  it("puts the typed secret nowhere in the document after the submit", async () => {
    const container = renderRegistrationForm();
    await typeAndSubmit(container);

    // Serialised markup first — the shape a crash report or a devtools copy captures.
    expect(document.body.innerHTML).not.toContain(TYPED_TOKEN);
    // Then every live value property, which serialisation does not carry: an input's
    // current value is engine state rather than markup, so the check above alone would
    // pass over a field that still held it.
    for (const field of document.body.querySelectorAll("input, textarea, select")) {
      expect((field as HTMLInputElement).value).not.toContain(TYPED_TOKEN);
    }
    // And the rendered text, which is where an outcome line would echo it.
    expect(document.body.textContent ?? "").not.toContain(TYPED_TOKEN);
  });

  it("negative control: the typed value did reach the field before the submit", async () => {
    // Without this, the three cases above would pass over a form whose token input
    // never received anything — an absence proving nothing rather than a clear.
    const container = renderRegistrationForm();
    const field = tokenFieldIn(container);
    await act(async () => {
      await userEvent.fill(field, TYPED_TOKEN);
      await crossMacrotaskBoundary();
    });
    expect(field.value).toBe(TYPED_TOKEN);
  });
});

describe("browser — the restart confirmation keeps the interrupted runs in its description", () => {
  const MOVING_RUN_ID = "run-still-moving";
  const WAITING_RUN_ID = "run-waiting-for-approval";

  /** The updates block over a ready update and a session holding two live runs. */
  async function renderReadyToRestart(): Promise<HTMLElement> {
    const sessionStore = sessionStoreHolding("session-restart-browser", [
      runEntity(MOVING_RUN_ID, "running"),
      runEntity(WAITING_RUN_ID, "waiting_for_approval"),
      runEntity("run-already-finished", "completed"),
    ]);
    const { block } = await renderUpdatesBlock(bridgeReporting({ status: "ready" }), sessionStore);
    await openRestartConfirmation(block);
    return block;
  }

  it("names both moving runs inside the paragraph the dialog describes itself with", async () => {
    await renderReadyToRestart();
    const dialog = restartDialog();
    expect(dialog).not.toBeNull();

    const description = dialog?.querySelector<HTMLElement>(CONFIRMATION_BODY_SELECTOR) ?? null;
    expect(description).not.toBeNull();
    // INSIDE the description, not merely somewhere in the popup. The note renders as
    // spans within a paragraph; had it grown a block element this parser would have
    // hoisted the whole tail of the sentence out, leaving a dialog that still read
    // correctly on screen and described itself with half of what it says.
    const describedText = description?.textContent ?? "";
    expect(describedText).toContain(MOVING_RUN_ID);
    expect(describedText).toContain(WAITING_RUN_ID);
    // The completed run is not interrupted by a restart and is not named.
    expect(describedText).not.toContain("run-already-finished");
    // It also says plainly that the tally is this window's and not the node's.
    expect(describedText).toContain("does not have open");
  });

  it("hands that same paragraph to the dialog as its accessible description", async () => {
    await renderReadyToRestart();
    const dialog = restartDialog();
    const describedById = dialog?.getAttribute("aria-describedby") ?? "";
    expect(describedById).not.toBe("");

    const described = document.getElementById(describedById);
    expect(described).not.toBeNull();
    // The same element, reached the way a screen reader reaches it: a description that
    // lost its children to the parser would resolve to an id whose element no longer
    // holds the run ids the sentence promises.
    expect(described?.textContent ?? "").toContain(MOVING_RUN_ID);
  });

  it("negative control: the paragraph is a paragraph, which is what makes the claim real", async () => {
    await renderReadyToRestart();
    const description = restartDialog()?.querySelector<HTMLElement>(CONFIRMATION_BODY_SELECTOR);
    // If this element were a `<div>`, nothing above would be at risk and these cases
    // would be a unit test in the wrong tier.
    expect(description?.tagName).toBe("P");
    // And it carries no block-level child, which is the shape the parser would hoist.
    expect(description?.querySelectorAll("p, div, ul, ol, section")).toHaveLength(0);
  });
});
