/// <reference path="./sdk/types.d.ts" />
/**
 * Table Tweaks — fixes for Thymer's NATIVE table view, applied to every table
 * in the workspace:
 *
 * - Rows per page, per view: the view's `opts.page_size` (0 = all rows), set
 *   from a select in the pager (presets, All rows, Custom…) or the command
 *   palette while the table is focused. Native hard-codes 75. The pager's
 *   Previous / Next tooltips name the page-turn keys.
 * - A pinned header that doesn't wobble while scrolling.
 * - ⌥← / ⌥→ turn the page (rebindable as `plugin.table_prev_page` /
 *   `plugin.table_next_page`), and the status bar names the page.
 * - Focusing the page's last row scrolls the pager into view too.
 *
 * None of this is SDK. The table is an app component (`hD`, a subclass of the
 * records-view base `Hn`) reached through `window.g_focusedComponent`; each
 * table instance gets own-property overrides of a few methods, deleted on
 * unload. Nothing is patched on a prototype and no Thymer node is rebuilt.
 * The names are internal and partly minified, so `INTERNALS` lists them and a
 * table missing any gets no tweaks and a toast instead.
 */

/** The leading options column's field id (the bundle's `Yt`). */
const OPTIONS_COL = ':first_col';

/** Page size presets offered in the palette; 0 = all rows. 75 is native's (`jC`). */
const PAGE_SIZES = [25, 50, 75, 100, 200, 0];
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
		'applyHeaderStickiness', 'isPhoneTableView', 'ensureFocusInView', 'onKeyboardNavigation', 'startFocus',
		'addPropertyColumn', 'getPeekStatusBarContext'],
	pagination: ['setPaginationDetails', 'requestPage', 'getPaginationNodes', 'refresh']
};

/** The tweaked methods, all own properties on the table instance. */
const PATCHED = ['Ue', 'Ot', 'handleCommandPaletteContextOption', 'updateStatusBarNumberOfItems', 'applyHeaderStickiness',
	'ensureFocusInView', 'onKeyboardNavigation'];

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Default page-turn keys. The app's shortcut parser accepts any `plugin.*`
 * action name, so users rebind these in Change Keyboard Shortcuts like the
 * app's own. The same names as plugins/table-view, so one binding serves both.
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

/** A native table component: its node is the `.table-view` and it pages. */
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
	const n = t.options.viewConfig.opts?.page_size;
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** True while the table shows more than one page. */
function isPaged(t) {
	return t.pagination.nrItemsPerPage > 0 && t.pagination.nrAvailablePages > 1;
}

export class Plugin extends AppPlugin {

	onLoad() {
		/** @type {Set<any>} every table instance currently tweaked */
		this.tables = new Set();
		/** @type {WeakMap<any, Animation>} each table's pinned-header scroll animation */
		this.stickyAnims = new WeakMap();
		/** problems already reported this load, so each warns once */
		this.reported = new Set();

		// A table is built whole in its constructor (the native page size is set
		// there too, `setInitView`) and paints a frame later, so catching its
		// node's insertion — a microtask — tweaks it before its first paint.
		this.observer = new MutationObserver((records) => {
			for (const r of records) {
				for (const n of r.addedNodes) {
					if (n.nodeType === 1 && (n.classList.contains('table-view') || n.querySelector('.table-view'))) {
						this.scan();
						return;
					}
				}
			}
		});
		this.observer.observe(document.body, { childList: true, subtree: true });
		this.scan();
	}

	onUnload() {
		this.observer?.disconnect();
		for (const t of this.tables) this.untweak(t);
		this.tables.clear();
	}

	/** Tweak every native table not tweaked yet; forget destroyed ones. */
	scan() {
		for (const t of this.tables) if (t._destroyed) this.tables.delete(t);
		const root = appRoot();
		if (!root) return;
		const stack = [root];
		while (stack.length) {
			const c = stack.pop();
			if (isNativeTable(c) && !c._destroyed && !this.tables.has(c)) this.tweak(c);
			for (const child of c.children || []) stack.push(child);
		}
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

	tweak(t) {
		const missing = missingInternals(t);
		if (missing.length) {
			this.reportInternals(missing);
			return;
		}
		this.tables.add(t);
		const plugin = this;
		const base = Object.getPrototypeOf(t);
		const pager = t.pagination;
		const pagerBase = Object.getPrototypeOf(pager).setPaginationDetails;

		// --- rows per page ------------------------------------------------------
		// Native passes its constant (`jC`) here once, in `setInitView`; every
		// other caller passes null for the size. The view's own size wins.
		pager.setPaginationDetails = function (n, size, page) {
			return pagerBase.call(this, n, size === null ? null : pageSizeOf(t, size), page);
		};
		pager.setPaginationDetails(null, NATIVE_PAGE_SIZE, null);

		// The pager redraws from `getPaginationNodes` (fresh nodes, inserted by
		// its `_refresh`), so the size select and key tooltips are added to
		// those nodes before Thymer inserts them — nothing already on the page
		// is touched, and every redraw carries them.
		const pagerNodesBase = Object.getPrototypeOf(pager).getPaginationNodes;
		pager.getPaginationNodes = function () {
			return plugin.pagerNodes(t, pagerNodesBase.call(this));
		};
		pager.refresh();

		t.Ot = function (palette) {
			base.Ot.call(this, palette);
			const current = this.pagination.nrItemsPerPage;
			palette.addStaticOptions(PAGE_SIZES.filter(n => n !== current).map(n => ({
				value: PALETTE_ACTION,
				label: n ? `Show ${n} Rows per Page` : 'Show All Rows',
				icon: 'ti-list-numbers',
				json: { size: n }
			})));
		};
		t.handleCommandPaletteContextOption = function (palette, option, ...rest) {
			if (option.value === PALETTE_ACTION && Number.isInteger(option.json?.size)) {
				plugin.setPageSize(this, option.json.size);
				return true;
			}
			return base.handleCommandPaletteContextOption.call(this, palette, option, ...rest);
		};

		// --- page indicator + page-turn keys ------------------------------------
		// The pager sits below the rows, often off screen while the keyboard turns
		// pages, so the status bar's item count names the page too. Forgetting the
		// cached count makes the next view's count repaint the label. The page
		// count is only known after a refresh, while the shortcuts (`Ue`) paint
		// on focus, so they repaint whenever the table starts or stops paging.
		let wasPaged = false;
		t.updateStatusBarNumberOfItems = function (n = null) {
			base.updateStatusBarNumberOfItems.call(this, n);
			if (isPaged(this) !== wasPaged) {
				wasPaged = !wasPaged;
				if (window.g_focusedComponent === this) this.ue();
			}
			const label = this.statusBar?.lineStatusItem;
			if (!isPaged(this) || typeof label?.setLabel !== 'function' || this._?.()?.panelHasFocusState?.() === false) return;
			label.setLabel(`${(n ?? this.cachedAllItems?.size ?? 0).toLocaleString()} items · Page ${this.pagination.currentPageNr + 1} of ${this.pagination.nrAvailablePages}`);
			this.statusBar.prevNrItems = null;
		};
		t.Ue = function () {
			const context = base.Ue.call(this);
			if (!context?.skipDefaultShortcuts || !isPaged(this) || this.getPeekStatusBarContext()) return context;
			const keys = pageKeys();
			const bound = [keys['plugin.table_prev_page'], keys['plugin.table_next_page']].filter(Boolean);
			if (bound.length) context.shortcuts.push({ kbd: bound.map(kbdLabel).join(' '), command: 'Page', extraClass: 'statusbar--kbd-modifier' });
			return context;
		};
		t.onKeyboardNavigation = function (e) {
			if (!this.focusState.isEditing && !this.inMoveMode) {
				const k = keyName(e);
				const keys = pageKeys();
				if (k && (k === keys['plugin.table_prev_page'] || k === keys['plugin.table_next_page'])) {
					if (plugin.turnPage(this, k === keys['plugin.table_next_page'] ? 1 : -1)) e.preventDefault();
					return;
				}
			}
			return base.onKeyboardNavigation.call(this, e);
		};

		// --- pager reveal --------------------------------------------------------
		// Not native: on the page's last row, scroll the pager below it into view
		// too, so its "Showing a–b of n" is on screen before the next page.
		// Native's rule alone leaves it hidden whenever that row was already in
		// view. The row still keeps native's 80px top clearance.
		t.ensureFocusInView = function () {
			base.ensureFocusInView.call(this);
			const row = this.focusState.row;
			const scroller = this.verticalScrollNode;
			const $pager = this.pagination.node;
			if (!row || !scroller || !isPaged(this) || !$pager?.isConnected || this.cachedRowItemsInView.at(-1)?.guid !== row.guid) return;
			const cell = this.$(`.table-view-row[data-guid="${CSS.escape(row.guid)}"]`);
			if (!cell) return;
			const v = scroller.getBoundingClientRect();
			const top = scroller.scrollTop;
			const showsPager = top + $pager.getBoundingClientRect().bottom - v.bottom;
			const clearsTop = top + cell.getBoundingClientRect().top - v.top - 80;
			const to = Math.min(Math.max(top, showsPager), clearsTop);
			if (Math.abs(to - top) >= 1) scroller.scrollTo({ top: to, behavior: Math.abs(to - top) > 500 ? 'auto' : 'smooth' });
		};

		// --- pinned header ---------------------------------------------------------
		// Native rewrites the pinned header's `top` (scrollTop - offset + 30) on
		// every scroll event, which lands a frame after the compositor has
		// scrolled: the header rides along for that frame and snaps back. Here
		// `top` keeps only the static part and a ScrollTimeline translateY adds
		// scrollTop, which the compositor applies in the same frame (a WAAPI
		// animation, so the app's reduced-motion `animation: none` rule doesn't
		// cancel it). Its range runs 1:1 in px, see STICKY_RANGE.
		t.applyHeaderStickiness = function () {
			base.applyHeaderStickiness.call(this);
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
			if (anim?.effect?.target !== $header) {
				anim?.cancel();
				anim = $header.animate(
					[{ transform: 'translateY(0px)' }, { transform: `translateY(${STICKY_RANGE}px)` }],
					{ timeline: new ScrollTimeline({ source: scroller, axis: 'block' }), rangeStart: '0px', rangeEnd: `${STICKY_RANGE}px`, fill: 'both', easing: 'linear' }
				);
				plugin.stickyAnims.set(this, anim);
			}
		};

		t.applyHeaderStickiness();
		t.refresh();
		t.ue();
	}

	untweak(t) {
		for (const name of PATCHED) delete t[name];
		delete t.pagination.setPaginationDetails;
		delete t.pagination.getPaginationNodes;
		this.stickyAnims.get(t)?.cancel();
		this.stickyAnims.delete(t);
		if (t._destroyed) return;
		t.pagination.setPaginationDetails(null, NATIVE_PAGE_SIZE, null);
		t.pagination.refresh();
		t.applyHeaderStickiness();
		t.refresh();
		t.ue();
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
		const select = el(`<dropdown-select class='pagination-size-select button-small button-minimal button-minimal-hover' placeholder='Page size'>
				${sizes.map(n => `<dropdown-option data-value='${n}' ${n === size ? 'selected' : ''}>${n} per page</dropdown-option>`).join('')}
				<dropdown-option data-value='0' ${size ? '' : 'selected'}>All rows</dropdown-option>
				<dropdown-option data-divider></dropdown-option>
				<dropdown-option data-value='custom'>Custom…</dropdown-option>
			</dropdown-select>`);
		// Its `change` doesn't bubble.
		select.addEventListener('change', (/** @type {any} */ e) => {
			if (e.detail.value === 'custom') this.customPageSize(t, select);
			else this.setPageSize(t, Number(e.detail.value));
		});
		controls.prepend(select);

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

	/** "Custom…": a number field in place of the size select; Enter saves, Escape or leaving it cancels. */
	customPageSize(t, select) {
		const input = /** @type {HTMLInputElement} */ (el(`<input type='number' min='1' step='1' class='pagination-size-input' placeholder='Rows per page' style='width: 110px'>`));
		if (t.pagination.nrItemsPerPage) input.value = String(t.pagination.nrItemsPerPage);
		const cancel = () => t.pagination.refresh();
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') cancel();
			if (e.key !== 'Enter') return;
			const n = Number(input.value);
			if (Number.isInteger(n) && n > 0) this.setPageSize(t, n);
		});
		input.addEventListener('blur', () => { if (input.isConnected) cancel(); });
		select.dropdown?.destroy?.();
		select.replaceWith(input);
		input.focus();
		input.select();
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
