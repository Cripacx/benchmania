"""Functional checks every backend implementation must pass before it is measured.

They make sure all implementations do the same work: correct shapes, values that come from the database,
JSON content type, persisted updates, consecutive ranges in /list, order totals rounded to cents and
rejection of invalid input.
"""

import json
import urllib.error
import urllib.request

ROUNDING_ORDER = {"customerId": 7, "items": [{"sku": "A", "quantity": 3, "unitPrice": 0.1},
                                             {"sku": "B", "quantity": 1, "unitPrice": 0.2}]}
ROUNDING_TOTAL = 0.5  # an unrounded binary floating-point sum gives 0.5000000000000001


def _call(base, path, body=None):
    req = urllib.request.Request(base + path, data=body, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return r.status, r.headers.get("Content-Type", ""), json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), None
    except json.JSONDecodeError:
        return -1, "", None


def _world(w):
    return (isinstance(w, dict) and set(w) == {"id", "randomNumber"} and type(w["id"]) is int
            and type(w["randomNumber"]) is int and 1 <= w["id"] <= 10000 and 1 <= w["randomNumber"] <= 10000)


def _number(v):
    return type(v) in (int, float)


def run_checks(base, data_dir, psql):
    problems = []

    def check(name, ok, detail=""):
        if not ok:
            problems.append(f"{name}{': ' + detail if detail else ''}")

    def is_json(ctype):
        return ctype.split(";")[0].strip().lower() == "application/json"

    def stored(ids):
        rows = psql(f"SELECT id, randomnumber FROM world WHERE id IN ({','.join(map(str, ids))})")
        return {int(i): int(v) for i, v in (line.split("|") for line in rows.splitlines() if line)}

    def matches_database(name, rows):
        """The returned values must be the ones in the table (last one wins for repeated ids)."""
        returned = {w["id"]: w["randomNumber"] for w in rows}
        in_db = stored(returned)
        check(name, in_db == returned, f"returned {str(returned)[:120]}, stored {str(in_db)[:120]}")

    s, ct, b = _call(base, "/json")
    check("GET /json", s == 200 and b == {"message": "Hello, World!"}, f"status {s}, body {str(b)[:80]}")
    check("GET /json content type", is_json(ct), ct or "missing")

    s, ct, b = _call(base, "/db")
    ok = s == 200 and _world(b)
    check("GET /db", ok, f"status {s}, body {str(b)[:80]}")
    check("GET /db content type", is_json(ct), ct or "missing")
    if ok:
        matches_database("GET /db returns the stored value", [b])

    s, ct, b = _call(base, "/queries")
    ok = s == 200 and isinstance(b, list) and len(b) == 20 and all(map(_world, b))
    check("GET /queries", ok, f"status {s}, {len(b) if isinstance(b, list) else 'no'} items")
    check("GET /queries content type", is_json(ct), ct or "missing")
    if ok:
        matches_database("GET /queries returns the stored values", b)
        # 20 independent draws from 10,000 ids are never all the same id
        check("GET /queries reads random rows", len({w["id"] for w in b}) > 1, "all 20 rows have the same id")

    s, ct, b = _call(base, "/updates")
    ok = s == 200 and isinstance(b, list) and len(b) == 5 and all(map(_world, b))
    check("GET /updates", ok, f"status {s}")
    check("GET /updates content type", is_json(ct), ct or "missing")
    if ok:
        matches_database("GET /updates persists the new values", b)

    s, ct, b = _call(base, "/list")
    ok = (s == 200 and isinstance(b, list) and len(b) == 100
          and all(isinstance(x, dict) and set(x) == {"id", "randomNumber", "isEven"} for x in b)
          and all(_world({"id": x["id"], "randomNumber": x["randomNumber"]}) for x in b)
          and [x["id"] for x in b] == list(range(b[0]["id"], b[0]["id"] + 100))
          and all(x["isEven"] is (x["randomNumber"] % 2 == 0) for x in b))
    check("GET /list", ok, f"status {s}")
    check("GET /list content type", is_json(ct), ct or "missing")
    if ok:
        matches_database("GET /list returns the stored values", b)

    order = (data_dir / "orders.json").read_bytes()
    expected = json.loads((data_dir / "orders_expected.json").read_text())
    s, ct, b = _call(base, "/orders", order)
    check("POST /orders", s == 200 and isinstance(b, dict) and b.get("customerId") == expected["customerId"]
          and b.get("itemCount") == expected["itemCount"] and b.get("totalQuantity") == expected["totalQuantity"]
          and _number(b.get("total")) and b["total"] == expected["total"], f"status {s}, body {str(b)[:120]}")
    check("POST /orders content type", is_json(ct), ct or "missing")

    s, _, b = _call(base, "/orders", json.dumps(ROUNDING_ORDER).encode())
    check("POST /orders rounds the total to cents", s == 200 and isinstance(b, dict) and b.get("itemCount") == 2
          and b.get("totalQuantity") == 4 and _number(b.get("total")) and b["total"] == ROUNDING_TOTAL,
          f"status {s}, body {str(b)[:120]}")

    def rejected(name, change):
        bad = json.loads(order)
        change(bad)
        status, _, _ = _call(base, "/orders", json.dumps(bad).encode())
        check(f"POST /orders rejects {name}", status in (400, 422), f"status {status}")

    rejected("quantity 0", lambda o: o["items"][3].update(quantity=0))
    rejected("an empty order", lambda o: o.update(items=[]))
    rejected("a negative price", lambda o: o["items"][3].update(unitPrice=-1))
    rejected("an empty SKU", lambda o: o["items"][3].update(sku=""))
    return problems
