# Screenshot Checklist

Capture screenshots into `docs/demo/images/` after starting the local app and verifying the data view is clean.

## Dashboard

- [x] Dashboard home page at `/` (`docs/demo/images/dashboard-home.png`)
- [x] Signals page at `/signals` (`docs/demo/images/signals.png`)
- [x] Related groups page at `/related-groups` (`docs/demo/images/related-groups.png`)
- [x] Snapshot inspector at `/snapshot-inspector` (`docs/demo/images/snapshot-inspector.png`)
- [ ] Live markets page at `/markets`
- [ ] Logs page at `/logs`

## Research Output

- [ ] Terminal output from `npm run research:summary`
- [ ] Terminal output from `npm run research:summary -- --format markdown`
- [ ] Terminal output from `npm run research:quote-sweep -- --markout-window 240m --fill-window 240m --min-entry-spread 0.04 --max-entry-spread 0.10 --dedupe-by ticker`
- [ ] README research summary section in GitHub preview or local Markdown preview

## Capture Notes

- Avoid screenshots with API keys, private environment values, personal browser data, or noisy unrelated terminal history.
- Prefer a clean browser width that shows the navigation and the main table/card content.
- If the database has little or no local data, capture the terminal research summary and README instead of forcing empty dashboard screenshots.
- Suggested filenames:
  - `dashboard-home.png`
  - `signals.png`
  - `related-groups.png`
  - `snapshot-inspector.png`
  - `research-summary-terminal.png`
  - `quote-sweep-terminal.png`
  - `readme-research-summary.png`
