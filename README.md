# PBE Terminal (terminal.propbetedge.ai)

All Access, read-only market intelligence workspace. Vercel project `pbe-terminal`, Git-connected: `main` deploys to production.

- **Data:** Terminal composes Compare (`compare.propbetedge.ai/api/{desk,event,series,live}`) behind its own fail-closed
  membership check (`api/_lib/access.js`). It owns no market reader, matcher or model. Compare owns contract pairing and
  rule parity; Predictions owns models (surfaced only through the desk's `pbe` field).
- **core.js** is vendored from `LHBUSA/predictions compare/core.js` (pinned SHA in its header). Re-vendor, do not fork.
- **Workspace sync (LHBUSA/terminal#3):** watchlist + pins persist per All Access account via `api/workspace.js` →
  auth Worker `propbetedge-auth-magic` v2.12 `GET/PUT /terminal/workspace` → identity Supabase `pbe_terminal_workspaces`
  (HMAC account key, revision compare-and-swap). `sync.js` keeps taps as operations and replays them on 409; local
  storage holds ids only, namespaced per account; pre-sync device saves are merged once. No email in or out.
- **Access:** guest 401, signed-in without All Access 403, authority unreachable 503 + Retry-After. Owner and all_access only.
- **Tests:** `npm test` (node --test). Must exit 0 before merge.
- **Rollback:** promote the previous production deployment in Vercel (`vercel promote <dpl>` / dashboard "Instant Rollback").
