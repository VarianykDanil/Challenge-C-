"""Data sources: the ``Source`` interface, the session context and the source registry.

A *source* produces channel values: the simulator (``sim``), a USB-serial sensor node
(``serial``), the car's CAN bus (``can``) or a recorded log (``replay``). Every source
implements :class:`Source` and registers itself with :func:`register_source`; the session
builds them from the config with :func:`create_source`, which imports the implementing
module only when that kind is actually used. That keeps the sim-only demo free of the
hardware libraries (python-can, cantools, pyserial).

Writing a source::

    from aerovolt.core.source import Source, register_source

    @register_source("serial")
    class SerialSource(Source):
        async def run(self, emit):
            ...                            # loop until cancelled
            emit(self.ctx.clock(), {"fw_p03": -412.5})

``emit`` must be called from the asyncio event-loop thread (a source that reads in a
worker thread hands values over with ``loop.call_soon_threadsafe``).
"""

from __future__ import annotations

import importlib
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Any, Callable

from .model import Emit, FaultInfo

if TYPE_CHECKING:
    from .catalog import Catalog
    from .config import AppConfig

#: Where each source kind is implemented (imported lazily by :func:`create_source`).
SOURCE_MODULES: dict[str, str] = {
    "sim": "aerovolt.sim.source",
    "serial": "aerovolt.sources.serial_source",
    "can": "aerovolt.sources.can_source",
    "replay": "aerovolt.sources.replay_source",
}

#: Third-party packages that only hardware sources need (``requirements-hw.txt``).
HARDWARE_PACKAGES: dict[str, str] = {"can": "python-can", "cantools": "cantools", "serial": "pyserial"}

HW_INSTALL_HINT = "pip install -r requirements-hw.txt"

_REGISTRY: dict[str, type[Source]] = {}


class SourceError(RuntimeError):
    """A source could not be created."""


class UnknownSourceError(SourceError, ValueError):
    """The config names a source type that does not exist."""


class MissingDependencyError(SourceError, ImportError):
    """A hardware source needs a package that is not installed."""


class SessionClock:
    """Session time for real sources: seconds (monotonic) since the session started."""

    def __init__(self, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._t0 = now()

    def __call__(self) -> float:
        return self._now() - self._t0

    def reset(self) -> None:
        """Restart the clock at 0 (session reset)."""
        self._t0 = self._now()


@dataclass
class SessionContext:
    """What every source and analysis module may read about the running session.

    ``track`` is a ``sim.tracks.Track``: set by the sim source when it starts, or loaded
    from the config by the session for real sources; ``None`` if unknown.
    """

    config: AppConfig
    catalog: Catalog
    vehicle: dict[str, Any]
    root: Path
    clock: Callable[[], float] = field(default_factory=SessionClock)
    track: Any = None


class Source(ABC):
    """Base class of every data source (SPEC section 4).

    Subclasses implement :meth:`run` and keep ``self.status`` (``'running'``,
    ``'waiting'`` or ``'error'``), ``self.detail`` (one line for the Sources panel) and
    ``self.stats`` (counters such as frames/s, checksum errors) up to date; :meth:`info`
    reports them.
    """

    kind: str = "base"
    default_label: str = "Source"

    def __init__(self, cfg: dict[str, Any], ctx: SessionContext) -> None:
        self.cfg = dict(cfg)
        self.ctx = ctx
        self.label: str = str(self.cfg.get("label") or self.default_label)
        self.status: str = "waiting"
        self.detail: str = ""
        self.stats: dict[str, Any] = {}

    @abstractmethod
    async def run(self, emit: Emit) -> None:
        """Produce data until cancelled: call ``emit(t, {channel: value})``."""

    def provides(self) -> set[str] | None:
        """Channels this source owns (``None`` = whatever it emits)."""
        channels = self.cfg.get("channels")
        return set(channels) if channels else None

    def faults(self) -> list[FaultInfo]:
        """Injectable faults (only the simulator has any)."""
        return []

    def set_fault(self, fault_id: str, active: bool) -> None:
        """Activate / clear a fault (only the simulator supports this)."""
        raise NotImplementedError(f"{self.kind} source has no injectable faults")

    def info(self) -> dict[str, Any]:
        """Status for the dashboard: ``{kind, label, status, detail, stats}``."""
        return {
            "kind": self.kind,
            "label": self.label,
            "status": self.status,
            "detail": self.detail,
            "stats": dict(self.stats),
        }


def register_source(kind: str) -> Callable[[type[Source]], type[Source]]:
    """Class decorator: register a :class:`Source` subclass under ``kind``."""

    def decorator(cls: type[Source]) -> type[Source]:
        if not (isinstance(cls, type) and issubclass(cls, Source)):
            raise TypeError(f"@register_source({kind!r}) must decorate a Source subclass")
        cls.kind = kind
        _REGISTRY[kind] = cls
        return cls

    return decorator


def registered_sources() -> dict[str, type[Source]]:
    """Kinds registered so far (modules are imported lazily, so this grows over time)."""
    return dict(_REGISTRY)


def _missing_hw_package(exc: ImportError) -> str | None:
    name = (getattr(exc, "name", None) or "").split(".")[0]
    return HARDWARE_PACKAGES.get(name)


def import_hardware(module: str) -> ModuleType:
    """Import a hardware library (``can``, ``cantools``, ``serial``) with a helpful error.

    Use this inside the CAN / serial sources instead of a top-level import::

        can = import_hardware("can")
    """
    try:
        return importlib.import_module(module)
    except ImportError as exc:
        package = _missing_hw_package(exc) or HARDWARE_PACKAGES.get(module.split(".")[0], module)
        raise MissingDependencyError(
            f"the '{package}' package is needed for this source - install the hardware "
            f"dependencies with: {HW_INSTALL_HINT}"
        ) from exc


def create_source(cfg: dict[str, Any], ctx: SessionContext) -> Source:
    """Instantiate the source described by a config dict (``{"type": "sim", ...}``)."""
    kind = cfg.get("type", cfg.get("kind"))
    if kind not in SOURCE_MODULES:
        known = ", ".join(sorted(SOURCE_MODULES))
        raise UnknownSourceError(f"unknown source type {kind!r} (known types: {known})")
    try:
        if kind not in _REGISTRY:
            importlib.import_module(SOURCE_MODULES[kind])
        if kind not in _REGISTRY:
            raise SourceError(f"module {SOURCE_MODULES[kind]} did not register a {kind!r} source "
                              f"(missing @register_source({kind!r})?)")
        return _REGISTRY[kind](cfg, ctx)
    except MissingDependencyError:
        raise
    except ImportError as exc:
        package = _missing_hw_package(exc)
        if package:
            raise MissingDependencyError(
                f"source type {kind!r} needs the '{package}' package - install the hardware "
                f"dependencies with: {HW_INSTALL_HINT}"
            ) from exc
        raise SourceError(f"cannot load source type {kind!r} from {SOURCE_MODULES[kind]}: {exc}") from exc
