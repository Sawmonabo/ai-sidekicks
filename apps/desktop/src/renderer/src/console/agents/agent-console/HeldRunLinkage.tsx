import { RunLinkage } from "../run-console/RunLinkage.js";
import { type ChildRunLinkageRead } from "../run-console/agent-console-reads.js";
import { usePushDrivenRead } from "../../seats/index.js";

/** The arm where a read is held, so the hook that reads it may be called. */
export function HeldRunLinkage(props: {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}): React.JSX.Element {
  const state = usePushDrivenRead(props.read);
  return <RunLinkage parentRunId={props.parentRunId} state={state} />;
}
