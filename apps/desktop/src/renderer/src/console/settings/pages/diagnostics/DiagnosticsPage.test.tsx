// What the diagnostics page renders once its four reads have settled.
//
// The page's whole claim is that a person can tell four different things apart: a
// reading that arrived, a reading that was refused, a question nobody put, and a
// machine that says everything is fine. Each of those is a case here, and each is
// asserted on the region that owns it rather than on the page's whole text.

import { describe, expect, it } from "vitest";

import {
  bridgeAnswering,
  degradedStatus,
  failureDetail,
  healthyStatus,
  movingInspection,
  overriddenPolicy,
  regionText,
  renderSettledPage,
  stuckInspection,
  FAILED_RUN_ID,
  SESSION_ID,
  STALLED_RUN_ID,
} from "./diagnostics-page.test-support.js";
import { runEntity, sessionStoreHolding } from "../../settings-page-mount.test-support.js";
import type { SessionStore } from "../../../store/index.js";

/** A session holding one moving run and one failed one — a subject for both reads. */
function storeWithBothSubjects(): SessionStore {
  return sessionStoreHolding(SESSION_ID, [
    runEntity(STALLED_RUN_ID, "running"),
    runEntity(FAILED_RUN_ID, "failed"),
  ]);
}

describe("the health banner", () => {
  it("renders the node's own verdict beside every component it named", async () => {
    const { bridge } = bridgeAnswering({ status: degradedStatus() });

    const container = await renderSettledPage(bridge);
    const banner = regionText(container, "Execution health");

    expect(banner).toContain("Degraded");
    expect(banner).toContain("daemon");
    expect(banner).toContain("provider");
    expect(banner).toContain("replay");
    expect(banner).toContain("Blocked");
  });

  it("collapses to one line when every component the node named is healthy", async () => {
    const { bridge } = bridgeAnswering({ status: healthyStatus() });

    const container = await renderSettledPage(bridge);
    const banner = regionText(container, "Execution health");

    expect(banner).toContain("reports every component it checked as healthy");
    expect(banner).not.toContain("daemon");
  });

  it("says so, and withdraws no control, when the node reports its rebuild blocked", async () => {
    // The design's degraded state. The notice is the whole of what the console
    // derives: the recovery controls stay, because eligibility is the daemon's.
    const { bridge } = bridgeAnswering({
      status: degradedStatus(),
      stall: stuckInspection("2026-01-01T07:53:30.000Z"),
    });

    const container = await renderSettledPage(bridge, storeWithBothSubjects());

    expect(container.textContent).toContain("projection rebuild blocked");
    expect(regionText(container, "Stuck runs")).toContain("Interrupt");
  });

  it("negative control: a node whose replay component is fine draws no such notice", async () => {
    const { bridge } = bridgeAnswering({ status: healthyStatus() });

    const container = await renderSettledPage(bridge);

    expect(container.textContent).not.toContain("projection rebuild blocked");
  });

  it("renders the refusal's own code where the read was refused", async () => {
    const { bridge } = bridgeAnswering({ refuse: ["status"] });

    const container = await renderSettledPage(bridge);

    expect(regionText(container, "Execution health")).toContain("not registered on this build");
  });
});

describe("the run-scoped regions", () => {
  it("says nothing was asked where this window has no session open", async () => {
    const { bridge, calls } = bridgeAnswering({
      stall: stuckInspection("2026-01-01T07:53:30.000Z"),
      failure: failureDetail(),
    });

    const container = await renderSettledPage(bridge);

    expect(regionText(container, "Stuck runs")).toContain("No run was inspected");
    expect(regionText(container, "Failure detail")).toContain("No failure detail was read");
    expect(calls.stall).not.toHaveBeenCalled();
    expect(calls.failure).not.toHaveBeenCalled();
  });

  it("asks about a moving run and a failed one, and says which is which", async () => {
    const { bridge, calls } = bridgeAnswering({
      stall: stuckInspection("2026-01-01T07:53:30.000Z"),
      failure: failureDetail(),
    });

    const container = await renderSettledPage(bridge, storeWithBothSubjects());

    expect(calls.stall).toHaveBeenCalledTimes(1);
    expect(calls.failure).toHaveBeenCalledTimes(1);
    expect(regionText(container, "Stuck runs")).toContain(STALLED_RUN_ID);
    expect(regionText(container, "Failure detail")).toContain(FAILED_RUN_ID);
  });

  it("escalates the badge for a run quiet past the escalation bound", async () => {
    const { bridge } = bridgeAnswering({ stall: stuckInspection("2026-01-01T07:53:30.000Z") });

    const container = await renderSettledPage(bridge, storeWithBothSubjects());

    expect(regionText(container, "Stuck runs")).toContain("Quiet for a long time");
  });

  it("renders the node's suggestion as words and offers no control for it", async () => {
    // `escalate` is in the inspect reply's vocabulary and not in the request's, so
    // there is no button that could send it.
    const { bridge } = bridgeAnswering({ stall: stuckInspection("2026-01-01T07:53:30.000Z") });

    const container = await renderSettledPage(bridge, storeWithBothSubjects());
    const region = regionText(container, "Stuck runs");
    const buttons = [
      ...(container.querySelector('section[aria-label="Stuck runs"]')?.querySelectorAll("button") ??
        []),
    ].map((button) => button.textContent);

    expect(region).toContain("escalate");
    expect(buttons).toEqual(["Try again", "Interrupt", "Abandon"]);
  });

  it("reports a run the node found moving rather than leaving the region blank", async () => {
    // "The daemon looked and it is fine" is an answer, and it must not read like the
    // region where nobody asked.
    const { bridge } = bridgeAnswering({ stall: movingInspection() });

    const container = await renderSettledPage(bridge, storeWithBothSubjects());

    expect(regionText(container, "Stuck runs")).toContain("still making progress");
    expect(regionText(container, "Stuck runs")).not.toContain("No run was inspected");
  });

  it("distinguishes the failure by its class rather than reporting a generic error", async () => {
    const { bridge } = bridgeAnswering({ failure: failureDetail() });

    const container = await renderSettledPage(bridge, storeWithBothSubjects());
    const region = regionText(container, "Failure detail");

    expect(region).toContain("provider failure");
    expect(region).toContain("provider_unavailable");
    expect(region).toContain("The provider closed the connection");
  });
});

describe("the redaction read-out and the record's location", () => {
  it("names every bucket, the outbound posture, and the override in force", async () => {
    const { bridge } = bridgeAnswering({ policy: overriddenPolicy() });

    const container = await renderSettledPage(bridge);
    const region = regionText(container, "Diagnostic redaction");

    expect(region).toContain("Retention override in force");
    expect(region).toContain("deny");
    expect(region).toContain("driver_raw_events");
    expect(region).toContain("tool_traces");
    expect(region).toContain("Raw content kept");
    expect(region).toContain("Redacted");
  });

  it("names where the engine event record lives and offers no way to collect it", async () => {
    const { bridge } = bridgeAnswering({ policy: overriddenPolicy() });

    const container = await renderSettledPage(bridge);
    const region = regionText(container, "The engine event record");
    const buttons = container
      .querySelector('section[aria-label="The engine event record"]')
      ?.querySelectorAll("button");

    expect(region).toContain("bounded-retention diagnostic tier");
    expect(buttons?.length ?? 0).toBe(0);
  });
});
