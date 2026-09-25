"""The icon vocabulary lives in two files, and they have to agree.

``packs.TYPE_CATEGORY`` decides which category a model type gets; ``ICONS`` and
``CATEGORY_COLOR`` in ``dashboard/frontend/topology.js`` decide what that
category is drawn as. A category present in one and missing from the other
fails *silently* -- the diagram falls back to a generic circle -- so it would
only ever be noticed as a node nobody could explain. This test is the guard.
"""

import re

from dashboard.backend import packs

TOPOLOGY_JS = packs.DASHBOARD_DIR / "frontend" / "topology.js"

#: The Collector is injected by the engine and unconditionally hidden by
#: build_topology, so it is the one category that is never drawn.
NEVER_DRAWN = {"collector"}


def _keys_of_object(source: str, name: str) -> set:
    """Top-level keys of a ``const <name> = { ... };`` object literal."""
    start = source.index(f"const {name} = {{")
    depth = 0
    for end, char in enumerate(source[start:], start):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                break
    body = source[start:end]
    return set(re.findall(r"^  (\w+):", body, re.MULTILINE))


def test_every_category_the_backend_can_emit_has_an_icon_and_a_colour():
    source = TOPOLOGY_JS.read_text(encoding="utf-8")
    icons = _keys_of_object(source, "ICONS")
    colours = _keys_of_object(source, "CATEGORY_COLOR")

    # The parse itself must have worked, or the rest is vacuously true.
    assert "generic" in icons and "generic" in colours

    drawable = packs.KNOWN_CATEGORIES - NEVER_DRAWN
    assert drawable <= icons, f"categories with no icon: {sorted(drawable - icons)}"
    assert drawable <= colours, f"categories with no colour: {sorted(drawable - colours)}"


def test_the_frontend_draws_nothing_the_backend_cannot_name():
    source = TOPOLOGY_JS.read_text(encoding="utf-8")
    icons = _keys_of_object(source, "ICONS")
    assert icons <= packs.KNOWN_CATEGORIES, (
        f"icons for categories check_pack would reject: "
        f"{sorted(icons - packs.KNOWN_CATEGORIES)}"
    )
