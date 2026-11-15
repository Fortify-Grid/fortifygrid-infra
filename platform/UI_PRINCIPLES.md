# UI principles: one behaviour in every FortifyGrid app

Website, Planner, IDE, RAG apps (heatmap, query) and Revenue analysis all look and behave the same way. Do not build
your own tabs, tables, filters or folding cards: use the kit. Live reference: https://fortifygrid.com/platform/v1/demo.html

```html
<link rel="stylesheet" href="https://fortifygrid.com/platform/v1/fg-ui.css">
<script src="https://fortifygrid.com/platform/v1/fg-ui.js"></script>   <!-- window.FG; apps under app.fortifygrid.com may use /platform/v1/… -->
<script>FG.configure({ app: '<app id>', user: '<signed-in email>' });</script>
```
Planner's look is the standard (it came first). Class names all start with `fg-`, so the kit never clashes with an app's CSS.

## 1. Shell: same frame everywhere, so moving between apps feels like one product
```
┌──────────────┬─────────────────────────────────────────────┐
│ [icon] App   │  Page title  (pill)             [+ Add]     │  .fg-top
│ Apps ▾       │  search · chips · toggles   12 of 80 · Reset │  .fg-bar (sticky)
│ Section      │  ┌─────────────────────────────────────────┐ │
│ Section      │  │ table / cards / sections                │ │
│ CHANNELS     │  └─────────────────────────────────────────┘ │
│ # Work       │                                             │
│ # Family     │                                             │
│ you@…        │                                             │
│ ← All apps   │                                             │
│ Sign out     │                                             │
└──────────────┴─────────────────────────────────────────────┘
```
- `FG.shell(aside, {...})`. **Brand** (top-left) = this app's home. **Apps ▾** directly under it, in every app: first
  entry **⌂ Home: all apps** (the portal tiles, which list only what you may open), then every app (`FG.APPS`, one list).
- **Sections** (the app's tabs) under Apps; **channels** (workstreams, projects, customers…) under a small heading.
- Foot: who you are, ← All apps, Sign out. Nothing else in the sidebar.
- Phone (≤ 720 px): the sidebar becomes a top bar with sideways-scrolling sections and channels; foot hidden.

## 2. Sections and channels
- Click to open. **Drag** to reorder; the order is saved per person per browser. The app's default order applies until you drag.
- A section your role does not allow stays **visible but greyed** ("ask an admin"), so people learn what exists.
  Admin-only tools (e.g. code docs) are **hidden** instead. The server always checks the role; hiding is convenience.
- Mark each panel `data-tab="<id>"` and register the tab in the portal (INFRA.md → Tabs).

## 3. Tables (`FG.table`)
- First column: tick box (when rows can be acted on) or row number. Tick-all ticks only the rows shown.
- **Click a header** to sort (▲ ▼, click again to flip). **Drag a header** to move the column. **Drag a header's edge**
  to resize. **Double-click an edge** to reset widths and order. ⓘ in a header explains the column.
- **Filter row** under the headers: a dropdown of the column's values (`f`), or a "Filter…" box for text (`text`).
- Row tint: complete = light green (`done`), overdue = light red (`late`). Row click opens the item when it has a page.
- Ticked rows show a **selection bar** ("3 selected · Edit selected · Copy list · Clear").
- Long lists without groups page: ◀ Prev · 26–50 of 80 · Next ▶ · 25 / 50 / 100 (remembered).
- Phone: add `cards: true` and the rows become cards (label: value), filters stay on top.
- Everything above (order, widths, sort, column filters, folded groups) is saved per person per browser.

## 4. Groups and subtables
- **Groups** (`group`): rows under a header row "▾ Work 10". Click ▾ to fold; drag the header row to reorder groups.
- **Subtables** (`sub`): a row with children shows ▸ in its first cell; click to open the nested table under it.
  Nested tables follow the same rules. Opening never navigates.

## 5. Folding cards (`FG.sections`)
- Page parts that are not one list are cards: ⠿ handle · ▾ · title · optional buttons at the right.
- **Click the title bar** to fold; **drag ⠿** to move; **double-click ⠿** to reset the page. Saved per person per browser.

## 6. Filters (`FG.filters`)
- One bar above the list, left to right: search box · chips (one choice, e.g. All / Overdue / Next 2 weeks) ·
  toggles (☑ Open only) · then "**12 of 80 shown**" · **Reset filters** (only when something is changed) · page buttons.
- Kept in the **URL** (a copied link shows the same view) and remembered per person; the URL wins.

## 7. Words, feedback, safety
- Plain words. Help in ⓘ, not paragraphs. Empty list: one sentence and the next step.
- Messages: `.fg-msg` (amber), `.fg-msg.err` (red), `.fg-msg.ok` (green), at the top of the work area.
- Deleting asks first, listing what goes; permanent or large deletes also ask to type DELETE.
- Buttons: `.fg-btn` (main), `.ghost`, `.danger`, `.small`. One main button per page, top right.

## 8. Changing the kit
- Edit `public/platform/v1/` in fortifygrid-infra, check the demo page, run `npm run check`, update this file.
- v1 stays backward compatible (apps load it live, cached 5 minutes). A breaking change goes in `v2/`; apps move one by one.
