"""Writes orders.json (the 50-item request body of the `orders` scenario) and orders_expected.json."""
import json
from pathlib import Path

here = Path(__file__).parent
items = [{"sku": f"SKU-{i:04d}", "quantity": i % 5 + 1, "unitPrice": round(1.25 * (i + 1), 2)} for i in range(50)]
order = {"customerId": 4711, "items": items}
body = json.dumps(order, separators=(",", ":"))
(here / "orders.json").write_text(body, newline="\n")
expected = {"customerId": 4711, "itemCount": 50, "totalQuantity": sum(i["quantity"] for i in items),
            "total": round(sum(i["quantity"] * i["unitPrice"] for i in items), 2)}
(here / "orders_expected.json").write_text(json.dumps(expected), newline="\n")
print(len(body), "bytes;", expected)
