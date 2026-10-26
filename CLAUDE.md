# Table Tweaks

A Thymer plugin. **Platform knowledge and workspace rules live in the `thymer` skill
(`~/.claude/skills/thymer/`) and the parent repo's `CLAUDE.md` (`~/repos/thymer`)** —
this file holds only what is specific to this plugin.

Mechanics (all repos identical): `./setup.sh` re-links `sdk/`, `bin/thymercli` and
`examples/` from the shared cache (they're gitignored symlinks — don't edit `sdk/`);
`./build.sh .` bundles to `dist/plugin.js`, the paste-ready form (committed on purpose;
`hooks/pre-push` keeps it in sync with source).

## What it is

A GLOBAL plugin (`AppPlugin`) that tweaks Thymer's NATIVE table view in every collection,
so it takes no collection's code slot. Built 2026-10-25 as the lighter alternative to
`plugins/table-view` (a full custom-view re-implementation), which was retired 2026-10-25 in
its favor and now lives in `plugins/archives/table-view`. This one only touches native table
components. Live as global plugin "Table Tweaks"
(created via MCP `create_collection type: global_plugin`). Deploy:

```bash
./build.sh . && bin/thymercli plugin update code <plugin-guid> -w <workspace-guid> < dist/plugin.js
```

A newly CREATED global plugin only starts in already-open clients after a reload (Cmd+R);
code updates hot-reload (onUnload → onLoad, verified: the live table's overrides swap).

Tweaks (all verified live 2026-10-25, debug Chrome, Actions' native "Thymer" view, bundle
`app-FX3P7QBW.js`):
- **Rows per page per view** — `opts.page_size` on the view config (0 = all, absent =
  native 75). Set from the command palette while the table is focused ("Show N Rows per
  Page" / "Show All Rows", the native `Ot` context-option mechanism) or from a select in
  the pager (presets, All rows, or any number typed into the dropdown's filter field —
  it shows as a pinned "N per page" option, Enter picks it; replaced the old Custom…
  number field 2026-10-25). The typed entry is an `addDynamicOptions` provider added by
  wrapping the select's dropdown `options.onPopulate` (a microtask after creation, once
  `_refresh` has inserted the select and it has built its `Js`); `pinned` options lead
  the results while searching. A preset number shows only the preset. The pager's Previous / Next tooltips name the page keys. Both
  come from the patched `getPaginationNodes` on the pager: native builds fresh nodes there and
  its `_refresh` inserts them, so the additions are made before insertion and ride every
  redraw — no live Thymer node is edited, no remount observer. Where native hides the
  pager (one page / All) the bar still shows count + select above 25 rows. The select is
  an app `dropdown-select`; its dropdown parents to the pager component, so the pager's
  redraw (`Wn()`) cleans it up like native's page select. Saved without a
  plugin reload through the native `addPropertyColumn` against a host (same trick as
  table-view). Persists across reload; no 75-row flash on a fresh table (per-frame row
  count during a view switch: 0 → 25). Other clients with the view OPEN follow on their
  own: when the config sync arrives (~8–26s, desktop → web Chrome) the app rebuilds their
  table, which comes up at the new size — no manual reload or view switch needed.
- **Steady pinned header** — screencast during wheel scroll: native alternates the band
  between pinned and dragged ~115px into the rows; tweaked holds still until it unpins.
- **⌥← / ⌥→ page turns** (`plugin.table_prev_page` / `plugin.table_next_page`, the same
  rebindable names table-view uses), keeping the row within the page and the column;
  status bar "97 items · Page 2 of 4" and a "⌥← ⌥→ Page" shortcut hint.

Everything table-view adds beyond native is now here (pager select + typed size + key
tooltips added 2026-10-25). Not ported on purpose: table-view's fix for native keeping
the old table width after Hide column. Default differs: unset = native 75 here, All there.

**Harness gotcha:** with the desktop app in front, the debug Chrome's app dropdowns
(ours AND native's page select) don't open on CDP clicks even with focus/lifecycle
emulation; bring Chrome to the front (ask the user), or dispatch the select's `change`
CustomEvent (`detail: {value, label}`), which is what picking an option fires. With
Chrome in front, verified 2026-10-25 with real clicks: presets, All rows, the old Custom… (Enter
saves / Escape / click-away cancel), Next, native page select alongside ours.

## How it hooks in (bundle-decoded)

- **Page size:** the 75 is the module constant `jC`, read only in native table
  `hD.setInitView` and the tasks view, both as `this.pagination.setPaginationDetails(null,
  jC, 0)`. Everything else reads the pager instance (`Fh`): `nrItemsPerPage`,
  `currentPageNr`, `nrAvailablePages`. `nrItemsPerPage = 0` is native "no paging" (`z6`
  returns all, `getPaginationNodes` null, and `getCellCoords`' `d/0` page is clamped to 0
  by `j6`). The plugin wraps the pager class's `setPaginationDetails` to swap a non-null
  size for the view's — at class level it catches `setInitView`'s 75 during construction,
  so a new table never shows 75 rows (per-frame row count across a rebuild: 25 → 0 → 25).
- **Class patches (since 2026-10-25, replacing per-instance overrides):** the first native
  table found yields `Object.getPrototypeOf(table)` (`hD`) and of `table.pagination`
  (`Fh`). `patch()` stores each original once under `Symbol.for('table-tweaks.originals')`
  on the prototype (`{fn, own}`), so a hot reload — or a load whose predecessor never
  unloaded — never wraps a wrapper; `restore()` puts own methods back and deletes the
  inherited one (`updateStatusBarNumberOfItems` lives on `Hn`, shared with the custom
  view `gD`, so it is patched as an own property of `hD.prototype` only). Every wrapper
  falls back to native on a throw (logged once per method). Already-open tables get a
  one-time fix-up (size, pager redraw, sticky, refresh, shortcuts) at patch time and on
  unload. Verified live 2026-10-25 (debug Chrome, by evaluation): hot reload keeps the same
  stored originals; reload with no table open → the first table opened comes up at its
  saved 25 with no 75 frame (rows per frame −1 → 0 → 25); the same `page_size: 25` config
  rendered as list / gallery (ad-hoc `setView`, unsaved) keeps their pagers at native 50
  with no select or key tooltips; the Tasks panel's pager stays native. Desktop app (9223,
  read-only): hot reload picked up the class patches, no leftover instance overrides.
  Same day, real CDP input (guarded key batches, screenshots): status-bar "⌥←⌥→ Page" hint
  and "Page N of M"; ⌥→ from row 11 lands on row 86, same column, ⌥← back, both no-ops
  at the ends; ⌘P "rows"
  lists the sizes minus the current one, Enter on one applies + saves (75 clears it);
  wheel-scroll screencast with the header painted magenta: tweaked 25/25 frames pinned,
  native jumps between pinned and ~130 CSS px into the rows.
- The sticky animation is rebuilt when it is `idle` as well as when the header element
  changes — a probe that cancelled it (to screencast native) otherwise left the header
  unpinned for good.
- **Table class** (`hD`, only native tables use it — registered solely as "Table", no
  subclasses): `Ot` + `handleCommandPaletteContextOption` (palette),
  `updateStatusBarNumberOfItems` + `Ue` (status bar; `ue()` repaints the shortcuts when
  paging starts/stops, since the page count is only known after a refresh),
  `onKeyboardNavigation` (page keys),
  `applyHeaderStickiness` (pinned header: base runs, then `top` is reset to its static
  part `30 - offset` and a WAAPI ScrollTimeline translateY adds scrollTop).
- **Pager class** (`Fh`): `setPaginationDetails`, `getPaginationNodes`. SHARED with the
  tasks view and the card views (list/gallery, page 50), so both pass through unless
  `this.parent instanceof` the table class (`ve` sets `parent` before `hD` builds its pager).
- **Finding the classes:** no SDK route, and no route without a live table (the collection
  plugin's `getViewTypeClass('table')` is reachable only from an open collection view, and
  the workspace's plugin lookup `z()` is module-private). With no table open at load, a
  MutationObserver waits for the first `.table-view`, then disconnects. Tables are found by
  walking the component tree (`g_focusedComponent` → `.parent` to the root → `.children`)
  for a node `.table-view` with `pagination`, `focusState`, `options.viewConfig` (excludes
  `gD`, whose node is `.custom-view`).
- **INTERNALS** lists every borrowed name, checked once against the first table; if any is
  missing nothing is patched and a "Table Tweaks needs updating" toast names them. When
  the code borrows a new internal, add it there. Re-decode recipe: `plugins/archives/table-view/CLAUDE.md`
  ("Native table, decoded").

## Open / unverified

- Verified 2026-10-25: saving the view's Table Settings dialog keeps `opts.page_size` (the
  save rebuilds the table; the new one comes up at the saved size). Toolbar save-as-default
  also keeps it (it clones the stored config and changes only the sort — bundle,
  `saveEphemeralChangesAsDefault`).
- Verified 2026-10-25: rebinding through Change Keyboard Shortcuts (`"plugin.table_next_page":
  "Alt+Shift+ArrowRight"`, `"plugin.table_prev_page": ""`) — the old key stops, the new one
  turns pages, the unbound one does nothing, the status-bar hint follows. Restored after.
- Verified 2026-10-25 in the desktop app (Electron, relaunched with
  `--remote-debugging-port=9223`, same bundle): tweaks applied to the native view on
  launch, page size via the palette handler (saved), ⌥→/⌥← via the table's key handler
  (slot `mac_electron` has no custom keys → defaults), status label + hint, pinned header
  holding at the panel top with its ScrollTimeline animation across scrolls. Driven by
  evaluation, not real input (the user's live app); the pixel wobble check was web-only.
- Phone layout: all tweaks but page size skip `isPhoneTableView()` tables.
- Removed 2026-10-25 at the user's request: the pager reveal (an `ensureFocusInView`
  wrapper scrolling the pager into view on the page's last row).
