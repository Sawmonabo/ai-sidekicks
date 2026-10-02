// A tool's result, in the same three states as the reply. A tool payload declares no media type,
// so its bytes decide: an escape means command output, and anything else is shown verbatim, every
// line as the program printed it.

import { MachineBody, type MachineBodyProps } from "./MachineBody.js";
import { toolOutputKindOf } from "./output-kinds.js";

/** What the tool's result is drawn from. */
export type ToolOutputProps = Omit<MachineBodyProps, "readOutputKind">;

/** A tool's result: command output when its bytes carry an escape, otherwise plain text. */
export function ToolOutput(props: ToolOutputProps): React.JSX.Element {
  return <MachineBody {...props} readOutputKind={toolOutputKindOf} />;
}
