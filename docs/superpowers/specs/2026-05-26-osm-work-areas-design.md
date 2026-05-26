# OSM Work Areas — Design Spec
**Date:** 2026-05-26

## Goal

Add OpenStreetMap (OSM) as a fourth live data source for construction work areas, shown alongside GIPOD, Brussels Mobility, and NDW. OSM covers the whole world, making the extension useful outside Belgium and the Netherlands. Features use the same red/orange severity scheme as existing sources but with slightly different tints so users can visually distinguish OSM data.

---

## Architecture / Data Flow

Follows the existing per-source pattern exactly:

1. **`background.js`** — `fetchOsmConstruction(bbox)` POSTs to the Overpass API. One query fetches both `highway=construction` ways and `barrier=construction` ways/nodes with full geometry. Result is normalised and stored in the existing 10-min bbox cache under a new `osm` key alongside `hindrances`, `brussels`, `ndw`, `diversions`.

2. **`content.js`** — the `RW_DATA` message gets a new `osm` field passed through unchanged.

3. **`injected.js`** — new source `rw-osm` and two new layers: `rw-osm-line` (ways) and `rw-osm-circle` (nodes). Both are included in `setVisible` and `setLimitedVisible`.

4. **`popup.html`** — OSM added to the data sources list with a Live badge.

---

## Overpass Query

Single POST per bbox to `https://overpass-api.de/api/interpreter`:

```
[out:json][timeout:25][bbox:{{south}},{{west}},{{north}},{{east}}];
(
  way[highway=construction];
  way[barrier=construction];
  node[barrier=construction];
);
out geom;
```

- `out geom` returns full coordinate arrays for ways (no extra node lookups needed).
- Timeout 25 s is safe for typical cycling-scale bboxes.
- No geographic restriction — works globally wherever the user is viewing the map.

---

## Normalisation

Each OSM element is mapped to the shared feature schema:

| Field | Value |
|---|---|
| `source` | `'osm'` |
| `id` | `'way/123456'` or `'node/123456'` |
| `description` | `construction=*` tag if present (e.g. `"cycleway"`), else `"Wegwerkzaamheden"` for `highway=construction` or `"Constructiebarrière"` for `barrier=construction` |
| `severity` | `access=permissive` or `access=yes` → `'partial'`; anything else (including absent) → `'full_closure'` |
| `start` | `start_date` OSM tag, or `null` |
| `end` | `end_date` OSM tag, or `null` |
| `owner` | `name` tag if present, else `'OpenStreetMap'` |
| `infoUrl` | `https://www.openstreetmap.org/way/123456` (or `/node/`) |

---

## Rendering

### Layer: `rw-osm-line` (ways → LineString/MultiLineString)

- `type: 'line'`
- `line-width: 4`
- `line-cap: 'round'`, `line-join: 'round'`
- `line-dasharray: [4, 3]` — dashed to distinguish from NDW solid lines
- Colors (slightly crimson-shifted vs GIPOD/Brussels/NDW):
  - `full_closure` → `#C62828`
  - partial → `#E65100`
- `line-opacity: 0.85`

### Layer: `rw-osm-circle` (nodes → Point)

- `type: 'circle'`
- `circle-radius: 7` (slightly smaller than Brussels circles at 9)
- Same color expression as above
- `circle-stroke-width: 2`, `circle-stroke-color: '#fff'`
- `circle-opacity: 0.9`

Both layers included in `setVisible` and `setLimitedVisible` filter lists.

---

## Popup

Reuses `buildPopupHtml` unchanged. Because `infoUrl` is always set for OSM elements, the existing popup already renders a "Meer info" link pointing to `openstreetmap.org/way/ID` — giving users a direct link to the OSM entity. The `owner` field (`'OpenStreetMap'` or the feature's `name` tag) identifies the source.

---

## Popup.html — Sources List

New row added after NDW:

```html
<div class="source">
  <span class="dot active"></span>
  <span>OpenStreetMap — Global</span>
  <span class="badge live">Live</span>
</div>
```

---

## Caching

OSM data is stored in the existing `_bboxCache` alongside the other sources. TTL: 10 minutes. No separate global cache (unlike NDW's gzip feed) — Overpass supports bbox filtering natively so per-tile fetching is appropriate.

---

## Out of Scope

- Toggling OSM independently (no per-source toggles exist for any source today)
- Fetching OSM relations (only ways and nodes)
- Filtering by cycling-specific tags (e.g. `bicycle=no`) — severity is inferred from `access=*` only
