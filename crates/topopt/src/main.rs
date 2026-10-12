//! `topopt` CLI — see `topopt help` and `docs/tasks/T-203-topopt.md`.

use topopt::cli::{self, Command};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        Ok(Command::Help) => print!("{}", cli::USAGE),
        Ok(other) => eprintln!("topopt: {other:?} needs the fem solver (not wired yet)"),
        Err(e) => {
            eprintln!("topopt: {e}");
            std::process::exit(1);
        }
    }
}
