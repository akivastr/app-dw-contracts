#!/usr/bin/env python3
"""
Compare the snapshot on disk with the last commit and write a PR description
that says, in plain terms, what changed in each contract and whether it can
break the other side.

Usage:
    python3 scripts/summarize.py [--out pr-body.md] [--base HEAD]

When run inside GitHub Actions it also sets the step outputs
`changed`, `breaking` and `review` (counts / true-false).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIRECTIONS = {
    "outbound": ("Outbound", "app DB → data warehouse", "the warehouse pipeline reads these"),
    "inbound": ("Inbound", "data warehouse → app DB", "the warehouse pipeline writes these"),
}
BREAKING, REVIEW, SAFE, INFO = "breaking", "review", "safe", "info"
BADGE = {BREAKING: "🔴 Breaking", REVIEW: "🟡 Review", SAFE: "🟢 Safe", INFO: "⚪ Info"}
ORDER = {BREAKING: 0, REVIEW: 1, SAFE: 2, INFO: 3}
KIND_LABEL = {
    "tables": "table", "views": "view", "matviews": "materialized view",
    "functions": "function", "types": "type", "sequences": "sequence", "_schema": "schema",
}

IDENT = r'(?:"(?:[^"]|"")*"|[^\s."(),;]+)'
QUALIFIED = rf"{IDENT}(?:\.{IDENT})*"
CREATE_RE = re.compile(
    rf"^CREATE (?:OR REPLACE )?(?:UNIQUE )?"
    rf"(?:TABLE|VIEW|MATERIALIZED VIEW|TYPE|DOMAIN|FUNCTION|PROCEDURE|AGGREGATE|SEQUENCE|SCHEMA) "
    rf"({QUALIFIED})",
    re.M,
)


@dataclass
class Change:
    level: str
    obj: str
    text: str


@dataclass
class Column:
    type: str
    not_null: bool
    default: str | None


# ------------------------------------------------------------------ git helpers
def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def has_commit(ref: str) -> bool:
    return subprocess.run(["git", "rev-parse", "--verify", "-q", ref], cwd=ROOT,
                          capture_output=True).returncode == 0


def old_files(base: str, folder: str) -> dict[str, str]:
    if not has_commit(base):
        return {}
    names = git("ls-tree", "-r", "--name-only", base, "--", folder).split()
    return {n: git("show", f"{base}:{n}") for n in names if n.endswith(".sql")}


def new_files(folder: str) -> dict[str, str]:
    base = ROOT / folder
    if not base.exists():
        return {}
    return {str(p.relative_to(ROOT)): p.read_text() for p in sorted(base.rglob("*.sql"))}


# ------------------------------------------------------------------ parsing
def object_name(path: str, sql: str) -> str:
    m = CREATE_RE.search(sql)
    if m:
        return m.group(1)
    parts = Path(path).parts
    return f"{parts[1]}.{Path(path).stem}" if len(parts) > 2 else Path(path).stem


def kind_of(path: str) -> str:
    parts = Path(path).parts
    return parts[2] if len(parts) > 3 else Path(path).stem


def parse_columns(sql: str) -> dict[str, Column]:
    m = re.search(r"^CREATE (?:FOREIGN )?TABLE [^\n]*\(\n(.*?)\n\)", sql, re.S | re.M)
    if not m:
        return {}
    cols: dict[str, Column] = {}
    for line in m.group(1).splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith("CONSTRAINT "):
            continue
        cm = re.match(r'("(?:[^"]|"")*"|\S+)\s+(.*)$', line)
        if not cm:
            continue
        name, rest = cm.group(1), cm.group(2)
        not_null = bool(re.search(r"\bNOT NULL\b", rest))
        dm = re.search(r"\bDEFAULT (.+?)(?: NOT NULL)?$", rest)
        col_type = re.split(r" (?:DEFAULT|NOT NULL|COLLATE|GENERATED)\b", rest)[0].strip()
        cols[name] = Column(col_type, not_null, dm.group(1) if dm else None)
    return cols


def has_identity(sql: str, col: str) -> bool:
    return bool(re.search(rf"ALTER COLUMN {re.escape(col)} ADD GENERATED", sql))


def parse_enum(sql: str) -> list[str] | None:
    m = re.search(r"AS ENUM \((.*?)\);", sql, re.S)
    return re.findall(r"'((?:[^']|'')*)'", m.group(1)) if m else None


def describe(col: Column) -> str:
    return f"`{col.type}{' NOT NULL' if col.not_null else ''}`"


# ------------------------------------------------------------------ comparison
def compare_table(direction: str, obj: str, old: str, new: str) -> list[Change]:
    out: list[Change] = []
    a, b = parse_columns(old), parse_columns(new)
    for name in b.keys() - a.keys():
        col = b[name]
        needs_value = col.not_null and col.default is None and not has_identity(new, name)
        if direction == "inbound" and needs_value:
            out.append(Change(BREAKING, obj, f"Required column `{name}` {describe(col)} added; "
                                              "the warehouse pipeline must start supplying it"))
        else:
            out.append(Change(SAFE, obj, f"Column `{name}` {describe(col)} added"))
    for name in a.keys() - b.keys():
        out.append(Change(BREAKING, obj, f"Column `{name}` {describe(a[name])} removed"))
    for name in a.keys() & b.keys():
        x, y = a[name], b[name]
        if x.type != y.type:
            out.append(Change(BREAKING, obj, f"Column `{name}` type changed `{x.type}` → `{y.type}`"))
        if x.not_null and not y.not_null:
            level = REVIEW if direction == "outbound" else SAFE
            out.append(Change(level, obj, f"Column `{name}` now allows NULL"))
        if not x.not_null and y.not_null:
            level = BREAKING if direction == "inbound" else SAFE
            out.append(Change(level, obj, f"Column `{name}` is now NOT NULL"))
        if x.default != y.default:
            out.append(Change(INFO, obj, f"Column `{name}` default `{x.default}` → `{y.default}`"))
    if not out:
        out.append(Change(INFO, obj, "Indexes, constraints, triggers or comments changed"))
    return out


def compare_file(direction: str, path: str, old: str | None, new: str | None) -> list[Change]:
    kind = kind_of(path)
    label = KIND_LABEL.get(kind, kind.rstrip("s"))
    obj = object_name(path, new or old or "")
    if old is None:
        cols = parse_columns(new or "")
        detail = f" with {len(cols)} columns" if cols else ""
        return [Change(SAFE, obj, f"New {label}{detail}")]
    if new is None:
        return [Change(BREAKING, obj, f"{label.capitalize()} removed")]
    if kind == "tables":
        return compare_table(direction, obj, old, new)
    if kind == "types":
        ea, eb = parse_enum(old), parse_enum(new)
        if ea is not None and eb is not None:
            changes = [Change(REVIEW, obj, f"Enum value `{v}` added; make sure the other side maps it")
                       for v in eb if v not in ea]
            changes += [Change(BREAKING, obj, f"Enum value `{v}` removed") for v in ea if v not in eb]
            if changes:
                return changes
    return [Change(REVIEW, obj, f"{label.capitalize()} definition changed")]


def collect(base: str) -> dict[str, list[Change]]:
    result: dict[str, list[Change]] = {}
    for folder in DIRECTIONS:
        old, new = old_files(base, folder), new_files(folder)
        changes: list[Change] = []
        for path in sorted(old.keys() | new.keys()):
            if old.get(path) != new.get(path):
                changes += compare_file(folder, path, old.get(path), new.get(path))
        result[folder] = sorted(changes, key=lambda c: (ORDER[c.level], c.obj))
    return result


# ------------------------------------------------------------------ output
def render(result: dict[str, list[Change]]) -> str:
    every = [c for cs in result.values() for c in cs]
    counts = {lvl: sum(c.level == lvl for c in every) for lvl in ORDER}
    headline = " · ".join(f"{counts[l]} {BADGE[l].split(' ', 1)[1].lower()}" for l in ORDER if counts[l])
    lines = ["## Schema contract changes", ""]
    if counts[BREAKING]:
        lines += ["> [!CAUTION]",
                  "> This PR contains **breaking** changes. Coordinate with the other side "
                  "before the next pipeline run.", ""]
    elif counts[REVIEW]:
        lines += ["> [!WARNING]", "> Some changes need a quick check by the other side.", ""]
    lines += [f"**{headline or 'No changes'}**", ""]
    for folder, (title, flow, note) in DIRECTIONS.items():
        changes = result[folder]
        lines += [f"### {title} ({flow})", f"_{note}_", ""]
        if not changes:
            lines += ["No changes.", ""]
            continue
        lines += ["| | Object | Change |", "|---|---|---|"]
        lines += [f"| {BADGE[c.level]} | `{c.obj}` | {c.text} |" for c in changes]
        lines.append("")
    lines += ["---",
              "_Opened automatically by the schema snapshot workflow. The **Files changed** tab "
              "shows the exact DDL. Merging this PR records the new state as the baseline._"]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="HEAD")
    ap.add_argument("--out", help="write markdown here (default: stdout)")
    args = ap.parse_args()

    result = collect(args.base)
    every = [c for cs in result.values() for c in cs]
    body = render(result)
    if args.out:
        Path(args.out).write_text(body)
    else:
        print(body)

    if gh_out := os.environ.get("GITHUB_OUTPUT"):
        with open(gh_out, "a") as f:
            f.write(f"changed={'true' if every else 'false'}\n")
            f.write(f"breaking={sum(c.level == BREAKING for c in every)}\n")
            f.write(f"review={sum(c.level == REVIEW for c in every)}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
