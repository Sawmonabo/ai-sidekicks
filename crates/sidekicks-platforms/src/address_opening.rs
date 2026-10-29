//! Opening an address, such as an app link, in the application the system has registered for its
//! scheme; each platform's module makes the system's own call, and this one holds the answer all of
//! them give when no application is registered.

use std::io::{self, ErrorKind};

/// The error every platform answers when the system reports no application registered for an
/// address's scheme: `NotFound`, the one kind a caller reads as "no handler".
pub(crate) fn no_handler_error() -> io::Error {
    io::Error::new(
        ErrorKind::NotFound,
        "no application is registered to open this address",
    )
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use std::io::ErrorKind;

    use crate::open_address;

    #[test]
    fn an_address_no_application_claims_answers_not_found() {
        let error = open_address("sidekicks-unclaimed-scheme-test://nothing")
            .expect_err("no application claims the made-up scheme");
        assert_eq!(error.kind(), ErrorKind::NotFound, "{error}");
    }
}
