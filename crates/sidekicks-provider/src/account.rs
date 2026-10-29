//! Provider accounts, naming no provider: the registry of the accounts this machine runs providers
//! on, with each account's minted identity, its current-account mark, its generation and stored
//! health, the credential home the daemon makes for each under its data folder and its reset, the
//! folders in every home that a backup keeps and the diagnostic expiry sweeps, each provider's
//! readiness derived from those rows, the usage turns the daemon keeps per account, the lock every
//! act in an account's home takes, and the background observer that reads each account's limits.

pub mod credential_home;
pub mod errors;
pub mod home_lock;
pub mod homes;
pub mod observer;
pub mod readiness;
pub mod registry;
pub mod usage_turns;
