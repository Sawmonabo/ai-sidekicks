//! The program's standard output, where a helper mode writes its one answer for the program that
//! started it.

use std::io::{self, Write as _};

use serde::Serialize;

/// Writes `value` to standard output as one line of JSON, then flushes it. Fails with the write's
/// or the serialization's failure.
pub fn write_json_line<Value: Serialize + ?Sized>(value: &Value) -> io::Result<()> {
    let mut standard_output = io::stdout().lock();
    serde_json::to_writer(&mut standard_output, value)?;
    writeln!(standard_output)?;
    standard_output.flush()
}
