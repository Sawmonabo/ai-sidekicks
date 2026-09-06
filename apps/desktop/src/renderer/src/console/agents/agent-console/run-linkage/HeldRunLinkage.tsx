import { useCallback } from "react";

import { RunLinkage } from "../../run-console/RunLinkage.js";
import { type ChildRunLinkageRead } from "../../run-console/agent-console-reads.js";
import { usePushDrivenRead } from "../../../seats/index.js";

/** The arm where a read is held, so the hook that reads it may be called. */
export function HeldRunLinkage(props: {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}): React.JSX.Element {
  const { read } = props;
  const state = usePushDrivenRead(read);
  // The lease is held HERE, so the way out of a refusal is composed here and handed
  // down. The view below renders the refusal and owns no stream, and a refusal a
  // person cannot act on is the shape this arm exists to stop being.
  const reopen = useCallback(() => {
    read.refresh("participant-request");
  }, [read]);
  return <RunLinkage parentRunId={props.parentRunId} state={state} onReopen={reopen} />;
}
