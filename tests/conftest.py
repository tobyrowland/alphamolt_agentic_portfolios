"""Make the repo root importable so tests can import the top-level modules.

The pipeline modules (db.py, swarm.py, screen.py, ...) live at the repo root
rather than in an installed package, so test collection needs the root on
sys.path regardless of where pytest is invoked from.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
