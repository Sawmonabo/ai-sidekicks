import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowStepPayloadKind } from "@ai-sidekicks/contracts/workflow/run/step/methods";

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useStepPayloadRead } from "../hooks/useStepPayloadRead.js";
import { StepPayload, type StepPayloadView } from "./StepPayload.js";

/**
 * One of a step's input, output and log tabs: the payload read through `workflow.stepRead`, in
 * the view the panel's Table and JSON switch holds. While it is read it reads
 * `Loading this step's data…` after the session's short delay; a read that fails reads
 * `Could not load this step's data` with `Try again`.
 */
export function StepPayloadTab(props: {
  readonly bridge: PlatformBridge;
  readonly step: WorkflowStep;
  readonly which: WorkflowStepPayloadKind;
  readonly view: StepPayloadView;
  /** Names the payload for what is said out loud about it: `Output of Summarize`. */
  readonly label: string;
}): React.JSX.Element | null {
  const clock = useClock();
  const { read, readAgain } = useStepPayloadRead(props.bridge, props.step, props.which);
  switch (read.kind) {
    case "reading":
      return <LoadingNotice clock={clock} placement="block" title="Loading this step's data…" />;
    case "failed":
      return (
        <Nothing
          kind="error"
          placement="block"
          title="Could not load this step's data"
          detail={read.refusal.detail}
          action={<TryAgainButton onPress={readAgain} />}
          attempt={read.refusal}
        />
      );
    case "read":
      return (
        <StepPayload
          items={read.items}
          storage={read.storage}
          view={props.view}
          label={props.label}
        />
      );
  }
}
