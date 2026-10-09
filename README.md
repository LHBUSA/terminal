# PBE Terminal (terminal.propbetedge.ai)

All Access, read-only market intelligence workspace. Vercel project `pbe-terminal`, Git-connected: `main` deploys to production.

- **Data:** Terminal composes Compare (`compare.propbetedge.ai/api/{desk,event,series,live}`) behind its own fail-closed
  membership check (`api/_lib/access.js`). It owns no market reader, matcher or model. Compare owns contract pairing and
  rule parity; Predictions owns models (surfaced only through the desk's `pbe` field).
- **core.js** is vendored from `LHBUSA/predictions compare/core.js` (pinned SHA in its header). Re-vendor, do not fork.
- **Access:** guest 401, signed-in without All Access 403, authority unreachable 503 + Retry-After. Owner and all_access only.
- **Tests:** `npm test` (node --test). Must exit 0 before merge.
- **Rollback:** promote the previous production deployment in Vercel (`vercel promote <dpl>` / dashboard "Instant Rollback").
