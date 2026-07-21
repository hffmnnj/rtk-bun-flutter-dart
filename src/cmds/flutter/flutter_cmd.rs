//! Flutter SDK command filters (pub, analyze, test, build).
//!
//! Built from the real-world fixtures in carlosfiori/rtk_flutter and the
//! requirements in rtk-ai/rtk#1098.

use crate::core::runner;
use crate::core::utils::{resolved_command, strip_ansi};
use anyhow::Result;
use lazy_static::lazy_static;
use regex::Regex;
use std::collections::HashMap;

pub fn run_flutter_pub(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered("flutter", &["pub"], args, "flutter pub", filter_flutter_pub, verbose)
}

pub fn run_flutter_analyze(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered(
        "flutter",
        &["analyze"],
        args,
        "flutter analyze",
        filter_flutter_analyze,
        verbose,
    )
}

pub fn run_flutter_test(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered(
        "flutter",
        &["test"],
        args,
        "flutter test",
        filter_flutter_test,
        verbose,
    )
}

pub fn run_flutter_build(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered(
        "flutter",
        &["build"],
        args,
        "flutter build",
        filter_flutter_build,
        verbose,
    )
}

fn run_filtered(
    base: &str,
    base_args: &[&str],
    args: &[String],
    label: &str,
    filter: fn(&str) -> String,
    verbose: u8,
) -> Result<i32> {
    let mut cmd = resolved_command(base);
    for a in base_args {
        cmd.arg(a);
    }
    for arg in args {
        cmd.arg(arg);
    }

    if verbose > 0 {
        eprintln!("Running: {} {} {}", base, base_args.join(" "), args.join(" "));
    }

    runner::run_filtered(
        cmd,
        label,
        &args.join(" "),
        filter,
        runner::RunOptions::default(),
    )
}

fn filter_flutter_pub(output: &str) -> String {
    let mut result = Vec::new();
    let mut changed = None;
    let mut outdated = Vec::new();

    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        if clean.starts_with("Changed ") && clean.contains("dependencies") {
            changed = Some(clean);
        } else if clean.contains("newer versions") || clean.contains("incompatible") {
            outdated.push(clean);
        } else if clean.to_lowercase().contains("error") || clean.to_lowercase().contains("warn") {
            result.push(clean);
        }
    }

    if let Some(c) = changed {
        result.push(c);
    }
    result.extend(outdated);

    if result.is_empty() {
        "ok".to_string()
    } else {
        result.join("\n")
    }
}

fn filter_flutter_analyze(output: &str) -> String {
    lazy_static! {
        static ref ISSUE_RE: Regex = Regex::new(
            r"^(info|warning|error)\s+•\s+(.+?)\s+•\s+(.+?):(\d+):(\d+)\s+•\s+(.+)$"
        ).unwrap();
    }

    let mut by_file: HashMap<String, Vec<(Sev, String, String)>> = HashMap::new();
    let mut summary = String::new();

    for line in output.lines() {
        let clean = strip_ansi(line);
        let trimmed = clean.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains("issues found") {
            summary = trimmed.to_string();
            continue;
        }

        if let Some(caps) = ISSUE_RE.captures(trimmed) {
            let sev = match &caps[1] {
                "error" => Sev::Error,
                "warning" => Sev::Warning,
                _ => Sev::Info,
            };
            let rule = caps[6].to_string();
            let message = caps[2].to_string();
            let file = format!("{}:{}", &caps[3], &caps[4]);
            by_file.entry(file).or_default().push((sev, rule, message));
        }
    }

    if by_file.is_empty() {
        return if summary.is_empty() {
            "ok".to_string()
        } else {
            summary
        };
    }

    let mut lines = Vec::new();
    if !summary.is_empty() {
        lines.push(summary);
    }

    // Sort files so errors/warnings appear first
    let mut files: Vec<_> = by_file.into_iter().collect();
    files.sort_by_key(|(_, issues)| {
        let errors = issues.iter().filter(|(s, _, _)| *s == Sev::Error).count();
        let warnings = issues.iter().filter(|(s, _, _)| *s == Sev::Warning).count();
        (std::cmp::Reverse(errors), std::cmp::Reverse(warnings))
    });

    for (file, issues) in files {
        lines.push(format!("{} ({} issues)", file, issues.len()));
        // Deduplicate by (severity, rule, message)
        let mut seen: HashMap<(Sev, String, String), usize> = HashMap::new();
        for (sev, rule, message) in &issues {
            *seen.entry((*sev, rule.clone(), message.clone())).or_insert(0) += 1;
        }
        let mut deduped: Vec<_> = seen.into_iter().collect();
        deduped.sort_by_key(|((sev, _, _), _)| match sev {
            Sev::Error => 0,
            Sev::Warning => 1,
            Sev::Info => 2,
        });
        for ((sev, rule, message), count) in deduped {
            let sev_label = match sev {
                Sev::Error => "error",
                Sev::Warning => "warning",
                Sev::Info => "info",
            };
            if count > 1 {
                lines.push(format!("  {} {}: {} (x{})", sev_label, rule, message, count));
            } else {
                lines.push(format!("  {} {}: {}", sev_label, rule, message));
            }
        }
    }

    lines.join("\n")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Sev {
    Error,
    Warning,
    Info,
}

fn filter_flutter_test(output: &str) -> String {
    let mut passed = 0;
    let mut failed = 0;
    let mut failures: Vec<String> = Vec::new();
    let mut in_exception = false;
    let mut current_failure = Vec::new();

    for line in output.lines() {
        let clean = strip_ansi(line);
        let trimmed = clean.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Progress line: 00:00 +N -M: /path/to/test.dart: description
        if trimmed.starts_with("00:00 +") {
            // Count passing/failing markers in the progress token
            if let Some(rest) = trimmed.strip_prefix("00:00 +") {
                let marker_end = rest.find(':').unwrap_or(rest.len());
                let marker = &rest[..marker_end];
                if marker.contains("-") {
                    // A failure is active at this point; we'll record it on [E] or explicit fail.
                }
            }
            continue;
        }

        if trimmed.contains("[E]") || trimmed.starts_with("══╡ EXCEPTION") || trimmed.contains("Test failed.") {
            if !current_failure.is_empty() {
                failures.push(current_failure.join("\n"));
                current_failure.clear();
            }
            in_exception = true;
            current_failure.push(trimmed.to_string());
            failed += 1;
            continue;
        }

        if in_exception {
            if trimmed.starts_with("═════════════════") {
                failures.push(current_failure.join("\n"));
                current_failure.clear();
                in_exception = false;
                continue;
            }
            current_failure.push(trimmed.to_string());
            continue;
        }

        if trimmed.starts_with("Failing tests:") {
            failures.push(trimmed.to_string());
            continue;
        }

        if trimmed.starts_with(" /home/")
            || trimmed.starts_with(" /Users/")
            || (trimmed.starts_with(" /") && trimmed.contains("test"))
        {
            failures.push(format!(" -{}", trimmed));
            continue;
        }

        if trimmed.contains("All tests passed!") {
            passed += 1;
        }
    }

    if !current_failure.is_empty() {
        failures.push(current_failure.join("\n"));
    }

    let summary = format!("{} passed, {} failed", passed.max(0), failed);
    let mut lines = vec![summary];
    for failure in failures {
        lines.push("---".to_string());
        lines.push(failure);
    }
    lines.join("\n")
}

fn filter_flutter_build(output: &str) -> String {
    lazy_static! {
        static ref BUILD_LINE_RE: Regex = Regex::new(
            r"^(\S+)\s+(.+)$"
        ).unwrap();
    }
    let mut result = Vec::new();
    let mut errors = Vec::new();

    for line in output.lines() {
        let clean = strip_ansi(line);
        let trimmed = clean.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if lower.contains("error") {
            errors.push(trimmed.to_string());
        } else if lower.contains("built")
            || lower.contains("success")
            || lower.contains("fail")
            || lower.contains("installing")
            || lower.contains("compiling")
            || trimmed.contains("MB")
            || trimmed.contains("KB")
        {
            result.push(trimmed.to_string());
        }
    }

    if !errors.is_empty() {
        result.push("---".to_string());
        result.extend(errors);
    }

    if result.is_empty() {
        "ok".to_string()
    } else {
        result.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_flutter_pub_summary() {
        let out = "Resolving dependencies...\n+ pkg 1.0.0\nChanged 58 dependencies!\n5 packages have newer versions";
        let res = filter_flutter_pub(out);
        assert!(res.contains("Changed 58"));
        assert!(res.contains("newer versions"));
        assert!(!res.contains("+ pkg"));
    }

    #[test]
    fn test_filter_flutter_analyze_groups() {
        let out = r#"
info • Don't invoke 'print' • lib/main.dart:21:5 • avoid_print
warning • Local variable unused • lib/main.dart:35:9 • unused_local_variable
20 issues found. (ran in 3.4s)
"#;
        let res = filter_flutter_analyze(out);
        assert!(res.contains("20 issues found"));
        assert!(res.contains("unused_local_variable"));
    }

    #[test]
    fn test_filter_flutter_build_errors() {
        let out = "Running Gradle...\nerror: resource not found\nBuild finished";
        let res = filter_flutter_build(out);
        assert!(res.contains("error"));
    }
}
