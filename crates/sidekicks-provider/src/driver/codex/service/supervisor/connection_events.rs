//! What a connection hands the service it was dialed for, and the events of a detached connection
//! that belongs to no session.

use std::sync::{Arc, Weak};
use std::time::{Instant, SystemTime};

use serde_json::value::RawValue;

use crate::driver::codex::service::asks::CodexServiceAsks;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::transition::event::SupervisorEvent;
use crate::driver::codex::transport::connection::{CodexConnectionEvents, CodexForgottenRequest};
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;

/// What a service's connection hands its service: frames routed on the reader, its drop, the
/// asks a close let go of and Codex's drain.
pub(super) struct ServiceConnectionEvents {
    pub(super) service: Weak<CodexService>,
    pub(super) dial: u64,
}

impl CodexConnectionEvents for ServiceConnectionEvents {
    fn notification(&self, method: &str, params: Box<RawValue>) {
        if let Some(service) = self.service.upgrade() {
            service.route(self.dial, method, params);
        }
    }

    fn dropped(&self, reason: &str) {
        if let Some(service) = self.service.upgrade() {
            if service.is_routed_dial(self.dial) {
                CodexTransportDiagnostic::ServiceConnectionDropped {
                    codex_home: service.home.codex_home.clone(),
                    reason: reason.to_owned(),
                }
                .report();
            }
            service.send(SupervisorEvent::Dropped {
                dial: self.dial,
                at: Instant::now(),
                wall_at: SystemTime::now(),
                is_unwaited_process_gone: false,
            });
        }
    }

    fn held_requests_dropped(&self, dropped: Vec<CodexForgottenRequest>) {
        if let Some(service) = self.service.upgrade() {
            CodexServiceAsks::new(Arc::downgrade(&service)).withdraw(dropped);
        }
    }

    fn service_draining(&self, message: &str) {
        if let Some(service) = self.service.upgrade() {
            service.send(SupervisorEvent::Draining {
                dial: self.dial,
                message: message.to_owned(),
            });
        }
    }

    fn request_timed_out(&self) {
        if let Some(service) = self.service.upgrade() {
            service.send(SupervisorEvent::RequestTimedOut { dial: self.dial });
        }
    }

    fn answered_after_timeout(&self) {
        if let Some(service) = self.service.upgrade() {
            service.send(SupervisorEvent::Answered { dial: self.dial });
        }
    }
}

/// The events of a detached connection that starts no conversation: nothing on it belongs to a
/// session.
pub(crate) struct DetachedConnectionEvents;

impl CodexConnectionEvents for DetachedConnectionEvents {
    fn notification(&self, method: &str, _params: Box<RawValue>) {
        CodexTransportDiagnostic::UnconsumedServerNotification {
            method: method.to_owned(),
        }
        .report();
    }

    // A drop fails the reads in flight on it, which is all it carries.
    fn dropped(&self, _reason: &str) {}

    // It starts no conversation, so Codex holds no ask on it.
    fn held_requests_dropped(&self, _dropped: Vec<CodexForgottenRequest>) {}

    // Its read fails with Codex's own words.
    fn service_draining(&self, _message: &str) {}

    // Its read fails at its own deadline; the service's silence is watched on its own connection.
    fn request_timed_out(&self) {}

    fn answered_after_timeout(&self) {}
}
