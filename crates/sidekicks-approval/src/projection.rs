//! The approval card's rows as a client reads them, built from the approval tables, and those
//! tables as a rebuild writes them from the session's log.

pub(crate) mod read;
pub(crate) mod rebuild;
