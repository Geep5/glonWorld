# glonWorld

Interactive 3D visualization of a **[glon](https://github.com/Geep5/glon)** environment — every object, every program, the agent's full DAG-backed conversation, and a click-to-recall affordance for memory management in 3D space.

![cosmos view](./snapshots/cosmos-final.png)
![agent view](./snapshots/agent-final.png)

## What you see

**Cosmos view** (default).  Every glon object is a 3D node, colored by type (agent, peer, program, typescript, proto, json, …). Nodes are laid out in concentric rings per type with the agent as the central star. Typed `ObjectLink` relations between objects show up as arcs:

- **Teal arcs** — generic object links (`owner`, `principal`, etc.).
- **Amber arcs** (thicker, taller arch) — subagent lineage (`spawn_parent`). Reads as parent→child trees at a glance.

**Agent stellar view**.  Click *Agent* (top right) or double-click the agent node in the cosmos and the camera flies in to the agent's own stellar view:

- The agent becomes a glowing star at the origin.
- Every block on the agent — user turn, assistant turn, `tool_use`, `tool_result`, `compaction_summary` — is placed as a small planet on a golden-ratio spiral. Inner blocks came first, outer blocks came last.
- Kind maps to a Y lane and a color (cyan = user, magenta = assistant, amber = tool_use, green = tool_result, red = tool_error, violet = compaction).
- Each `tool_use` is bridged to its matching `tool_result` by a curved arc — you can literally trace every tool dispatch the model made.
- Compaction summaries render as translucent bubbles that enclose the blocks they replaced, plus a small violet marker block at the bubble's centroid.
- Registered tools orbit as satellites on a fixed equatorial ring.

**Per-block visual state.**  Each block in the stellar view is classified and rendered accordingly:

- **In context** (block is at or after the latest compaction's `firstKeptBlockId`) — bright, fully opaque, normal emissive.
- **Compacted** (logically skipped on the next ask, but still in the DAG) — dim, ~35 % opacity, low emissive. Click anyway — the inspector shows the full content.
- **Memory-surfaced** (block is referenced by some `pinned_fact.sourced_from_block_id` or `milestone.sourced_from_blocks`) — boosted emissive plus a translucent halo sphere in the block's color so the glow is visible even on tiny blocks.

**Filter chips** (top-right, agent view).  Three toggles — `in context`, `compacted`, `memory` — union-filter visible blocks. A memory-surfaced block survives whenever the memory chip is on, regardless of its in/out-of-context state.

**Inspector** (right panel).  Shows the selected object's metadata, fields, outbound/inbound links, raw content preview, and full change DAG history. For agents it also shows tokens / turn counts / compaction state / system prompt. **For compacted blocks**, the inspector shows a `← Recall into context` button that re-injects the block as a fresh user turn (see *Memory management* below).

**Search** (top input).  Live highlight on type/name/id/scalar value as you type, plus a debounced server-side query that scans **agent block content too** — every `text`, every `tool_use` input, every compaction summary. A results panel below the input shows snippets centered on the match with `live` / `compacted` chips. Click any result to fly to the host agent and open that block in the inspector (recall button ready if it's compacted).

**Time scrubber** (bottom).  Filter out objects and blocks whose creation/timestamp is after the slider time. Replay the environment's growth.

## Memory management in 3D

The conceptual story: an LLM agent's compaction discards turns from its live context window for the next call, but **never deletes them from the DAG**. glonWorld surfaces every compacted turn as a dim planet you can still click. Two affordances let the user manage the agent's memory deliberately:

1. **Search** the raw text of every block — including compacted ones — by phrase.
2. **Click-to-recall** any compacted block: glonWorld POSTs to the running glon daemon, which appends a new `user_text` block on the agent quoting the original (`[Recalled <role> turn from <timestamp>]: …`, truncated at 8 KB). The block lands after the latest compaction's `firstKeptBlockId`, so the model sees it on the next ask.

You usually won't need to recall anything — compaction summaries cover most context — but when the agent has forgotten a specific turn the user knows is relevant, this is the escape hatch. It's still cheaper than disabling compaction, because you only pay context tokens for the one turn you chose.

## How it works

It reads `.pb` files directly from `~/.glon/changes/<object-id>/*.pb` (or `$GLON_DATA/changes/`). It reuses the glon project's own protobuf codec and DAG replay — the viz is a pure derived view over the change DAG, not a separate data source.

```
 ~/.glon/changes/                     glonWorld server (Node/Express)
 ├ <agent-id>/                    →   decodeChange()  →  computeState()
 │ ├ <hex>.pb   (Change)              ↓
 │ ├ <hex>.pb                          derive: objects, links, agent blocks,
 │ └ …                                 in_context flag, memory refs, junk + dedupe filters
 └ …                                   ↓
                                       /api/state, /api/objects/:id,
                                       /api/agents/:id/conversation, /api/search
                                       ↓
                                       three.js frontend
                                       — cosmos + stellar + inspector + filters + search panel
```

Read path has **no dependency on glon being running** — it reads the disk snapshot on demand and caches for 3 seconds.

The **recall** path (POST `/api/agents/:id/recall/:blockId`) does require the glon daemon to be running, because the new block has to be written through the agent's actor on the daemon (HTTP dispatch on `:6430` by default — see `GLON_DISPATCH_URL` below). When the daemon isn't reachable, recall returns 503 and the read-only viz still works.

### Server-side data hygiene

The reader applies two filters by default before serving any view, so noise from earlier development doesn't pollute the cosmos:

- **Junk filter** — drops objects with no `typeKey` (incomplete create) and agents whose `system` field is suspiciously short (the signature of a `/agent new X --system "…"` invocation that the shell mis-tokenized). Set `GLON_WORLD_JUNK_FILTER=0` to disable.
- **Dedupe filter** \u2014 collapses identity-duplicate peers (matching `display_name + kind + email + discord_id`) and agents (matching `name`); keeps the member with the highest `changeCount` (tie-break on `updatedAt`). Useful if `/holdfast setup` was ever run twice. Set `GLON_WORLD_DEDUPE=0` to disable.

Both filters log every drop to the server console on each cache rebuild.

## Run

```bash
# (once) install deps
npm install

# start the viz (default http://127.0.0.1:4173)
npm run dev
```

Then open http://127.0.0.1:4173 .

Requires the sibling `../Graice/glonGraice` checkout (the reader imports its proto + DAG code directly via `../../Graice/glonGraice/src/...`).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | bind host |
| `PORT` | `4173` | bind port |
| `GLON_DATA` | `~/.glon` | DAG root directory to read from |
| `GLON_DISPATCH_URL` | `http://127.0.0.1:6430/dispatch` | glon daemon HTTP dispatch endpoint (used only by the recall route) |
| `GLON_WORLD_DEDUPE` | unset (on) | set to `0` to show identity-duplicate objects raw |
| `GLON_WORLD_JUNK_FILTER` | unset (on) | set to `0` to keep malformed objects |

```bash
# point at a different glon data dir
GLON_DATA=~/.glon-peer-b npm run dev

# bind another port / host
HOST=0.0.0.0 PORT=8080 npm run dev

# show every object including duplicates and malformed ones
GLON_WORLD_DEDUPE=0 GLON_WORLD_JUNK_FILTER=0 npm run dev
```

## Interactions

| input | effect |
|-------|--------|
| `drag` | orbit camera |
| `scroll` | zoom |
| `right drag` | pan |
| `click` a node | select it; inspector shows details |
| `dbl-click` a node | focus camera on it; double-clicking the agent enters stellar view |
| `click` a block in agent view | inspector shows that block's raw content |
| `click` `← Recall into context` (compacted blocks only) | re-inject that block as a new user turn via the glon daemon |
| `Esc` / `c` | back to cosmos |
| `a` | jump to agent view |
| legend type | click a type row to mute all objects of that type |
| filter chip | toggle `in context` / `compacted` / `memory` block visibility |
| search box | live object highlight + debounced backend search over block text; results panel underneath |
| `click` a search result | fly to the host agent and open the block in the inspector |
| `Enter` in search | select best object match (or block hit if no object matches) |
| `Esc` in search | dismiss the results panel |
| time scrubber | filter to `createdAt ≤ slider-ms` |

## API

```
GET  /api/meta                                 { root, now }
GET  /api/state                                graph snapshot (objects, links, byType, timeline)
GET  /api/objects/:id                          detail + outLinks + inLinks + rawFields + contentPreview
GET  /api/objects/:id/changes                  full Change DAG (ids, parents, timestamps, ops)
GET  /api/agents/:id/conversation              classified blocks + registered tools (per block:
                                                 inContext: bool, memoryRefs: MemoryRef[])
GET  /api/search?q=…&limit=20                  free-text hits over object metadata + agent block content;
                                                 returns { query, objects, blocks } with snippets
POST /api/agents/:id/recall/:blockId           re-inject a compacted block via the glon daemon;
                                                 returns { ok, newBlockId, sourceKind, truncated }
```

## Layout

```
glonWorld/
├ server/
│ ├ index.ts        Express app + static + recall proxy + search route
│ └ reader.ts       disk scan + computeState + dedupe/junk filters + memory index
├ public/
│ ├ index.html      shell + importmap (three via /vendor) + filter chips + search panel
│ ├ style.css
│ └ js/
│   ├ main.js       scene, camera, controls, raycasting, mode switching, search panel,
│   │              recall button, filter chips
│   ├ cosmos.js     cosmos view builder (concentric rings + arcs, lineage styling)
│   ├ agent.js      agent stellar view builder (spiral + tool arcs + horizons + glow + dim)
│   ├ inspector.js  inspector panel DOM renderer
│   └ colors.js     stable type palette + block colors
└ proto                # (inherited from ../Graice/glonGraice via relative imports)
```
