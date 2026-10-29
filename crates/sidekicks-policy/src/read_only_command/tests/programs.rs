//! Listed programs and their options, and the options of a listed program that write or run.

use rstest::rstest;

use super::reads_only;

#[rstest]
#[case::make_test("make test", false)]
#[case::ls("ls", true)]
#[case::ls_la_src("ls -la src", true)]
#[case::ls_sort_eq_size("ls --sort=size", true)]
#[case::head_n_5_a_txt("head -n 5 a.txt", true)]
#[case::head_5_a_txt("head -5 a.txt", true)]
#[case::tail_n_20_log_txt("tail -n 20 log.txt", true)]
#[case::cat_n_a_txt("cat -n a.txt", true)]
#[case::wc_l_a_txt("wc -l a.txt", true)]
#[case::stat_upper_l_a_txt("stat -L a.txt", true)]
#[case::rg_n_foo_src("rg -n foo src", true)]
#[case::rg_g_squote_star_rs_squote_foo("rg -g '*.rs' foo", true)]
#[case::grep_rn_foo("grep -rn foo .", true)]
#[case::diff_u_a_b("diff -u a b", true)]
#[case::find_name_squote_star_rs_squote_type_f("find . -name '*.rs' -type f", true)]
#[case::cd_src("cd src", true)]
#[case::pwd_upper_p("pwd -P", true)]
#[case::echo_n_hi("echo -n hi", true)]
#[case::which_a_ls("which -a ls", true)]
#[case::git_status_sb("git status -sb", true)]
#[case::git_log_oneline_5("git log --oneline -5", true)]
#[case::git_diff_stat("git diff --stat", true)]
#[case::git_show_stat_upper_head("git show --stat HEAD", true)]
#[case::git_no_pager_log_1("git --no-pager log -1", true)]
#[case::tail_f_log_txt("tail -f log.txt", false)]
#[case::ls_col_eq_never("ls --col=never", false)]
#[case::cat_double_dash_n("cat -- -n", true)]
#[case::cat_lone_dash("cat -", true)]
#[case::touch_f("touch f", false)]
#[case::du_sh("du -sh .", false)]
#[case::rg_pre_sh_foo("rg --pre sh foo", false)]
#[case::rg_pre_eq_sh_foo("rg --pre=sh foo", false)]
#[case::rg_pre_glob_squote_star_gz_squote_foo("rg --pre-glob '*.gz' foo", false)]
#[case::rg_z_foo("rg -z foo", false)]
#[case::rg_hostname_bin_eq_h_foo("rg --hostname-bin=h foo", false)]
#[case::find_delete("find . -delete", false)]
#[case::find_exec_rm_brace_backslash_semicolon("find . -exec rm {} \\;", false)]
#[case::find_execdir_sh_brace_plus("find . -execdir sh {} +", false)]
#[case::find_ok_rm_brace_backslash_semicolon("find . -ok rm {} \\;", false)]
#[case::find_okdir_rm_brace_backslash_semicolon("find . -okdir rm {} \\;", false)]
#[case::find_fls_out("find . -fls out", false)]
#[case::find_fprint_out("find . -fprint out", false)]
#[case::find_fprint0_out("find . -fprint0 out", false)]
#[case::find_fprintf_out_percent_p("find . -fprintf out %p", false)]
#[case::find_files0_from_list("find . -files0-from list", false)]
#[case::diff_l_a_b("diff -l a b", false)]
#[case::git_log_output_eq_out("git log --output=out", false)]
#[case::git_diff_output_out("git diff --output out", false)]
#[case::git_show_output_eq_out_upper_head("git show --output=out HEAD", false)]
#[case::git_c_core_pager_eq_sh_log("git -c core.pager=sh log", false)]
#[case::git_config_env_eq_core_pager_eq_upper_v_log("git --config-env=core.pager=V log", false)]
#[case::git_exec_path_eq_tmp_log("git --exec-path=/tmp log", false)]
#[case::git_upper_c_sub_status("git -C sub status", false)]
#[case::git_git_dir_eq_x_log("git --git-dir=x log", false)]
#[case::git_work_tree_eq_x_status("git --work-tree=x status", false)]
#[case::git_p_log("git -p log", false)]
#[case::git_diff_ext_diff("git diff --ext-diff", false)]
#[case::git_log_p_textconv("git log -p --textconv", false)]
#[case::git_branch("git branch", false)]
#[case::cd_sub_amp_amp_git_status("cd sub && git status", false)]
#[case::git_status_semicolon_cd_sub("git status; cd sub", false)]
#[case::cd_sub_amp_amp_ls("cd sub && ls", true)]
#[case::cd_sub_semicolon_rg_x_2_gt_dev_null("cd sub; rg x . 2>/dev/null", true)]
// An option's value is skipped unchecked, so a value of `--` ends no option and one that reads as
// an option is no option.
#[case::rg_value_of_dashes("rg -e -- --pre=sh x", false)]
#[case::diff_value_of_dashes("diff -x -- --paginate a b", false)]
#[case::rg_long_value_of_dashes("rg --regexp -- --pre=sh x", false)]
// A value inside the option's own word leaves the next word an option.
#[case::rg_long_value_inside_the_word("rg --regexp=foo --pre=sh x", false)]
#[case::rg_value_inside_the_cluster("rg -efoo --pre=sh x", false)]
#[case::rg_pattern_like_an_option("rg -e -z src", true)]
// Git's `-U` takes only the value inside its word, so the next word is git's own option.
#[case::git_diff_attached_value("git diff -U --output=f", false)]
// A primary's value that starts with `-` is no primary.
#[case::find_value_with_a_dash("find . -mtime -7", true)]
fn a_listed_program_reads_only_with_its_own_options(
    #[case] line: &str,
    #[case] is_read_only: bool,
) {
    assert_eq!(reads_only(line), is_read_only, "{line:?}");
}
