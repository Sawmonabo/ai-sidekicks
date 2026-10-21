//! The service's crash reports: the monitor that writes a dump when the service crashes, the
//! builder that turns each dump into a stripped report, and the method that lists the reports.

pub(crate) mod methods;
pub mod monitor;
pub(crate) mod reports;
