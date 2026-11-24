#!/usr/bin/env python3
"""FOV-2948 (narrow B): invalidate Hindsight status memories about Multica issues that are
now done, cancelled or released.

Dry run by default; changes nothing without --apply. Per bank:

  1. List the bank's world/experience facts (observations are derived and can't be curated;
     invalidating a fact drops the observations built on it and re-queues their other sources).
  2. Keep facts whose text names exactly one issue (FOV-123 / FOV-123a, a full issue UUID, or a
     short 01a… prefix that matches one issue). Any MUL-… ref, an unknown FOV number or an
     ambiguous prefix makes the fact "unresolvable"; two or more refs make it "skipped".
  3. Facts about an issue that is not done/cancelled/released are skipped without an LLM call.
  4. The rest are labelled by an LLM: pending (a snapshot saying the issue or its work is still
     open/waiting/in progress), mixed (that plus durable content), other. Only "pending" is
     invalidated. Labels are cached by issue+text, so repeat runs only classify new facts.
  5. --apply re-reads each fact right before the PATCH and skips it if it changed.

Every decision goes to a TSV log (state dir, not shared: it holds memory text). --revert LOG
sets every fact the log invalidated back to valid.
"""
import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PILOT_BANKS = ("agent-secretary,agent-overlord,agent-lodd,agent-lodd2,agent-lodrelease,agent-lovl,"
               "agent-lovo,agent-snakyvd,agent-crmdd,agent-tsdr,agent-sacompliance,agent-sadl,"
               "agent-reviewer")
CLOSED = {"done", "cancelled", "released"}
FOV = re.compile(r"\bFOV-(\d+)(?:[a-z]\b|\b)")
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
SHORT = re.compile(r"\b(01a[0-9a-f]{4,5})\b(?!-)")  # issue ids are UUIDv7: 01a0…/01a1…/01a2…
MUL = re.compile(r"\bMUL-\d+\b")
LABELS = {"pending", "mixed", "other", "stale", "keep"}
PROMPT = """You label memories an AI agent stored about work items (Multica issues).
For each memory, answer with ONE label:
- "pending": its main claim is a snapshot of the issue's state at that moment saying the issue
  or its work is NOT finished yet: open, todo, in progress, in review, blocked, parked, waiting
  or awaiting someone or something, assigned to someone now, a check or wakeup armed, a PR
  open or unmerged, something scheduled or still to do, "still", "remains", "stays", "as of".
  Identifiers, assignees, thread or comment ids, PR links, page URLs, dates and who it waits on
  are part of the snapshot: they do NOT make it "mixed".
- "mixed": a pending snapshot AND a separate durable point a reader would still want after the
  issue is closed: a decision with its rationale, a rule or convention, a technical finding
  about code or systems, a lesson.
- "other": anything else: durable facts, decisions, lessons, technical details, events that
  already happened, the issue being done/closed/cancelled, parent/child relations.
Reply with JSON only: {"labels": [{"i": <index>, "label": "<label>"}, ...]} covering every index.

Memories:
"""
# Second, stricter question, asked only about first-pass "pending" facts: invalidate on agreement.
CONFIRM = """Each memory below was written while the issue in brackets was still open. That issue is
now closed (done or cancelled). For each memory answer ONE label:
- "stale": its point is that the issue or its work was still unfinished at the time (open,
  waiting, in review, blocked, assigned to someone, scheduled, armed, still to do), so it is now
  false or obsolete, and it holds nothing else worth keeping.
- "keep": it states something completed, live or done; records where a document, decision
  page, file or report lives; states a decision, rule, technical finding or lesson; or you are
  unsure.
Reply with JSON only: {"labels": [{"i": <index>, "label": "<label>"}, ...]} covering every index.

Memories:
"""


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def http(method, url, body=None, headers=None, timeout=300):
    """(status, parsed-or-text). Never raises on HTTP errors: callers report the status."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, str(e)


def http_error(status, body):
    if status == 401:
        return "authentication failed"
    if status == 403:
        return "permission denied"
    return f"HTTP {status}: {body}"


def hs_auth(args):
    return {"Authorization": f"Bearer {args.hs_key}"} if args.hs_key else {}


def list_facts(args, bank, state=None):
    out = []
    for t in ("world", "experience"):
        off = 0
        while True:
            q = {"type": t, "limit": 500, "offset": off}
            if state:
                q["state"] = state
            st, d = http("GET", f"{args.api}/v1/default/banks/{bank}/memories/list?"
                         + urllib.parse.urlencode(q), headers=hs_auth(args))
            if st != 200:
                sys.exit(f"{bank}: listing {t} failed: {http_error(st, d)}")
            out += d["items"]
            off += len(d["items"])
            if not d["items"] or off >= d["total"]:
                break
    return out


def list_observation_sources(args, bank):
    """{observation id: [source fact ids]} — only for the dry-run impact count."""
    obs, off = {}, 0
    while True:
        st, d = http("GET", f"{args.api}/v1/default/banks/{bank}/memories/list?type=observation"
                     f"&limit=500&offset={off}", headers=hs_auth(args))
        if st != 200:
            sys.exit(f"{bank}: listing observations failed: {http_error(st, d)}")
        for it in d["items"]:
            obs[it["id"]] = it.get("source_memory_ids") or []
        off += len(d["items"])
        if not d["items"] or off >= d["total"]:
            return obs


def load_issues(cli):
    issues, off = {}, 0
    while True:
        p = subprocess.run([cli, "issue", "list", "--limit", "100", "--offset", str(off),
                            "--output", "json", "--fields", "id,identifier,status"],
                           capture_output=True, text=True)
        if p.returncode:
            sys.exit(f"multica issue list failed (exit {p.returncode}): {p.stderr.strip()[:300]}")
        d = json.loads(p.stdout)
        for i in d["issues"]:
            issues[i["identifier"]] = i
        off += len(d["issues"])
        if not d.get("has_more") or not d["issues"]:
            return issues


def issue_refs(text, issues, by_uuid):
    """(set of resolved identifiers, list of unresolvable refs)."""
    refs, bad = set(), []
    for n in FOV.findall(text):
        ident = f"FOV-{n}"
        (refs.add(ident) if ident in issues else bad.append(ident))
    for u in UUID.findall(text):
        if u in by_uuid:
            refs.add(by_uuid[u])
        # a full UUID that is not an issue is a task/comment/memory id: not an issue ref
    for s in SHORT.findall(text):
        hits = [ident for u, ident in by_uuid.items() if u.startswith(s)]
        (refs.add(hits[0]) if len(set(hits)) == 1 else bad.append(s))
    bad += MUL.findall(text)
    return refs, bad


def classify(args, batch, prompt, model):
    """batch: [(key, issue, text)] -> {key: label}; raises on failure."""
    body = "\n".join(f"[{i}] ({iss}) {txt[:700]}" for i, (_, iss, txt) in enumerate(batch))
    st, d = http("POST", f"{args.llm_url}/chat/completions",
                 {"model": model, "temperature": 0,
                  "response_format": {"type": "json_object"},
                  "messages": [{"role": "user", "content": prompt + body}]},
                 headers={"Authorization": f"Bearer {os.environ.get('LITELLM_API_KEY', '')}"})
    if st != 200:
        raise RuntimeError(http_error(st, d))
    content = d["choices"][0]["message"]["content"] or ""
    content = content[content.find("{"): content.rfind("}") + 1]
    got = {int(x["i"]): x["label"] for x in json.loads(content)["labels"]}
    return {k: got[i] for i, (k, _, _) in enumerate(batch) if got.get(i) in LABELS}


def label_all(args, todo, cache, prompt=PROMPT, model=None):
    """Fill cache for every (key, issue, text) in todo; failures stay missing."""
    todo = [t for t in todo if t[0] not in cache]
    batches = [todo[i:i + args.batch] for i in range(0, len(todo), args.batch)]
    with cf.ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(classify, args, b, prompt, model or args.llm_model): b for b in batches}
        for n, f in enumerate(cf.as_completed(futs), 1):
            try:
                cache.update(f.result())
            except Exception as e:  # noqa: BLE001 — reported as unresolvable, never guessed
                print(f"  classify batch failed: {str(e)[:200]}", file=sys.stderr)
            if n % 20 == 0:
                print(f"  classified {n}/{len(batches)} batches", file=sys.stderr)


def invalidate(args, bank, fact, issue, status):
    url = f"{args.api}/v1/default/banks/{bank}/memories/{fact['id']}"
    st, cur = http("GET", url, headers=hs_auth(args))
    if st != 200:
        return f"skip: re-read failed ({http_error(st, cur)})", st
    if cur.get("state") != "valid" or cur.get("text") != fact["text"]:
        return "skip: changed since listing", st
    body = {"state": "invalidated",
            "reason": f"FOV-2948: status snapshot about {issue}, now {status}"}
    for attempt in range(3):
        st, d = http("PATCH", url, body, headers=hs_auth(args))
        if st == 200:
            return "invalidated", st
        # curation contends with background consolidation: a deadlock is safe to retry
        if "deadlock" not in str(d):
            break
        time.sleep(2 * (attempt + 1))
    return f"failed: {http_error(st, d)}", st


def run(args):
    issues = load_issues(args.cli)
    by_uuid = {i["id"]: k for k, i in issues.items()}
    state = Path(args.state_dir)
    state.mkdir(parents=True, exist_ok=True)
    cache_f = state / "labels.json"
    cache = json.loads(cache_f.read_text()) if cache_f.exists() else {}
    mode = "apply" if args.apply else "dry-run"
    log_f = Path(args.log or state / f"{now()[:19].replace(':', '')}-{mode}.tsv")
    counts = {}
    with open(log_f, "w") as log:
        log.write("time\tmode\tbank\tmemory_id\tfact_type\tissue\tissue_status\tdecision\t"
                  "http_status\ttext\n")
        for bank in args.banks.split(","):
            facts = list_facts(args, bank)
            c = counts[bank] = collections.Counter()
            rows, todo = [], []
            for f in facts:
                refs, bad = issue_refs(f["text"], issues, by_uuid)
                if bad and len(refs) + len(bad) == 1:
                    rows.append((f, ",".join(bad), "", "unresolvable: unknown issue ref"))
                elif len(refs) + len(bad) > 1:
                    c["skipped: names several issues"] += 1
                elif not refs:
                    c["no issue named"] += 1
                else:
                    iss = next(iter(refs))
                    status = issues[iss]["status"]
                    if status not in CLOSED:
                        c["skipped: issue not closed"] += 1
                        continue
                    key = hashlib.sha1(f"{PROMPT}\n{iss}\n{f['text']}".encode()).hexdigest()
                    todo.append((key, iss, f["text"]))
                    rows.append((f, iss, status, key))
            label_all(args, todo, cache)
            confirm = {k: hashlib.sha1(f"{CONFIRM}{args.confirm_model}\n{i}\n{t}".encode()).hexdigest()
                       for k, i, t in todo if cache.get(k) == "pending"}
            label_all(args, [(confirm[k], i, t) for k, i, t in todo if k in confirm], cache,
                      CONFIRM, args.confirm_model)
            cache_f.write_text(json.dumps(cache))
            doomed = set()
            for f, iss, status, key in rows:
                if key.startswith("unresolvable"):
                    decision, http_st = key, ""
                elif key not in cache:
                    decision, http_st = "unresolvable: classifier failed", ""
                elif cache[key] != "pending":
                    decision, http_st = f"skipped: {cache[key]}", ""
                elif confirm[key] not in cache:
                    decision, http_st = "unresolvable: classifier failed", ""
                elif cache[confirm[key]] != "stale":
                    decision, http_st = "skipped: pending, not confirmed", ""
                elif not args.apply:
                    decision, http_st = "would invalidate", ""
                    doomed.add(f["id"])
                else:
                    decision, http_st = invalidate(args, bank, f, iss, status)
                    if decision == "invalidated":
                        doomed.add(f["id"])
                c[decision if not decision.startswith(("skip: ", "failed")) else
                  decision.split(" (")[0]] += 1
                text = " ".join(f["text"].split())[:300]
                log.write(f"{now()}\t{mode}\t{bank}\t{f['id']}\t{f['fact_type']}\t{iss}\t{status}\t"
                          f"{decision}\t{http_st}\t{text}\n")
            if doomed and not args.apply:
                obs = list_observation_sources(args, bank)
                c["observations that would be rebuilt"] = sum(
                    1 for srcs in obs.values() if doomed & set(srcs))
            print(f"{bank}: {dict(c)}", file=sys.stderr)
    print(json.dumps({"mode": mode, "log": str(log_f), "per_bank": counts}, indent=1))
    return 1 if any(k.startswith("failed") for c in counts.values() for k in c) else 0


def revert(args):
    rows = [r.rstrip("\n").split("\t") for r in open(args.revert)][1:]
    failed = 0
    for r in rows:
        bank, mid, decision = r[2], r[3], r[7]
        if decision != "invalidated":
            continue
        st, d = http("PATCH", f"{args.api}/v1/default/banks/{bank}/memories/{mid}",
                     {"state": "valid"}, headers=hs_auth(args))
        ok = st == 200
        failed += not ok
        print(f"{bank}\t{mid}\t{'reverted' if ok else http_error(st, d)}")
    return 1 if failed else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--api", default="http://127.0.0.1:18888")
    ap.add_argument("--hs-key", default=os.environ.get("HINDSIGHT_API_KEY", ""))
    ap.add_argument("--banks", default=PILOT_BANKS, help="comma-separated (default: 13 pilot banks)")
    ap.add_argument("--apply", action="store_true", help="invalidate (default: dry run)")
    ap.add_argument("--revert", metavar="LOG", help="set every fact LOG invalidated back to valid")
    ap.add_argument("--log", help="TSV log path (default: STATE_DIR/<time>-<mode>.tsv)")
    ap.add_argument("--state-dir", default=str(Path.home() / ".local/state/hindsight-status-gc"))
    ap.add_argument("--cli", default=os.environ.get("MULTICA_CLI_PATH", "multica"))
    ap.add_argument("--llm-url", default="http://100.67.84.55:4000/v1")
    ap.add_argument("--llm-model", default="deepseek-flash")
    ap.add_argument("--confirm-model", default="deepseek-flash",
                    help="model for the second, stricter pass on 'pending' facts")
    ap.add_argument("--batch", type=int, default=25)
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    sys.exit(revert(args) if args.revert else run(args))


if __name__ == "__main__":
    main()
