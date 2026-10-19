//! A shell's integration: takes the shell's own prompt and command marks out of its output. The
//! marks are OSC 133 semantic-prompt marks carrying the shell's nonce as a named option, which a
//! terminal that does not know the option ignores: `ESC ] 133 ; A ; nonce=<nonce> BEL` before each
//! prompt, `... ; C ; ...` before each command and `... ; D ; <exit code> ; ...` before the prompt
//! after it. A mark without this shell's nonce, from a printed file, a program or another tool's
//! integration, is ordinary output.

use std::mem;

use memchr::memchr;

const ESCAPE: u8 = 0x1b;
const BELL: u8 = 0x07;
const BACKSLASH: u8 = b'\\';
/// `ESC ] 133 ;`, the start every semantic-prompt mark shares.
const MARK_INTRODUCER: &[u8] = b"\x1b]133;";
/// The named option each of the daemon's marks carries the shell's nonce in, with its `;` and `=`.
const NONCE_OPTION: &[u8] = b";nonce=";
/// The string terminator, `ESC \`, the longer of the two terminators a mark may end with.
const STRING_TERMINATOR_LENGTH: usize = 2;
/// The longest exit code a shell reports: a signed 32-bit integer.
const LONGEST_EXIT_CODE: &[u8] = b"-2147483648";
/// The most digits an exit code a mark carries may have.
const EXIT_CODE_MAX_DIGITS: usize = 10;

/// A mark the shell reported, at `offset`: the index in the `kept` buffer of the read that took it
/// out. A `CommandEnd` written with no command started since the last prompt carries no exit code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShellMark {
    /// The shell is about to draw its prompt.
    Prompt {
        /// Where the mark sat in the kept output.
        offset: usize,
    },
    /// The shell is about to run a command.
    CommandStart {
        /// Where the mark sat in the kept output.
        offset: usize,
    },
    /// The command ended, with the exit code the shell reported for it.
    CommandEnd {
        /// The command's exit code, up to ten digits with an optional sign.
        exit_code: Option<i64>,
        /// Where the mark sat in the kept output.
        offset: usize,
    },
}

/// What the bytes from an escape are.
enum MarkMatch {
    /// One of this shell's marks, ending just before `end`.
    Mark { kind: MarkKind, end: usize },
    /// The start of a mark the input ends inside.
    Incomplete,
    /// Not one of this shell's marks.
    NotAMark,
}

/// Which mark a body names, before its place in the output is known.
#[derive(Clone, Copy)]
enum MarkKind {
    Prompt,
    CommandStart,
    CommandEnd { exit_code: Option<i64> },
}

/// Reads one shell's output and takes its marks out. Stateful per shell: a mark split across reads
/// is held until its terminator, but a held prefix longer than the longest mark the daemon writes
/// is not one of its marks and is passed on at once.
pub(crate) struct ShellMarkReader {
    nonce: Box<[u8]>,
    /// The length of the longest mark carrying this shell's nonce.
    longest_mark_length: usize,
    /// The start of a mark the last read ended inside.
    held: Vec<u8>,
}

impl ShellMarkReader {
    /// A reader of the marks that carry `nonce`.
    pub(crate) fn new(nonce: &str) -> Self {
        let longest_mark_length = MARK_INTRODUCER.len()
            + b"D;".len()
            + LONGEST_EXIT_CODE.len()
            + NONCE_OPTION.len()
            + nonce.len()
            + STRING_TERMINATOR_LENGTH;
        Self {
            nonce: nonce.as_bytes().into(),
            longest_mark_length,
            held: Vec::new(),
        }
    }

    /// Appends to `kept` what stays of `chunk`, after any prefix the previous read held, with this
    /// shell's marks taken out, and appends each mark to `marks` in the order they sat.
    pub(crate) fn read(&mut self, chunk: &[u8], kept: &mut Vec<u8>, marks: &mut Vec<ShellMark>) {
        let joined;
        let input: &[u8] = if self.held.is_empty() {
            chunk
        } else {
            let mut held = mem::take(&mut self.held);
            held.extend_from_slice(chunk);
            joined = held;
            &joined
        };
        let mut copied_up_to = 0;
        let mut passed_up_to = input.len();
        let mut search_from = 0;
        while let Some(found) = memchr(ESCAPE, &input[search_from..]) {
            let start = search_from + found;
            match self.match_at(input, start) {
                MarkMatch::Incomplete => {
                    self.held.extend_from_slice(&input[start..]);
                    passed_up_to = start;
                    break;
                }
                MarkMatch::NotAMark => search_from = start + 1,
                MarkMatch::Mark { kind, end } => {
                    kept.extend_from_slice(&input[copied_up_to..start]);
                    let offset = kept.len();
                    marks.push(match kind {
                        MarkKind::Prompt => ShellMark::Prompt { offset },
                        MarkKind::CommandStart => ShellMark::CommandStart { offset },
                        MarkKind::CommandEnd { exit_code } => {
                            ShellMark::CommandEnd { exit_code, offset }
                        }
                    });
                    copied_up_to = end;
                    search_from = end;
                }
            }
        }
        kept.extend_from_slice(&input[copied_up_to..passed_up_to]);
    }

    /// Appends to `kept` the prefix the last read held, which is output once the shell has ended.
    pub(crate) fn finish(&mut self, kept: &mut Vec<u8>) {
        kept.append(&mut self.held);
    }

    /// Whether the bytes from `start`, an escape, are one of this shell's marks, the start of one
    /// the input ends inside, or neither. Holding stops at the longest mark's length.
    fn match_at(&self, input: &[u8], start: usize) -> MarkMatch {
        for (index, &expected) in MARK_INTRODUCER.iter().enumerate() {
            match input.get(start + index) {
                None => return MarkMatch::Incomplete,
                Some(&byte) if byte != expected => return MarkMatch::NotAMark,
                Some(_) => {}
            }
        }
        let body_start = start + MARK_INTRODUCER.len();
        let mut index = body_start;
        while index - start < self.longest_mark_length {
            let Some(&byte) = input.get(index) else {
                return MarkMatch::Incomplete;
            };
            if byte == BELL {
                return self.mark_from(&input[body_start..index], index + 1);
            }
            if byte == ESCAPE {
                return match input.get(index + 1) {
                    None => MarkMatch::Incomplete,
                    Some(&BACKSLASH) => {
                        self.mark_from(&input[body_start..index], index + STRING_TERMINATOR_LENGTH)
                    }
                    Some(_) => MarkMatch::NotAMark,
                };
            }
            index += 1;
        }
        MarkMatch::NotAMark
    }

    /// The mark whose body is `body`, ending just before `end`, when it is this shell's: `A`, `C`
    /// or `D` with an optional exit code of up to ten digits, then the nonce option holding
    /// exactly this shell's nonce.
    fn mark_from(&self, body: &[u8], end: usize) -> MarkMatch {
        let (kind, rest) = match body.split_first() {
            Some((b'A', rest)) => (MarkKind::Prompt, rest),
            Some((b'C', rest)) => (MarkKind::CommandStart, rest),
            Some((b'D', rest)) => {
                let (exit_code, rest) = split_exit_code(rest);
                (MarkKind::CommandEnd { exit_code }, rest)
            }
            _ => return MarkMatch::NotAMark,
        };
        let is_this_shells = rest
            .strip_prefix(NONCE_OPTION)
            .is_some_and(|nonce| !nonce.contains(&b';') && nonce == &*self.nonce);
        if is_this_shells {
            MarkMatch::Mark { kind, end }
        } else {
            MarkMatch::NotAMark
        }
    }
}

/// The exit code `;<code>` at the start of `rest`, an optional `-` and one to ten ASCII digits, and
/// what follows it; no exit code and `rest` whole when it does not start with one.
fn split_exit_code(rest: &[u8]) -> (Option<i64>, &[u8]) {
    let Some(after) = rest.strip_prefix(b";") else {
        return (None, rest);
    };
    let (is_negative, unsigned) = match after.strip_prefix(b"-") {
        Some(unsigned) => (true, unsigned),
        None => (false, after),
    };
    let digits = unsigned
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if !(1..=EXIT_CODE_MAX_DIGITS).contains(&digits) {
        return (None, rest);
    }
    // Ten decimal digits stay far below `i64::MAX`, so the fold cannot overflow.
    let magnitude = unsigned[..digits]
        .iter()
        .fold(0_i64, |value, digit| value * 10 + i64::from(digit - b'0'));
    let exit_code = if is_negative { -magnitude } else { magnitude };
    (Some(exit_code), &unsigned[digits..])
}

#[cfg(test)]
mod tests {
    use super::{ShellMark, ShellMarkReader};

    const NONCE: &str = "0f3c9a7e5b";

    /// Reads `pieces` one read at a time and finishes, returning the kept output and the marks.
    fn read_all(reader: &mut ShellMarkReader, pieces: &[&[u8]]) -> (Vec<u8>, Vec<ShellMark>) {
        let mut output = Vec::new();
        let mut marks = Vec::new();
        for piece in pieces {
            let mut kept = Vec::new();
            let mut read_marks = Vec::new();
            reader.read(piece, &mut kept, &mut read_marks);
            marks.extend(
                read_marks
                    .into_iter()
                    .map(|mark| shifted(mark, output.len())),
            );
            output.extend_from_slice(&kept);
        }
        reader.finish(&mut output);
        (output, marks)
    }

    /// `mark` with its offset moved from its read's kept output to the whole output.
    fn shifted(mark: ShellMark, by: usize) -> ShellMark {
        match mark {
            ShellMark::Prompt { offset } => ShellMark::Prompt {
                offset: offset + by,
            },
            ShellMark::CommandStart { offset } => ShellMark::CommandStart {
                offset: offset + by,
            },
            ShellMark::CommandEnd { exit_code, offset } => ShellMark::CommandEnd {
                exit_code,
                offset: offset + by,
            },
        }
    }

    #[test]
    fn takes_marks_out_wherever_the_reads_split_them() {
        let output = format!(
            "ab\x1b]133;D;-1;nonce={NONCE}\x1b\\cd\x1b]133;A;nonce={NONCE}\x07ef\x1b]133;C;nonce=\
             {NONCE}\x07"
        );
        let bytes = output.as_bytes();
        for split in 0..=bytes.len() {
            let mut reader = ShellMarkReader::new(NONCE);
            let (kept, marks) = read_all(&mut reader, &[&bytes[..split], &bytes[split..]]);
            assert_eq!(kept, b"abcdef", "split at {split}");
            assert_eq!(
                marks,
                [
                    ShellMark::CommandEnd {
                        exit_code: Some(-1),
                        offset: 2
                    },
                    ShellMark::Prompt { offset: 4 },
                    ShellMark::CommandStart { offset: 6 },
                ],
                "split at {split}"
            );
        }
    }

    #[test]
    fn passes_a_mark_with_another_nonce_through_as_output() {
        let output = "a\x1b]133;A;nonce=1111111111\x07b\x1b]133;D;0;nonce=\x07c";
        let mut reader = ShellMarkReader::new(NONCE);

        let (kept, marks) = read_all(&mut reader, &[output.as_bytes()]);

        assert_eq!(kept, output.as_bytes());
        assert_eq!(marks, [] as [ShellMark; 0]);
    }

    #[test]
    fn lets_go_of_a_held_prefix_longer_than_the_longest_mark() {
        let unterminated = format!("\x1b]133;A;nonce={NONCE}{}", "x".repeat(64));
        let mut reader = ShellMarkReader::new(NONCE);
        let mut kept = Vec::new();
        let mut marks = Vec::new();

        reader.read(unterminated.as_bytes(), &mut kept, &mut marks);

        assert_eq!(kept, unterminated.as_bytes());
        assert_eq!(marks, [] as [ShellMark; 0]);
        let mut finished = Vec::new();
        reader.finish(&mut finished);
        assert_eq!(finished, [] as [u8; 0]);
    }
}
