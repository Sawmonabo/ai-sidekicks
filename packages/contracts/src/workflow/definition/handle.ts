// The handle grammar: an edge names each end by one string, `<mode>/<type>/<index>`, such as
// `outputs/main/1` or `inputs/tool/0`, so the side, the connection type and the branch index
// are recoverable from a stored edge alone. The parse is tolerant so a document always opens;
// whether the string named a declared type is kept, so the daemon's check at save can refuse it.

const WORKFLOW_HANDLE_MODES = ["inputs", "outputs"] as const;
/** The side of a node a handle stands on. */
export type WorkflowHandleMode = (typeof WORKFLOW_HANDLE_MODES)[number];

const WORKFLOW_HANDLE_TYPES = ["main", "tool"] as const;
/** What a handle carries: items on `main`, a capability an agent can call on `tool`. */
export type WorkflowHandleType = (typeof WORKFLOW_HANDLE_TYPES)[number];

/**
 * A handle id of one mode and type. The type cannot say the index is a whole number written
 * without leading zeros; {@link parseWorkflowHandle} can.
 */
export type WorkflowHandleId<
  Mode extends WorkflowHandleMode = WorkflowHandleMode,
  Type extends WorkflowHandleType = WorkflowHandleType,
> = `${Mode}/${Type}/${number}`;

/**
 * A parsed handle id. `isTypeKnown` is false when the stored string named a type other than
 * `main` or `tool`, read as `main`, or could not be read at all, read as `outputs/main/0`.
 */
export interface WorkflowHandle {
  readonly mode: WorkflowHandleMode;
  readonly type: WorkflowHandleType;
  readonly index: number;
  readonly isTypeKnown: boolean;
}

const HANDLE_ID_PATTERN = new RegExp(
  `^(${WORKFLOW_HANDLE_MODES.join("|")})/([^/]+)/(0|[1-9][0-9]*)$`,
  "u",
);

const FALLBACK_HANDLE: WorkflowHandle = {
  mode: "outputs",
  type: "main",
  index: 0,
  isTypeKnown: false,
};

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
  return isHandleType(type)
    ? { mode, type, index: parsedIndex, isTypeKnown: true }
    : { mode, type: "main", index: parsedIndex, isTypeKnown: false };
}

function isHandleType(type: string): type is WorkflowHandleType {
  return (WORKFLOW_HANDLE_TYPES as readonly string[]).includes(type);
}
