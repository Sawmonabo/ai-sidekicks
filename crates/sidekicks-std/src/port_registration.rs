//! A port another part of the program registers once at run time, after the drivers that call it
//! are built, so a driver reads the port when it needs it rather than when it is built.

use std::sync::OnceLock;

/// Why a port could not be registered or read.
#[derive(Debug, thiserror::Error)]
pub enum PortRegistrationError {
    /// A port was registered already; each has a single owner.
    #[error("the {0} port is already registered")]
    AlreadyRegistered(&'static str),
    /// The port's owner has not registered it yet.
    #[error("the {0} port is not registered yet")]
    NotRegistered(&'static str),
}

/// One port, absent until its owner registers it. A caller that finds it absent leaves the
/// provider waiting rather than answering in the owner's place, or refuses through
/// [`Self::require_port`].
pub struct PortRegistration<Port> {
    /// The port's name, as the errors give it.
    port_name: &'static str,
    /// The port, once registered.
    port: OnceLock<Port>,
}

impl<Port> PortRegistration<Port> {
    /// An empty registration; `port_name` names the port in its errors.
    pub const fn new(port_name: &'static str) -> Self {
        Self {
            port_name,
            port: OnceLock::new(),
        }
    }

    /// The port's name, as its errors give it.
    pub const fn port_name(&self) -> &'static str {
        self.port_name
    }

    /// Registers `port`. An error when one is registered already, since it has a single owner.
    pub fn register(&self, port: Port) -> Result<(), PortRegistrationError> {
        if self.port.set(port).is_err() {
            return Err(PortRegistrationError::AlreadyRegistered(self.port_name));
        }
        Ok(())
    }

    /// The registered port, or `None` before its owner registers it.
    pub fn port(&self) -> Option<&Port> {
        self.port.get()
    }

    /// The registered port, for an operation that cannot go on, or wait, without it. An error
    /// naming the port when its owner has not registered it yet.
    pub fn require_port(&self) -> Result<&Port, PortRegistrationError> {
        self.port
            .get()
            .ok_or(PortRegistrationError::NotRegistered(self.port_name))
    }
}
