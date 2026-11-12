#!/usr/bin/env python3
"""Build data/catalog/seed-source.json from community colour tables.

This is a one-off import tool, kept so the seed can be rebuilt or extended.
It reads local copies of two public datasets and writes a small curated
sample. Nothing is fetched from the network by this script.

Inputs (download them first):
  1. github.com/Arcturus5404/miniature-paints  (MIT licence)
       paints/Citadel_Colour.md, paints/Vallejo.md, paints/Monument.md
  2. github.com/seanockert/rgb-to-dmc  (no licence file published)
       rgb-dmc.json

Usage:
  python3 scripts/buildSeedSource.py <dir-with-the-four-files>

What comes from the datasets: name, product code and hex.
What does NOT come from the datasets and is assigned here by hand:
  finish, opacity and medium. Treat those as editorial assumptions.
"""

import json
import re
import sys
from pathlib import Path

PAINTS_SOURCE = "github.com/Arcturus5404/miniature-paints (MIT)"
DMC_SOURCE = "github.com/seanockert/rgb-to-dmc (licence not stated)"

# (name, set) -> finish. Anything not listed uses the line default.
CITADEL = {
    "Base": {
        "default": ("matte", 0.95),
        "names": [
            "Abaddon Black", "Mephiston Red", "Macragge Blue", "Averland Sunset", "Caliban Green",
            "Zandri Dust", "Mechanicus Standard Grey", "Rhinox Hide", "Khorne Red", "Kantor Blue",
            "Corax White",
        ],
        "metallic": ["Leadbelcher", "Retributor Armour", "Balthasar Gold"],
    },
    "Layer": {
        "default": ("matte", 0.8),
        "names": [
            "Evil Sunz Scarlet", "Wild Rider Red", "Calgar Blue", "Yriel Yellow", "Warpstone Glow",
            "Moot Green", "Ushabti Bone", "Cadian Fleshtone", "Kislev Flesh", "Dawnstone",
            "Administratum Grey", "White Scar", "Screaming Skull",
        ],
        "metallic": ["Ironbreaker", "Runefang Steel", "Auric Armour Gold"],
    },
    "Shade": {
        "default": ("wash", 0.25),
        "names": ["Nuln Oil", "Agrax Earthshade", "Reikland Fleshshade", "Druchii Violet"],
        "metallic": [],
    },
    "Contrast": {
        "default": ("contrast", 0.35),
        "names": ["Blood Angels Red", "Ultramarines Blue", "Black Templar", "Snakebite Leather"],
        "metallic": [],
    },
}
CITADEL_DISCONTINUED = ("Foundation (discontinued)", ["Mechrite Red", "Tausept Ochre"])

VALLEJO = {
    "matte": [
        "Black", "White", "Flat Red", "Flat Blue", "Flat Yellow", "Flat Green", "Flat Earth",
        "Flat Flesh", "German Grey", "Ivory", "Sky Blue", "Prussian Blue", "Vermilion",
        "Burnt Umber", "Yellow Ochre", "Olive Green", "Neutral Grey", "Purple", "Bright Orange",
        "Turquoise",
    ],
    "metallic": ["Silver", "Gold", "Gunmetal"],
    "fluorescent": ["Yellow Fluorescent"],
    "gloss": ["Glossy Black"],
}

PRO_ACRYL = {
    "matte": [
        "Bold Titanium White", "Coal Black", "Bold Pyrrole Red", "Green", "Blue", "Golden Yellow",
        "Orange", "Purple", "Magenta", "Sky Blue", "Jade", "Ivory", "Tan Flesh", "Dark Umber",
        "Neutral Grey", "Turquoise", "Yellow Ochre", "Burnt Red",
    ],
    "metallic": ["Silver", "Bright Gold", "Copper"],
    "wash": ["Black Wash", "Brown Wash"],
}

DMC_NUMBERS = [
    "310", "B5200", "321", "666", "797", "820", "699", "702", "444", "307", "740", "550", "553",
    "938", "433", "436", "739", "318", "414", "3371", "3713", "760", "995",
]

OPACITY = {"matte": 0.85, "gloss": 0.85, "metallic": 0.9, "fluorescent": 0.6, "wash": 0.25}


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
        if set(cells[0]) <= {"-"}:
            continue
        row = dict(zip(header, cells))
        match = re.search(r"`(#[0-9A-Fa-f]{6})`", row.get("Hex", ""))
        if not match:
            raise SystemExit(f"no hex in row: {line}")
        row["Hex"] = match.group(1).lower()
        rows.append(row)
    return rows


def find(rows: list[dict], name: str, set_name: str) -> dict:
    hits = [r for r in rows if r["Name"] == name and r["Set"] == set_name]
    if len(hits) != 1:
        raise SystemExit(f"expected exactly one '{name}' in '{set_name}', found {len(hits)}")
    return hits[0]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    items: list[dict] = []

    def add(brand, line, sku, name, hex_value, medium, finish, opacity, source, discontinued=False):
        items.append({
            "brand": brand, "line": line, "sku": sku, "name": name, "hex": hex_value,
            "medium": medium, "finish": finish, "opacity": opacity,
            "discontinued": discontinued, "source": source,
        })

    citadel = read_table(src / "Citadel_Colour.md")
    for set_name, spec in CITADEL.items():
        finish, opacity = spec["default"]
        for name in spec["names"]:
            row = find(citadel, name, set_name)
            # The dataset carries no Citadel product codes, so the SKU is derived from the name.
            add("Citadel", set_name, slug(name), name, row["Hex"], "acrylic_paint", finish, opacity, PAINTS_SOURCE)
        for name in spec["metallic"]:
            row = find(citadel, name, set_name)
            add("Citadel", set_name, slug(name), name, row["Hex"], "acrylic_paint", "metallic", 0.9, PAINTS_SOURCE)
    set_name, names = CITADEL_DISCONTINUED
    for name in names:
        row = find(citadel, name, set_name)
        add("Citadel", "Foundation", slug(name), name, row["Hex"], "acrylic_paint", "matte", 0.95, PAINTS_SOURCE, True)

    vallejo = read_table(src / "Vallejo.md")
    for finish, names in VALLEJO.items():
        for name in names:
            row = find(vallejo, name, "Model Color")
            add("Vallejo", "Model Color", row["Code"], name, row["Hex"], "acrylic_paint", finish, OPACITY[finish], PAINTS_SOURCE)

    monument = read_table(src / "Monument.md")
    for finish, names in PRO_ACRYL.items():
        set_name = "Monument Pro Acrylic Wash" if finish == "wash" else "Monument Pro Acrylic Paints"
        for name in names:
            row = find(monument, name, set_name)
            add("Monument Hobbies", "Pro Acryl", row["Code"], name, row["Hex"], "acrylic_paint", finish, OPACITY[finish], PAINTS_SOURCE)

    dmc = {row["floss"]: row for row in json.loads((src / "rgb-dmc.json").read_text(encoding="utf-8"))}
    for number in DMC_NUMBERS:
        if number not in dmc:
            raise SystemExit(f"DMC {number} not found")
        row = dmc[number]
        # Build the hex from r/g/b: the dataset's own hex column drops leading zeros (black is "0").
        channels = [int(row[key]) for key in ("r", "g", "b")]
        if any(not 0 <= value <= 255 for value in channels):
            raise SystemExit(f"DMC {number} has an out-of-range channel: {channels}")
        add("DMC", "Six-Strand Cotton Floss", number, row["description"].strip(),
            "#" + "".join(f"{value:02x}" for value in channels), "embroidery_floss", "matte", 1.0, DMC_SOURCE)

    out = {
        "description": "Curated seed sample. Hex, name and code come from the cited community "
                       "datasets and are unverified against physical product. Finish, opacity and "
                       "medium were assigned by hand in scripts/buildSeedSource.py.",
        "items": items,
    }
    target = Path(__file__).resolve().parent.parent / "data" / "catalog" / "seed-source.json"
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    counts: dict[str, int] = {}
    for item in items:
        counts[item["brand"]] = counts.get(item["brand"], 0) + 1
    print(f"wrote {target} with {len(items)} items: {counts}")


if __name__ == "__main__":
    main()
