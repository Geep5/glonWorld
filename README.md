# glonAstrolabe

Live 3D dashboard for a **[glon](https://github.com/Geep5/glon)** environment. Every object is a planet; every change write lights it up.

![Cosmos with live log, AI jobs panel, and inject button](./snapshots/hero.png)

<details>
<summary>more screenshots</summary>

![idle cosmos with the AI Jobs panel and the activity heat strip](./snapshots/cosmos.png)

![SSE event log open, streaming tool calls](./snapshots/livelog.png)

</details>

## What you see

**The cosmos.** Every glon object is a node on a per-type ring, colored by type (agent, peer, program, `chain.token`, `chain.coin.bucket`, pinned_fact, milestone, …). Links render as quadratic-Bezier arcs. Nodes drift on sin-waves so the scene feels alive.

**Activity heat.** Every object decays heat as `exp(-Δt / 30s)` from `lastSeen`. Heat drives emissive intensity, halo opacity, and scale pulse.

**In-context halo.** Objects referenced by the active agent's current context window get a persistent halo + 18% scale boost.

**Cursor magnet.** Balls within ~4.5 world units of the cursor slide toward it.

**Live event log** (bottom-left). SSE-tail of `~/.glon/changes/`. Every `.pb` file becomes one row per op. Click a row to inspect that object.

**AI jobs panel.** One row per agent with a context-window fill bar. Plus reminders in the last 24h (pending / sent / failed / cancelled).

**Crypto panel.** Lists `chain.token` objects (name, symbol, holders, supply) and `chain.coin.bucket` objects (coin count, unspent, supply). Click to inspect.

**Inspector** (right panel). Object metadata, fields, links, raw content, change DAG. For agents: model, turns, compaction state, system prompt.
- **`→ Inject into context`** — posts a reference via `/agent ask` so the agent's next turn sees it.
- **`← Recall into context`** — re-injects a compacted block via `/agent recall`.

**Search** (top). Live highlight on type/name/id/scalar, plus server-side block-text search with `live`/`compacted` chips.

**Time scrubber** (bottom). Filter to `createdAt ≤ slider` and replay growth.

## How it works

```
~/.glon/changes/                  glonAstrolabe server (Node / Express)
├ <object-id>/                →   decodeChange() → computeState()
│ ├ <hex>.pb   (Change)            ↓
│ ├ <hex>.pb                       derive: VizObject + agentStats + outLinks + tokenState + coinState
│ └ …                              ↓
└ …                                /api/state, /api/objects/:id, /api/agents/:id/conversation,
                                   /api/agents/:id/context, /api/tokens, /api/coins,
                                   /api/search, /api/events (SSE)
                                   ↓
                                   three.js frontend
```

Read path has **no dependency on glon running** — it reads the disk snapshot on demand and caches for 3s. The SSE watcher (`fs.watch` recursive on the changes dir) tails new `.pb` files as they land.

Mutation paths (`recall`, `inject`) proxy to the glon daemon at `GLON_DISPATCH_URL`. If the daemon isn't reachable, calls return 503 and the read-only viz still works.

### Server-side filters

- **Junk filter** — drops objects with no `typeKey` and agents with a truncated `system` field. Set `GLON_ASTROLABE_JUNK_FILTER=0` to disable.
- **Dedupe filter** — collapses identity-duplicate peers and agents. Keeps the highest `changeCount`. Set `GLON_ASTROLABE_DEDUPE=0` to disable.

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:4173
```

The reader imports proto + DAG code from `../../../3/glon/src/` (hardcoded relative path). Make sure that checkout exists.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | bind host |
| `PORT` | `4173` | bind port |
| `GLON_DATA` | `~/.glon` | DAG root directory to read from |
| `GLON_DISPATCH_URL` | `http://127.0.0.1:6430/dispatch` | glon daemon HTTP dispatch |
| `GLON_ASTROLABE_DEDUPE` | unset (on) | set to `0` to disable dedupe |
| `GLON_ASTROLABE_JUNK_FILTER` | unset (on) | set to `0` to disable junk filter |

```bash
GLON_DATA=~/.glon-peer-b npm run dev               # different DAG root
HOST=0.0.0.0 PORT=8080 npm run dev                  # bind elsewhere
GLON_ASTROLABE_DEDUPE=0 GLON_ASTROLABE_JUNK_FILTER=0 npm run dev   # raw mode
```

## Interactions

| input | effect |
|---|---|
| `drag` | orbit |
| `scroll` | zoom |
| `right drag` | pan |
| `click` a ball | select; inspector shows details |
| `dbl-click` a ball | focus camera on it |
| `click` an event row | select the object that emitted it |
| `click` an AI Jobs row | select that agent or reminder |
| `Esc` | clear selection |
| legend type | click a type row to mute all objects of that type |
| search box | live highlight + backend search over block text |
| `click` a search result | fly to host agent + open block in inspector |
| `Enter` in search | select best object match |
| `Esc` in search | dismiss results |
| time scrubber | filter to `createdAt ≤ slider-ms` |

## API

```
GET  /api/meta                                 { root, now }
GET  /api/state                                graph snapshot (objects, links, byType, timeline)
GET  /api/objects/:id                          detail + outLinks + inLinks + rawFields + contentPreview + tokenState + coinState
GET  /api/objects/:id/changes                  full Change DAG
GET  /api/agents/:id/conversation              classified blocks + registered tools
GET  /api/agents/:id/context                   { agentId, agentName, objectIds }
GET  /api/tokens                               all chain.token objects with derived state
GET  /api/coins                                all chain.coin.bucket objects with derived coin state
GET  /api/search?q=…&limit=20                  free-text hits over metadata + agent block content
GET  /api/events                               SSE stream (replays last ~50, then live)
GET  /api/events/recent                        last ≤200 events as JSON
POST /api/agents/:id/recall/:blockId           re-inject a compacted block via glon daemon
POST /api/agents/:agentId/inject/:objectId     post a user_text reference into agent context
```

## Layout

```
glonAstrolabe/
├ server/
│ ├ index.ts     Express + static + SSE + API routes
│ ├ reader.ts    disk scan + computeState + dedupe/junk + context refs
│ ├ events.ts    fs.watch + op summarizer + SSE bus
│ └ coins.ts     read-only coin replay for chain.coin.bucket
├ public/
│ ├ index.html   shell + importmap + panels
│ ├ style.css
│ └ js/
│   ├ main.js     scene, camera, controls, raycasting, jobs/crypto/search panels
│   ├ cosmos.js   ball layout, drift, magnet, heat, halo, link tubes
│   ├ inspector.js inspector DOM + recall + inject buttons
│   ├ livelog.js  SSE client + console row renderer
│   └ colors.js   stable type palette + block colors
└ snapshots/     screenshots
```

No compile step on the frontend — `index.html` uses an importmap to resolve `three` from `node_modules`.
