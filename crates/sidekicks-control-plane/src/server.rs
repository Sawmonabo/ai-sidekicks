//! The control plane's HTTP server: the router both hosts serve, its refusals, and the gates
//! every request passes first; the Worker's host reads Cloudflare's environment and headers.

use std::error::Error;

pub mod gate;
#[cfg(target_arch = "wasm32")]
pub(crate) mod host;
pub mod received_json;
pub mod router;

/// Logs a failure a caller reads only as a 500, with the request id that ties the line to the
/// edge's own log: the Worker's console on Cloudflare, `tracing` in the Compose relay.
pub(crate) fn log_internal_failure(request_id: Option<&str>, error: &(dyn Error + 'static)) {
    let request_id = request_id.unwrap_or("-");
    #[cfg(target_arch = "wasm32")]
    {
        let mut causes = vec![error.to_string()];
        let mut cause = error.source();
        while let Some(source) = cause {
            causes.push(source.to_string());
            cause = source.source();
        }
        let causes = causes.join(": ");
        worker::console_error!("request {request_id} failed: {causes}");
    }
    #[cfg(not(target_arch = "wasm32"))]
    tracing::error!(request_id, error, "a control plane request failed");
}
