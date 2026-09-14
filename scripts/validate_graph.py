"""Validate the generated Graphify artifacts required by the specification."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "graphify-out"
REQUIRED = ["graph.json", "graph.html", "GRAPH_REPORT.md", "cost.json"]


def main() -> None:
    missing = [name for name in REQUIRED if not (OUTPUT / name).is_file()]
    if missing:
        raise SystemExit(f"Missing Graphify outputs: {', '.join(missing)}")

    graph = json.loads((OUTPUT / "graph.json").read_text(encoding="utf-8"))
    nodes = graph.get("nodes", [])
    links = graph.get("links", [])
    if graph.get("directed") is not True:
        raise SystemExit("Graphify graph must be directed.")
    if not nodes or not links:
        raise SystemExit("Graphify graph must contain nodes and links.")
    for index, link in enumerate(links):
        if not isinstance(link, dict) or "source" not in link or "target" not in link:
            raise SystemExit(f"Graphify link {index} has missing endpoints.")

    cost = json.loads((OUTPUT / "cost.json").read_text(encoding="utf-8"))
    if cost.get("totalTokens") != 0 or cost.get("mode") != "local-structural-ast":
        raise SystemExit("Initial graph must record the zero-token structural build.")

    print(f"Graphify valid: {len(nodes)} nodes, {len(links)} directed links, 0 tokens.")


if __name__ == "__main__":
    main()
