# Convenience shell with the check toolchain (types, tests, browser suite).
#   nix-shell shell.nix --run ./check.sh
# The browser out-links used by check.sh come from gcroots.nix.
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShellNoCC {
  packages = [
    pkgs.nodejs_22
    pkgs.deno          # `deno check` and the test runner; check.sh needs it on PATH
    pkgs.esbuild       # tools/build-standalone.mjs spawns this CLI to bundle
    # From gcroots.nix's own pkgs so PLAYWRIGHT_BROWSERS_PATH and the driver the
    # suite requires are the same revision. Passing pkgs.playwright-driver here
    # directly looked the same but resolved to a different browser set than the
    # .gc-roots/pw out-link, and the launch failure it caused was invisible: the
    # suite reported 0/0 and exited 0.
    pkgs.playwright-driver
    pkgs.firefox
    pkgs.python3
    # styles.css asks for `ui-sans-serif, system-ui`, which resolves to
    # whatever the host has. Golden images that contain text therefore differ
    # between machines; fontconfig gives that keyword a defined answer.
    pkgs.fontconfig
    pkgs.dejavu_fonts
    pkgs.liberation_ttf
  ];
  PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
}
