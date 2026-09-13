# BloxOS design

## One visual system

BloxOS has a single visual system, **Monoform**, with the **Lumen** visual finish.
There is no layout picker, no
theme gallery and no palette-per-layout: every authenticated page renders the
same responsive shell — a desktop navigation rail, mobile navigation, and a top
bar carrying the page title and global actions.

The only appearance choice is contrast:

| Mode | Character |
| --- | --- |
| **Dark** (default) | Near-black canvas with raised panels, readable secondary text and restrained borders. |
| **Bright** | Light surfaces with dark text and the same layout and operational hierarchy. |

Bright is stored as `light`; Dark is stored as `dark`. There is no
"follow the operating system" mode. The stored choice is applied before
hydration to avoid an initial appearance flash.

Choose **Settings → Preferences → Appearance**, or use the contrast toggle in
the top bar. The choice is stored locally so it applies before you log in, and
synced to your account through `GET/PATCH /api/me/theme` so it follows you to
another browser. A failed sync is not fatal: the local choice stays in effect.

## What replaced the layouts

Earlier releases offered five selectable dashboard layouts (Classic,
Operations Wall, Grove Workspace, Precision Console, Fleet Ledger), each with
its own colour variants, plus an eight-palette theme gallery. All of it has
been removed in favour of one system.

Stored `light` selects Bright; retired `gray` and unrecognised values resolve
to Dark. Nothing needs to be reset by hand, and the
per-user database columns the old system wrote are left in place rather than
dropped, so an older hub binary still reads its own rows.

Everything the layouts were used for is unchanged: live fleet data, the same
permissions and action paths, and the same status semantics. Empty or missing
telemetry is reported as unavailable, not as an invented zero; stale readings
are excluded from current aggregates; GPU power is component telemetry rather
than wall power, and incomplete readings are labelled partial.

## Where it lives

- `dashboard/src/app/monoform.css` — the whole token layer and every `.mf-*`
  component class, including both contrast modes.
- `dashboard/src/app/globals.css` — imports the above and maps the shared
  semantic tokens the component library reads.
- `dashboard/src/components/shell/AppShell.tsx` — the one shell: rail, top bar
  and content region.
- `dashboard/src/components/shell/navItems.tsx` — the single navigation list.
- `dashboard/src/contexts/ThemeContext.tsx` — `useTheme() → { appearance,
  setAppearance }`, local persistence and the per-user sync.
- `dashboard/src/app/layout.tsx` — the pre-hydration bootstrap that paints the
  stored contrast mode before React mounts.
- `dashboard/src/lib/monoform-classes.ts` — the shared class constants pages
  use instead of repeating utility strings.
- `hub/user_prefs.go` — server-side acceptance of `monoform` plus `dark`/`light`.

Guard tests in `dashboard/src/lib/monoform-guard.test.mjs` fail if the retired
vocabulary reappears in dashboard source, or if a second navigation rendering
path is added.

## BloxOS logo

The shared square mark is in three parts: an open enclosure, a solid compute
core and a detached node. It inherits `currentColor`, so it takes the active
contrast mode's foreground wherever it appears.

SVG masters are in `dashboard/public/brand/`: `bloxos-mark.svg`,
`bloxos-mark-black.svg`, and `bloxos-mark-white.svg`. These have transparent
backgrounds. The React `BloxosMark` component is used by the default
application header; uploaded instance logos and custom titles retain their
existing precedence.

[Screenshot gallery](../screenshots/README.md) · [Back to BloxOS](../../README.md)
