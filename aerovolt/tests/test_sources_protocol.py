"""Serial line protocol (SPEC 7.1): formatting, checksum, tolerant and strict parsing."""

from __future__ import annotations

import math

import pytest

from aerovolt.sources.protocol import (
    ChecksumError,
    ProtocolError,
    checksum,
    format_data,
    format_hello,
    format_status,
    format_value,
    parse_line,
    with_checksum,
)


def test_checksum_is_xor_of_bytes_between_dollar_and_star():
    payload = "AV,N1,0,a=1"
    expected = 0
    for ch in payload:
        expected ^= ord(ch)
    assert checksum(payload) == expected == 0x19
    assert checksum(payload.encode()) == expected
    assert with_checksum(payload) == "$AV,N1,0,a=1*19"


def test_format_data_matches_documented_example_and_round_trips():
    line = format_data("AERO1", 1234, {"fw_p03": -412.5})
    assert line == "$AV,AERO1,1234,fw_p03=-412.5*16\r\n"
    parsed = parse_line(line)
    assert parsed is not None and parsed.kind == "data" and parsed.is_data
    assert parsed.node == "AERO1" and parsed.ms == 1234
    assert parsed.values == {"fw_p03": -412.5}


def test_round_trip_many_values_including_nan_and_gps_precision():
    values = {"fw_p01": -1.25, "amb_temp": 18.4, "gps_lat": 52.0786123, "pitot_dp": float("nan"),
              "sdc_closed": 1.0}
    parsed = parse_line(format_data("N", 7, values))
    assert parsed.values["gps_lat"] == 52.0786123
    assert parsed.values["sdc_closed"] == 1.0
    assert math.isnan(parsed.values["pitot_dp"])
    assert list(parsed.values) == list(values)


def test_format_value():
    assert format_value(3.0) == "3"
    assert format_value(-412.5) == "-412.5"
    assert format_value(None) == "nan"
    assert format_value(float("inf")) == "nan"
    assert float(format_value(0.1 + 0.2)) == 0.1 + 0.2


def test_hello_and_status_round_trip():
    hello = parse_line(format_hello("AERO1", "1.2.0", ["fw_p03", "amb_temp"]))
    assert hello.kind == "hello" and not hello.is_data
    assert (hello.node, hello.fw_version, hello.channels) == ("AERO1", "1.2.0", ["fw_p03", "amb_temp"])
    status = parse_line(format_status("AERO1", 99, "warn", "SDP810 #2 CRC error, retrying"))
    assert status.kind == "status"
    assert (status.ms, status.status, status.message) == (99, "warn", "SDP810 #2 CRC error, retrying")


def test_tolerant_whitespace_crlf_lowercase_hex_and_spaces_around_equals():
    payload = "AV,N1,5,fw_p03 = -10.5, amb_temp=18"
    cs = checksum(payload)
    for line in (f"  ${payload}*{cs:02x}\r\n", f"${payload}*{cs:02X}\n", f"${payload}*{cs:02X}",
                 f"\t${payload}*{cs:02x}  \r\n".encode("ascii")):
        parsed = parse_line(line)
        assert parsed is not None, line
        assert parsed.values == {"fw_p03": -10.5, "amb_temp": 18.0}


def test_bad_checksum_returns_none_or_raises_checksum_error():
    good = format_data("N1", 1, {"fw_p03": -412.5}).strip()
    corrupted = good.replace("-412.5", "-412.6")  # one flipped character
    assert parse_line(corrupted) is None
    with pytest.raises(ChecksumError):
        parse_line(corrupted, raise_errors=True)
    wrong_cs = good[:-2] + ("00" if good[-2:] != "00" else "01")
    with pytest.raises(ChecksumError):
        parse_line(wrong_cs, raise_errors=True)


@pytest.mark.parametrize("line", [
    "$AV,N1,1,fw_p03=-412.5",                       # no checksum
    "$AV,N1,1,fw_p03=-412.5*G1",                    # not hex
    "$AV,N1,1,fw_p03=-412.5*1",                     # one digit
    with_checksum("AV,N1,1"),                       # no values
    with_checksum("AV,N1,abc,fw_p03=1"),            # ms not an integer
    with_checksum("AV,N1,1,fw_p03"),                # no '='
    with_checksum("AV,N1,1,fw_p03=abc"),            # value not a number
    with_checksum("AV,N1,1,FW-P03=1"),              # not a channel id
    with_checksum("AVX,N1,1,fw_p03=1"),             # unknown sentence
    with_checksum("AVS,N1,1,panic,boom"),           # unknown status word
    with_checksum("AVH,N1"),                        # hello without firmware version
    with_checksum("AVH,N1,1.0,Bad Id"),             # bad channel in hello
    '{"fw_p03": "abc"}',                            # JSON value not a number
    '{"fw_p03": [1, 2]}',                           # JSON value not a number
    '{"fw_p03": -412.5',                            # broken JSON
    '{"fw_p03": 1} {"x": 2}',                       # two objects on one line
    '{}',                                           # empty object
])
def test_malformed_lines(line):
    assert parse_line(line) is None
    with pytest.raises(ProtocolError):
        parse_line(line, raise_errors=True)


@pytest.mark.parametrize("line", ["", "   ", "\r\n", "Booting AeroVolt node v1.2...", "# comment", b"\x00\xff\xfe"])
def test_free_text_and_blank_lines_are_ignored_even_in_strict_mode(line):
    assert parse_line(line) is None
    assert parse_line(line, raise_errors=True) is None


def test_json_fallback_for_beginners():
    parsed = parse_line('{"fw_p03": -412.5, "amb_temp": 18.4, "sdc_closed": true, "pitot_dp": null}\r\n')
    assert parsed.kind == "json" and parsed.is_data and parsed.node is None
    assert parsed.values["fw_p03"] == -412.5
    assert parsed.values["sdc_closed"] == 1.0
    assert math.isnan(parsed.values["pitot_dp"])
    assert parse_line('{"amb_rh": "55.5"}').values == {"amb_rh": 55.5}


def test_nan_variants_and_infinity_become_nan():
    parsed = parse_line(with_checksum("AV,N,1,a=nan,b=NaN,c=inf,d="))
    assert all(math.isnan(v) for v in parsed.values.values())


def test_status_message_may_contain_commas():
    parsed = parse_line(with_checksum("AVS,N1,5,error,I2C bus stuck, resetting mux"))
    assert parsed.message == "I2C bus stuck, resetting mux"


def test_formatters_reject_values_that_would_break_the_framing():
    with pytest.raises(ValueError):
        format_data("bad,node", 1, {"a": 1})
    with pytest.raises(ValueError):
        format_data("N", 1, {})
    with pytest.raises(ValueError):
        format_data("N", 1, {"Bad": 1})
    with pytest.raises(ValueError):
        format_status("N", 1, "fine", "x")
    with pytest.raises(ValueError):
        format_status("N", 1, "ok", "a*b")
    with pytest.raises(ValueError):
        format_hello("N", "1 0", ["a"])
