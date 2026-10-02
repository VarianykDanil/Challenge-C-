"""Tiny synchronous publish/subscribe bus.

The session publishes events (alerts, laps, strategy updates, fault changes, source
status) as plain dicts shaped like the WebSocket messages of SPEC section 9, e.g.
``{"type": "lap", "lap": {...}}``. The server subscribes and forwards them to every browser;
the data logger subscribes to keep the metadata timeline. Handlers run synchronously, in
subscription order, in the publisher's thread. A failing handler is logged and does not
stop the others (one broken browser connection must never stop the session).
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Iterable

Event = dict[str, Any]
Handler = Callable[[Event], None]

log = logging.getLogger(__name__)


class EventBus:
    """Synchronous pub/sub keyed by the event ``type`` field."""

    def __init__(self) -> None:
        self._subs: list[tuple[Handler, frozenset[str] | None]] = []

    def subscribe(self, handler: Handler, types: Iterable[str] | None = None) -> Callable[[], None]:
        """Call ``handler(event)`` for every published event (or only the given types).

        Returns a function that unsubscribes the handler.
        """
        entry = (handler, None if types is None else frozenset(types))
        self._subs.append(entry)

        def unsubscribe() -> None:
            if entry in self._subs:
                self._subs.remove(entry)

        return unsubscribe

    def publish(self, event: Event) -> None:
        """Deliver ``event`` (a dict with a ``"type"`` key) to the matching handlers."""
        kind = event.get("type")
        for handler, types in list(self._subs):
            if types is not None and kind not in types:
                continue
            try:
                handler(event)
            except Exception:  # noqa: BLE001 - isolate subscribers from each other
                log.exception("event handler %r failed for %s event", handler, kind)

    def emit(self, kind: str, **payload: Any) -> None:
        """Shortcut: ``bus.emit("lap", lap={...})`` publishes ``{"type": "lap", "lap": {...}}``."""
        self.publish({"type": kind, **payload})

    def __len__(self) -> int:
        return len(self._subs)
