#!/usr/bin/env python3
"""Historical v3-named compatibility shim; use representation_engine.py for new runs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from representation_engine import main


if __name__ == "__main__":
    main()
