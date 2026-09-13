# PR #240 pre-merge repairs

The two requested code blockers are fixed. This remains a visual-finish change with the explicitly requested metric request-state repair; no unrelated styling or backend changes were added.

## Request states

Metric history is keyed by machine and period. A new key is immediately masked as loading, before effect cleanup/setup. Responses must be successful with an array-valued `points`. HTTP/network/JSON/shape errors and the 15-second timeout become explicit errors. Cleanup cancels and suppresses the old request. Retry and the unchanged 30-second poll share the same request path; overlapping calls cannot race each other.

A refresh failure retains same-key loaded points with a warning. Empty history is claimed only after a successful empty response. The five independent unit charts, domains, no-animation configuration and single-point dots are unchanged.

| Captured state | Screenshot |
| --- | --- |
| Loading after period change; previous readings immediately removed | [Loading](metrics-loading.png) |
| Failed initial request with Retry | [Initial error](metrics-initial-error.png) |
| Successful empty response; Retry retained the selected 6h period | [Confirmed empty](metrics-confirmed-empty.png) |
| One point; five metric charts and five dots observed | [Single point](metrics-single-point.png) |
| Failed automatic refresh retaining readings | [Refresh warning](metrics-refresh-warning.png) |
| Normal Metrics, Dark | [Dark](metrics-normal-dark.png) |
| Normal Metrics, Bright | [Bright](metrics-normal-bright.png) |

These captures use the actual locally served production build with **controlled API responses**, not live fleet data. Loading and error states contain no empty-history claim. The tests exercise malformed responses, non-cleanup abort, cleanup with late response, timeout even when the transport ignores abort, and request overlap in addition to the requested cases.

## Accent foreground

Both accent-foreground aliases now resolve to the existing `--mf-action-text`. Browser-computed keyboard-focus colors were:

- Dark: `rgb(17, 20, 28)` on `rgb(135, 148, 255)`, **6.76:1**.
- Bright: white on `rgb(49, 73, 217)`, **6.81:1**.

The Dark ordinary menu item, radio item, checkbox item and primary Add Machine action all use that same readable pair. Menu popover text retains its separate semantic foreground. The shared tooltip uses background/foreground tokens, not either modified accent alias.

[Dark menu focus](dark-menu-keyboard-focus.png) · [Radio focus](dark-radio-menu-focus.png) · [Checkbox focus](dark-checkbox-menu-focus.png) · [Bright menu focus](bright-menu-keyboard-focus.png)

## Validation

- Dashboard tests: **281 pass**, including 14 new behavioral request-state tests.
- Dashboard lint: exit 0, three existing PreferencesContext warnings; no new warning.
- Dashboard production build: exit 0, including TypeScript.
- Hub `go vet ./...` and `go test ./... -count=1`: exit 0; hub package 123.346s.
- No BloxOS console exception or hydration warning observed in the controlled browser checks. The user browser reported an unrelated wallet-extension `Cannot redefine property: ethereum` exception; this is explicitly not counted as an application error. Forced HTTP failures are intentional test inputs.

## Remaining real-environment merge gate

**Not yet satisfied.** An authenticated production tab at `https://192.168.16.113/` is available, but it serves the previous UI: `main.mf-content` without the new frame class and accent `#6d7cff`. It does not serve this PR. Inspecting it would not validate the candidate, and these controlled captures must not be represented as real-environment release evidence.

The requested real-environment responsive/persistence/RBAC/terminal/action verification and real-environment screenshots still require the candidate on an approved staging/deployed instance. No production deployment, merge, permission change, or destructive machine action was performed. Merge is held pending that gate.
