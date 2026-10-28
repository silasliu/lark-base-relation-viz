# Task Dependency Graph (Base extension)

A read-only view of task dependencies and parent-child relations in a Feishu Base table, drawn with AntV G6.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## What it does

- **Views** — dagre TB (default) / dagre LR / force / circular / radial.
- **Nodes** — title, due date (red when overdue), blocking badge (`阻塞：N`, where N is the number of downstream unfinished tasks this task blocks **transitively**), **list** (blue chip) + tag chips (max 2 + `+N`); left bar red = incomplete, gray-green = done.
- **Dependency edges** — **task → prerequisite**, the arrow points at what it is waiting for. Prerequisites are laid out **above** tasks, and anchors are picked dynamically from the two nodes' actual positions. Three states: red = prerequisite unfinished (blocking), green = prerequisite done (clear to start), gray = this task is done (relation no longer actionable).
- **Parent-child edges** — parent → child, gray dashed, no arrow. **Can be turned off** in settings; when off, tasks that only have parent links no longer appear.
- **Checklist** — ready / blocked / done / all, searchable by list and tag; click to focus the node.
- **Details** — task body (description), clickable prerequisites/successors/parent/children, clickable list and tags (click to filter), web link and client link.
- **Interaction** — click to select & highlight neighbours, double-click to open TickTick, right-click to collapse/expand, wheel zoom proportional to physical distance, fit-all button.
- **Sidebar** — collapsible; on narrow screens (Feishu side panel) it moves to the bottom, collapsed as a single row and expanded to the lower half, without covering the canvas.

## Narrow containers (Feishu side panel)

| Canvas width | Node size | Sidebar |
|---|---|---|
| ≥ 560px | normal (132–240 wide) | docked right, collapsible |
| < 560px | **compact** (100–168 wide, tighter padding) | moves to the bottom, collapsed to one row |

With `minZoom: 0.2` a large graph can be zoomed out until the whole structure is visible, and "fit all" uses the same floor. At very low zoom the text is unreadable by design — that is the overview level; the status bar shows "最小缩放".

## Shipping it to other people

### 1. Register the extension (one time)

1. Open the [Feishu developer console](https://open.feishu.cn/app) and create an **enterprise app**.
2. Add capability → **Base extension** → table view.
3. Put the assigned `blockTypeID` into `block.json`.

### 2. Configure fields

Field names are **not hardcoded**. On open the plugin lists every self-referencing link field in the
current table and lets you choose.

Field direction defaults to "the field stores my prerequisites". If a table's one-way link points the
other way (it stores "my successors"), arrows flip; set the semantics to `fieldIsSuccessor` for that table.

The choice is **persisted** to the Feishu Bridge (shared per document + extension) and restored next time.

### 3. Deployment

The official way to ship a Base extension script is to **host the page yourself** and paste its URL
into the Base "add script" dialog. There is no "upload and Feishu hosts it" CLI
(`block-basekit-cli` targets automation plugins and does not apply here).

| Mode | Command | Notes |
|---|---|---|
| Development | `npm run dev` | local HTTPS server; the Feishu host must be able to reach it |
| Production | see GitHub Pages below | public static hosting, stable URL, platform-provided certificate |

**GitHub Pages (current setup)**

- Repository: [silasliu/lark-base-relation-viz](https://github.com/silasliu/lark-base-relation-viz) (public)
- URL: <https://blog.silas.fun/lark-base-relation-viz/>
- Source lives on `main`; build output lives on `gh-pages`, which Pages publishes
- To update: change code → `npm run build` → push the contents of `dist` to `gh-pages`

> `public/mock-data.json` is a snapshot exported from the real Base and is for local debugging only.
> `build.copyPublicDir: false` in `vite.config.ts` keeps it **out** of the build output, so the
> public deployment contains no real data.

## Why "open client" may do nothing

Feishu runs the extension inside a **sandboxed iframe**. Per the HTML spec, navigation to a custom
protocol (`ticktick://`) from a sandboxed iframe is **silently dropped** unless the host grants
`allow-popups` or `allow-top-navigation-to-custom-protocols` — tokens controlled by Feishu, not by
this plugin.

Therefore:

- **The web link** (`https://dida365.com/webapp/#p/...`) always works and is the primary path.
- **Open client** uses a real `<a href="ticktick://...">` (higher trust than `a.click()`); if it gets
  blocked, nothing happens — that is not a plugin bug.
- Fallback: **"复制标题"** — paste into the TickTick search box.

`@lark-base-open/js-sdk` exposes no API to open external protocols or links (all 1.0.2 exports checked).

## Debugging (plain browser)

Outside the Feishu host the SDK never resolves. The app falls back to `public/mock-data.json`
(a snapshot exported from the real Base, gitignored) so layout and interaction can be tuned in a browser.

```bash
npm run dev          # http://localhost:5173
```

## Project layout

```
feishu-plugins/dependency-graph/
├── src/
│   ├── config.ts                  # optional fields + TickTick search scheme
│   ├── types.ts                   # data structures (incl. direction semantics)
│   ├── App.tsx                    # toolbar / direction confirm / sidebar / dialog notice
│   ├── services/
│   │   ├── BaseDataService.ts     # SDK reads (with mock fallback), cell normalization
│   │   ├── ConfigStore.ts         # persisted config (table/fields/direction/layout)
│   │   └── graphBuilder.ts        # pure logic: tasks -> graph + checklist (with flipping)
│   └── components/
│       ├── DependencyGraph.tsx    # G6 graph: selection / dblclick / resize / zoom
│       ├── graphShapes.ts         # node & edge shapes, layouts, overlap separation
│       ├── nodeMetrics.ts         # node content & sizing (width-aware, same font as draw)
│       ├── ChecklistPanel.tsx     # checklist
│       └── DetailsPanel.tsx       # details
├── block.json                     # manifest (fill blockTypeID)
├── public/mock-data.json          # browser-debug snapshot (gitignored)
└── vite.config.ts
```

## Build & checks

```bash
npm run typecheck    # type check
npm run build        # output in dist/
```

## Implementation notes

1. **Node size must reach dagre** (`size: [w, h]`). Without it dagre lays out on a 40×40 grid and nodes
   overlap massively — that, not text overflow, was the real cause of the "tags overlapping" report.
2. **Edge geometry lives in `getPath` only.** G6 v4 recomputes it on item updates; a path drawn inside
   `draw` gets reverted after the first relayout.
3. **Control points follow the layout axis** — vertical for TB, horizontal for LR. Mixing them distorts
   diagonal edges badly (measured 159px deviation from the chord).
4. **The parent-edge branch must `return`**, otherwise a second dependency edge is drawn on top,
   producing "gray dashed + red/green arrow" hybrids.
5. **resize never resets zoom** — only the first load fits the graph, using the local `fitGraph` helper so G6 never receives a ratio below `minZoom`.

## Known limitations

1. Read-only.
2. Self-referencing link fields only.
3. TickTick jump is a search (no official task-id scheme); duplicate titles may take an extra click.
4. Non-HTTPS origins trigger the confirmation **every time** (see above).
5. Only the first parent value is used.
6. G6 v4; `radial`/`circular` overlaps are handled by a post-layout separation pass, which can leave
   small residue on very large graphs.

## References

- [Base extension script API](https://lark-base-team.github.io/js-sdk-docs/zh/)
- [AntV G6 v4 documentation](https://g6.antv.antgroup.com/)
- [TickTick URL Scheme](https://help.dida365.com/tasks/a/6424515668858634240)
