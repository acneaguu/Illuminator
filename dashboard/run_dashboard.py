#!/usr/bin/env python
"""Start the Illuminator dashboard.

A thin, friendly wrapper around uvicorn. Doing it this way rather than invoking
uvicorn directly buys three things that matter in practice:

* the working directory is set to the repository root, which the Illuminator
  engine requires (it resolves scenario and data paths relative to it);
* the browser opens by itself once the server is actually accepting
  connections;
* the common mistakes -- dependencies missing, port already in use -- produce an
  explanation instead of a traceback.

Usage::

    python dashboard/run_dashboard.py                 # serve and open a browser
    python dashboard/run_dashboard.py --demo          # captured data, no engine
    python dashboard/run_dashboard.py --reload        # restart on code changes
    python dashboard/run_dashboard.py --host 0.0.0.0  # reachable from the network
"""

from __future__ import annotations

import argparse
import errno
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

# dashboard/run_dashboard.py -> dashboard -> repository root
REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000


def _fail(message: str, hint: str = "") -> int:
    print(f"\n  {message}", file=sys.stderr)
    if hint:
        print(f"\n  {hint}", file=sys.stderr)
    print(file=sys.stderr)
    return 1


def _port_problem(host: str, port: int) -> str | None:
    """Return None if the port can be bound, otherwise why it cannot.

    Distinguishing the reasons matters: "already in use" and "not permitted"
    call for completely different fixes, and reporting the first when the second
    happened sends people hunting for a process that does not exist.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind((host if host != "0.0.0.0" else "", port))
        return None
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            return "in use"
        if exc.errno in (errno.EACCES, errno.EPERM):
            return "denied"
        if exc.errno == errno.EADDRNOTAVAIL:
            return "unavailable"
        return f"failed: {exc.strerror or exc}"
    finally:
        probe.close()


def _open_browser_when_ready(url: str, host: str, port: int, timeout: float = 30.0) -> None:
    """Wait for the server to accept connections, then open a browser once."""
    target = "127.0.0.1" if host in ("0.0.0.0", "") else host
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((target, port), timeout=0.5):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.15)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Start the Illuminator dashboard.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help=f"interface to bind (default {DEFAULT_HOST}; "
                             "use 0.0.0.0 to allow other machines in)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port to listen on (default {DEFAULT_PORT})")
    parser.add_argument("--demo", action="store_true",
                        help="open in demo mode: the interface runs off captured data "
                             "and no simulations are started")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    parser.add_argument("--reload", action="store_true",
                        help="restart the server when the code changes (development; "
                             "this abandons any simulation in progress)")
    parser.add_argument("--log-level", default="info",
                        choices=["critical", "error", "warning", "info", "debug", "trace"])
    args = parser.parse_args(argv)

    # The engine resolves scenario and data paths relative to the working
    # directory, so anchor it regardless of where this was launched from.
    os.chdir(REPO_ROOT)
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))

    try:
        import uvicorn
    except ImportError:
        return _fail(
            "uvicorn is not installed in this Python environment.",
            "Install the dashboard's dependencies with:\n\n"
            "      pip install -r dashboard/requirements.txt\n\n"
            "  Use the environment the Illuminator itself runs in "
            "(the conda env 'illuminator').",
        )

    try:
        import illuminator  # noqa: F401  -- imported only to check it is present
    except ImportError:
        return _fail(
            "the 'illuminator' package is not importable from this environment.",
            "The dashboard drives the Illuminator engine, so it must be installed:\n\n"
            "      pip install -e .\n\n"
            "  Run that from the repository root.",
        )

    problem = _port_problem(args.host, args.port)
    if problem == "in use":
        return _fail(
            f"port {args.port} is already in use.",
            "Another dashboard may already be running — try opening\n\n"
            f"      http://{args.host}:{args.port}\n\n"
            f"  or start this one elsewhere with:  --port {args.port + 1}",
        )
    if problem == "denied":
        hint = ("Ports below 1024 need elevated privileges — try a higher one:\n\n"
                "      --port 8000"
                if args.port < 1024 else
                "A sandbox, firewall or security policy is preventing this process\n"
                "  from listening. Check whether one is active for this terminal.")
        return _fail(f"not allowed to listen on {args.host}:{args.port}.", hint)
    if problem == "unavailable":
        return _fail(
            f"the address {args.host} is not available on this machine.",
            "Use --host 127.0.0.1 for local access, or --host 0.0.0.0 to accept "
            "connections\n  from the network.",
        )
    if problem:
        return _fail(f"could not bind {args.host}:{args.port} — {problem}.")

    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}/"
    if args.demo:
        url += "?mock=1"

    print()
    print(f"  Illuminator dashboard   {url}")
    if args.demo:
        print("  Demo mode: the interface uses captured data and runs no simulations.")
    if args.host == "0.0.0.0":
        print("  Listening on all interfaces — reachable from other machines on this network.")
    print("  Press Ctrl+C to stop.")
    print()

    if not args.no_browser:
        threading.Thread(target=_open_browser_when_ready,
                         args=(url, args.host, args.port), daemon=True).start()

    # One worker, always: the run manager holds the simulation subprocess handles
    # and enforces the one-run-at-a-time limit in this process. Extra workers
    # would each keep their own, inconsistent view.
    uvicorn.run(
        "dashboard.backend.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        reload_dirs=[str(REPO_ROOT / "dashboard")] if args.reload else None,
        log_level=args.log_level,
        workers=1,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n  Dashboard stopped.\n")
