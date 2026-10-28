//! The shared tool server's provider-independent part: the tool contracts, discovery, registration
//! and the listener a provider's process reaches. A tool registers here from the crate above this
//! one that implements it: the shell tools from the shell crate, and a tool that calls queue or
//! session from a crate above those.
