//! A process id as macOS's and Linux's calls take it.

use std::io::{self, ErrorKind};
use std::num::NonZeroI32;

/// Process `id` as the system's signed process id. Fails with `InvalidInput` for 0, which the
/// calls read as the caller's own process or group, or on macOS as the kernel, and for an id past
/// `i32::MAX`, which no process has.
pub(crate) fn system_process_id(id: u32) -> io::Result<NonZeroI32> {
    i32::try_from(id)
        .ok()
        .and_then(NonZeroI32::new)
        .ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidInput,
                format!("the id {id} names no process this daemon reads"),
            )
        })
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::num::NonZeroI32;

    use rstest::rstest;

    use super::system_process_id;

    // Fails when 0, which a signal call reads as the caller's own group, or an id past the signed
    // range reaches a system call as a process id.
    #[rstest]
    #[case::zero(0, None)]
    #[case::past_the_signed_range(1 << 31, None)]
    #[case::a_process(1, Some(1))]
    fn process_id_refuses_what_names_no_process(#[case] id: u32, #[case] expected: Option<i32>) {
        let read = system_process_id(id)
            .map(NonZeroI32::get)
            .map_err(|error| error.kind());

        assert_eq!(read, expected.ok_or(ErrorKind::InvalidInput));
    }
}
