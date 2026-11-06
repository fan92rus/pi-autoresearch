# research-map fixtures (synthetic)

Every file here is a SYNTHETIC fixture: the numbers, timestamps, hashes and
descriptions are invented for tests. They illustrate the legacy `.auto/` layout
of pi-autoresearch. They are NOT historical campaign data and must never be
cited as evidence that the research loop or the direction-review engine finds
real improvements (research-map task 5.2: historical data is illustrative, not
proof of search efficiency).

- `legacy-campaign/` — an old-format campaign: `log.jsonl` rows without
  `activity_type`, no `observations.jsonl` / `run-links.jsonl` / `analysis.jsonl`
  sidecars, no `tree.json`. Used by the legacy-compat and rollback tests.
