//! The fills of a line cmd.exe runs: the places only cmd.exe's reading refuses or accepts at
//! save, and the line a cmd launch builds.

use rstest::rstest;

use super::{LIMIT, fills_of, launch, save};
use crate::shell_commands::fills::{FillRefusal, cmd};
use crate::shell_commands::{ShellGrammar, ShellLineReader};

// A cmd launch's environment: names spelled in another case than the lines spell them, a
// value holding a `^`, one holding a `!`, one a lone `"`, one whose `^^` and `!` cmd.exe's
// second phase reads as a `^` and a `!`, and one a `!` then a `"`.
const CMD_ENVIRONMENT: &[(&str, &str)] = &[
    ("Target", "C:\\a^b"),
    ("Bang", "a!b"),
    ("q", "\""),
    ("Carets", "a^^b!"),
    ("Mark", "!\""),
];

// Each place a save accepts that cmd.exe reads on its own: a `^` inside double quotes, which it
// reads as plain text, a `^` its own `^` escapes, and `%…:…%` text that writes no substring or
// substitution form, or whose name holds `=` and so is no variable, which stays as written.
#[rstest]
#[case::a_caret_in_a_string("grep \"^{{ x }}\" file")]
#[case::an_escaped_caret("echo ^^{{ x }}")]
#[case::a_format_between_percent_signs("printf \"%s:{{ x }}%d\\n\" a 1")]
#[case::an_escaped_address("curl \"http://h/a%20b:{{ x }}%2F\"")]
#[case::a_name_holding_an_equals_sign("echo %a=b:{{ x }}=y%")]
fn a_save_accepts_a_fill_cmd_reads_as_written(#[case] line: &str) {
    assert_eq!(save(line, LIMIT), vec![Ok(())]);
}

// Each place a save refuses for cmd.exe alone: right after an escape caret, and in a reference's
// substitution search or text, quoted or not, or its substring form.
#[rstest]
#[case::a_cmd_escape("echo ^{{ x }}", FillRefusal::CmdCaret)]
#[case::a_cmd_escape_after_an_escaped_quote("echo ^\"^{{ x }}^\"", FillRefusal::CmdCaret)]
#[case::a_cmd_substitution_search("echo %PATH:{{ x }}=y%", FillRefusal::CmdReferenceModifier)]
#[case::a_cmd_substitution_text("echo \"%PATH:a={{ x }}%\"", FillRefusal::CmdReferenceModifier)]
#[case::a_cmd_substring("echo %PATH:~{{ x }}%", FillRefusal::CmdReferenceModifier)]
fn a_save_refuses_a_fill_by_cmds_rule_of_its_place(
    #[case] line: &str,
    #[case] refusal: FillRefusal,
) {
    assert_eq!(save(line, LIMIT), vec![Err(refusal)]);
}

// cmd.exe's delayed expansion reads again each piece of a command holding a `!`, the arguments
// as one piece, and of an `if` each compared value alone, so a launch escapes the author's
// `^` and `!` there, inside quotes and out, and leaves a name running through a `/`, a
// redirection's target, another command, an `if`'s other value and its command without a `!`
// as written.
#[rstest]
#[case::a_caret_in_a_string("grep \"^{{ x }}\" file", "grep \"^^!SIDEKICKS_VALUE_1!\" file")]
#[case::a_caret_before_text_in_a_string(
    "grep \"^a {{ x }}\" file",
    "grep \"^^a !SIDEKICKS_VALUE_1!\" file"
)]
#[case::an_escaped_caret("echo ^^{{ x }}", "echo ^^^^\"!SIDEKICKS_VALUE_1!\"")]
#[case::an_escaped_caret_in_a_name_running_through_a_slash(
    "echo/^^ {{ x }}",
    "echo/^^ \"!SIDEKICKS_VALUE_1!\""
)]
#[case::an_exclamation_mark("echo \"a!\" {{ x }}", "echo \"a^!\" \"!SIDEKICKS_VALUE_1!\"")]
#[case::a_redirections_target(
    "grep \"^a\" {{ x }} > \"^b\"",
    "grep \"^^a\" \"!SIDEKICKS_VALUE_1!\" > \"^b\""
)]
#[case::another_command(
    "echo \"^a\" & echo {{ x }}",
    "echo \"^a\" & echo \"!SIDEKICKS_VALUE_1!\""
)]
#[case::an_if_comparison(
    "IF \"^a{{ x }}\"==\"^b\" echo \"^c\"",
    "IF \"^^a!SIDEKICKS_VALUE_1!\"==\"^b\" echo \"^c\""
)]
#[case::an_if_comparison_after_its_options(
    "IF /I NOT \"^a\" EQU \"^b{{ x }}\" echo \"^c\"",
    "IF /I NOT \"^a\" EQU \"^^b!SIDEKICKS_VALUE_1!\" echo \"^c\""
)]
fn a_cmd_launch_keeps_the_written_text_through_delayed_expansion(
    #[case] line: &str,
    #[case] filled: &str,
) {
    assert_eq!(launch(line, ShellGrammar::Cmd), Ok(filled.to_owned()));
}

// Of a `for` delayed expansion reads the set alone, and the command after `do` as a command of
// its own; each case runs the escape step on the line a launch would build.
#[rstest]
#[case::a_reference_in_the_set(
    "for %i in (\"^a\" \"!SIDEKICKS_VALUE_1!\") do echo \"^b\"",
    "for %i in (\"^^a\" \"!SIDEKICKS_VALUE_1!\") do echo \"^b\""
)]
#[case::a_reference_in_the_command(
    "for %i in (\"^a\") do echo \"^b\" \"!SIDEKICKS_VALUE_1!\"",
    "for %i in (\"^a\") do echo \"^^b\" \"!SIDEKICKS_VALUE_1!\""
)]
fn a_cmd_for_keeps_the_written_text_through_delayed_expansion(
    #[case] line: &str,
    #[case] kept: &str,
) {
    let reference = "\"!SIDEKICKS_VALUE_1!\"";
    let start = line.find(reference).expect("each line holds the reference");
    let range = start..start + reference.len();
    assert_eq!(
        cmd::keep_through_delayed_expansion(line, std::slice::from_ref(&range), &[]),
        kept
    );
}

// A `%…%` reference to a variable the launch's environment defines, its substring and
// substitution forms included, hands the command the value the author's line gives it, read
// as the line's own text: as written where delayed expansion leaves that value whole, as an
// unquoted `C:\a^b` that cmd.exe's second phase reads as `C:\ab`, a value opening quotes or
// a target without a `!`; in its delayed form, escaped outside quotes for the second phase so
// it stays one word, where the value reads as plain text in one piece read again; else as the
// value the second phase reads, behind the carets delayed expansion removes. An undefined one
// stays as written, and the first phase goes on from after its first `%`, so a defined name
// can start at its second; a piece holding a variable whose value has a `!` is read again, and
// an escape caret before a reference escapes its value's first character.
#[rstest]
#[case::a_defined_name(
    "copy {{ x }} \"%TARGET%\"",
    "copy \"!SIDEKICKS_VALUE_1!\" \"!TARGET!\""
)]
#[case::an_undefined_name(
    "copy {{ x }} \"%SOURCE%\"",
    "copy \"!SIDEKICKS_VALUE_1!\" \"%SOURCE%\""
)]
#[case::a_defined_name_after_an_undefined_one(
    "copy {{ x }} %SOURCE%TARGET%",
    "copy \"!SIDEKICKS_VALUE_1!\" %SOURCE%TARGET%"
)]
#[case::an_unquoted_name_whose_value_loses_its_caret(
    "copy {{ x }} %TARGET%",
    "copy \"!SIDEKICKS_VALUE_1!\" %TARGET%"
)]
#[case::a_value_keeping_a_caret_after_an_undefined_name(
    "copy {{ x }} %SOURCE%CARETS%",
    "copy \"!SIDEKICKS_VALUE_1!\" %SOURCEa^^^^b^^!"
)]
#[case::a_substring_form(
    "copy {{ x }} \"%TARGET:~0,5%\"",
    "copy \"!SIDEKICKS_VALUE_1!\" \"!TARGET:~0,5!\""
)]
#[case::a_substitution_form_outside_quotes(
    "copy {{ x }} %BANG:^=+%",
    "copy \"!SIDEKICKS_VALUE_1!\" !BANG:^^^=+!"
)]
#[case::a_modifier_form_with_a_space_in_an_if_value(
    "IF %BANG:a b=c%==x echo {{ x }}",
    "IF !BANG:a^ b^=c!==x echo \"!SIDEKICKS_VALUE_1!\""
)]
#[case::a_value_holding_a_mark(
    "echo {{ x }} & echo \"^a\" %BANG%",
    "echo \"!SIDEKICKS_VALUE_1!\" & echo \"^^a\" !BANG!"
)]
#[case::a_value_opening_quotes(
    "type %Q% & echo \"^a\" {{ x }}",
    "type %Q% & echo \"^a\" \"!SIDEKICKS_VALUE_1!\""
)]
#[case::an_escape_caret_before_a_name(
    "copy {{ x }} ^%TARGET%",
    "copy \"!SIDEKICKS_VALUE_1!\" ^%TARGET%"
)]
#[case::an_escape_caret_before_a_value_opening_quotes(
    "copy {{ x }} ^%Q% \"^a\"",
    "copy \"!SIDEKICKS_VALUE_1!\" ^%Q% \"^^a\""
)]
#[case::a_quoted_value_closing_its_quotes(
    "copy {{ x }} \"%MARK%\"",
    "copy \"!SIDEKICKS_VALUE_1!\" \"^!\"\""
)]
#[case::a_target_not_read_again(
    "copy {{ x }} b > \"%TARGET%\"",
    "copy \"!SIDEKICKS_VALUE_1!\" b > \"%TARGET%\""
)]
fn a_cmd_launch_hands_a_defined_variable_over_unscanned(#[case] line: &str, #[case] filled: &str) {
    let mut reader = ShellLineReader::new(LIMIT);
    assert_eq!(
        fills_of(line).fill_for_launch(&mut reader, ShellGrammar::Cmd, CMD_ENVIRONMENT),
        Ok(filled.to_owned())
    );
}
