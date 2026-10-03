/**
 * How long a transient status (`Copied`, `Could not copy`, `Opening…`) holds before its control
 * returns to rest, in milliseconds. One duration, so two statuses never clear at different moments.
 */
export const TRANSIENT_STATUS_DURATION_MS = 1_200;
