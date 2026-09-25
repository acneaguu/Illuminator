"""Make the ``dashboard`` package importable wherever pytest is run from.

The dashboard lives at the repository root and is not part of the installed
``illuminator`` package, so pytest does not put it on ``sys.path`` by itself.
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
