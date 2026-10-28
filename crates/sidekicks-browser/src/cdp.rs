//! The debug-protocol transport: messages routed on their raw bytes and decoded late, command
//! ids, flat sessions, events fanned out by session under a byte bound per session, and the
//! NUL-framed pipe reader and writer over the two descriptors.
