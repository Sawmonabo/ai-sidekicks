//! The read-only verdict on every form of a line, one table per kind of form.

mod expansions;
mod lists;
mod program_names;
mod programs;
mod quoting;
mod redirections;
mod shell_lines;
mod wrappers;

use super::*;

// Past the 10,000-character rule, so the long line meets that rule and not the reader's bound.
const LIMIT: usize = 64 * 1024;

fn reads_only(line: &str) -> bool {
    is_read_only_command(&mut ShellLineReader::new(LIMIT), line, None)
}
