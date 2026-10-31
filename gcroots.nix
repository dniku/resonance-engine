{ pkgs ? import <nixpkgs> {} }:
{
  # The standalone build shells out to the esbuild CLI (nixpkgs ships it
  # binary-only, and this project has no node_modules), so CI provisions it here
  # rather than relying on it happening to be in /nix/store already.
  esbuild = pkgs.esbuild;
  pw = pkgs.playwright-driver;
  node = pkgs.nodejs_22;
  browsers = pkgs.playwright-driver.browsers;
}
