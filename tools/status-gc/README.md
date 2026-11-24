# status-gc — invalidate status memories about closed issues (FOV-2948)

Invalidates Hindsight facts that are status snapshots ("FOV-972 still open", "stays in_review
with JC") about exactly one Multica issue that is now `done`, `cancelled` or `released`.
Invalidation is Hindsight's reversible curation state: the fact moves to the archive, drops out
of recall, and the observations built on it are rebuilt from their other sources.

## Rule

1. Only world/experience facts (observations can't be curated; they follow their sources).
2. The text names exactly one issue: `FOV-123` / `FOV-123a`, a full issue UUID, or an `01a…`
   prefix that matches one issue. `MUL-…`, unknown numbers and ambiguous prefixes are reported
   as unresolvable; two or more refs are skipped.
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
keep them out of shared folders). Exit code 1 if any PATCH failed.

## Schedule (proposed, not installed)

Daily is enough: a run only classifies facts it hasn't seen, and issues close a few dozen a day.

```
# ~/.config/systemd/user/hindsight-status-gc.service
[Service]
Type=oneshot
EnvironmentFile=/opt/projects/litellm-proxy/litellm-key.env
Environment=MULTICA_CLI_PATH=/usr/local/bin/multica
ExecStart=/usr/bin/python3 -I /opt/projects/tools/pi-hindsight/tools/status-gc/hindsight_status_gc.py --apply

# ~/.config/systemd/user/hindsight-status-gc.timer
[Timer]
OnCalendar=*-*-* 03:30 UTC
Persistent=true
[Install]
WantedBy=timers.target
```
