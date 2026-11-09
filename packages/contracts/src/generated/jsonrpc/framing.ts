// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The frame codec's limits: the header, the largest chunk, a lane's first credit and a message's caps.

/** The bytes of a frame's header: kind, flags, lane and length. */
export const FRAME_HEADER_BYTES = 10 as const;

/**
 * The most body bytes one DATA frame carries: the largest channel message, less its 16-byte
 * seal tag and the header, so one frame always fits one sealed message.
 */
export const MAX_CHUNK_BYTES = 65509 as const;

/** The credit each lane starts with in each direction, in body bytes. */
export const INITIAL_LANE_CREDIT = 262144 as const;

/**
 * The most bytes of JSON one message carries: a send of 2^20 characters, the largest input a
 * provider takes, at up to 6 bytes each once escaped as JSON (6 MiB), and 1 MiB for its
 * envelope, the JSON-RPC members, its id of up to 256 bytes and the send's other members. It
 * bounds what one message makes the reader hold, never what a person may type.
 */
export const MAX_MESSAGE_BYTES = 7340032 as const;

/**
 * The most bytes of attachments one message carries, each attachment's 4-byte length
 * included.
 */
export const MAX_ATTACHMENT_BYTES = 4194304 as const;

/**
 * The most bytes one attachment carries: a message's whole attachment budget less the one
 * 4-byte length its bytes are written after.
 */
export const MAX_ONE_ATTACHMENT_BYTES = 4194300 as const;
