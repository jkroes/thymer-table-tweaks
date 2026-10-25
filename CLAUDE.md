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
`plugins/table-view` (a full custom-view re-implementation); both can run side by side —
this one only touches native table components. Live as global plugin "Table Tweaks"
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
  the pager (presets, All rows, Custom… → number field; Enter saves, Escape/blur cancel,
  keys stay in the field). The pager's Previous / Next tooltips name the page keys. Both
  come from an own `getPaginationNodes` on the pager: native builds fresh nodes there and
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
- **Pager reveal** — keyboard focus on the page's last row scrolls the pager into view.
  Mouse focus doesn't (native sets `skipRefocus` for clicks, so `ensureFocusInView` isn't
  called) — same as table-view.

Everything table-view adds beyond native is now here (pager select + Custom… + key
tooltips added 2026-10-25). Not ported on purpose: table-view's fix for native keeping
the old table width after Hide column. Default differs: unset = native 75 here, All there.

**Harness gotcha:** with the desktop app in front, the debug Chrome's app dropdowns
(ours AND native's page select) don't open on CDP clicks even with focus/lifecycle
emulation; bring Chrome to the front (ask the user), or dispatch the select's `change`
CustomEvent (`detail: {value, label}`), which is what picking an option fires. With
Chrome in front, verified 2026-10-25 with real clicks: presets, All rows, Custom… (Enter
saves / Escape / click-away cancel), Next, native page select alongside ours.

## How it hooks in (bundle-decoded)

- **Page size:** the 75 is the module constant `jC`, read only in native table
  `hD.setInitView` and the tasks view, both as `this.pagination.setPaginationDetails(null,
  jC, 0)`. Everything else reads the pager instance (`Fh`): `nrItemsPerPage`,
  `currentPageNr`, `nrAvailablePages`. `nrItemsPerPage = 0` is native "no paging" (`z6`
  returns all, `getPaginationNodes` null, and `getCellCoords`' `d/0` page is clamped to 0
  by `j6`). The plugin puts an OWN `setPaginationDetails` on each table's pager that swaps
  a non-null size for the view's.
- **Finding tables:** no SDK route. A MutationObserver on `document.body` watches for an
  added `.table-view`, then walks the component tree (`g_focusedComponent` → `.parent` to
  the root → `.children`) for components whose node is `.table-view` with `pagination`,
  `focusState`, `options.viewConfig` (excludes the custom view's `gD`, whose node is
  `.custom-view`). `hD` builds its node in `ve`'s constructor and calls `setInitView` at
  the end of its own; the first paint is a rAF later, so the observer's microtask tweaks
  it before anything paints.
- **Everything else** is own-property overrides on the instance (`PATCHED`), calling the
  prototype's method: `Ot` + `handleCommandPaletteContextOption` (palette),
  `updateStatusBarNumberOfItems` + `Ue` (status bar; `ue()` repaints the shortcuts when
  paging starts/stops, since the page count is only known after a refresh),
  `onKeyboardNavigation` (page keys), `ensureFocusInView` (pager reveal),
  `applyHeaderStickiness` (pinned header: base runs, then `top` is reset to its static
  part `30 - offset` and a WAAPI ScrollTimeline translateY adds scrollTop). onUnload
  deletes them, restores 75, cancels the animations.
- **INTERNALS** lists every borrowed name; a table missing any is left native and a
  "Table Tweaks needs updating" toast names them (once per name per load). When the code
  borrows a new internal, add it there. Re-decode recipe: table-view's CLAUDE.md
  ("Native table, decoded").

## NEXT: switch from instance overrides to class patches (decided 2026-10-25)

Keep ONE plugin; replace the per-table discovery (MutationObserver + tree walk + own
properties) with patches on two classes, reached once from the first live table
(`table.constructor.prototype`, `table.pagination.constructor.prototype`) or a collection
component's internal `plugin.getViewTypeClass('table')`:
- **Table class** (`hD`): `Ue`, `Ot`, `handleCommandPaletteContextOption`,
  `updateStatusBarNumberOfItems`, `onKeyboardNavigation`, `ensureFocusInView`,
  `applyHeaderStickiness`. Only native tables use it (bundle FX3P7QBW: registered solely
  as view type "Table", no subclasses) — no guard needed. Methods are looked up per call,
  so already-open tables pick the patches up; no fix-up.
- **Pager class** (`Fh`): `setPaginationDetails` (view's size), `getPaginationNodes`
  (picker + key tooltips). SHARED with the tasks view and the card views (list/gallery,
  page 50), so guard on "parent is a native table" and pass through otherwise. Patching
  `setPaginationDetails` at class level catches `setInitView`'s 75 during construction —
  no first-paint race. Tables already open at patch time need a one-time size fix-up.
- Safeguards for both: wrap a STORED original (private key on the prototype, so a hot
  reload never wraps a wrapper); try/catch in every wrapper falling back to the original
  (worst case = native behavior); onUnload restores the originals. Keep the INTERNALS
  check, run once against the classes.
- Still needs a one-time wait for the first table when no table is open at load.

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
