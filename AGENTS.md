# AGENTS.md

Release checklist for `cortico-world-bili-live-reminder`, a Cortico World extension. How to write one:
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) and
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).
`pnpm describe:extension <dir>` and `pnpm check:extension <dir>` run from the root of a Cortico
checkout; `<dir>` is this package's directory.

Run `corepack pnpm typecheck` and `corepack pnpm test` in this directory. `pnpm test` builds the
WebUI panel first. After changing tools, event types or the env prompt, run `corepack pnpm describe`
to regenerate `describe.json`.

- [ ] **Contract version**: `cortico.api` is `6`, the current World contract.
- [ ] **Self-description**: `cortico.describe` points to `describe.json`; `tests/world.test.ts`
  compares it with the code and `ENV_PROMPT.md` and it must match exactly.
- [ ] **Tags**: `cortico.tags` lists `streaming` (plain) only. No notice or warning tag applies:
  the extension reads only public live status and does not put third-party text into an `internal`
  event.
- [ ] **CHANGELOG.md** has a `## 0.2.6` section for the version being published.
- [ ] **`os`**: omitted; the package is pure Node plus a browser panel and runs on every platform
  Coopanion supports.
- [ ] **WebUI panel**: `src/webui/client.ts` declares the `subscriptions` panel; `dist/webui.js` is
  rebuilt with `corepack pnpm build:webui`, `cortico.webUiClient` points to it, and `files` ships
  `dist`. The panel only calls `ctx.invoke('subscriptions', ...)`; it does not read config or call
  `/api/` directly.
- [ ] **Privacy**: no key anywhere; no cookie, SESSDATA or browser data; no user files read or
  written; no `dataDir` writes. The only network host is `api.live.bilibili.com`, and only public
  UIDs are sent. Streamer names, titles and areas arrive as `external` events.
- [ ] **Requests to the maintainers** (tag changes, certification, a replacement package, appeals)
  are issues in [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions).
