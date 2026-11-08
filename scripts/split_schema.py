#!/usr/bin/env python3
"""
Split `pg_dump --schema-only` (plain format) into one file per database object.

Constraints, indexes, triggers, policies, defaults, owned sequences and comments
are regrouped into the file of the table they belong to, so a PR diff shows
"tables/residents.sql changed" instead of a hunk somewhere in a 5,000-line dump.

Usage:
    pg_dump "$PG_URL" --schema-only --no-owner --no-privileges \
        | python3 split_schema.py --out schema

Layout:
    schema/<schema>/_schema.sql
    schema/<schema>/tables/<table>.sql        (+ its constraints, indexes, triggers, ...)
    schema/<schema>/views/<view>.sql
    schema/<schema>/matviews/<matview>.sql
    schema/<schema>/functions/<name(args)>.sql
    schema/<schema>/types/<type>.sql          (enums, composites, domains)
    schema/<schema>/sequences/<seq>.sql       (only sequences not owned by a table)
    schema/_database/extensions/<ext>.sql     (objects that belong to no schema)
"""
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

MARKER = ".pg-schema-split"  # lets --out be wiped safely on each run

# "-- Name: notes t; Type: TRIGGER; Schema: public; Owner: -" (+ optional "; Tablespace: x")
HEADER_RE = re.compile(
    r"^-- (?:Data for )?Name: (?P<name>.*); Type: (?P<type>[^;]+); "
    r"Schema: (?P<schema>[^;]*); Owner: [^;]*(?:; .*)?$"
)
NOISE_RE = re.compile(
    r"^(SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict|"
    r"-- Dumped (from|by)|-- PostgreSQL database dump)"
)

IDENT = r'(?:"(?:[^"]|"")*"|[^\s."(),;]+)'
QUALIFIED = rf"{IDENT}(?:\.{IDENT})*"

# Top-level objects that get their own file -> directory name.
BASE_DIRS = {
    "TABLE": "tables",
    "FOREIGN TABLE": "tables",
    "VIEW": "views",
    "MATERIALIZED VIEW": "matviews",
    "FUNCTION": "functions",
    "PROCEDURE": "functions",
    "AGGREGATE": "functions",
    "TYPE": "types",
    "DOMAIN": "types",
    "SEQUENCE": "sequences",
    "EXTENSION": "extensions",
    "COLLATION": "collations",
    "OPERATOR": "operators",
    "CAST": "casts",
    "EVENT TRIGGER": "event_triggers",
    "PUBLICATION": "publications",
    "SERVER": "servers",
    "FOREIGN DATA WRAPPER": "foreign_data_wrappers",
}
RELATION_TYPES = {"TABLE", "FOREIGN TABLE", "VIEW", "MATERIALIZED VIEW"}

# Dependents whose tag starts with the owning relation's name ("<table> <thing>").
TABLE_PREFIXED = {
    "CONSTRAINT", "FK CONSTRAINT", "CHECK CONSTRAINT", "DEFAULT",
    "TRIGGER", "POLICY", "RULE", "ROW SECURITY", "TABLE ATTACH",
}
# Tags like "TABLE notes" / "COLUMN notes.body" / "TRIGGER t ON notes".
META_TYPES = {"COMMENT", "ACL", "SECURITY LABEL"}
META_KINDS = (
    "MATERIALIZED VIEW", "FOREIGN TABLE", "TABLE", "VIEW", "COLUMN", "FUNCTION",
    "PROCEDURE", "AGGREGATE", "TYPE", "DOMAIN", "SEQUENCE", "INDEX", "EXTENSION",
    "SCHEMA", "CONSTRAINT", "TRIGGER", "POLICY", "RULE",
)


@dataclass
class Block:
    name: str
    type: str
    schema: str  # "-" for database-level objects
    body: str


def unquote(ident: str) -> str:
    if ident.startswith('"') and ident.endswith('"'):
        return ident[1:-1].replace('""', '"')
    return ident


def split_qualified(text: str) -> list[str]:
    return [unquote(p) for p in re.findall(IDENT, text)]


def parse_blocks(lines: list[str]) -> list[Block]:
    blocks: list[Block] = []
    current: Block | None = None
    body: list[str] = []
    i = 0
    while i < len(lines):
        m = HEADER_RE.match(lines[i + 1]) if i + 2 < len(lines) else None
        if lines[i] == "--" and m and lines[i + 2] == "--":
            if current:
                current.body = "\n".join(body).strip()
                blocks.append(current)
            current = Block(m["name"], m["type"], m["schema"], "")
            body = []
            i += 3
            continue
        if current is not None and not NOISE_RE.match(lines[i]):
            body.append(lines[i])
        i += 1
    if current:
        current.body = "\n".join(body).strip()
        blocks.append(current)
    return [b for b in blocks if b.body]


def safe_filename(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_.(),-]+", "_", name).strip(".") or "_"
    if len(s) > 120:  # long overloaded signatures
        s = s[:100] + "_" + hashlib.sha1(name.encode()).hexdigest()[:8]
    return s


class Splitter:
    def __init__(self, blocks: list[Block]):
        self.blocks = blocks
        self.files: dict[tuple, list[str]] = defaultdict(list)  # key -> bodies
        self.base: dict[tuple[str, str, str], tuple] = {}  # (schema,type,name) -> key
        self.relations: dict[str, list[str]] = defaultdict(list)  # schema -> names
        self.index_owner: dict[tuple[str, str], tuple] = {}  # (schema, index) -> key
        self.seq_owner: dict[tuple[str, str], tuple] = {}  # (schema, seq) -> key
        self.unresolved: list[Block] = []

    def key_for(self, b: Block) -> tuple:
        if b.type == "SCHEMA":
            return (b.name, None, "_schema")
        directory = BASE_DIRS.get(b.type) or re.sub(r"\W+", "_", b.type.lower())
        scope = "_database" if b.schema in ("-", "") else b.schema
        return (scope, directory, b.name)

    def rel_key(self, schema: str, rel: str) -> tuple | None:
        for t in RELATION_TYPES:
            if (schema, t, rel) in self.base:
                return self.base[(schema, t, rel)]
        return None

    def rel_by_prefix(self, schema: str, tag: str, sep: str = " ") -> tuple | None:
        # Longest match wins, so "care plan" beats "care" for tag "care plan pk".
        best = None
        for rel in self.relations.get(schema, []):
            if (tag == rel or tag.startswith(rel + sep)) and (best is None or len(rel) > len(best)):
                best = rel
        return self.rel_key(schema, best) if best else None

    def table_from_body(self, pattern: str, body: str, default_schema: str) -> tuple | None:
        m = re.search(pattern, body)
        if not m:
            return None
        parts = split_qualified(m.group(1))
        schema, rel = (parts[-2], parts[-1]) if len(parts) >= 2 else (default_schema, parts[-1])
        return self.rel_key(schema, rel)

    def run(self) -> None:
        # Pass 1: register every top-level object.
        for b in self.blocks:
            if b.type in BASE_DIRS or b.type == "SCHEMA":
                self.base[(b.schema, b.type, b.name)] = self.key_for(b)
                if b.type in RELATION_TYPES:
                    self.relations[b.schema].append(b.name)

        # Pass 2: learn which table owns each index and sequence.
        for b in self.blocks:
            if b.type == "INDEX":
                owner = self.table_from_body(rf"\bON (?:ONLY )?({QUALIFIED})", b.body, b.schema)
                if owner:
                    self.index_owner[(b.schema, b.name)] = owner
            elif b.type == "SEQUENCE OWNED BY":
                m = re.search(rf"OWNED BY ({QUALIFIED})", b.body)
                parts = split_qualified(m.group(1)) if m else []
                if len(parts) >= 3:
                    owner = self.rel_key(parts[-3], parts[-2])
                    if owner:
                        self.seq_owner[(b.schema, b.name)] = owner
            elif b.type == "SEQUENCE" and b.body.startswith("ALTER TABLE"):  # identity column
                owner = self.table_from_body(rf"ALTER TABLE (?:ONLY )?({QUALIFIED})", b.body, b.schema)
                if owner:
                    self.seq_owner[(b.schema, b.name)] = owner

        # Pass 3: place every block, in dump order (which is dependency order).
        prev = None
        for b in self.blocks:
            key = self.place(b)
            if key is None and b.type in META_TYPES and prev is not None:
                key = prev  # pg_dump emits comments right after the object they describe
            if key is None:
                self.unresolved.append(b)
                key = ("_unresolved", re.sub(r"\W+", "_", b.type.lower()), b.name)
            self.files[key].append(b.body)
            prev = key

    def place(self, b: Block) -> tuple | None:
        if b.type == "SEQUENCE" and (b.schema, b.name) in self.seq_owner:
            return self.seq_owner[(b.schema, b.name)]
        if b.type in BASE_DIRS or b.type == "SCHEMA":
            return self.base[(b.schema, b.type, b.name)]
        if b.type in TABLE_PREFIXED:
            return self.rel_by_prefix(b.schema, b.name)
        if b.type == "INDEX":
            return self.index_owner.get((b.schema, b.name))
        if b.type == "INDEX ATTACH":
            m = re.search(rf"ATTACH PARTITION ({QUALIFIED})", b.body)
            if m:
                parts = split_qualified(m.group(1))
                return self.index_owner.get((parts[-2] if len(parts) > 1 else b.schema, parts[-1]))
            return None
        if b.type == "SEQUENCE OWNED BY":
            return self.seq_owner.get((b.schema, b.name)) or self.base.get((b.schema, "SEQUENCE", b.name))
        if b.type == "STATISTICS":
            return self.table_from_body(rf"\bFROM ({QUALIFIED})", b.body, b.schema)
        if b.type in META_TYPES:
            return self.place_meta(b)
        return None

    def place_meta(self, b: Block) -> tuple | None:
        # COMMENT/ACL tags quote identifiers: 'TABLE "Care Plan"', 'COLUMN "Care Plan".contact',
        # 'FUNCTION f(a integer)' (with arg names, unlike the FUNCTION tag 'f(integer)').
        kind = next((k for k in META_KINDS if b.name.startswith(k + " ")), None)
        if kind is None:
            return None
        rest = b.name[len(kind) + 1:]
        if kind == "COLUMN":
            parts = split_qualified(rest)
            return self.rel_key(b.schema, parts[0]) if len(parts) >= 2 else None
        if kind in ("CONSTRAINT", "TRIGGER", "POLICY", "RULE"):
            _, _, rel = rest.rpartition(" ON ")
            return self.rel_key(b.schema, unquote(rel))
        if kind in ("FUNCTION", "PROCEDURE", "AGGREGATE"):
            return self.match_function(b.schema, rest)
        name = unquote(rest)
        if kind == "INDEX":
            return self.index_owner.get((b.schema, name))
        if kind == "SEQUENCE" and (b.schema, name) in self.seq_owner:
            return self.seq_owner[(b.schema, name)]
        if kind == "SCHEMA":
            return self.base.get(("-", "SCHEMA", name))
        if kind in ("TYPE", "DOMAIN"):
            return self.base.get((b.schema, "TYPE", name)) or self.base.get((b.schema, "DOMAIN", name))
        return self.base.get((b.schema, kind, name))

    def match_function(self, schema: str, sig: str) -> tuple | None:
        # Match 'f(a integer, b text)' to the function tagged 'f(integer, text)'.
        fname, _, args = sig.partition("(")
        fname, args = unquote(fname), args.rstrip(")")
        want = [a.strip() for a in args.split(",")] if args.strip() else []
        for (s, t, n), key in self.base.items():
            if s != schema or t not in ("FUNCTION", "PROCEDURE", "AGGREGATE"):
                continue
            bname, _, bargs = n.partition("(")
            have = [a.strip() for a in bargs.rstrip(")").split(",")] if bargs.strip(") ") else []
            if bname == fname and len(have) == len(want) and all(
                w == h or w.endswith(" " + h) for w, h in zip(want, have)
            ):
                return key
        return None

    def paths(self, out: Path) -> dict[Path, list[str]]:
        # Map keys to paths, de-duplicating names that only differ by case so the
        # repo still works on case-insensitive filesystems (Windows, macOS).
        result: dict[Path, list[str]] = {}
        seen: dict[str, int] = defaultdict(int)
        for key in sorted(self.files, key=lambda k: (k[0], k[1] or "", k[2])):
            scope, directory, name = key
            folder = out / safe_filename(scope) / directory if directory else out / safe_filename(scope)
            stem = safe_filename(name)
            fold = str(folder / stem).lower()
            seen[fold] += 1
            if seen[fold] > 1:
                stem = f"{stem}~{seen[fold]}"
            result[folder / f"{stem}.sql"] = self.files[key]
        return result


def prepare_out(out: Path) -> None:
    if out.exists():
        if not (out / MARKER).exists() and any(out.iterdir()):
            sys.exit(f"refusing to wipe {out}: not empty and no {MARKER} marker")
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / MARKER).write_text("Generated by split_schema.py; this folder is wiped on every run.\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump", nargs="?", help="pg_dump output file (default: stdin)")
    ap.add_argument("--out", default="schema", help="output directory (default: schema)")
    ap.add_argument("--strict", action="store_true", help="exit 1 if any block can't be placed")
    args = ap.parse_args()

    text = Path(args.dump).read_text() if args.dump else sys.stdin.read()
    blocks = parse_blocks(text.splitlines())
    if not blocks:
        sys.exit("no pg_dump blocks found in input")

    splitter = Splitter(blocks)
    splitter.run()

    out = Path(args.out)
    prepare_out(out)
    files = splitter.paths(out)
    for path, bodies in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n\n".join(bodies) + "\n")

    print(f"{len(blocks)} objects -> {len(files)} files in {out}/", file=sys.stderr)
    for b in splitter.unresolved:
        print(f"warning: couldn't place {b.type} '{b.name}' (schema {b.schema}); "
              f"wrote it under {out}/_unresolved/", file=sys.stderr)
    return 1 if args.strict and splitter.unresolved else 0


if __name__ == "__main__":
    sys.exit(main())
