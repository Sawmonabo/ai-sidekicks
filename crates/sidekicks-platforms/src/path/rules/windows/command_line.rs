//! A program's command line on Windows: how std's `Command` writes it and how long it may be.

use std::iter;

/// The most UTF-16 units a Windows command line holds, its ending NUL included, as `CreateProcessW`
/// takes it.
pub(crate) const COMMAND_LINE_UNITS: usize = 32_767;

/// The NUL-ended command line, in UTF-16 units: `program` in double quotes, then each argument
/// after one space as a C program's standard argument parsing reads it back, the rule std's
/// `Command` writes by. A program path holds no quote, so its own is never escaped.
pub(crate) fn compose_command_line(
    program: impl IntoIterator<Item = u16>,
    arguments: &[impl AsRef<str>],
) -> Vec<u16> {
    let quote = u16::from(b'"');
    let mut line = vec![quote];
    line.extend(program);
    line.push(quote);
    for argument in arguments {
        line.push(u16::from(b' '));
        append_argument(&mut line, argument.as_ref());
    }
    line.push(0);
    line
}

// Appends `argument`, quoted when it is empty or holds a space or a tab, its backslashes doubled
// where a quote follows them.
fn append_argument(line: &mut Vec<u16>, argument: &str) {
    let quote = u16::from(b'"');
    let backslash = u16::from(b'\\');
    let is_quoted = argument.is_empty() || argument.contains([' ', '\t']);
    if is_quoted {
        line.push(quote);
    }
    let mut backslashes = 0_usize;
    for unit in argument.encode_utf16() {
        if unit == backslash {
            backslashes += 1;
        } else {
            if unit == quote {
                line.extend(iter::repeat_n(backslash, backslashes + 1));
            }
            backslashes = 0;
        }
        line.push(unit);
    }
    if is_quoted {
        line.extend(iter::repeat_n(backslash, backslashes));
        line.push(quote);
    }
}

#[cfg(test)]
mod tests {
    use super::compose_command_line;

    // Fails when the doubled backslashes before a quote are dropped, or an argument holding a tab
    // is left unquoted, which changes what the program reads back.
    #[test]
    fn a_command_line_argument_reads_back_as_written() {
        for (argument, expected) in [
            ("plain", "plain"),
            ("", r#""""#),
            ("two words", r#""two words""#),
            (r#"say "hi""#, r#""say \"hi\"""#),
            (r#"a\"b"#, r#"a\\\"b"#),
            (r"C:\folder\", r"C:\folder\"),
            (r"C:\my folder\", r#""C:\my folder\\""#),
            ("a\tb", "\"a\tb\""),
            (r"C:\my folder\\", r#""C:\my folder\\\\""#),
        ] {
            let line = compose_command_line([], &[argument]);
            assert_eq!(
                String::from_utf16_lossy(&line),
                format!("\"\" {expected}\0"),
                "{argument}"
            );
        }
    }
}
