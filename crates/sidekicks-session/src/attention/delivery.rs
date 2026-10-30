//! Delivery beyond this machine: the outcome row each channel keeps of its last attempt, and the
//! web address's sender.

pub mod outcome;
pub mod web_address;

/// The delivery secrets' keychain account holding the email digest's mail password.
pub const MAIL_PASSWORD_ACCOUNT: &str = "mail-password";
