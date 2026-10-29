//! A shell handed a line.

use rstest::rstest;

use super::reads_only;

#[rstest]
#[case::bin_zsh_lc_squote_ls_la_squote("/bin/zsh -lc 'ls -la'", true)]
#[case::bin_zsh_lc_ls("/bin/zsh -lc ls", true)]
#[case::bin_bash_lc_squote_git_status_squote("/bin/bash -lc 'git status'", true)]
#[case::bin_sh_c_squote_ls_la_squote("/bin/sh -c 'ls -la'", true)]
#[case::zsh_cl_squote_ls_la_squote("zsh -cl 'ls -la'", true)]
#[case::bash_l_c_squote_ls_la_squote("bash -l -c 'ls -la'", true)]
#[case::bash_c_squote_ls_la_squote("bash -c 'ls -la'", true)]
#[case::bin_zsh_lc_squote_ls_la_amp_amp_rm_a_squote("/bin/zsh -lc 'ls -la && rm a'", false)]
#[case::bin_zsh_lc_squote_bash_lc_ls_squote("/bin/zsh -lc 'bash -lc ls'", false)]
#[case::bin_zsh_lc_squote_ls_squote("/bin/zsh -lc 'ls'", false)]
#[case::bash_c_dquote_ls_la_dquote("bash -c \"ls -la\"", false)]
#[case::bash_lc_squote_ls_la_squote_x("bash -lc 'ls -la' x", false)]
#[case::bash_c_l_squote_ls_la_squote("bash -c -l 'ls -la'", false)]
#[case::bash_lc_double_dash_squote_ls_la_squote("bash -lc -- 'ls -la'", false)]
#[case::bash_i_c_squote_ls_la_squote("bash -i -c 'ls -la'", false)]
#[case::bash_rcfile_f_i_c_ls("bash --rcfile f -i -c ls", false)]
#[case::ksh_upper_r_f_c_ls("ksh -R f -c ls", false)]
#[case::bash_o_posix_c_squote_ls_la_squote("bash -o posix -c 'ls -la'", false)]
#[case::bash_xc_squote_ls_la_squote("bash -xc 'ls -la'", false)]
#[case::bash_noprofile_c_squote_ls_la_squote("bash --noprofile -c 'ls -la'", false)]
#[case::bash_l_squote_ls_la_squote("bash -l 'ls -la'", false)]
#[case::ls_c_squote_a_b_squote("ls -c 'a b'", true)]
#[case::bash_script_sh("bash script.sh", false)]
#[case::bash_s("bash -s", false)]
#[case::bash_lc_squote_ls_la_squote("./bash -lc 'ls -la'", false)]
#[case::tmp_x_zsh_lc_squote_ls_la_squote("/tmp/x/zsh -lc 'ls -la'", false)]
#[case::dquote_bash_dquote_lc_squote_ls_la_squote("\"bash\" -lc 'ls -la'", false)]
#[case::bin_upper_zsh_lc_squote_ls_la_squote("/bin/ZSH -lc 'ls -la'", false)]
#[case::ksh_lc_squote_ls_la_squote("ksh -lc 'ls -la'", false)]
#[case::ksh_c_squote_ls_la_squote("ksh -c 'ls -la'", false)]
#[case::dash_c_squote_ls_la_squote("dash -c 'ls -la'", false)]
#[case::dash_lc_squote_ls_la_squote("dash -lc 'ls -la'", false)]
#[case::csh_c_squote_ls_la_squote("csh -c 'ls -la'", false)]
#[case::tcsh_c_squote_ls_la_squote("tcsh -c 'ls -la'", false)]
#[case::fish_c_squote_ls_la_squote("fish -c 'ls -la'", false)]
#[case::login_option_apart_unquoted("zsh -l -c ls", true)]
fn a_shell_line_reads_only_in_a_providers_own_form(#[case] line: &str, #[case] is_read_only: bool) {
    assert_eq!(reads_only(line), is_read_only, "{line:?}");
}
