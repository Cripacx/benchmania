"""Robust statistics for repeated measurements.

Benchmarks have few repetitions (typically 5) and occasional disturbed passes, so everything here is
median-based: median, interquartile range, MAD outlier flags and a percentile bootstrap interval of the median.
"""

import math
import random
import statistics

MAD_SCALE = 1.4826  # makes MAD comparable to a standard deviation for normal data
OUTLIER_Z = 3.5


def quantile(values, q):
    v = sorted(values)
    if not v:
        raise ValueError("no values")
    pos = (len(v) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return v[lo] + (v[hi] - v[lo]) * (pos - lo)


def outliers(values):
    """Indices of values whose robust z-score exceeds 3.5 (Iglewicz and Hoaglin)."""
    if len(values) < 3:
        return []
    med = statistics.median(values)
    mad = statistics.median(abs(x - med) for x in values) * MAD_SCALE
    if mad == 0:
        return []
    return [i for i, x in enumerate(values) if abs(x - med) / mad > OUTLIER_Z]


def bootstrap_ci(values, level=0.95, rounds=2000, seed=7):
    """Percentile bootstrap interval of the median; deterministic for reproducible summaries.

    None below three values: one or two passes cannot support a 95 % interval. With three to five passes
    the interval is close to [min, max], which is the honest answer for so few repetitions.
    """
    if len(values) < 3:
        return None
    rng = random.Random(seed)
    meds = sorted(statistics.median(rng.choices(values, k=len(values))) for _ in range(rounds))
    a = (1 - level) / 2
    return [quantile(meds, a), quantile(meds, 1 - a)]


def summarize(values):
    """Summary of one metric over passes. None values (metric unavailable in a pass) are ignored."""
    v = [float(x) for x in values if x is not None and not (isinstance(x, float) and math.isnan(x))]
    if not v:
        return None
    med = statistics.median(v)
    out = {
        "median": med,
        "min": min(v),
        "max": max(v),
        "n": len(v),
        "iqr": [quantile(v, 0.25), quantile(v, 0.75)],
        "ci95": bootstrap_ci(v),
        "cv": (statistics.pstdev(v) / statistics.fmean(v)) if len(v) > 1 and statistics.fmean(v) else 0.0,
        "outliers": outliers(v),
    }
    return out


def geomean(values):
    v = [x for x in values if x and x > 0]
    if not v:
        return None
    return math.exp(sum(math.log(x) for x in v) / len(v))
