//! A failure described in one line, its own message followed by each of its causes'.

use std::error::Error;

/// `error`'s message followed by each of its causes', joined by `: `, so one line says the whole
/// failure.
pub fn describe_error(error: &(dyn Error + 'static)) -> String {
    let mut description = error.to_string();
    for cause in std::iter::successors(error.source(), |&cause| cause.source()) {
        description.push_str(": ");
        description.push_str(&cause.to_string());
    }
    description
}
