# Convenience shell with the check toolchain (types, tests, browser suite).
#   nix-shell shell.nix --run ./check.sh
# The browser out-links used by check.sh come from gcroots.nix.
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShellNoCC {
  packages = [
    pkgs.nodejs_22
    pkgs.deno          # `deno check` and the test runner; check.sh needs it on PATH
    pkgs.playwright-driver
    pkgs.firefox
    pkgs.python3
  ];
  PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
}
