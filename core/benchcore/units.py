"""Parsing of human-friendly durations and sizes used in manifests."""

import re

_DURATION = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$")
_SIZE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgt]i?b?|b)?\s*$", re.IGNORECASE)


def seconds(value):
    """'15s' -> 15.0, '500ms' -> 0.5, '2m' -> 120.0; plain numbers are seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    m = _DURATION.match(str(value))
    if not m:
        raise ValueError(f"invalid duration: {value!r} (use e.g. '15s', '500ms', '2m')")
    n, unit = float(m.group(1)), m.group(2) or "s"
    return n * {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[unit]


def size_bytes(value):
    """'1g' / '1GiB' -> 1073741824, '512m' -> 536870912; binary units throughout."""
    if isinstance(value, int):
        return value
    m = _SIZE.match(str(value))
    if not m:
        raise ValueError(f"invalid size: {value!r} (use e.g. '512m', '1g')")
    n, unit = float(m.group(1)), (m.group(2) or "b").lower()[0]
    return int(n * {"b": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}[unit])


def docker_duration(value):
    """Duration in whole seconds formatted for wrk/oha ('15s')."""
    return f"{max(1, round(seconds(value)))}s"
