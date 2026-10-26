/// <reference path="./sdk/types.d.ts" />
/**
 * Table Tweaks — fixes for Thymer's NATIVE table view, applied to every table
 * in the workspace:
 *
 * - Rows per page, per view: the view's `opts.page_size` (0 = all rows), set
 *   from a select in the pager (presets, All rows, or any number typed into
 *   its filter field) or the command
 *   palette while the table is focused. Native hard-codes 75. The pager's
 *   Previous / Next tooltips name the page-turn keys.
 * - A pinned header that doesn't wobble while scrolling.
 * - ⌥← / ⌥→ turn the page (rebindable as `plugin.table_prev_page` /
 *   `plugin.table_next_page`), and the status bar names the page.
 *
 * None of this is SDK. The table is an app component (`hD`, a subclass of the
 * records-view base `Hn`) reached through `window.g_focusedComponent`. The
 * first table found yields two classes, patched in place: the table class
 * (native tables only) and its pager class (shared with other views, so those
 * wrappers check for a table parent). Every wrapper falls back to native on a
 * throw, and unload restores the originals. No Thymer node is rebuilt. The
 * names are internal and partly minified, so `INTERNALS` lists them and a
 * build missing any gets no tweaks and a toast instead.
 */

/** The leading options column's field id (the bundle's `Yt`). */
const OPTIONS_COL = ':first_col';

/** Page size presets offered in the palette; 0 = all rows. 75 is native's (`jC`). */
const PAGE_SIZES = [25, 50, 75, 100, 0];
const NATIVE_PAGE_SIZE = 75;

/**
 * The pinned header's ScrollTimeline range and translateY end, in px: equal, so
 * translateY = scrollTop for any scroll range up to this (a px range end past the
 * scroller's max is honored, not clamped). 1e6 keeps compositor float precision.
 */
const STICKY_RANGE = 1e6;

const PALETTE_ACTION = 'table-tweaks.page_size';

/** Instance methods and fields the tweaks use; see the header comment. */
const INTERNALS = {
	methods: ['refresh', 'ue', '$', 'Ue', 'Ot', 'handleCommandPaletteContextOption', 'updateStatusBarNumberOfItems',
		'applyHeaderStickiness', 'isPhoneTableView', 'onKeyboardNavigation', 'startFocus',
		'addPropertyColumn', 'getPeekStatusBarContext'],
	pagination: ['setPaginationDetails', 'requestPage', 'getPaginationNodes', 'refresh']
};

/**
 * Where a patched prototype keeps its originals: `name → { fn, own }`. A
 * registry symbol, so a reloaded plugin finds the originals a previous load
 * stored and never wraps a wrapper, even if that load never unloaded.
 */
const ORIGINALS = Symbol.for('table-tweaks.originals');

/** Replace each method with `make(original)`, the original stored once per prototype. */
function patch(proto, wrappers) {
	const originals = proto[ORIGINALS] ??= {};
	for (const [name, make] of Object.entries(wrappers)) {
		originals[name] ??= { fn: proto[name], own: Object.hasOwn(proto, name) };
		proto[name] = make(originals[name].fn);
	}
}

/** Undo `patch`: own methods back in place, inherited ones uncovered again. */
function restore(proto) {
	for (const [name, { fn, own }] of Object.entries(proto[ORIGINALS] || {})) {
		if (own) proto[name] = fn;
		else delete proto[name];
	}
	delete proto[ORIGINALS];
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Default page-turn keys. The app's shortcut parser accepts any `plugin.*`
 * action name, so users rebind these in Change Keyboard Shortcuts like the
 * app's own. The same names the retired plugins/table-view used, so old bindings carry over.
 */
const DEFAULT_KEYS = {
	'plugin.table_prev_page': 'Alt+ArrowLeft',
	'plugin.table_next_page': 'Alt+ArrowRight'
};
/** The account's custom-keybinding slot for this platform (`c_()`). */
const KBD_SLOT = (IS_MAC ? 'mac' : 'win') + (window.thymerDesktopAPI ? '_electron' : '_web');
const KEY_MODIFIERS = ['Meta', 'Ctrl', 'Alt', 'Shift'];
const NAMED_KEYS = ['Escape', 'Enter', 'Tab', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
	'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10',
	'F11', 'F12', 'NumpadEnter', 'Insert'];

function appRoot() {
	let root = window.g_focusedComponent;
	while (root?.parent) root = root.parent;
	return root || null;
}

/** The bundle's `r$`: a binding as typed ("cmd+backspace" is an error, "shift+meta+k" → "Meta+Shift+K"), or null. */
function normalizeKey(s) {
	const parts = s.split('+').map(p => p.trim());
	if (parts.some(p => !p)) return null;
	const mods = new Set();
	for (const p of parts.slice(0, -1)) {
		const m = KEY_MODIFIERS.find(k => k.toLowerCase() === p.toLowerCase());
		if (!m) return null;
		mods.add(m);
	}
	let key = parts[parts.length - 1];
	if (/\p{So}/u.test(key)) return null;
	if (key.length === 1) key = key.toUpperCase();
	else key = { copy: 'C', cut: 'X', paste: 'V' }[key.toLowerCase()] || NAMED_KEYS.find(k => k.toLowerCase() === key.toLowerCase());
	return key ? [...KEY_MODIFIERS.filter(m => mods.has(m)), key].join('+') : null;
}

let keymapSource = null;
let keymap = null;

/**
 * The page-turn keys as the app would resolve them (`Vu` + `OI`): the
 * defaults, then the account's custom shortcuts in order — a rebind, an
 * unbind (`"action": ""`), a bare-key unbind (`"": "key"`), or another action
 * taking the key. A config with any error is ignored whole, as the app does.
 */
function pageKeys() {
	const source = appRoot()?.sideBar?.activeUser?.acct_json?.kbd?.[KBD_SLOT] || '';
	if (keymap && source === keymapSource) return keymap;
	const keys = { ...DEFAULT_KEYS };
	const entries = [];
	let ok = true;
	if (!/^\{\s*\}$/.test(source.trim())) {
		for (const raw of source.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('//') || line === '{' || line === '}') continue;
			const m = line.match(/^(?:"(?<action>[^"]*)"|'(?<action>[^']*)')\s*:\s*(?:"(?<key>[^"]*)"|'(?<key>[^']*)')\s*,?/);
			const rest = m && line.slice(m[0].length).trim();
			if (!m || (rest && !rest.startsWith('//'))) { ok = false; break; }
			const { action, key } = m.groups;
			if (!action && !key) { ok = false; break; }
			if (action && !action.includes('.')) { ok = false; break; }
			const normalized = key ? normalizeKey(key) : '';
			if (normalized === null) { ok = false; break; }
			entries.push({ action: action.toLowerCase(), key: normalized });
		}
	}
	if (ok) {
		for (const { action, key } of entries) {
			if (action in keys) keys[action] = key;
			else if (key) for (const a in keys) if (keys[a] === key) keys[a] = '';
		}
	}
	keymapSource = source;
	keymap = keys;
	return keys;
}

/** Key glyphs for status-bar labels (the bundle's `uz`). */
const KEY_GLYPHS = {
	Space: 'Space', ArrowRight: '→', ArrowLeft: '←', Escape: 'Esc', Enter: '↵', Tab: '⇥', ArrowUp: '↑',
	ArrowDown: '↓', PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del', Backspace: IS_MAC ? '⌫' : 'Bksp'
};

/** The bundle's `ce()`: "Alt+ArrowLeft" → "⌥←" on macOS, "Alt + ←" elsewhere. */
function kbdLabel(key) {
	if (!key) return '';
	const parts = key.split('+').map(p => p.trim());
	const last = parts.pop();
	const k = KEY_GLYPHS[last] || last.toUpperCase();
	const mods = parts.map(m => ({
		ctrl: IS_MAC ? '⌃' : 'Ctrl', alt: IS_MAC ? '⌥' : 'Alt', shift: IS_MAC ? '⇧' : 'Shift',
		meta: IS_MAC ? '⌘' : 'Ctrl', cmd: IS_MAC ? '⌘' : 'Ctrl'
	}[m.toLowerCase()] || m));
	return IS_MAC ? mods.join('') + k : [...mods, k].join(' + ');
}

/** The bundle's `ns()`: modifiers in Meta, Ctrl, Alt, Shift order, then the key. */
function keyName(e) {
	if (e.isComposing || e.key === 'Dead') return '';
	const mods = (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '');
	if (e.code === 'Space') return mods + 'Space';
	return mods + (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

function el(html) {
	const t = document.createElement('template');
	t.innerHTML = html.trim();
	return /** @type {HTMLElement} */ (t.content.firstElementChild);
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** A native table component: its node is the `.table-view` and it pages. Used to find the class. */
function isNativeTable(c) {
	return !!(c?.node?.classList?.contains('table-view') && c.pagination && c.focusState && c.options?.viewConfig);
}

/** The internals (see INTERNALS) this table lacks, as `owner.name`; [] when all are there. */
function missingInternals(t) {
	const missing = INTERNALS.methods.filter(n => typeof t[n] !== 'function');
	missing.push(...INTERNALS.pagination.filter(n => typeof t.pagination[n] !== 'function').map(n => `pagination.${n}`));
	for (const f of ['nrItemsPerPage', 'currentPageNr', 'nrAvailablePages']) {
		if (typeof t.pagination[f] !== 'number') missing.push(`pagination.${f}`);
	}
	if (!Array.isArray(t.cachedRowItemsInView)) missing.push('cachedRowItemsInView');
	if (!Array.isArray(t.cachedRowItemsInViewBeforePagination)) missing.push('cachedRowItemsInViewBeforePagination');
	if (!(t.columnFields instanceof Map)) missing.push('columnFields');
	if (!t.verticalScrollNode) missing.push('verticalScrollNode');
	if (typeof t.plugin?.getConfiguration !== 'function') missing.push('plugin.getConfiguration');
	return missing;
}

/** The view's chosen page size, or `fallback` (native's) when it has none. */
function pageSizeOf(t, fallback) {
	const n = t.options?.viewConfig?.opts?.page_size;
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** True while the table shows more than one page. */
function isPaged(t) {
	return t.pagination.nrItemsPerPage > 0 && t.pagination.nrAvailablePages > 1;
}

export class Plugin extends AppPlugin {

	onLoad() {
		/** @type {WeakMap<any, Animation>} each table's pinned-header scroll animation */
		this.stickyAnims = new WeakMap();
		/** @type {WeakMap<any, boolean>} whether each table was paging at its last status-bar update */
		this.wasPaged = new WeakMap();
		/** problems already reported this load, so each warns once */
		this.reported = new Set();
		/** the patched prototypes, once a first table has shown them */
		this.tableProto = null;
		this.pagerProto = null;

		// The classes are only reachable from a live table, so with none open the
		// plugin waits for the first one. A table is built whole in its
		// constructor (native's page size is set there, `setInitView`) and paints
		// a frame later, so catching its node's insertion — a microtask — fixes
		// it up before its first paint. Tables built after the patch are right
		// from the start.
		if (this.findAndPatch()) return;
		this.observer = new MutationObserver((records) => {
			for (const r of records) {
				for (const n of r.addedNodes) {
					if (n.nodeType === 1 && (n.classList.contains('table-view') || n.querySelector('.table-view'))) {
						if (this.findAndPatch()) this.observer.disconnect();
						return;
					}
				}
			}
		});
		this.observer.observe(document.body, { childList: true, subtree: true });
	}

	onUnload() {
		this.observer?.disconnect();
		if (!this.tableProto) return;
		restore(this.tableProto);
		restore(this.pagerProto);
		for (const t of this.openTables()) {
			this.stickyAnims.get(t)?.cancel();
			t.pagination.setPaginationDetails(null, NATIVE_PAGE_SIZE, null);
			t.pagination.refresh();
			t.applyHeaderStickiness();
			t.refresh();
			t.ue();
		}
	}

	/** Every live native table (or, before the patch, every native-looking one). */
	openTables() {
		const tables = [];
		const stack = [appRoot()].filter(Boolean);
		while (stack.length) {
			const c = stack.pop();
			if (!c._destroyed && (this.tableProto ? c instanceof this.tableProto.constructor : isNativeTable(c))) tables.push(c);
			for (const child of c.children || []) stack.push(child);
		}
		return tables;
	}

	/**
	 * Patch the table and pager classes from the first native table open, and
	 * fix up the tables already built. True once patched, or once the plugin
	 * has given up on this build (internals missing); false while no table is open.
	 */
	findAndPatch() {
		const tables = this.openTables();
		if (!tables.length) return false;
		const missing = missingInternals(tables[0]);
		if (missing.length) {
			this.reportInternals(missing);
			return true;
		}
		this.tableProto = Object.getPrototypeOf(tables[0]);
		this.pagerProto = Object.getPrototypeOf(tables[0].pagination);
		patch(this.tableProto, this.tableWrappers());
		patch(this.pagerProto, this.pagerWrappers());
		for (const t of tables) {
			t.pagination.setPaginationDetails(null, NATIVE_PAGE_SIZE, null);
			t.pagination.refresh();
			t.applyHeaderStickiness();
			t.refresh();
			t.ue();
		}
		return true;
	}

	/**
	 * A Thymer update changed what the plugin relies on: the table stays native,
	 * untweaked, and the plugin needs re-checking against the new build.
	 */
	reportInternals(problems) {
		const fresh = problems.filter(p => !this.reported.has(p));
		if (!fresh.length) return;
		fresh.forEach(p => this.reported.add(p));
		console.warn('[Table Tweaks] app internals changed — re-check them against this Thymer build:', fresh);
		this.ui.addToaster({
			title: 'Table Tweaks needs updating',
			message: `Thymer changed internals the tweaks rely on (${fresh.join(', ')}). Tables stay native until the plugin is re-checked against this build.`,
			dismissible: true
		});
	}

	/** A tweak threw: logged once per method, and that call falls back to native. */
	reportError(name, e) {
		if (this.reported.has(name)) return;
		this.reported.add(name);
		console.warn(`[Table Tweaks] ${name} failed, native behavior kept:`, e);
	}

	/**
	 * The pager class is shared with the tasks and card views, so both wrappers
	 * pass through unless the pager belongs to a native table.
	 */
	pagerWrappers() {
		const plugin = this;
		const Table = this.tableProto.constructor;
		return {
			// --- rows per page ----------------------------------------------------
			// Native passes its constant (`jC`) here once, in `setInitView`; every
			// other caller passes null for the size. The view's own size wins.
			setPaginationDetails: (orig) => function (n, size, page) {
				if (size !== null && this.parent instanceof Table) {
					try {
						size = pageSizeOf(this.parent, size);
					} catch (e) {
						plugin.reportError('setPaginationDetails', e);
					}
				}
				return orig.call(this, n, size, page);
			},
			// The pager redraws from `getPaginationNodes` (fresh nodes, inserted by
			// its `_refresh`), so the size select and key tooltips are added to
			// those nodes before Thymer inserts them — nothing already on the page
			// is touched, and every redraw carries them.
			getPaginationNodes: (orig) => function () {
				const nodes = orig.call(this);
				if (!(this.parent instanceof Table)) return nodes;
				try {
					return plugin.pagerNodes(this.parent, nodes);
				} catch (e) {
					plugin.reportError('getPaginationNodes', e);
					return orig.call(this);
				}
			}
		};
	}

	/** Only native tables use the table class (registered once, as "Table"; no subclasses). */
	tableWrappers() {
		const plugin = this;
		/** Native first, then `extra`; a throw in `extra` is reported and the native result stands. */
		const after = (name, extra) => (orig) => function (...args) {
			const result = orig.apply(this, args);
			try {
				extra.call(this, result, ...args);
			} catch (e) {
				plugin.reportError(name, e);
			}
			return result;
		};
		/** `own` handles the call when it returns true; otherwise, or on a throw, native does. */
		const before = (name, own, handled = true) => (orig) => function (...args) {
			try {
				if (own.apply(this, args)) return handled;
			} catch (e) {
				plugin.reportError(name, e);
			}
			return orig.apply(this, args);
		};

		return {
			Ot: after('Ot', function (_result, palette) {
				const current = this.pagination.nrItemsPerPage;
				palette.addStaticOptions(PAGE_SIZES.filter(n => n !== current).map(n => ({
					value: PALETTE_ACTION,
					label: n ? `Show ${n} Rows per Page` : 'Show All Rows',
					icon: 'ti-list-numbers',
					json: { size: n }
				})));
			}),
			handleCommandPaletteContextOption: before('handleCommandPaletteContextOption', function (palette, option) {
				if (option.value !== PALETTE_ACTION || !Number.isInteger(option.json?.size)) return false;
				plugin.setPageSize(this, option.json.size);
				return true;
			}),

			// --- page indicator + page-turn keys ----------------------------------
			// The pager sits below the rows, often off screen while the keyboard
			// turns pages, so the status bar's item count names the page too.
			// Forgetting the cached count makes the next view's count repaint the
			// label. The page count is only known after a refresh, while the
			// shortcuts (`Ue`) paint on focus, so they repaint whenever the table
			// starts or stops paging.
			updateStatusBarNumberOfItems: after('updateStatusBarNumberOfItems', function (_result, n = null) {
				const paged = isPaged(this);
				if (paged !== (plugin.wasPaged.get(this) ?? false)) {
					plugin.wasPaged.set(this, paged);
					if (window.g_focusedComponent === this) this.ue();
				}
				const label = this.statusBar?.lineStatusItem;
				if (!paged || typeof label?.setLabel !== 'function' || this._?.()?.panelHasFocusState?.() === false) return;
				label.setLabel(`${(n ?? this.cachedAllItems?.size ?? 0).toLocaleString()} items · Page ${this.pagination.currentPageNr + 1} of ${this.pagination.nrAvailablePages}`);
				this.statusBar.prevNrItems = null;
			}),
			Ue: after('Ue', function (context) {
				if (!context?.skipDefaultShortcuts || !isPaged(this) || this.getPeekStatusBarContext()) return;
				const keys = pageKeys();
				const bound = [keys['plugin.table_prev_page'], keys['plugin.table_next_page']].filter(Boolean);
				if (bound.length) context.shortcuts.push({ kbd: bound.map(kbdLabel).join(' '), command: 'Page', extraClass: 'statusbar--kbd-modifier' });
			}),
			// A page key is swallowed even at either end. Native returns nothing here.
			onKeyboardNavigation: before('onKeyboardNavigation', function (e) {
				if (this.focusState.isEditing || this.inMoveMode) return false;
				const k = keyName(e);
				const keys = pageKeys();
				if (!k || (k !== keys['plugin.table_prev_page'] && k !== keys['plugin.table_next_page'])) return false;
				if (plugin.turnPage(this, k === keys['plugin.table_next_page'] ? 1 : -1)) e.preventDefault();
				return true;
			}, undefined),

			// --- pinned header -------------------------------------------------------
			// Native rewrites the pinned header's `top` (scrollTop - offset + 30) on
			// every scroll event, which lands a frame after the compositor has
			// scrolled: the header rides along for that frame and snaps back. Here
			// `top` keeps only the static part and a ScrollTimeline translateY adds
			// scrollTop, which the compositor applies in the same frame (a WAAPI
			// animation, so the app's reduced-motion `animation: none` rule doesn't
			// cancel it). Its range runs 1:1 in px, see STICKY_RANGE.
			applyHeaderStickiness: after('applyHeaderStickiness', function () {
				if (this.isPhoneTableView() || typeof ScrollTimeline !== 'function') return;
				const $header = this.$('.table-view-header-row');
				const scroller = this.verticalScrollNode;
				let anim = plugin.stickyAnims.get(this);
				if (!$header || !scroller || !this.headerInStickyMode) {
					anim?.cancel();
					plugin.stickyAnims.delete(this);
					return;
				}
				const offset = this.node.getBoundingClientRect().y + scroller.scrollTop - scroller.getBoundingClientRect().y;
				$header.style.top = `${30 - offset}px`;
				// A new header node needs a new animation; so does a cancelled one
				// (`idle`), or the header would stay unpinned on this same node.
				if (anim?.effect?.target !== $header || anim.playState === 'idle') {
					anim?.cancel();
					anim = $header.animate(
						[{ transform: 'translateY(0px)' }, { transform: `translateY(${STICKY_RANGE}px)` }],
						{ timeline: new ScrollTimeline({ source: scroller, axis: 'block' }), rangeStart: '0px', rangeEnd: `${STICKY_RANGE}px`, fill: 'both', easing: 'linear' }
					);
					plugin.stickyAnims.set(this, anim);
				}
			})
		};
	}

	/**
	 * Native's pager bar (summary, Previous, page select, Next) plus a
	 * page-size select, and the page-turn keys in the buttons' tooltips. Where
	 * native shows no pager (one page, or all rows) the bar still shows with
	 * just the count and the select, once there are more rows than the
	 * smallest preset. The select is an app `dropdown-select`, whose dropdown
	 * becomes a child of the pager component, so the pager's own redraw
	 * cleans it up as it does its page select.
	 */
	pagerNodes(t, nodes) {
		const p = t.pagination;
		const total = p.nrItems;
		const size = p.nrItemsPerPage;
		const presets = PAGE_SIZES.filter(n => n);
		if (!nodes && total <= presets[0]) return nodes;
		const bar = nodes?.[0] ?? el(`<div class='pagination-bar'>
				<div class='pagination-summary text-details'><span class='pagination-count'>${total.toLocaleString()}</span> items</div>
				<div class='pagination-controls'></div>
			</div>`);
		const controls = bar.querySelector('.pagination-controls');
		if (!controls) return nodes;

		const sizes = [...new Set([...presets, ...(size ? [size] : [])])].sort((a, b) => a - b);
		const select = el(`<dropdown-select class='pagination-size-select button-small button-minimal button-minimal-hover' placeholder='Type any number of rows'>
				${sizes.map(n => `<dropdown-option data-value='${n}' ${n === size ? 'selected' : ''}>${n} per page</dropdown-option>`).join('')}
				<dropdown-option data-value='0' ${size ? '' : 'selected'}>All rows</dropdown-option>
			</dropdown-select>`);
		// Its `change` doesn't bubble.
		select.addEventListener('change', (/** @type {any} */ e) => this.setPageSize(t, Number(e.detail.value)));
		controls.prepend(select);
		// A number typed into the dropdown's filter field becomes a pinned "N per
		// page" option at the top, so Enter picks it and `change` saves it like a
		// preset. The select builds its dropdown component (`Js`) once it is
		// inserted, which `_refresh` does right after this returns; each opening
		// populates a fresh autocomplete through `onPopulate`, whose
		// `addDynamicOptions` providers run on every keystroke.
		queueMicrotask(() => {
			const options = /** @type {any} */ (select).dropdown?.options;
			if (typeof options?.onPopulate !== 'function') return;
			const populate = options.onPopulate;
			options.onPopulate = (/** @type {any} */ ac) => {
				ac.addDynamicOptions?.((/** @type {string} */ query) => {
					const n = /^\s*\d+\s*$/.test(query) ? Number(query) : 0;
					return n > 0 && !sizes.includes(n) ? [{ label: `${n} per page`, value: String(n), pinned: true }] : [];
				});
				return populate(ac);
			};
		});

		const keys = pageKeys();
		for (const [cls, label, action] of [['pagination-prev', 'Previous page', 'plugin.table_prev_page'], ['pagination-next', 'Next page', 'plugin.table_next_page']]) {
			const button = bar.querySelector(`.${cls}`);
			if (!button || !keys[action]) continue;
			button.classList.add('tooltip');
			button.setAttribute('data-tooltip-dir', 'top');
			button.setAttribute('data-tooltip-html', `${esc(label)} <span class='kbd kbd-subtle'>${kbdLabel(keys[action])}</span>`);
		}
		return [bar];
	}

	/**
	 * The page-turn keys: the focus keeps its row within the page and its
	 * column; without a focus they act like the Previous / Next buttons.
	 * False at either end.
	 */
	turnPage(t, dir) {
		const p = t.pagination;
		const n = p.currentPageNr + dir;
		if (!isPaged(t) || n < 0 || n >= p.nrAvailablePages) return false;
		const { row, fieldId } = t.focusState;
		const rows = t.cachedRowItemsInViewBeforePagination;
		const field = row && t.columnFields.get(fieldId);
		const index = row ? rows.findIndex(r => r.guid === row.guid) : -1;
		if (!field || index < 0) {
			p.requestPage(n);
			return true;
		}
		const offset = Math.max(0, index - p.currentPageNr * p.nrItemsPerPage);
		p.setPaginationDetails(null, null, n);
		t.startFocus(rows[Math.min(n * p.nrItemsPerPage + offset, rows.length - 1)], field);
		return true;
	}

	/**
	 * Applied at once, then saved to the view's `opts` (where native views keep
	 * theirs, e.g. a list's `page_preview`), so it syncs. Saved the way the
	 * native "+" column saves `field_ids`: `addPropertyColumn` writes the config
	 * without reloading the collection's plugin. Handed the edited config and a
	 * column the view already has, that write is all it does. 75 (native's)
	 * clears the setting.
	 */
	async setPageSize(t, n) {
		const vc = t.options.viewConfig;
		vc.opts = { ...vc.opts, page_size: n };
		if (n === NATIVE_PAGE_SIZE) delete vc.opts.page_size;
		const row = t.focusState.row;
		const index = row ? t.cachedRowItemsInViewBeforePagination.findIndex(r => r.guid === row.guid) : -1;
		t.pagination.setPaginationDetails(null, n, n && index >= 0 ? Math.floor(index / n) : 0);
		t.refresh();
		t.ue();

		const cfg = structuredClone(t.plugin.getConfiguration());
		const v = cfg.views?.find(x => x.id === vc.id);
		let saved = false;
		if (v?.field_ids?.length) {
			v.opts = { ...v.opts, page_size: n };
			if (n === NATIVE_PAGE_SIZE) delete v.opts.page_size;
			const host = Object.create(t, {
				plugin: { value: Object.create(t.plugin, { getConfiguration: { value: () => cfg } }), writable: true },
				columnFields: { value: new Map() },
				columnSizes: { value: new Map() },
				bustAllNodeCache: { value: () => {} },
				refresh: { value: () => {} }
			});
			try {
				saved = await t.addPropertyColumn.call(host, { id: v.field_ids[0] }, false);
			} catch (e) {
				console.warn('[Table Tweaks] saving the page size failed:', e);
			}
		}
		if (!saved) this.ui.addToaster({ title: 'Table Tweaks', message: "Couldn't save the page size; it applies until this view is reopened.", dismissible: true, autoDestroyTime: 5000 });
	}
}
