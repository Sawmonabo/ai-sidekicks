// How the daemon words a rejected value in a log line or a failure detail.

/** The message of a rejected value, or its string form when it is not an Error. */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}
