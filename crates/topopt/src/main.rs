//! `topopt` CLI — see `topopt help` and `docs/tasks/T-203-topopt.md`.

use topopt::cli::{self, Command};
use topopt::commands;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = cli::parse(&args).and_then(|cmd| match cmd {
        Command::Help => {
            print!("{}", cli::USAGE);
            Ok(())
        }
        Command::Run(a) => commands::run(&a),
        Command::Calibrate(a) => commands::calibrate(&a),
        Command::Eval(paths) => commands::eval(&paths),
    });
    if let Err(e) = result {
        eprintln!("topopt: {e}");
        std::process::exit(1);
    }
}
