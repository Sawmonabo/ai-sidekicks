// Puts an execution root on disk for one workspace ahead of any run: name the branch, then
// Prepare. The form is collapsed and held by the mount's bind availability, since a prepare is a
// bind. The mount card states why once; the form draws no second copy, and its `Prepare` button
// is described by the card's line instead.

import "./PrepareExecutionRoot.css";

import { useCallback, useId } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { BUTTON_CLASS_NAME } from "../../button-class.js";
import { type BindControlAvailability } from "../../bind-control-availability.js";
import { usePrepareController } from "./hooks/usePrepareController.js";
import type { PrepareOperations, PrepareReading } from "./controller.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

/**
 * The line that holds the control while no branch is named. The branch is required here though
 * optional on the wire, because only a run can derive one; a prepare without it is refused with
 * `workspace.branch_name_required`. Git's own rule judges the name, so the form sets no length.
 */
const BRANCH_REQUIRED_COPY = "Name the branch this root should check out.";

/** What the prepare form is bound to: the workspace, its mode, and the call it makes. */
export interface PrepareExecutionRootProps {
  readonly bridge: PlatformBridge;
  /** The prepare this control sends. */
  readonly operations: PrepareOperations;
  readonly workspaceId: string;
  /** The mode this workspace is bound in. */
  readonly executionMode: ExecutionMode;
  /** Whether the owning mount admits binds. Derived once by the mount card. */
  readonly availability: BindControlAvailability;
  /** The id of the mount card's line saying why binds are held, which describes `Prepare`. */
  readonly heldReasonLineId: string;
  /** Read the section again, so a prepared root appears in the roots list. */
  readonly onPrepared: () => void;
}

/** The collapsed form that puts an execution root on disk for one workspace. */
export function PrepareExecutionRoot(props: PrepareExecutionRootProps): React.JSX.Element {
  const { reading, controllerIdentity, prepare, clearAct } = usePrepareController(
    props.bridge,
    { workspaceId: props.workspaceId, executionMode: props.executionMode },
    props.operations,
  );
  // The branch dies with the controller it is sent through: a re-bind in another mode re-mints
  // the mode-scoped controller under a component React never unmounts, and a plain register would
  // carry the old branch across. Addressing state at the controller's identity re-seeds it in
  // the same pass; an effect would leave one committed frame with a pressable control.
  const { value: branchName, publish: publishBranchName } = useSubjectScopedState<string>(
    controllerIdentity,
    undefined,
    () => "",
  );
  const isBranchNamed = branchName.trim().length > 0;
  const { onPrepared } = props;
  const isHeld = !props.availability.available;
  // The branch line is standing guidance, read with the controls it describes rather than
  // spoken: the form is collapsed, so a spoken line would be heard for text nobody sees. The held
  // reason is the mount card's own line, which `Prepare` cites.
  const branchLineId = useId();
  const prepareDescribedBy =
    [isHeld ? props.heldReasonLineId : undefined, isBranchNamed ? undefined : branchLineId]
      .filter((lineId) => lineId !== undefined)
      .join(" ") || undefined;

  const nameBranch = useCallback(
    (nextBranchName: string) => {
      publishBranchName(nextBranchName);
      // A settlement read against the previous branch says nothing about this one.
      clearAct();
    },
    [clearAct, publishBranchName],
  );

  const submit = useCallback(() => {
    if (!isBranchNamed) {
      return;
    }
    prepare(branchName);
  }, [branchName, isBranchNamed, prepare]);

  return (
    <details className="meridian-prepare-root">
      <summary className="meridian-prepare-root__summary">
        Prepare an execution root
        <span className="meridian-prepare-root__line">{summaryLineFor(reading)}</span>
      </summary>

      <label className="meridian-form__field">
        <span className="meridian-form__label">Branch</span>
        <input
          type="text"
          className="meridian-form__input meridian-form__input--wire"
          value={branchName}
          spellCheck={false}
          autoComplete="off"
          disabled={isHeld}
          aria-describedby={isBranchNamed ? undefined : branchLineId}
          onChange={(event) => {
            nameBranch(event.target.value);
          }}
        />
      </label>

      {renderSettlement(reading, onPrepared)}

      <button
        type="button"
        className={BUTTON_CLASS_NAME}
        disabled={isHeld || !isBranchNamed || reading.status === "sending"}
        aria-describedby={prepareDescribedBy}
        onClick={submit}
      >
        Prepare
      </button>
      {isBranchNamed ? null : (
        <p className="meridian-form__blocked" id={branchLineId}>
          {BRANCH_REQUIRED_COPY}
        </p>
      )}
    </details>
  );
}

/** One honest line per reading, for a summary with room for exactly one. */
function summaryLineFor(reading: PrepareReading): string {
  switch (reading.status) {
    case "idle":
      return "not prepared";
    case "sending":
      return "preparing";
    case "refused":
      return reading.refusal.detail;
    case "prepared":
      return "prepared";
  }
}

/** What the prepare did, with the section offered a re-read once it has. */
function renderSettlement(
  reading: PrepareReading,
  onPrepared: () => void,
): React.JSX.Element | null {
  switch (reading.status) {
    case "idle":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Preparing." />;
    case "refused":
      return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
    case "prepared":
      return (
        // The state is read out; the root path and the re-read control beside it are not.
        <AnnouncedLine
          element="div"
          className="meridian-form__settlement meridian-form__settlement--inline"
          words={codeWords(reading.state)}
          politeness="polite"
        >
          <WireFigure value={reading.executionRoot} />
          <span>{codeWords(reading.state)}</span>
          {/* The re-read is a control, not an effect: it stays after the first press because the
              list can be asked again. */}
          <button type="button" className={BUTTON_CLASS_NAME} onClick={onPrepared}>
            Show it in the roots list
          </button>
        </AnnouncedLine>
      );
  }
}
