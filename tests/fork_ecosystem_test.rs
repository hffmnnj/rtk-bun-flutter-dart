//! Fork routing must survive upstream's move from main.rs to lib.rs.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Output;

mod common;

fn run_stub(tool: &str, body: &str, args: &[&str]) -> Output {
    let dir = tempfile::tempdir().expect("scratch directory");
    let path = dir.path().join(tool);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write stub");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod stub");
    common::rtk_command()
        .args(args)
        .env("PATH", dir.path())
        .env("RTK_TEE", "0")
        .current_dir(dir.path())
        .output()
        .expect("run fork CLI")
}

#[test]
fn bun_unknown_reporter_preserves_stderr_and_failure() {
    let out = run_stub(
        "bun",
        "printf 'TAP version 13\\nnot ok 1 - custom reporter failure\\n' >&2; exit 7",
        &["bun", "test", "--reporter=tap"],
    );
    assert_eq!(out.status.code(), Some(7), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("not ok 1 - custom reporter failure"),
        "{out:?}"
    );
    assert!(!stderr.contains("0 passed"), "{out:?}");
}

#[test]
fn bun_build_stdout_is_the_bundle_not_a_status_summary() {
    let out = run_stub(
        "bun",
        "printf 'export const value = 42;\\n'",
        &["bun", "build", "index.ts"],
    );
    assert!(out.status.success(), "{out:?}");
    assert_eq!(out.stdout, b"export const value = 42;\n");
}

#[test]
fn bun_build_preserves_diagnostics_and_exit_code() {
    let out = run_stub(
        "bun",
        "printf 'error: Could not resolve missing\\n' >&2; exit 5",
        &["bun", "build", "index.ts"],
    );
    assert_eq!(out.status.code(), Some(5), "{out:?}");
    assert_eq!(out.stderr, b"error: Could not resolve missing\n");
    assert!(out.stdout.is_empty(), "{out:?}");
}

#[test]
fn flutter_cumulative_counts_survive_cli_routing() {
    let out = run_stub(
        "flutter",
        "printf '00:00 +0: loading suite\\n00:00 +1: second test\\n00:00 +2: All tests passed!\\n'",
        &["flutter", "test"],
    );
    assert!(out.status.success(), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("2 passed, 0 failed"),
        "{out:?}"
    );
}
