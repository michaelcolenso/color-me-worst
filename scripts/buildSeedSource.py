#!/usr/bin/env python3
"""Build data/catalog/seed-source.json from community colour tables.

Imports the full brush-paint ranges that miniature-painting tutorials name,
for four brands, plus a small DMC thread sample. Nothing is fetched from the
network by this script.

Inputs (download them first; pass a directory holding paints/ and rgb-dmc.json):
  1. github.com/Arcturus5404/miniature-paints  (MIT licence; see
     THIRD_PARTY_NOTICES.md for the notice and the caveats about its wording)
       paints/Citadel_Colour.md, paints/Vallejo.md, paints/Army_Painter.md,
       paints/Monument.md
  2. github.com/seanockert/rgb-to-dmc  (no licence file published)
       rgb-dmc.json

Usage:
  python3 scripts/buildSeedSource.py <dir-with-the-five-files>

What comes from the datasets: name, product code, range and hex.
What does NOT come from the datasets and is assigned here by rule:
  finish, opacity and medium (per range, with metallic/fluorescent/gloss
  detected from the name), and which ranges count as discontinued. Treat
  those as editorial assumptions; the rules are below and the build prints
  every name it classed as metallic so they can be checked.

Product ids are <brand>:<range>:<code>. Ids of items already published must
not change: the ranges and codes below reproduce every id of revision 1.
"""

import json
import re
import sys
from pathlib import Path

PAINTS_SOURCE = "github.com/Arcturus5404/miniature-paints (MIT)"
DMC_SOURCE = "github.com/seanockert/rgb-to-dmc (licence not stated)"

# Finish defaults per kind of range, and their assumed opacity.
OPAQUE = ("matte", 0.85)
BASE = ("matte", 0.95)
LAYER = ("matte", 0.8)
WASH = ("wash", 0.25)
GLAZE = ("wash", 0.15)
CONTRAST = ("contrast", 0.35)

# (brand, file, dataset range) -> (catalogue range name, finish rule, discontinued, opaque?)
# "opaque" ranges get metallic / fluorescent / gloss detection from the name.
RANGES = [
    ("Citadel", "Citadel_Colour.md", "Base", "Base", BASE, False, True),
    ("Citadel", "Citadel_Colour.md", "Layer", "Layer", LAYER, False, True),
    ("Citadel", "Citadel_Colour.md", "Dry", "Dry", BASE, False, True),
    ("Citadel", "Citadel_Colour.md", "Shade", "Shade", WASH, False, False),
    ("Citadel", "Citadel_Colour.md", "Glaze", "Glaze", GLAZE, False, False),
    ("Citadel", "Citadel_Colour.md", "Contrast", "Contrast", CONTRAST, False, False),
    # Old tutorials still name these; kept so they resolve, marked discontinued.
    ("Citadel", "Citadel_Colour.md", "Foundation (discontinued)", "Foundation", BASE, True, True),
    ("Citadel", "Citadel_Colour.md", "Foundation Wash (discontinued)", "Foundation Wash", WASH, True, False),
    ("Vallejo", "Vallejo.md", "Model Color", "Model Color", OPAQUE, False, True),
    ("Vallejo", "Vallejo.md", "Game Color", "Game Color", OPAQUE, False, True),
    ("Vallejo", "Vallejo.md", "Game Color Wash", "Game Color Wash", WASH, False, False),
    ("Vallejo", "Vallejo.md", "Xpress Color", "Xpress Color", CONTRAST, False, False),
    ("Vallejo", "Vallejo.md", "Xpress Color Intense", "Xpress Color Intense", CONTRAST, False, False),
    ("Army Painter", "Army_Painter.md", "Warpaints Fanatic", "Warpaints Fanatic", OPAQUE, False, True),
    ("Army Painter", "Army_Painter.md", "Warpaints Fanatic Wash", "Warpaints Fanatic Wash", WASH, False, False),
    ("Army Painter", "Army_Painter.md", "Speedpaint Set 2.0", "Speedpaint 2.0", CONTRAST, False, False),
    # Assumption: the original Warpaints range was superseded by Warpaints
    # Fanatic. Kept so older tutorials resolve, marked discontinued.
    ("Army Painter", "Army_Painter.md", "Warpaints", "Warpaints", OPAQUE, True, True),
    ("Army Painter", "Army_Painter.md", "Warpaints Wash", "Warpaints", WASH, True, False),
    # Revision 1 published the core and wash ranges as one "Pro Acryl" range; ids depend on it.
    ("Monument Hobbies", "Monument.md", "Monument Pro Acrylic Paints", "Pro Acryl", OPAQUE, False, True),
    ("Monument Hobbies", "Monument.md", "Monument Pro Acrylic Wash", "Pro Acryl", WASH, False, False),
    ("Monument Hobbies", "Monument.md", "Monument Pro Signature Series", "Pro Acryl Signature", OPAQUE, False, True),
]

# Whole words that mark a metallic paint in an opaque range.
METALLIC_WORDS = {
    "gold", "silver", "bronze", "brass", "copper", "steel", "iron", "alloy", "metal", "metallic",
    "chrome", "mithril", "tin", "pewter", "gunmetal", "chainmail", "platinum", "aluminium",
    "aluminum",
}
# Metallic paints whose names carry none of those words.
METALLIC_NAMES = {
    "Leadbelcher", "Ironbreaker", "Retributor Armour", "Auric Armour Gold", "Screaming Bell",
    "Golden Griffon", "Necron Compound", "Sigmarite",
}
# Names that contain a metal word but are ordinary colours. "Steel Grey" (Vallejo
# Game Color) is listed here on judgement, not on evidence: check it against the product.
NOT_METALLIC_NAMES = {"Steel Legion Drab", "Bronze Green", "Bronze Brown", "Steel Grey"}
NOT_METALLIC = re.compile(r"\bgold(en)?\s+(yellow|brown|ochre)\b|\bgolden\b|\bsilver\s+grey\b", re.IGNORECASE)

# Products that are not colours: varnishes, mediums and the like.
NOT_A_COLOUR = re.compile(r"\b(varnish|medium|thinner|primer|retarder|flow improver)\b", re.IGNORECASE)

# Pairs the dataset lists twice with different colours. Only the first listed is kept.
KNOWN_DUPLICATES = {("Citadel", "Foundation", "kommando-khaki"), ("Vallejo", "Xpress Color Intense", "72-483")}

DMC_NUMBERS = [
    "310", "B5200", "321", "666", "797", "820", "699", "702", "444", "307", "740", "550", "553",
    "938", "433", "436", "739", "318", "414", "3371", "3713", "760", "995",
]


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def read_table(path: Path) -> list[dict]:
    rows, header = [], None
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if header is None:
            header = cells
            continue
        if set(cells[0]) <= {"-", ":", " "}:
            continue
        row = dict(zip(header, cells))
        match = re.search(r"`(#[0-9A-Fa-f]{6})`", row.get("Hex", ""))
        if not match:
            raise SystemExit(f"no hex in row: {line}")
        row["Hex"] = match.group(1).lower()
        rows.append(row)
    return rows


def classify(name: str, default: tuple[str, float], opaque: bool) -> tuple[str, float]:
    if not opaque:
        return default
    words = set(re.findall(r"[a-z]+", name.lower()))
    # Some ranges list their washes and inks alongside the opaque paints.
    if "wash" in words or "ink" in words:
        return WASH
    if name in NOT_METALLIC_NAMES:
        return default
    if name in METALLIC_NAMES or (words & METALLIC_WORDS and not NOT_METALLIC.search(name)):
        return ("metallic", 0.9)
    if "fluorescent" in words or "fluo" in words or "neon" in words:
        return ("fluorescent", 0.6)
    if "gloss" in words or "glossy" in words:
        return ("gloss", default[1])
    return default


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    items: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    metallic_report: dict[str, list[str]] = {}
    tables: dict[str, list[dict]] = {}
    names_by_key: dict[tuple[str, str, str], str] = {}
    collisions: list[str] = []

    for brand, file, dataset_range, line, default, discontinued, opaque in RANGES:
        rows = tables.setdefault(file, read_table(src / "paints" / file))
        matched = [row for row in rows if row["Set"] == dataset_range]
        if not matched:
            raise SystemExit(f"no rows for {brand} '{dataset_range}' in {file}")
        for row in matched:
            name = row["Name"]
            if NOT_A_COLOUR.search(name):
                continue
            code = row.get("Code", "null")
            # Citadel publishes no codes, and most Army Painter rows lack one: derive from the name.
            sku = code if code not in ("", "null") else slug(name)
            key = (brand, line, slug(sku))
            if key in seen:
                if key in KNOWN_DUPLICATES:
                    continue
                if key in names_by_key and names_by_key[key] != name:
                    # The dataset gives two different paints one code. Keep the code on the first and
                    # identify the second by name, so neither id can be mistaken for the other.
                    collisions.append(f"{brand} {line} {sku}: '{names_by_key[key]}' and '{name}'")
                    sku = slug(name)
                    key = (brand, line, sku)
                if key in seen:
                    raise SystemExit(f"unexpected duplicate {key}: '{name}'")
            seen.add(key)
            names_by_key[key] = name
            finish, opacity = classify(name, default, opaque)
            if finish == "metallic":
                metallic_report.setdefault(f"{brand} {line}", []).append(name)
            items.append({
                "brand": brand, "line": line, "sku": sku, "name": name, "hex": row["Hex"],
                "medium": "acrylic_paint", "finish": finish, "opacity": opacity,
                "discontinued": discontinued, "source": PAINTS_SOURCE,
            })

    dmc = {row["floss"]: row for row in json.loads((src / "rgb-dmc.json").read_text(encoding="utf-8"))}
    for number in DMC_NUMBERS:
        if number not in dmc:
            raise SystemExit(f"DMC {number} not found")
        row = dmc[number]
        # Build the hex from r/g/b: the dataset's own hex column drops leading zeros (black is "0").
        channels = [int(row[key]) for key in ("r", "g", "b")]
        if any(not 0 <= value <= 255 for value in channels):
            raise SystemExit(f"DMC {number} has an out-of-range channel: {channels}")
        items.append({
            "brand": "DMC", "line": "Six-Strand Cotton Floss", "sku": number,
            "name": row["description"].strip(), "hex": "#" + "".join(f"{value:02x}" for value in channels),
            "medium": "embroidery_floss", "finish": "matte", "opacity": 1.0, "discontinued": False,
            "source": DMC_SOURCE,
        })

    target = Path(__file__).resolve().parent.parent / "data" / "catalog" / "seed-source.json"
    # Keep the hand-maintained revision; bump it there when the content changes.
    previous_revision = json.loads(target.read_text(encoding="utf-8")).get("revision", 1) if target.exists() else 1
    out = {
        "description": "Brush-paint ranges for Citadel, Vallejo, Army Painter and Monument Hobbies, plus a DMC "
                       "thread sample. Hex, name and code come from the cited community datasets and are "
                       "unverified against physical product. Finish, opacity, medium and discontinued status "
                       "were assigned by rule in scripts/buildSeedSource.py.",
        "revision": previous_revision,
        "items": items,
    }
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    counts: dict[str, int] = {}
    for item in items:
        counts[item["brand"]] = counts.get(item["brand"], 0) + 1
    print(f"wrote {target} with {len(items)} items: {counts}")
    for collision in collisions:
        print(f"  code used twice in the dataset: {collision}")
    for group, names in metallic_report.items():
        print(f"  metallic in {group}: {', '.join(names)}")


if __name__ == "__main__":
    main()
