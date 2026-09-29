/**
 * How long a transient status holds before its control returns to rest, in milliseconds.
 *
 * One duration for every such status (`Copied`, `Could not copy`, `Opening…`), so two
 * statuses on one screen never clear at different moments.
 */
export const TRANSIENT_STATUS_DURATION_MS = 1_200;
