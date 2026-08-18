# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm start              # http://localhost:3000
npm run dev            # same, restarts on file change
PORT=3100 npm start    # any free port; useful while another instance is running
```

Node >= 18 (relies on global `fetch`). Express is the only runtime dependency.

**There is no test suite, linter, or build step.** Do not invent one in
instructions or docs. Changes are verified by starting the server on a spare port
and exercising the endpoints with `curl` — especially the failure paths, since
almost every interesting behaviour in this codebase is a guard:

```bash
PORT=3900 node server/index.js > /tmp/dw.log 2>&1 &
curl -s -X POST http://localhost:3900/api/deploy -H "Content-Type: application/json" \
  -d '{"provider":"netlify","netlifyToken":"nfp_bad","siteName":"demo",
       "files":[{"path":"index.html","content":"aGk="}]}'
```

A bad token reaching the provider and returning `401` is a *successful* test — it
proves the request travelled the whole path and only stopped at authentication.

## What this is

A drag-and-drop tool: the user drops a folder of HTML files into a web UI, the
tool pushes it to a static host and returns a working URL.

## The constraint that shapes everything

**Render has no file-upload API.** `POST /v1/services` requires a `repo` field
pointing at a git repository. **Netlify accepts files directly.** These are not
two configurations of one flow — they are two genuinely different pipelines:

```
Netlify:  files -> sha1 digest -> upload only what Netlify lacks -> done
Render:   files -> commit to GitHub (Git Data API) -> point Render at that repo
```

Everything awkward about the Render path (needing a GitHub token, public repos,
overwrite guards) follows from that one API limitation. Netlify is the default
because it avoids all of it.

## Architecture

`server/index.js` holds two functions, `deployToNetlify` and `deployToRender`,
dispatched through a `PROVIDERS` map. Both return the same normalized shape
(`{provider, steps, siteId, deployId, siteUrl, dashboardUrl, repoUrl}`) so the
frontend never branches on provider. Adding a provider means adding a lib module,
a function returning that shape, an entry in `PROVIDERS`, and a branch in the two
`:provider` routes.

`server/lib/` holds one module per external API plus two shared concerns:

- `validate.js` — normalizes uploaded files before anything touches a network.
  Filtering is a **denylist**, not an allowlist: source trees carry every
  extension imaginable, and an allowlist silently swallows the user's files.
  Widening it that way raises the stakes on secrets, so `.env`, `id_rsa`,
  `.pem`/`.key` and friends are blocked outright and reported as a distinct
  category — publishing a private key to a public site is a different kind of
  mistake from shipping a `.exe` that will not run.
- `reachability.js` — provider-agnostic "can a stranger actually see this?"

**Files travel as base64 inside one JSON body.** The browser reads them with the
File API (recursively walking dropped directories via `webkitGetAsEntry`), so
there is no multipart parser and no zip library anywhere. `express.json` is
raised to 40mb because base64 inflates ~33%. Zip files are not supported.

## Conventions that are load-bearing

**Guards run before mutations, and report together.** The pattern in
`deployToRender` collects every blocker into an array, then throws once with
`error.detail = blockers` so the UI can list them as separate lines. The user
fixes everything in one round trip instead of discovering problems one at a time.
Guards are positioned so that when they trip, nothing has been written yet.

**Destructive-by-design, guarded-by-default.** `github.commitFiles` deliberately
omits `base_tree`, so each deploy fully replaces the repo tree — that is what
makes locally-deleted files disappear from the site. The cost is that pointing at
an existing repo destroys its contents. Same for reusing a Netlify site. Both
require explicit `overwriteExisting` opt-in. Never relax these guards to make a
flow smoother.

**Anything that publishes user content needs explicit opt-in.** `makeRepoPublic`
only runs when the request says so. Do not add convenience defaults here.

**Provider status is not ground truth.** `ready` / `live` means the deploy
finished, not that a visitor can see the page — Netlify has made new projects
private by default since 2026-07-28, so a site can sit at `ready` while returning
401 to everyone. `reachability.js` fetches the URL *without credentials* to find
out. When that check itself fails it reports `checked: false`, which the UI shows
as "chưa rõ". Never collapse "unknown" into "public".

**Credentials are per-request.** Keys arrive in the request body (deploy) or the
`x-provider-key` header (status, listing), fall back to env vars, and are never
persisted server-side or logged. The error middleware deliberately logs only
`error.message` for 5xx.

**The client's copy of state is a hint, never a decision.** The UI warns about
name collisions using its loaded site list, but the server re-checks against the
provider. Client-side lists can be stale or absent.

**Nothing is cached locally.** Site lists are read from the provider on every
request, so a site deleted in the provider's dashboard vanishes here immediately
rather than lingering as a stale entry needing reconciliation.

## Frontend

`web/app.js` is a single vanilla-JS IIFE in ES5 style (`var`, `function`) with no
build step — keep it that way. Provider-specific UI blocks are marked
`data-provider="netlify|render"` and toggled by `syncProviderUi()`; the two source
input modes use `data-mode-panel="drop|paste"` and `setMode()`.

`collectFiles()` is the seam between those modes — both return the same
`[{path, content}]` shape with base64 content, so nothing downstream of it knows
whether the user dropped a folder or pasted into the editor.

The preview iframe runs `sandbox="allow-scripts"` **without** `allow-same-origin`,
which puts it in an opaque origin. That combination is deliberate and must not be
loosened: pasted HTML is untrusted code, and API keys live in the `localStorage`
of this origin. Granting same-origin would hand them over. `closeModal()` clears
`srcdoc` so scripts in a preview stop running once it is closed.

`web/formatter.js` is a hand-written HTML indenter (loaded before `app.js`, exposed
as `window.DW.formatHtml`) rather than a dependency, to preserve the no-build-step
rule. It pulls `pre`/`textarea`/`script`/`style` bodies out behind plain-ASCII
tokens before indenting, because whitespace in those elements is either visible or
load-bearing. Those tokens are uppercase ASCII on purpose: earlier versions used
control characters and tooling silently corrupted the file.

Regexes for control characters and combining marks use explicit `\uXXXX` escapes
(`validate.js`, `app.js`). This is deliberate: literal characters in those ranges
have been silently corrupted by tooling before. Keep the escaped form.

## Language

Code comments, UI copy, error messages and README are **Vietnamese**. Commit
messages are English. Match the surrounding file.

Comments explain *why*, especially for third-party quirks and dates
(`2026-07-28`, `draft: false`, missing `base_tree`). Those notes exist because the
behaviour is surprising and undocumented — preserve them when editing nearby.

## Verified provider facts

Do not re-derive these from memory; they were confirmed against live APIs and
current docs, and some post-date model training data:

- Render's create-service API requires `repo`; there is no upload endpoint.
- Render cannot fetch private repos unless the Render GitHub App is installed
  (`github.com/apps/render/installations/new`) — a browser-only, one-time step
  that cannot be automated.
- Netlify deploys are production unless `draft: true`; the code passes
  `draft: false` explicitly.
- Netlify's public OpenAPI spec exposes **no** field for project visibility, so
  private-by-default cannot be flipped through the API.

When a question turns on a third-party service's current behaviour, look it up
rather than answering from memory.
