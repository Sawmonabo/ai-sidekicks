// Reading a handle id, `<mode>/<type>/<index>`, such as `outputs/main/1` or `inputs/tool/0`. The
// read is tolerant so a document always opens; whether the string named a declared type is kept,
// so the daemon's check at save can refuse it.
import type {
  WorkflowHandle,
  WorkflowHandleMode,
} from "../../generated/workflow/definition/handle.js";

const HANDLE_ID_PATTERN = /^(inputs|outputs)\/([^/]+)\/(0|[1-9][0-9]*)$/u;

const FALLBACK_HANDLE: WorkflowHandle = Object.freeze({
  mode: "outputs",
  type: "main",
  index: 0,
  isTypeKnown: false,
});

/**
 * Reads a handle id and never throws. A well-formed id whose type is neither `main` nor `tool`
 * reads as `main` on its own mode and index; anything else reads as the first `main` output.
 */
export function parseWorkflowHandle(id: string): WorkflowHandle {
  const match = HANDLE_ID_PATTERN.exec(id);
  if (match === null) {
    return FALLBACK_HANDLE;
  }
  const [, mode, type, index] = match as unknown as [string, WorkflowHandleMode, string, string];
  const parsedIndex = Number(index);
  if (!Number.isSafeInteger(parsedIndex)) {
    return FALLBACK_HANDLE;
  }
  return type === "main" || type === "tool"
    ? { mode, type, index: parsedIndex, isTypeKnown: true }
    : { mode, type: "main", index: parsedIndex, isTypeKnown: false };
}
