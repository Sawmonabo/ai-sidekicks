//! The keychains a secret's value is kept in: the operating system's credential store, and the
//! daemon's items file where that store cannot be used.

pub(crate) mod file;
pub(crate) mod os;
