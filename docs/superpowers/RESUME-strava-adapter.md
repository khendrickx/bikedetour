# Resume: Strava Adapter Implementation

## Status
Design and plan are complete. Implementation not yet started.

## What was done
- Spec: `docs/superpowers/specs/2026-06-07-strava-adapter-design.md`
- Implementation plan: `docs/superpowers/plans/2026-06-07-strava-adapter.md`
- Both committed on branch `ridewithgps`

## What to do next
Execute the implementation plan. Read the plan at `docs/superpowers/plans/2026-06-07-strava-adapter.md` and follow it task-by-task using the `superpowers:subagent-driven-development` or `superpowers:executing-plans` skill.

The plan has 6 tasks:
1. Update both manifests (`extension/manifest.json`, `extension-firefox/manifest.json`)
2. Create `extension/content-strava.js`
3. Create `extension/adapters/StravaAdapter.js`
4. Create `extension/injected-strava.js`
5. Build and manually verify in Chrome at `https://www.strava.com/maps/create`
6. Update `agents.md`

## Key context
- Branch: `ridewithgps`
- Strava uses **Mapbox GL JS** (confirmed from bundle analysis) — assigned explicitly as `window.mapboxgl = bundledLib()`
- `/routes/new` server-redirects to `/maps/create` — manifest must match `/maps/*`
- The adapter is a near-copy of `KomootAdapter` (same Mapbox/MapLibre API)
- No React fiber walk needed (unlike Komoot)
- All code is in the plan — no design decisions left open
