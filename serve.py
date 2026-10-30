#!/usr/bin/env python3
"""Serve the project over HTTP.

The bind address comes from the environment, in this order:

* ``HOST`` / ``PASEO_PORT`` -- injected by the Paseo daemon when this is started
  as a workspace service, where the port is allocated for us and the proxy needs
  the chosen port to be reachable from outside the container (so ``HOST`` is
  ``0.0.0.0``).
* ``PORT`` -- a plain override for local use.
* loopback on 8000 -- the default for a person running this by hand.

An unparseable value is an error rather than a silent fallback: a typo in a
deployed port should not quietly bind somewhere else.
"""
from __future__ import annotations

import http.server
import os
import socketserver
import sys
from functools import partial
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
ROOT = Path(__file__).resolve().parent


class ConfigError(ValueError):
    """An environment variable that cannot describe a socket."""


def listen_target(environ: dict[str, str]) -> tuple[str, int]:
    """Where to bind: Paseo's ``HOST``/``PASEO_PORT`` first, then ``PORT``, then loopback."""
    host = environ.get("HOST")
    raw_port = environ.get("PASEO_PORT")
    if raw_port is None:
        raw_port = environ.get("PORT")
    if raw_port is None:
        port = DEFAULT_PORT
    else:
        try:
            port = int(raw_port)
        except ValueError as error:
            raise ConfigError(f"port must be an integer, got {raw_port!r}") from error
        if not 0 <= port <= 65535:
            raise ConfigError(f"port out of range: {port}")
    return (host or DEFAULT_HOST), port


class Handler(http.server.SimpleHTTPRequestHandler):
    # A wrong MIME type on a .js file is a blank page with an opaque console
    # error, so the types ES modules care about are pinned rather than guessed.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".png": "image/png",
    }

    def end_headers(self) -> None:
        # Development default: a stale bundle is a confusing way to look old.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main(argv: list[str]) -> int:
    # A positional port wins over the environment, so `serve.py 9000` still works.
    environ = dict(os.environ)
    if len(argv) > 1:
        if argv[1] in ("-h", "--help"):
            print(f"usage: {Path(argv[0]).name} [PORT]\n\n{__doc__}")
            return 0
        environ["PORT"] = argv[1]
        environ.pop("PASEO_PORT", None)

    try:
        host, port = listen_target(environ)
    except ConfigError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    handler = partial(Handler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer((host, port), handler) as httpd:
            print(f"Resonance Engine on http://{host}:{port}/ (Ctrl-C to stop)", flush=True)
            httpd.serve_forever()
    except OSError as error:
        print(f"error: cannot bind {host}:{port}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
