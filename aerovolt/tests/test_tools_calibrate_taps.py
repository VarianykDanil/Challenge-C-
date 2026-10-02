"""tools/calibrate_taps.py against the fake sensor node (pty + SerialSource, virtual CAN)."""

from __future__ import annotations

import importlib.util
import sys
import threading
import uuid
from pathlib import Path

import pytest

from aerovolt.core.catalog import Catalog
from aerovolt.core.config import load_calibration

pytest.importorskip("serial")

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fake = _load("fake_sensor_node")
cal = _load("calibrate_taps")

HEADER = "# my calibration notes\n# keep me\n"


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return Catalog.load(ROOT / "config" / "sensors.yaml")


class RunningNode:
    """A fake node on a pseudo-terminal, running in a background thread."""

    def __init__(self, node) -> None:
        self.sink = fake.PtySink()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=fake.run, args=(node, self.sink),
                                       kwargs={"duration": 60.0, "stop": self.stop}, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return self.sink.path

    def __exit__(self, *exc) -> None:
        self.stop.set()
        self.thread.join(2)
        self.sink.close()


def calibration_file(tmp_path: Path) -> Path:
    path = tmp_path / "calibration.yaml"
    path.write_text(HEADER + "rw_p01: {offset: 1.5, scale: 0.98}\nfw_p03: {offset: 9.0, scale: 1.02}\n")
    return path


def test_writes_offsets_from_a_still_node(tmp_path: Path, catalog: Catalog, capsys) -> None:
    node = fake.FakeNode(catalog, ["fw_p03", "fw_p04", "pitot_dp", "amb_temp"], pattern=fake.Pattern("steady"),
                         offsets={"fw_p03": 3.4, "pitot_dp": -1.2}, noise_pa=0.2, seed=5)
    path = calibration_file(tmp_path)
    with RunningNode(node) as port:
        code = cal.main(["--port", port, "--seconds", "1.5", "--calibration", str(path)])
    assert code == cal.EXIT_OK
    out = capsys.readouterr().out
    assert "fw_p03" in out and "Wrote 3 offset(s)" in out
    text = path.read_text()
    assert text.startswith(HEADER)  # the user's comments survive
    result = load_calibration(path)
    assert result["fw_p03"].offset == pytest.approx(3.4, abs=0.1)
    assert result["fw_p03"].scale == 1.02             # an existing gain is kept
    assert result["fw_p04"].offset == pytest.approx(0.0, abs=0.1)
    assert result["fw_p04"].scale == 1.0
    assert result["pitot_dp"].offset == pytest.approx(-1.2, abs=0.1)
    assert result["rw_p01"].offset == 1.5 and result["rw_p01"].scale == 0.98  # untouched
    assert "amb_temp" not in result                   # only taps + pitot by default
    applied = result["fw_p03"].apply(3.4)
    assert applied == pytest.approx(0.0, abs=0.15)


def test_refuses_when_air_is_moving(tmp_path: Path, catalog: Catalog, capsys) -> None:
    node = fake.FakeNode(catalog, ["fw_p03"], pattern=fake.Pattern("sweep", vmax=15.0, period=4.0))
    path = calibration_file(tmp_path)
    before = path.read_text()
    with RunningNode(node) as port:
        code = cal.main(["--port", port, "--seconds", "1.0", "--calibration", str(path)])
    assert code == cal.EXIT_AIRFLOW
    assert "REFUSED" in capsys.readouterr().err
    assert path.read_text() == before


def test_dry_run_and_channel_selection(tmp_path: Path, catalog: Catalog, capsys) -> None:
    node = fake.FakeNode(catalog, ["fw_p03", "fw_p04", "amb_temp"], pattern=fake.Pattern("steady"),
                         offsets={"fw_p04": 2.0})
    path = calibration_file(tmp_path)
    before = path.read_text()
    with RunningNode(node) as port:
        code = cal.main(["--port", port, "--seconds", "1.0", "--channels", "fw_p04", "--dry-run",
                         "--calibration", str(path)])
    assert code == cal.EXIT_OK and path.read_text() == before
    out = capsys.readouterr().out
    assert "fw_p04" in out and "fw_p03" not in out


def test_no_data(tmp_path: Path) -> None:
    sink = fake.PtySink()  # a port where nothing is ever printed
    try:
        code = cal.main(["--port", sink.path, "--seconds", "0.5", "--wait", "1", "--calibration",
                         str(tmp_path / "c.yaml")])
    finally:
        sink.close()
    assert code == cal.EXIT_NO_DATA
    assert not (tmp_path / "c.yaml").exists()


def test_over_can(tmp_path: Path, catalog: Catalog) -> None:
    can = pytest.importorskip("can")
    pytest.importorskip("cantools")
    channel = f"cal_{uuid.uuid4().hex[:8]}"
    node = fake.FakeNode(catalog, ["ut_p01", "ut_p02"], pattern=fake.Pattern("steady"), offsets={"ut_p02": -4.0})
    sender = fake.CanSender(node.channel_ids, "virtual", channel, bus=can.Bus(interface="virtual", channel=channel))
    stop = threading.Event()
    thread = threading.Thread(target=fake.run, args=(node, None, sender), kwargs={"duration": 30.0, "stop": stop},
                              daemon=True)
    thread.start()
    path = tmp_path / "calibration.yaml"
    try:
        code = cal.main(["--can", f"virtual:{channel}", "--seconds", "1.0", "--calibration", str(path)])
    finally:
        stop.set()
        thread.join(2)
        sender.close()
    assert code == cal.EXIT_OK
    result = load_calibration(path)
    assert set(result) == {"ut_p01", "ut_p02"}
    assert result["ut_p02"].offset == pytest.approx(-4.0, abs=0.15)  # 0.1 Pa CAN resolution + noise


def test_channel_stats_and_merge(tmp_path: Path) -> None:
    st = cal.ChannelStats.of("fw_p03", [1.0, 2.0, 3.0, float("nan")])
    assert (st.n, st.nan, st.mean, st.lo, st.hi) == (3, 1, 2.0, 1.0, 3.0)
    assert st.std == pytest.approx(1.0)
    empty = cal.ChannelStats.of("fw_p04", [])
    assert empty.n == 0
    path = tmp_path / "new.yaml"
    data = cal.merge_calibration(path, [st], 10.0, "serial test")
    assert data["fw_p03"]["offset"] == 2.0 and data["fw_p03"]["scale"] == 1.0
    assert load_calibration(path)["fw_p03"].offset == 2.0
    assert path.read_text().startswith("#")
