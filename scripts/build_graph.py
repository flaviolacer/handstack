"""Build HandStack's local, directed, zero-token structural knowledge graph."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "graphify-out"
GRAPH = OUTPUT / "graph.json"


def run(*arguments: str) -> None:
    subprocess.run([sys.executable, "-m", "graphify", *arguments], cwd=ROOT, check=True)


def make_directed() -> None:
    data = json.loads(GRAPH.read_text(encoding="utf-8"))
    data["directed"] = True
    data["multigraph"] = False
    GRAPH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_cost() -> None:
    cost = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(UTC).isoformat(),
        "mode": "local-structural-ast",
        "provider": None,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
        "estimatedFullRepositoryReadingTokens": None,
    }
    (OUTPUT / "cost.json").write_text(
        json.dumps(cost, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--update", action="store_true")
    arguments = parser.parse_args()

    if arguments.update and GRAPH.exists():
        run("update", ".", "--force")
    else:
        run("extract", ".", "--code-only", "--force", "--max-workers", "2")
    make_directed()
    run("cluster-only", ".", "--no-label")
    make_directed()
    write_cost()


if __name__ == "__main__":
    main()
