#!/usr/bin/env python3
"""CLI entry point for the v0.3 graph-driven relational entity engine."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from engine import analyze


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True); parser.add_argument("--output", required=True); parser.add_argument("--config", required=True)
    arguments = parser.parse_args()
    result = analyze(Path(arguments.input), Path(arguments.output), json.loads(arguments.config))
    print(json.dumps({"ok": True, **result}))


if __name__ == "__main__":
    main()
