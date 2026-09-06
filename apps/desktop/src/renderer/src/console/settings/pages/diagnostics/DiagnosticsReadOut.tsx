// The four readings, their refresh, and the one place their lifetime is owned.
//
// A component separate from the page because the read is a RESOURCE: it is built on
// the subjects it addresses, started in an effect, refreshed by three signals, and
// disposed when the surface leaves — none of which the page's frame can arrange while
// also rendering the prose around it. `MountInventoryList` is the same shape for the
// same reason.
//
// THE THREE SIGNALS ARE BOUND HERE AND NOWHERE ELSE. Focus is the window's, reconnect
// is the transport's, and the run terminals are the session's — bound by the read
// itself, because only it knows which kinds matter. Each goes through the read's own
// scheduler, so a burst costs one pass over four wires. There is no fourth signal and
// no timer: `Spec-023 §Console Design (Meridian)` §Diagnostics and health forbids a
// health subscription outright and forbids polling in the next clause.
//
// EVERY REGION RENDERS ITS OWN ANSWER. The reads settle independently, so a refused
// policy read leaves the banner standing and a stall question nobody could address
// leaves the failure card alone. The recovery prompt is offered wherever there is a
// run to address it to, whatever the other three said — the section's refusal state
// requires exactly that.

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useConsoleClock, type ConsoleBridge } from "../../../bridge/index.js";
import { Nothing } from "../../../primitives/index.js";
import { usePushDrivenRead } from "../../../seats/index.js";
import type { SessionStore } from "../../../store/index.js";
import { ArmAbsence } from "./ArmAbsence.js";
import { BundleLocationNote } from "./BundleLocationNote.js";
import { createDiagnosticsRead, isProjectionRebuildBlocked } from "./diagnostics-reading.js";
import { DiagnosticsRegion } from "./DiagnosticsRegion.js";
import { FailureDetailCard } from "./FailureDetailCard.js";
import { HealthBanner } from "./HealthBanner.js";
import { HealthBannerSkeleton } from "./HealthBannerSkeleton.js";
import { RecoveryPrompt } from "./RecoveryPrompt.js";
import { RedactionReadOut } from "./RedactionReadOut.js";
import type { DiagnosticsRunSubjects } from "./run-subjects.js";
import { StuckRunBadge } from "./StuckRunBadge.js";

export function DiagnosticsReadOut(props: {
  readonly bridge: ConsoleBridge;
  readonly subjects: DiagnosticsRunSubjects;
  readonly sessionStore: SessionStore | undefined;
}): ReactNode {
  const { bridge, subjects, sessionStore } = props;
  // The scenario's frozen clock under the fixture, the real one otherwise, so a story
  // advances this read's coalescing window exactly when it advances everything else's
  // — and so the quiet interval beside the stall badge is measured on the same clock
  // the scenario is driving.
  const clock = useConsoleClock();
  const { stalledCandidateRunId, failedCandidateRunId } = subjects;
  // The openings made for this read. Its only job is to be a dependency the read's
  // construction can be moved by: a read whose first pass failed is re-put by a
  // person pressing the control, and nothing else in the list below has moved.
  const [openingOrdinal, setOpeningOrdinal] = useState(0);
  const diagnosticsRead = useMemo(
    () =>
      createDiagnosticsRead({
        bridge,
        clock,
        // Rebuilt from the two ids rather than from the object, which the parent
        // composes fresh on every render of a store subscription: keyed on the
        // object this read would be re-put on every session-store change, four
        // wires at a time, for subjects that had not moved.
        subjects: { stalledCandidateRunId, failedCandidateRunId },
        sessionStore,
      }),
    [bridge, clock, stalledCandidateRunId, failedCandidateRunId, sessionStore, openingOrdinal],
  );
  useEffect(() => {
    diagnosticsRead.start();
    return () => {
      diagnosticsRead.dispose();
    };
  }, [diagnosticsRead]);
  useEffect(() => {
    const onWindowFocus = (): void => {
      diagnosticsRead.refresh("window-focus");
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [diagnosticsRead]);
  // A SEPARATE EFFECT rather than a second listener inside the one above, because the
  // two release differently: the focus listener is the window's and the reconnect
  // subscription is the transport's, and one cleanup releasing both would be a single
  // identity for two lifetimes.
  useEffect(
    () =>
      bridge.transportReconnect.subscribe(() => {
        diagnosticsRead.refresh("reconnect");
      }),
    [bridge, diagnosticsRead],
  );

  const state = usePushDrivenRead(diagnosticsRead);
  if (state.kind === "not-loaded") {
    return (
      <>
        <DiagnosticsRegion heading="Execution health">
          <HealthBannerSkeleton />
        </DiagnosticsRegion>
        <DiagnosticsRegion heading="Stuck runs">
          <Nothing kind="not-loaded" placement="surface" title="Inspecting this session’s runs." />
        </DiagnosticsRegion>
        <DiagnosticsRegion heading="Failure detail">
          <Nothing kind="not-loaded" placement="surface" title="Reading failure detail." />
        </DiagnosticsRegion>
        <DiagnosticsRegion heading="Diagnostic redaction">
          <Nothing kind="not-loaded" placement="surface" title="Reading the retention policy." />
        </DiagnosticsRegion>
      </>
    );
  }
  if (state.kind === "failed") {
    // Reachable only where the read itself could not be put — the four wires each
    // settle their own refusal into an arm, so nothing that merely refused lands
    // here. The control is the way back, because there is no push signal behind a
    // read that never ran.
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={state.refusal.code}
        detail={state.refusal.detail}
        action={
          <button
            type="button"
            className="meridian-settings-page__action"
            onClick={() => {
              setOpeningOrdinal((held) => held + 1);
            }}
          >
            Try again
          </button>
        }
      />
    );
  }
  const reading = state.value;
  return (
    <>
      {isProjectionRebuildBlocked(reading.status) ? (
        <p
          className="meridian-settings-page__state meridian-settings-page__state--failed"
          role="alert"
        >
          This machine reports its projection rebuild blocked. Readings on this page were taken
          against a node in that state and may be incomplete, and a request made from here may be
          refused for the same reason — the refusal will say so on the control that raised it.
        </p>
      ) : null}

      <DiagnosticsRegion heading="Execution health">
        {reading.status.kind === "served" ? (
          <HealthBanner
            overall={reading.status.value.overall}
            components={reading.status.value.components}
          />
        ) : (
          <ArmAbsence arm={reading.status} unaskedTitle="This machine's health was not read." />
        )}
      </DiagnosticsRegion>

      <DiagnosticsRegion heading="Stuck runs">
        {reading.stall.kind === "served" ? (
          <StuckRunBadge
            inspection={reading.stall.value}
            readAtMilliseconds={reading.readAtMilliseconds}
          />
        ) : (
          <ArmAbsence arm={reading.stall} unaskedTitle="No run was inspected." />
        )}
        {reading.stalledCandidateRunId === undefined ? null : (
          <RecoveryPrompt bridge={bridge} runId={reading.stalledCandidateRunId} />
        )}
      </DiagnosticsRegion>

      <DiagnosticsRegion heading="Failure detail">
        {reading.failure.kind === "served" ? (
          <FailureDetailCard detail={reading.failure.value} />
        ) : (
          <ArmAbsence arm={reading.failure} unaskedTitle="No failure detail was read." />
        )}
      </DiagnosticsRegion>

      <DiagnosticsRegion heading="Diagnostic redaction">
        {reading.policy.kind === "served" ? (
          <RedactionReadOut policy={reading.policy.value} />
        ) : (
          <ArmAbsence arm={reading.policy} unaskedTitle="The retention policy was not read." />
        )}
      </DiagnosticsRegion>

      <DiagnosticsRegion heading="The engine event record">
        <BundleLocationNote />
      </DiagnosticsRegion>
    </>
  );
}
