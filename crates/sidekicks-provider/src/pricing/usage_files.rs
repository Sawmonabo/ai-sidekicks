//! A provider's own usage files, read for price while its telemetry export is absent: each read on
//! from the offset its last read stopped at, whole lines only, so a line still being written is
//! read whole by the next read; a line past the bound is skipped and logged.

use std::fs::File;
use std::io::{self, BufRead as _, BufReader, Seek as _, SeekFrom};
use std::ops::ControlFlow;
use std::path::Path;

/// The longest line a usage file's read hands on, in bytes; a longer one is skipped and logged.
pub(crate) const USAGE_FILE_LINE_MAX: usize = 1 << 20;

/// Reads `path` from `offset`, handing `read_line` each whole line after it without its newline
/// until the file ends or `read_line` breaks, and answers the offset just past the last line
/// handed on or skipped, where the next read resumes. A line past `USAGE_FILE_LINE_MAX` is
/// skipped, logged with its offset; a last line with no newline yet is left for the next read.
/// Blocking. Fails as the file cannot be opened or read.
pub(crate) fn read_usage_file_lines(
    path: &Path,
    offset: u64,
    mut read_line: impl FnMut(&[u8]) -> ControlFlow<()>,
) -> io::Result<u64> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    // Where the line being gathered starts, and how far the read has consumed.
    let mut line_start = offset;
    let mut position = offset;
    let mut is_too_long = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(line_start);
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let content = &buffer[..newline.unwrap_or(buffer.len())];
        if !is_too_long {
            if line.len() + content.len() > USAGE_FILE_LINE_MAX {
                is_too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(content);
            }
        }
        let taken = newline.map_or(buffer.len(), |at| at + 1);
        reader.consume(taken);
        position += taken as u64;
        if newline.is_none() {
            continue;
        }
        if is_too_long {
            tracing::warn!(
                path = %path.display(),
                offset = line_start,
                "a usage file's line is past the longest read and was skipped"
            );
        } else if read_line(&line).is_break() {
            return Ok(position);
        }
        line_start = position;
        line.clear();
        is_too_long = false;
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::ops::ControlFlow;

    use super::{USAGE_FILE_LINE_MAX, read_usage_file_lines};

    // Each read from `offset`: the lines it handed on and where the next read resumes.
    fn read_from(path: &std::path::Path, offset: u64) -> (Vec<String>, u64) {
        let mut lines = Vec::new();
        let next = read_usage_file_lines(path, offset, |line| {
            lines.push(String::from_utf8(line.to_vec()).expect("the test writes text"));
            ControlFlow::Continue(())
        })
        .expect("the file reads");
        (lines, next)
    }

    // A line past the bound is skipped whole, a line still being written is left for the next
    // read, which hands it on once its newline lands, and nothing is handed on twice. Killed by
    // cutting a long line instead of skipping it, by answering the offset past a partial line, and
    // by a resumed read that starts anywhere but the partial line's start.
    #[test]
    fn a_read_hands_on_whole_lines_once_and_skips_a_line_past_the_bound() {
        let folder = tempfile::tempdir().expect("a test folder");
        let path = folder.path().join("usage.jsonl");
        let mut file = std::fs::File::create(&path).expect("the file opens");
        let long_line = "x".repeat(USAGE_FILE_LINE_MAX + 1);
        write!(file, "first\n{long_line}\nsecond\nthi").expect("the file writes");

        let (lines, offset) = read_from(&path, 0);
        assert_eq!(lines, ["first", "second"]);

        writeln!(file, "rd").expect("the file writes");
        let (lines, next) = read_from(&path, offset);
        assert_eq!(lines, ["third"]);
        assert_eq!(read_from(&path, next), (Vec::new(), next));
    }
}
