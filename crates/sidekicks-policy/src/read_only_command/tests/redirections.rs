//! Redirections, here-documents and here-strings.

use rstest::rstest;

use super::reads_only;

#[rstest]
#[case::ls_gt_dev_null("ls >/dev/null", true)]
#[case::ls_2_gt_dev_null("ls 2>/dev/null", true)]
#[case::ls_amp_gt_dev_null("ls &>/dev/null", true)]
#[case::ls_gt_dev_null_2_gt_amp_1("ls >/dev/null 2>&1", true)]
#[case::ls_2_gt_amp_1("ls 2>&1", true)]
#[case::ls_gt_amp_2("ls >&2", true)]
#[case::ls_2_gt_amp("ls 2>&-", true)]
#[case::ls_3_gt_amp_1_1_gt_amp_2_2_gt_amp_3("ls 3>&1 1>&2 2>&3", true)]
#[case::ls_1_gt_amp_2("ls 1>&2-", false)]
#[case::cat_lt_a_txt("cat <a.txt", true)]
#[case::cat_0_lt_amp_3("cat 0<&3", true)]
#[case::cat_lt_dev_tcp_example_com_80("cat </dev/tcp/example.com/80", true)]
#[case::ls_gt_out("ls >out", false)]
#[case::ls_gt_gt_out("ls >>out", false)]
#[case::ls_gt_pipe_out("ls >|out", false)]
#[case::ls_amp_gt_out("ls &>out", false)]
#[case::ls_amp_gt_gt_out("ls &>>out", false)]
#[case::ls_gt_amp_out("ls >&out", false)]
#[case::ls_2_gt_out("ls 2>out", false)]
#[case::ls_gt_dev_stdout("ls >/dev/stdout", false)]
#[case::ls_gt_dev_zero("ls >/dev/zero", false)]
#[case::ls_gt_dquote_dollar_f_dquote("ls >\"$f\"", false)]
#[case::ls_gt_bang_out("ls >! out", false)]
#[case::ls_lt_gt_f("ls <>f", false)]
#[case::ls_brace_fd_gt_amp_1("ls {fd}>&1", false)]
#[case::exec_3_gt_out("exec 3>out", false)]
#[case::gt_out("> out", false)]
#[case::gt_dev_null(">/dev/null", false)]
#[case::lt_notes_txt("< notes.txt", false)]
#[case::lt_lt_lt_hi("<<<hi", false)]
#[case::find_lt_dev_null_delete("find . </dev/null -delete", false)]
#[case::find_lt_amp_0_delete("find . <&0 -delete", false)]
#[case::find_lt_amp_delete("find . <&- -delete", false)]
#[case::find_gt_amp_delete("find . >&- -delete", false)]
#[case::find_lt_lt_upper_eof_delete_newline_x("find . <<EOF -delete\nx\nEOF", false)]
#[case::find_2_gt_dev_null_delete("find . 2>/dev/null -delete", false)]
#[case::find_amp_gt_dev_null_delete("find . &>/dev/null -delete", false)]
#[case::lt_dev_null_find_delete("</dev/null find . -delete", false)]
#[case::find_lt_lt_lt_x_delete("find . <<<x -delete", false)]
#[case::rg_x_2_gt_dev_null_src("rg x 2>/dev/null src", true)]
#[case::ls_2_gt_amp_1_la("ls 2>&1 -la", true)]
#[case::cat_lt_lt_upper_eof_newline_hi_newline_upper("cat <<EOF\nhi\nEOF", true)]
#[case::cat_lt_lt_upper_eof_newline_tab_hi_newline("cat <<-EOF\n\thi\n\tEOF", true)]
#[case::cat_lt_lt_squote_upper_eof_squote_newline("cat <<'EOF'\n$(touch f)\nEOF", true)]
#[case::cat_lt_lt_dquote_upper_eof_dquote_newline("cat <<\"EOF\"\n$(touch f)\nEOF", true)]
#[case::cat_lt_lt_backslash_upper_eof_newline_dollar("cat <<\\EOF\n$(touch f)\nEOF", true)]
#[case::cat_lt_lt_upper_eof_newline_dollar_paren("cat <<EOF\n$(touch f)\nEOF", false)]
#[case::cat_lt_lt_upper_eof_newline_dollar_brace("cat <<EOF\n${HOME}\nEOF", true)]
#[case::cat_lt_lt_upper_eof_newline_backquote_touch("cat <<EOF\n`touch f`\nEOF", false)]
#[case::cat_lt_lt_upper_e_squote_upper_of_squote("cat <<E'OF'\n$(touch f)\nEOF", true)]
#[case::partly_quoted_delimiter_then_a_read("cat <<E'OF'\n$(touch f)\nEOF\nls", true)]
#[case::partly_quoted_delimiter_then_a_write("cat <<E'OF'\nx\nEOF\nrm a", false)]
#[case::cat_lt_lt_upper_eof_pipe_sh_newline_x("cat <<EOF | sh\nx\nEOF", false)]
#[case::cat_lt_lt_upper_eof_amp_amp_rm_a_newline_x("cat <<EOF && rm a\nx\nEOF", false)]
#[case::cat_lt_lt_lt_hi("cat <<<hi", true)]
#[case::cat_lt_lt_lt_dquote_dollar_upper_home_dquote("cat <<<\"$HOME\"", true)]
#[case::cat_lt_lt_lt_dollar_paren_touch_f("cat <<<$(touch f)", false)]
#[case::errors_to_quoted_null("rg x 2>'/dev/null'", true)]
// `{name}` before a redirect assigns the descriptor it opens to `name`.
#[case::descriptor_name("echo hi {PATH}>/dev/null; ls", false)]
#[case::descriptor_element("echo hi {a[PATH=0]}>/dev/null; ls", false)]
// zsh evaluates `[…]` right after `$name` in a here-document's body too.
#[case::zsh_subscript_in_a_here_document("cat <<EOF\n$a[PATH=0]\nEOF\nls", false)]
// The parser leaves `$` before `#`, a digit or a special parameter as text in a body.
#[case::zsh_length_subscript_in_a_here_document("cat <<EOF\n$#a[PATH=0]\nEOF\nls", false)]
#[case::zsh_positional_subscript_in_a_here_document("cat <<EOF\n$1[PATH=0]\nEOF", false)]
// The parser reads two bodies from one line last first, the shell in order.
#[case::two_quoted_here_documents_piped("cat <<'A' | cat <<'B'\nx\nA\ny\nB\ntouch made\nA", false)]
#[case::two_here_documents_piped("cat <<A | cat <<B\nx\nA\ny\nB\ntouch made\nA", false)]
#[case::two_here_documents_chained("cat <<'A' && cat <<'B'\nx\nA\ny\nB\ntouch made\nA", false)]
// The parser never ends a body at a delimiter past ASCII, and reads on to the line's end.
#[case::delimiter_past_ascii("cat <<\u{20ac}\n$HOME\n\u{20ac}\ntouch made\n", false)]
// Only a start that opens with a quote or `\` makes the parser read its body as text.
#[case::escaped_letter_in_a_delimiter("cat <<E\\OF\n$(\nEOF\ntouch made\nexit\n)", false)]
#[case::escaped_blank_in_a_delimiter("cat <<E\\ X\n$(\nE X\ntouch made\nexit\n)", false)]
#[case::escaped_quote_in_a_delimiter("cat <<E\\'OF\n$(\nE'OF\ntouch made\nexit\n)", false)]
#[case::double_quotes_inside_a_delimiter("cat <<E\"OF\"\n$HOME\nEOF", true)]
// bash and zsh end `$'EOF'` at `EOF`; bash ends `$"EOF"` there too and zsh at `$EOF`.
#[case::ansi_c_delimiter("cat <<$'EOF'\nx\nEOF\ntouch made\n$EOF", false)]
#[case::translated_delimiter("cat <<$\"EOF\"\nx\nEOF\ntouch made\n$EOF", false)]
// bash 3.2 keeps `\u` as written in a start, bash 5.3 and zsh decode it.
#[case::unicode_escape_in_an_ansi_c_delimiter(
    "cat <<$'l\\u0073'\nl\\u0073\ntouch made\nls\ncat <<'Z'\n$'lu0073'\nZ",
    false
)]
// A plain parameter in a start is its own text in every shell.
#[case::parameter_in_a_delimiter("cat <<$X\n$HOME\n$X", true)]
#[case::quoted_parameter_in_a_delimiter("cat <<\"$X\"\n$(touch f)\n$X", true)]
// bash 5.3 and zsh read a quote inside `$[…]` in a start as nested, and zsh inside `"…"` too.
#[case::arithmetic_in_a_delimiter("cat <<a$[b\"c\"]\na$[b\"c\"]\ntouch made\na$[bc]", false)]
#[case::arithmetic_alone_in_a_delimiter("cat <<$['x']\n$['x']\ntouch made\n$[x]", false)]
#[case::arithmetic_in_a_quoted_delimiter(
    "cat <<\"$[ \"1\" ]\"\n$[ \"1\" ]\ntouch made\n$[ 1 ]",
    false
)]
// zsh reads a quote inside a `$(…)` or backquotes in a start as nested, bash as the word's own.
#[case::substitution_in_a_delimiter(
    "cat <<\"$(echo \"x\")\"\n$(echo \"x\")\ntouch made\n$(echo x)",
    false
)]
#[case::backquotes_in_a_delimiter("cat <<\"a`b \"c\"`\"\na`b \"c\"`\ntouch made\na`b c`", false)]
// zsh evaluates `$+name[…]` and its flag siblings' subscripts in a body.
#[case::zsh_flag_subscript_in_a_here_document("cat <<EOF\n$+a[PATH=0]\nEOF", false)]
// The shell ends a body only at a line that is the delimiter whole, after leading tabs for `<<-`;
// the parser ends one at a line that starts with it after blanks, so a second here-document the
// parser opens there hides the shell's next command.
#[case::delimiter_line_with_a_trailing_blank(
    "cat <<'EOF'\nEOF \ncat <<'X'\nEOF\ntouch made\nX",
    false
)]
#[case::delimiter_line_after_blanks("cat <<'EOF'\n  EOF\ncat <<'X'\nEOF\ntouch made\nX", false)]
#[case::delimiter_line_after_a_tab("cat <<'EOF'\n\tEOF\ncat <<'X'\nEOF\ntouch made\nX", false)]
#[case::delimiter_line_with_a_comment("cat <<'EOF'\nEOF #\ncat <<'X'\nEOF\ntouch made\nX", false)]
#[case::delimiter_line_with_a_separator("cat <<'EOF'\nEOF;\ncat <<'X'\nEOF\ntouch made\nX", false)]
#[case::tab_stripping_delimiter_after_blanks(
    "cat <<-'EOF'\n  EOF\ncat <<'X'\nEOF\ntouch made\nX",
    false
)]
#[case::expanded_body_delimiter_with_a_trailing_blank(
    "cat <<EOF\nx\nEOF \ncat <<'X'\nEOF\ntouch made\nX",
    false
)]
// bash ends an expanded body at its delimiter line inside a quote or a substitution.
#[case::substitution_across_the_delimiter("cat <<EOF\n$(cat '\nEOF\ntouch made\n')\nEOF", false)]
#[case::quote_across_the_delimiter("cat <<EOF\n${x:-\"\nEOF\ntouch made\n\"}\nEOF", false)]
#[case::here_document_across_the_delimiter(
    "cat <<EOF\n$(cat <<'X'\nEOF\ntouch made\nX\n)\nEOF",
    false
)]
#[case::tab_stripping_delimiter_after_tabs("cat <<-'EOF'\n\tx\n\tEOF", true)]
fn a_redirect_reads_only_when_it_writes_no_file(#[case] line: &str, #[case] is_read_only: bool) {
    assert_eq!(reads_only(line), is_read_only, "{line:?}");
}
