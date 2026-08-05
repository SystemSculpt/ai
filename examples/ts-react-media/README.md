# TanStack AI Visual (`ts-react-media`)

Image and video generation demos for TanStack AI, including **BytePlus Seedance**.

## Routes

| Path | What it is |
| --- | --- |
| `/` | Visual Content Generator — Image, Video, Omni Studio, and Seedance Studio tabs |
| `/seedance`, `/seedance-chat` | Redirect to `/` (old bookmarks) |

## Seedance Studio tab (prompt → clip → continue)

Same tab pattern as **Omni Studio** under Visual Content Generator. Always
start with a prompt; each clip is a turn; the next prompt continues from a
selected clip.

| Continue action | What it does |
| --- | --- |
| **Remix** (default) | Prior clip as `@Video1` reference video + new instruction |
| **Extend** | Prior last frame as first frame + “what happens next” |
| **Start a new shot** | Clears the parent; fresh text / frames / references |

Reference mode accepts **image, video, and audio** uploads (not images only).
Templates stay collapsed under the prompt. `/seedance-chat` redirects here.

## Generation persistence

Both **Seedance Studio** and **Seedance Chat** wire
`withGenerationPersistence` so finished clips outlive Ark’s ~24h URL expiry:

| Piece | Role |
| --- | --- |
| `lib/generation-persistence.ts` | sqlite (`./.data/generation.db`) + `artifactUrl` → `/api/artifacts` |
| `lib/sqlite-persistence.ts` | Same `node:sqlite` backend as `ts-react-chat` |
| `routes/api.artifacts.ts` | Serves stored bytes (Range-aware for `<video>` seeking) |
| Studio `useGenerateVideo` | `persistence: true` + hydrate/join server fns |
| Chat tools | Each clip is filed under `seedance-chat:<clipId>`; tool `videoUrl` is the durable serve path |

Reload the Studio mid-job (or after it finishes) and the last run for
`seedance-studio` is restored. Chat tool results already embed durable URLs, so
the version stack keeps playing after the provider link would have died.

Clips live on disk under `.data/` (gitignored), so they survive Vite HMR, a
dev-server restart, and a page reload — which matters when a Seedance job takes
several minutes.

### Env

```bash
# Required for Seedance video jobs
export ARK_API_KEY=...

# Preferred for the chat agent (tool calling). Falls back to BytePlus Seed
# chat on ARK_API_KEY if OpenAI is not set.
export OPENAI_API_KEY=...
```

### Run

From the monorepo root (after `pnpm install` and a package build):

```bash
cd examples/ts-react-media
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and choose the **Seedance Studio** tab.

> Seedance jobs often take several minutes (up to a 30‑minute poll ceiling).
