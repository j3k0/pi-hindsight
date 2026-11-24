# status-gc — invalidate status memories about closed issues (FOV-2948)

Invalidates Hindsight facts that are status snapshots ("FOV-972 still open", "stays in_review
with JC") about exactly one Multica issue that is now `done`, `cancelled` or `released`.
Invalidation is Hindsight's reversible curation state: the fact moves to the archive, drops out
of recall, and the observations built on it are rebuilt from their other sources.

## Rule

1. Only world/experience facts (observations can't be curated; they follow their sources).
2. The text names exactly one issue: `FOV-123` / `FOV-123a`, a full issue UUID, or an `01a…`
   prefix that matches one issue. `MUL-…`, unknown numbers and ambiguous prefixes are reported
   as unresolvable; two or more refs are skipped. A letter suffix (`FOV-2735a`) is a decision
   page revision on that issue, not a sub-issue, so it is judged by the issue itself. A short
   prefix counts only right after "issue"/"multica"; a bare prefix that matches an issue makes
   the fact unresolvable (it may be a task or comment id from the same minute).
3. Issue not closed → skipped, no LLM call.
4. Two LLM passes (`deepseek-flash` via the LiteLLM gateway): first `pending` / `mixed` /
   `other`; then every `pending` gets a stricter "now false and nothing worth keeping?"
   question. Invalidated only when both agree. Labels are cached by prompt+issue+text.
5. `--apply` re-reads each fact before the PATCH and skips it if it changed.

## Run

```
set -a; . /opt/projects/litellm-proxy/litellm-key.env; set +a     # LITELLM_API_KEY
python3 -I hindsight_status_gc.py                 # dry run, 13 pilot banks
python3 -I hindsight_status_gc.py --apply         # invalidate
python3 -I hindsight_status_gc.py --revert LOG    # undo everything LOG invalidated
```

Logs and the label cache go to `~/.local/state/hindsight-status-gc/` (they hold memory text:
kept out of shared folders, dir mode 0700). Exit code 1 if any PATCH or classifier call failed.

## Guards

- `--max-invalidate 200`: `--apply` aborts before patching a bank that would take the run past
  the cap, and exits 1. It catches a drifted model (the `deepseek-flash` alias can be remapped in
  LiteLLM without changing the cache key). A first backfill needs a higher cap on purpose.
- Apply logs keep only invalidated / unresolvable / failed rows; logs older than 90 days are
  pruned (`--keep-logs-days`). `--revert` needs the log, so a revert is possible for 90 days.
- Exit 1 on a failed PATCH, a classifier failure or the cap. Nothing watches the unit's failed
  state yet: the backstop is the periodic re-measure on FOV-2948 (first 2026-12-01).

## Schedule (devbox3, jeko user timer)

Units are versioned in `systemd/` and symlinked. The service runs a **detached worktree at a
reviewed commit**, never the shared checkout:

```
git -C /opt/projects/tools/pi-hindsight worktree add --detach /opt/projects/tools/hindsight-status-gc <sha>
ln -s /opt/projects/tools/hindsight-status-gc/tools/status-gc/systemd/hindsight-status-gc.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start hindsight-status-gc.service      # one manual run, check the journal
systemctl --user enable --now hindsight-status-gc.timer # daily 03:30 UTC
```

Update after review: `git -C /opt/projects/tools/hindsight-status-gc checkout --detach <sha>`.
