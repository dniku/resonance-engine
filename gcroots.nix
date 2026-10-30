{ pkgs ? import <nixpkgs> {} }:
{
  pw = pkgs.playwright-driver;
  node = pkgs.nodejs_22;
  browsers = pkgs.playwright-driver.browsers;
}
