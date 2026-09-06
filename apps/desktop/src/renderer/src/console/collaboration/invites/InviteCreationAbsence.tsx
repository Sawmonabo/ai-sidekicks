import { Nothing } from "../../primitives/index.js";

/**
 * Why there is no create control here.
 *
 * `not-checked` rather than `error`: nothing failed, and nothing is missing from
 * the daemon either. The console cannot ASK, because it does not know who it is.
 */
export function InviteCreationAbsence(): React.JSX.Element {
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title="This console cannot mint an invitation yet."
      detail="Creating one names the sender's own participant id, and no read this console has tells it which participant it is. Nothing was asked — this is not a refusal from the daemon."
    />
  );
}
