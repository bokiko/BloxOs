# Lumen visual finish review

Visual-finish pass only. Captured on 2026-09-13 with Chromium at device scale 1, with no browser zoom or CSS scaling. After screenshots use the production dashboard build. Before screenshots use main `5ba2132` in the existing local preview.

## Before and after

These are local API fixtures, **not live-fleet measurements**. Four machines, one AI session, measured/modelled/unavailable power, flat real metrics, and disabled-signing/unavailable-binary states exercise the existing displays. The fixture SSE response ends, so the reconnecting/updates-paused notices are expected and remain visible. Timestamps advance between captures.

| Route, Dark at 2048 × 1040 | Before | After |
| --- | --- | --- |
| Overview | [Before](before-overview-2048-dark-3.png) | [After](after-overview-2048-dark-3.png) |
| Machine Detail | [Before](before-machine-2048-dark-3.png) | [After](after-machine-2048-dark-3.png) |
| Inventory | [Before](before-inventory-2048-dark-3.png) | [After](after-inventory-2048-dark-3.png) |
| AI Sessions | [Before](before-sessions-2048-dark-3.png) | [After](after-sessions-2048-dark-3.png) |
| Versions | [Before](before-versions-2048-dark-3.png) | [After](after-versions-2048-dark-3.png) |

Full-page images preserve the requested viewport width and may extend below its height.

## Coverage and results

- 38 production-build captures: all five routes at 2048 × 1040 and 1440 × 1000; Dark Services, Metrics, no-history, and signing/binary diagnostics; Overview with 3, 2, 1 and 0 mini modules; Bright versions of all five routes; Overview and Machine Detail at 390 × 1000 in both appearances.
- The harness asserts the rendered Overview module count, rather than assuming the preferences fixture was applied.
- Zero captured console errors, page exceptions, or hydration warnings. No document-width overflow, including 390px; the fleet table retains its own horizontal scroll region.
- Rendered-text contrast audit found no failures in the sampled screens: 4.5:1 normal text, 3:1 large text. It composites text/background tokens through ancestors; SVG chart text, disabled controls and unvisited interaction states are outside that automated audit.
- No visible operational button, table-header, fact-label or form-label text below 12px in the checked screens. Chart ticks may remain smaller.
- Keyboard Tab exposed a visible 2px focus outline. Four additional mobile captures with reduced motion enabled passed; sampled CSS transitions stayed within 180ms. Machine-card hover translation/spring was removed.
- Visually inspected the main routes, all Overview compositions, Services, separate metric units, flat-zero metrics, no-history states, mobile and Bright layouts. Empty histories are labelled; no substitute reading is generated.

[Render measurements](render-checks.json) · [Reduced-motion measurements](reduced-motion-checks.json)

## Validation

- `cd dashboard && pnpm -s test`: 267 pass.
- `pnpm -s lint`: exit 0; three existing unused eslint-disable warnings in PreferencesContext.
- `pnpm -s build`: exit 0, including TypeScript compilation.
- `cd hub && go vet ./... && go test ./... -count=1`: exit 0; hub package 124.089s.
- `git diff --check`: clean.

## Preserved contracts

Routes, requests and response shapes, SSE, RBAC, commands/dialogs, terminal lifecycle, machine filters, persisted Overview settings and appearance behavior are unchanged. Power remains teal; host metrics blue; GPU metrics violet. Measured/modelled labels, independent domains, sample means and peaks, freshness/exclusions and unavailable values retain their meanings. No energy/cost calculation, estimator, backend change, migration or deployment is included.

Single metric samples are now visible as dots; no-history panels name their unit and unavailable history instead of indefinitely implying collection. Metric charts retain five separate units and use straight segments. Technical signing/binary reasons can be disclosed, while rollout status and request errors remain visible.
