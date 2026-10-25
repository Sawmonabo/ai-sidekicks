//! The ports this machine shares with the person's other devices: the list, kept in the database
//! and in memory, each port's close signal, the readers of the list, and the loopback connect that
//! checks the list before it dials.

pub(crate) mod schema;
pub(crate) mod store;
