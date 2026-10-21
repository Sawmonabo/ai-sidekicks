//! The control plane's integration tests: the rate limit over a real account file, the router's
//! refusals as a caller reads them, and the passkey ceremonies and signed-in routes end to end
//! over a scripted verifier.

mod helpers;
mod layer;
mod limiter;
mod refusals;
mod registration;
mod sign_in;
mod signed_in;
