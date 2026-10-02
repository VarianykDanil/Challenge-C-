"""The web server: dashboard files, WebSocket live feed and REST API (SPEC section 9).

Routes
------
* ``GET /`` and static files from ``web/`` (no-cache headers so a refreshed browser always
  gets the newest dashboard; ``.js`` served as ``text/javascript`` - ES modules refuse to
  load with a wrong MIME type).
* ``GET /ws`` - WebSocket: ``hello`` on connect, then ``frame`` messages at
  ``broadcast_hz`` (wall clock), events (``alert``, ``lap``, ``strategy``, ``faults``) as
  they happen and ``sources`` every second (with ``rates``: each channel's measured sample
  rate, Hz of session time, for the Sensors tab). After a session reset every client gets a new
  ``hello``.
* ``GET /api/hello``, ``GET /api/history?ids=a,b&seconds=60``, ``GET /api/faults``,
  ``POST /api/faults/{id}`` (body ``{"active": true}``; 400 bad body, 404 unknown fault,
  409 no simulator), ``GET /api/laps``, ``GET /api/alerts`` (whole log, oldest first),
  ``POST /api/session/reset``, ``GET /api/sources``.

Broadcasting: each message is serialised to JSON **once** and the same text is sent to
every client; a single sender task sends messages in order, each client with a timeout, so
one stalled browser cannot hold up the others (it is disconnected instead). Frames are
skipped while the send queue is backed up - live data is only useful when it is fresh.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import mimetypes
import time
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from aerovolt.core.config import PROJECT_ROOT
from aerovolt.core.manager import NoSimSourceError
from aerovolt.core.model import _json_any

from .session import Session

log = logging.getLogger(__name__)

#: Default folder of the dashboard.
WEB_ROOT = PROJECT_ROOT / "web"
#: Headers that stop browsers caching the dashboard or API answers.
NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"}
#: A client that cannot take a message within this time is disconnected, s.
SEND_TIMEOUT_S = 2.0
#: Frames are dropped while more than this many messages wait to be sent.
MAX_QUEUED_FRAMES = 4
#: Period of the ``sources`` status message, s.
SOURCES_PERIOD_S = 1.0

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")


class PortInUseError(OSError):
    """The TCP port for the web server is already taken."""


def dumps(message: Any) -> str:
    """JSON text of a message; NaN / inf become ``null`` (never invalid JSON)."""
    try:
        return json.dumps(message, allow_nan=False, separators=(",", ":"))
    except ValueError:
        return json.dumps(_json_any(message), allow_nan=False, separators=(",", ":"))


def json_response(data: Any, status: int = 200) -> web.Response:
    return web.Response(text=dumps(data), status=status, content_type="application/json", headers=NO_CACHE)


class Broadcaster:
    """Fans session data out to every connected WebSocket client (module docstring)."""

    def __init__(self, session: Session, broadcast_hz: float) -> None:
        self.session = session
        self.period = 1.0 / float(broadcast_hz)
        self.clients: set[web.WebSocketResponse] = set()
        self.queue: asyncio.Queue[tuple[str, bool]] = asyncio.Queue()
        self.tasks: list[asyncio.Task[None]] = []
        self.stats = {"frames": 0, "frames_skipped": 0, "events": 0, "disconnects": 0}
        self._unsubscribe = session.bus.subscribe(self._on_event)

    # ---- event bus -> clients ----

    def _on_event(self, event: dict[str, Any]) -> None:
        """Bus handler (runs on the loop thread inside the data path): just enqueue."""
        if not self.clients:
            return
        if event.get("type") == "reset":
            self.enqueue(dumps(self.session.hello()))
            return
        self.stats["events"] += 1
        self.enqueue(dumps(event))

    def enqueue(self, text: str, is_frame: bool = False) -> None:
        self.queue.put_nowait((text, is_frame))

    # ---- tasks ----

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self._frames(), name="ws-frames"),
                      asyncio.create_task(self._sender(), name="ws-sender")]

    async def stop(self) -> None:
        self._unsubscribe()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []
        for ws in list(self.clients):
            await ws.close(code=1001, message=b"server shutdown")
        self.clients.clear()

    async def _frames(self) -> None:
        """Frames at ``broadcast_hz`` and source status every second (wall clock)."""
        loop = asyncio.get_running_loop()
        next_frame = loop.time()
        next_sources = next_frame + SOURCES_PERIOD_S
        while True:
            next_frame += self.period
            delay = next_frame - loop.time()
            if delay < -self.period:  # fell behind (busy CPU): do not try to catch up
                next_frame = loop.time()
                delay = 0.0
            await asyncio.sleep(max(delay, 0.0))
            if not self.clients:
                continue
            if self.queue.qsize() > MAX_QUEUED_FRAMES:
                self.stats["frames_skipped"] += 1
            else:
                self.stats["frames"] += 1
                self.enqueue(dumps(self.session.frame()), is_frame=True)
            if loop.time() >= next_sources:
                next_sources = loop.time() + SOURCES_PERIOD_S
                self.enqueue(dumps({"type": "sources", "sources": self.session.sources_info(),
                                    "rates": self.session.rates()}))

    async def _sender(self) -> None:
        while True:
            text, _ = await self.queue.get()
            clients = list(self.clients)
            if clients:
                await asyncio.gather(*(self._send(ws, text) for ws in clients))

    async def _send(self, ws: web.WebSocketResponse, text: str) -> None:
        if ws.closed:
            self.clients.discard(ws)
            return
        try:
            await asyncio.wait_for(ws.send_str(text), SEND_TIMEOUT_S)
        except (ConnectionError, RuntimeError, asyncio.TimeoutError) as exc:
            log.info("dropping WebSocket client: %s", type(exc).__name__)
            self.stats["disconnects"] += 1
            self.clients.discard(ws)
            if not ws.closed:
                asyncio.ensure_future(ws.close())


SESSION_KEY = web.AppKey("session", Session)
BROADCASTER_KEY = web.AppKey("broadcaster", Broadcaster)
WEB_ROOT_KEY = web.AppKey("web_root", Path)


# --------------------------------------------------------------------------------------
# Handlers
# --------------------------------------------------------------------------------------


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    session = request.app[SESSION_KEY]
    broadcaster = request.app[BROADCASTER_KEY]
    ws = web.WebSocketResponse(heartbeat=20.0, max_msg_size=1 << 20)
    await ws.prepare(request)
    await ws.send_str(dumps(session.hello()))
    broadcaster.clients.add(ws)
    try:
        async for msg in ws:  # the dashboard does not send anything; just wait for close
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        broadcaster.clients.discard(ws)
    return ws


async def handle_hello(request: web.Request) -> web.Response:
    return json_response(request.app[SESSION_KEY].hello())


async def handle_history(request: web.Request) -> web.Response:
    ids = [i.strip() for i in request.query.get("ids", "").split(",") if i.strip()]
    if not ids:
        return json_response({"error": "ids=a,b,... required"}, 400)
    text = request.query.get("seconds", "60")
    try:
        seconds = float(text)
    except ValueError:
        return json_response({"error": "seconds must be a number"}, 400)
    if not seconds >= 0:
        return json_response({"error": "seconds must be >= 0"}, 400)
    return json_response(request.app[SESSION_KEY].history(ids, seconds))


async def handle_faults(request: web.Request) -> web.Response:
    return json_response(request.app[SESSION_KEY].faults())


async def handle_set_fault(request: web.Request) -> web.Response:
    session = request.app[SESSION_KEY]
    fault_id = request.match_info["fault_id"]
    try:
        body = await request.json()
        active = body["active"]
        if not isinstance(active, bool):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        return json_response({"error": 'body must be {"active": true|false}'}, 400)
    try:
        faults = session.set_fault(fault_id, active)
    except NoSimSourceError as exc:
        return json_response({"error": str(exc)}, 409)
    except KeyError:
        return json_response({"error": f"unknown fault {fault_id!r}"}, 404)
    return json_response(faults)


async def handle_laps(request: web.Request) -> web.Response:
    return json_response(request.app[SESSION_KEY].laps)


async def handle_alerts(request: web.Request) -> web.Response:
    """All alerts of the session (active and cleared), oldest first."""
    return json_response(request.app[SESSION_KEY].alerts_json())


async def handle_reset(request: web.Request) -> web.Response:
    await request.app[SESSION_KEY].reset()
    return json_response({"ok": True})


async def handle_sources(request: web.Request) -> web.Response:
    return json_response(request.app[SESSION_KEY].sources_info())


PLACEHOLDER_PAGE = """<!doctype html><meta charset="utf-8"><title>AeroVolt</title>
<body style="font-family:sans-serif;background:#111;color:#ddd;padding:2em">
<h1>AeroVolt server is running</h1><p>The dashboard (<code>web/index.html</code>) is not
installed. The live feed works: try <a href="/api/hello" style="color:#6cf">/api/hello</a>.</p>"""


async def handle_static(request: web.Request) -> web.StreamResponse:
    root: Path = request.app[WEB_ROOT_KEY]
    rel = request.match_info.get("path", "") or "index.html"
    target = (root / rel).resolve()
    if not target.is_relative_to(root):
        raise web.HTTPForbidden()
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        if target == root / "index.html":
            return web.Response(text=PLACEHOLDER_PAGE, content_type="text/html", headers=NO_CACHE)
        raise web.HTTPNotFound()
    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return web.FileResponse(target, headers={**NO_CACHE, "Content-Type": ctype})


# --------------------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------------------


def create_app(session: Session, web_root: str | Path | None = None, *, manage_session: bool = True) -> web.Application:
    """The aiohttp application for ``session``.

    With ``manage_session`` (default) the session is started with the app and stopped
    (log closed) on shutdown.
    """
    app = web.Application()
    app[SESSION_KEY] = session
    app[WEB_ROOT_KEY] = Path(web_root or WEB_ROOT).resolve()
    broadcaster = Broadcaster(session, session.config.server.broadcast_hz)
    app[BROADCASTER_KEY] = broadcaster

    app.router.add_get("/ws", handle_ws)
    app.router.add_get("/api/hello", handle_hello)
    app.router.add_get("/api/history", handle_history)
    app.router.add_get("/api/faults", handle_faults)
    app.router.add_post("/api/faults/{fault_id}", handle_set_fault)
    app.router.add_get("/api/laps", handle_laps)
    app.router.add_get("/api/alerts", handle_alerts)
    app.router.add_post("/api/session/reset", handle_reset)
    app.router.add_get("/api/sources", handle_sources)
    app.router.add_get("/", handle_static)
    app.router.add_get("/{path:.*}", handle_static)

    async def on_startup(app_: web.Application) -> None:
        if manage_session:
            await session.start()
        broadcaster.start()

    async def on_shutdown(app_: web.Application) -> None:
        await broadcaster.stop()

    async def on_cleanup(app_: web.Application) -> None:
        if manage_session:
            await session.stop()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app


async def start_server(session: Session, host: str, port: int,
                       web_root: str | Path | None = None) -> tuple[web.AppRunner, int]:
    """Start the server; returns the runner (``await runner.cleanup()`` to stop) and the
    actual port (useful with ``port=0``). Raises :class:`PortInUseError`."""
    runner = web.AppRunner(create_app(session, web_root), handle_signals=False)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    try:
        await site.start()
    except OSError as exc:
        await runner.cleanup()
        if exc.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1)):
            raise PortInUseError(exc.errno, f"port {port} on {host} is already in use") from exc
        raise
    actual = port
    server = getattr(site, "_server", None)
    if server is not None and server.sockets:
        actual = server.sockets[0].getsockname()[1]
    return runner, actual


async def serve(session: Session, host: str, port: int, web_root: str | Path | None = None,
                stop_event: asyncio.Event | None = None, on_started: Any = None) -> None:
    """Run the server until ``stop_event`` is set (or the task is cancelled), then shut
    down gracefully: WebSockets closed, sources stopped, log closed."""
    runner, actual = await start_server(session, host, port, web_root)
    if on_started is not None:
        on_started(actual)
    try:
        if stop_event is None:
            while True:
                await asyncio.sleep(3600)
        else:
            await stop_event.wait()
    finally:
        t0 = time.monotonic()
        await runner.cleanup()
        log.info("server stopped in %.2f s", time.monotonic() - t0)
