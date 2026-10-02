#!/usr/bin/env python3
"""Take Playwright screenshots of every AeroVolt dashboard tab (and check for JS errors).

Used to produce the images in ``docs/img`` and as a smoke test of the web UI: the script
fails (exit status 1) if the page logs a console error, throws an uncaught exception, or a
tab does not mount. Start a server first (``python -m aerovolt`` or the mock feed
``python tools/mock_feed_server.py --port 8080``), then::

    python tools/screenshot.py                                  # all tabs, 1600x900
    python tools/screenshot.py --url http://127.0.0.1:8090 --prefix dev- --width 1366 --height 768
    python tools/screenshot.py --fault cell_hot --fault fw_damage_left --drawer alerts

``--fault ID`` activates simulator faults (``POST /api/faults/{id}``) before the capture and
deactivates them again afterwards (unless ``--keep-faults``). ``--drawer alerts|faults``
captures one extra image of the first tab with that drawer open
(``<prefix><tab>-<drawer>.png``).

Chromium: the pre-installed headless build at ``/opt/pw-browsers`` with SwiftShader WebGL
(``--use-gl=swiftshader``), so the three.js views render without a GPU.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
CHROMIUM_ARGS = ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"]
TABS = ["overview", "aero", "powertrain", "sensors", "laps"]


def post_fault(base_url: str, fault_id: str, active: bool) -> None:
    """``POST /api/faults/{id}`` with ``{"active": active}``; raises on an HTTP error."""
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/faults/{fault_id}",
        data=json.dumps({"active": active}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--url", default="http://127.0.0.1:8080", help="dashboard URL (default %(default)s)")
    p.add_argument("--out", type=Path, default=ROOT / "docs" / "img", help="output folder (default docs/img)")
    p.add_argument("--prefix", default="", help="file name prefix, e.g. 'dev-'")
    p.add_argument("--tabs", default=",".join(TABS), help="comma-separated tabs (default: all)")
    p.add_argument("--wait", type=float, default=6.0, help="seconds to let each tab fill with data (default 6)")
    p.add_argument("--width", type=int, default=1600)
    p.add_argument("--height", type=int, default=900)
    p.add_argument("--scale", type=float, default=1.0, help="device scale factor (2 = HiDPI)")
    p.add_argument("--fault", action="append", default=[], metavar="ID", help="activate a fault first (repeatable)")
    p.add_argument("--keep-faults", action="store_true", help="leave --fault faults active afterwards")
    p.add_argument("--drawer", choices=["alerts", "faults"], help="also capture the first tab with this drawer open")
    p.add_argument("--chromium", default=CHROMIUM, help="Chromium executable")
    args = p.parse_args(argv)
    args.tabs = [t.strip() for t in args.tabs.split(",") if t.strip()]
    unknown = [t for t in args.tabs if t not in TABS]
    if unknown:
        p.error(f"unknown tab(s): {', '.join(unknown)} (choose from {', '.join(TABS)})")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("error: playwright is not installed (pip install playwright)", file=sys.stderr)
        return 2

    base = args.url.rstrip("/")
    args.out.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []

    for fid in args.fault:
        try:
            post_fault(base, fid, True)
            print(f"fault {fid}: active")
        except (urllib.error.URLError, OSError) as exc:
            problems.append(f"could not activate fault {fid!r}: {exc}")

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=args.chromium, args=CHROMIUM_ARGS, headless=True)
            page = browser.new_page(viewport={"width": args.width, "height": args.height},
                                    device_scale_factor=args.scale)
            page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.on("pageerror", lambda e: problems.append(f"page error: {e}"))
            page.goto(f"{base}/#{args.tabs[0]}", wait_until="load")
            try:
                page.wait_for_selector("#splash", state="detached", timeout=15000)
            except Exception:  # noqa: BLE001 - reported as a problem below
                problems.append("dashboard did not connect within 15 s (splash still shown)")
            if args.fault:
                time.sleep(1.0)  # let the fault events arrive
            for i, tab in enumerate(args.tabs):
                page.evaluate("(t) => { location.hash = '#' + t; }", tab)
                try:
                    page.wait_for_selector(f'.view[data-view="{tab}"][data-mounted]', timeout=15000)
                except Exception:  # noqa: BLE001
                    problems.append(f"tab {tab!r} did not mount")
                state = page.get_attribute(f'.view[data-view="{tab}"]', "data-mounted")
                if state == "error":
                    problems.append(f"tab {tab!r} failed to load")
                page.wait_for_timeout(int(args.wait * 1000 if i == 0 else max(1.5, args.wait / 2) * 1000))
                path = args.out / f"{args.prefix}{tab}.png"
                page.screenshot(path=str(path))
                print(f"saved {path}")
            if args.drawer:
                page.evaluate("(t) => { location.hash = '#' + t; }", args.tabs[0])
                page.wait_for_timeout(800)
                page.keyboard.press("a" if args.drawer == "alerts" else "f")
                page.wait_for_timeout(1200)
                path = args.out / f"{args.prefix}{args.tabs[0]}-{args.drawer}.png"
                page.screenshot(path=str(path))
                print(f"saved {path}")
            browser.close()
    finally:
        if not args.keep_faults:
            for fid in args.fault:
                try:
                    post_fault(base, fid, False)
                except (urllib.error.URLError, OSError):
                    pass

    if problems:
        print(f"\n{len(problems)} problem(s):", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print("no console errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
