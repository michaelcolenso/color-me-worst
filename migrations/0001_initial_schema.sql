-- 0001_initial_schema.sql
-- Target: Cloudflare D1 (SQLite). Apply with `wrangler d1 migrations apply`.
--
-- Conventions
--   * Timestamps are integer milliseconds since the Unix epoch (UTC).
--   * Rows that sync to devices are never hard-deleted; `deleted = 1` is a
--     tombstone so the deletion reaches every device.
--   * `user_id` is an opaque identifier issued by whichever auth provider is
--     adopted later. There is deliberately no users table yet.
--   * Enumerations are enforced with CHECK constraints and must stay in step
--     with MediumType / FinishType in src/lib/color/types.ts.
--   * Foreign keys rely on enforcement being on, which is D1's default.

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE brands (
  id          TEXT    PRIMARY KEY,               -- slug, e.g. 'citadel'
  name        TEXT    NOT NULL UNIQUE,
  website     TEXT,
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE TABLE catalog_items (
  id            TEXT    PRIMARY KEY,             -- '<brand>:<line>:<sku>' slug
  brand_id      TEXT    NOT NULL REFERENCES brands (id),
  line          TEXT    NOT NULL,
  sku           TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  medium        TEXT    NOT NULL CHECK (medium IN (
                  'acrylic_paint', 'enamel_paint', 'oil_paint', 'embroidery_floss',
                  'alcohol_marker', 'fabric', 'bead', 'leather_dye')),
  finish        TEXT    NOT NULL CHECK (finish IN (
                  'matte', 'satin', 'gloss', 'metallic', 'wash', 'contrast',
                  'fluorescent', 'variegated')),
  opacity       REAL    NOT NULL CHECK (opacity >= 0 AND opacity <= 1),

  -- Colour. hex is the display value; lab_* is what matching uses.
  hex           TEXT    NOT NULL CHECK (
                  length(hex) = 7 AND substr(hex, 1, 1) = '#'
                  AND NOT substr(hex, 2) GLOB '*[^0-9a-f]*'),
  rgb_r         INTEGER NOT NULL CHECK (rgb_r BETWEEN 0 AND 255),
  rgb_g         INTEGER NOT NULL CHECK (rgb_g BETWEEN 0 AND 255),
  rgb_b         INTEGER NOT NULL CHECK (rgb_b BETWEEN 0 AND 255),
  lab_l         REAL    NOT NULL,
  lab_a         REAL    NOT NULL,
  lab_b         REAL    NOT NULL,
  oklch_l       REAL    NOT NULL,
  oklch_c       REAL    NOT NULL,
  oklch_h       REAL    NOT NULL,

  -- How much the colour can be trusted:
  --   community     crowd-sourced hex, unverified
  --   manufacturer  published by the maker
  --   measured      instrument reading of the physical product
  color_source  TEXT    NOT NULL DEFAULT 'community' CHECK (color_source IN (
                  'community', 'manufacturer', 'measured')),
  source_note   TEXT,

  discontinued  INTEGER NOT NULL DEFAULT 0 CHECK (discontinued IN (0, 1)),

  -- Monotonic catalogue revision in which this row last changed. A device
  -- holding revision N asks for `revision > N` to update incrementally.
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),

  UNIQUE (brand_id, line, sku)
);

CREATE INDEX idx_catalog_items_brand_line    ON catalog_items (brand_id, line);
CREATE INDEX idx_catalog_items_medium_finish ON catalog_items (medium, finish);
CREATE INDEX idx_catalog_items_name          ON catalog_items (name COLLATE NOCASE);
CREATE INDEX idx_catalog_items_revision      ON catalog_items (revision);
-- Coarse server-side prefilter for colour queries: narrow by lightness, then
-- rank the survivors with CIEDE2000 in application code.
CREATE INDEX idx_catalog_items_lightness     ON catalog_items (medium, lab_l);

-- ---------------------------------------------------------------------------
-- User inventory
-- ---------------------------------------------------------------------------

CREATE TABLE user_stashes (
  user_id          TEXT    NOT NULL,
  catalog_item_id  TEXT    NOT NULL REFERENCES catalog_items (id),
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  note             TEXT,
  updated_at       INTEGER NOT NULL,             -- set by the writing device; last write wins
  deleted          INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (user_id, catalog_item_id)
) WITHOUT ROWID;

-- "Everything of mine that changed since my last sync."
CREATE INDEX idx_user_stashes_sync ON user_stashes (user_id, updated_at);

-- ---------------------------------------------------------------------------
-- Recipes and saved palettes
-- ---------------------------------------------------------------------------

CREATE TABLE recipes (
  id          TEXT    PRIMARY KEY,               -- client-generated UUID
  user_id     TEXT    NOT NULL,
  title       TEXT    NOT NULL CHECK (length(title) > 0),
  source_url  TEXT,
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);

CREATE INDEX idx_recipes_sync ON recipes (user_id, updated_at);

-- One required colour of a recipe. It is either a known catalogue item
-- (a tutorial that names a paint) or a free colour (a pin on a photo), and
-- always carries its own target colour so it still resolves if the catalogue
-- row is later changed.
CREATE TABLE recipe_items (
  recipe_id        TEXT    NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  position         INTEGER NOT NULL CHECK (position >= 0),
  label            TEXT    NOT NULL,             -- e.g. 'cloak highlight'
  catalog_item_id  TEXT    REFERENCES catalog_items (id),
  target_hex       TEXT    NOT NULL CHECK (
                     length(target_hex) = 7 AND substr(target_hex, 1, 1) = '#'
                     AND NOT substr(target_hex, 2) GLOB '*[^0-9a-f]*'),
  target_lab_l     REAL    NOT NULL,
  target_lab_a     REAL    NOT NULL,
  target_lab_b     REAL    NOT NULL,
  target_finish    TEXT    NOT NULL DEFAULT 'matte' CHECK (target_finish IN (
                     'matte', 'satin', 'gloss', 'metallic', 'wash', 'contrast',
                     'fluorescent', 'variegated')),
  PRIMARY KEY (recipe_id, position)
) WITHOUT ROWID;

CREATE INDEX idx_recipe_items_catalog ON recipe_items (catalog_item_id);
