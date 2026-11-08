#!/usr/bin/env node
/**
 * Split `pg_dump --schema-only` (plain format) into one file per database object.
 *
 * Constraints, indexes, triggers, policies, defaults, owned sequences and comments
 * are regrouped into the file of the table they belong to, so a PR diff shows
 * "tables/residents.sql changed" instead of a hunk somewhere in a 5,000-line dump.
 *
 * Usage:
 *   pg_dump "$PG_URL" --schema-only --no-owner --no-privileges \
 *     | node scripts/split-schema.ts --out schema [--strict]
 *
 * Layout:
 *   <out>/<schema>/_schema.sql
 *   <out>/<schema>/tables/<table>.sql       (+ its constraints, indexes, triggers, ...)
 *   <out>/<schema>/views/<view>.sql
 *   <out>/<schema>/matviews/<matview>.sql
 *   <out>/<schema>/functions/<name(args)>.sql
 *   <out>/<schema>/types/<type>.sql         (enums, composites, domains)
 *   <out>/<schema>/sequences/<seq>.sql      (only sequences not owned by a table)
 *   <out>/_database/extensions/<ext>.sql    (objects that belong to no schema)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const MARKER = ".pg-schema-split"; // lets --out be wiped safely on each run

// "-- Name: notes t; Type: TRIGGER; Schema: public; Owner: -" (+ optional "; Tablespace: x")
const HEADER_RE =
  /^-- (?:Data for )?Name: (?<name>.*); Type: (?<type>[^;]+); Schema: (?<schema>[^;]*); Owner: [^;]*(?:; .*)?$/;
const NOISE_RE =
  /^(SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict|-- Dumped (from|by)|-- PostgreSQL database dump)/;

export const IDENT = String.raw`(?:"(?:[^"]|"")*"|[^\s."(),;]+)`;
export const QUALIFIED = String.raw`${IDENT}(?:\.${IDENT})*`;

/** Top-level objects that get their own file -> directory name. */
const BASE_DIRS: Record<string, string> = {
  TABLE: "tables",
  "FOREIGN TABLE": "tables",
  VIEW: "views",
  "MATERIALIZED VIEW": "matviews",
  FUNCTION: "functions",
  PROCEDURE: "functions",
  AGGREGATE: "functions",
  TYPE: "types",
  DOMAIN: "types",
  SEQUENCE: "sequences",
  EXTENSION: "extensions",
  COLLATION: "collations",
  OPERATOR: "operators",
  CAST: "casts",
  "EVENT TRIGGER": "event_triggers",
  PUBLICATION: "publications",
  SERVER: "servers",
  "FOREIGN DATA WRAPPER": "foreign_data_wrappers",
};
const RELATION_TYPES = ["TABLE", "FOREIGN TABLE", "VIEW", "MATERIALIZED VIEW"];

/** Dependents whose tag starts with the owning relation's name ("<table> <thing>"). */
const TABLE_PREFIXED = new Set([
  "CONSTRAINT", "FK CONSTRAINT", "CHECK CONSTRAINT", "DEFAULT",
  "TRIGGER", "POLICY", "RULE", "ROW SECURITY", "TABLE ATTACH",
]);
/** Tags like 'TABLE "Care Plan"' / 'COLUMN notes.body' / 'POLICY p ON notes'. */
const META_TYPES = new Set(["COMMENT", "ACL", "SECURITY LABEL"]);
const META_KINDS = [
  "MATERIALIZED VIEW", "FOREIGN TABLE", "TABLE", "VIEW", "COLUMN", "FUNCTION",
  "PROCEDURE", "AGGREGATE", "TYPE", "DOMAIN", "SEQUENCE", "INDEX", "EXTENSION",
  "SCHEMA", "CONSTRAINT", "TRIGGER", "POLICY", "RULE",
];
const FUNCTION_TYPES = new Set(["FUNCTION", "PROCEDURE", "AGGREGATE"]);

interface Block {
  name: string;
  type: string;
  schema: string; // "-" for database-level objects
  body: string;
}

/** Where a block is written: [scope (schema or _database), directory or null, object name]. */
type FileKey = readonly [scope: string, dir: string | null, name: string];
const keyId = (k: FileKey): string => JSON.stringify(k);
const baseId = (schema: string, type: string, name: string): string => `${schema}\u0000${type}\u0000${name}`;
const pairId = (schema: string, name: string): string => `${schema}\u0000${name}`;

export function unquote(ident: string): string {
  return ident.startsWith('"') && ident.endsWith('"') ? ident.slice(1, -1).replaceAll('""', '"') : ident;
}

export function splitQualified(text: string): string[] {
  return [...text.matchAll(new RegExp(IDENT, "g"))].map((m) => unquote(m[0]));
}

const typeSlug = (type: string): string => type.toLowerCase().replace(/\W+/g, "_");

export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current) {
      current.body = body.join("\n").trim();
      blocks.push(current);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const m = i + 2 < lines.length ? HEADER_RE.exec(lines[i + 1]) : null;
    if (lines[i] === "--" && m?.groups && lines[i + 2] === "--") {
      flush();
      current = { name: m.groups.name, type: m.groups.type, schema: m.groups.schema, body: "" };
      body = [];
      i += 2;
      continue;
    }
    if (current && !NOISE_RE.test(lines[i])) body.push(lines[i]);
  }
  flush();
  return blocks.filter((b) => b.body);
}

export function safeFilename(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_.(),-]+/g, "_").replace(/^\.+|\.+$/g, "") || "_";
  if (s.length > 120) {
    // long overloaded signatures
    s = `${s.slice(0, 100)}_${createHash("sha1").update(name).digest("hex").slice(0, 8)}`;
  }
  return s;
}

export class Splitter {
  readonly files = new Map<string, { key: FileKey; bodies: string[] }>();
  readonly unresolved: Block[] = [];
  private readonly blocks: Block[];
  private readonly base = new Map<string, FileKey>(); // (schema,type,name) -> key
  private readonly relations = new Map<string, string[]>(); // schema -> names
  private readonly indexOwner = new Map<string, FileKey>(); // (schema,index) -> key
  private readonly seqOwner = new Map<string, FileKey>(); // (schema,seq) -> key

  constructor(blocks: Block[]) {
    this.blocks = blocks;
  }

  private keyFor(b: Block): FileKey {
    if (b.type === "SCHEMA") return [b.name, null, "_schema"];
    const dir = BASE_DIRS[b.type] ?? typeSlug(b.type);
    const scope = b.schema === "-" || b.schema === "" ? "_database" : b.schema;
    return [scope, dir, b.name];
  }

  private isBase(type: string): boolean {
    return type in BASE_DIRS || type === "SCHEMA";
  }

  private relKey(schema: string, rel: string | undefined): FileKey | undefined {
    if (rel === undefined) return undefined;
    for (const t of RELATION_TYPES) {
      const k = this.base.get(baseId(schema, t, rel));
      if (k) return k;
    }
    return undefined;
  }

  /** Longest match wins, so "care plan" beats "care" for tag "care plan pk". */
  private relByPrefix(schema: string, tag: string): FileKey | undefined {
    let best: string | undefined;
    for (const rel of this.relations.get(schema) ?? []) {
      if ((tag === rel || tag.startsWith(`${rel} `)) && (best === undefined || rel.length > best.length)) {
        best = rel;
      }
    }
    return this.relKey(schema, best);
  }

  private tableFromBody(pattern: string, body: string, defaultSchema: string): FileKey | undefined {
    const m = new RegExp(pattern).exec(body);
    if (!m) return undefined;
    const parts = splitQualified(m[1]);
    const [schema, rel] = parts.length >= 2 ? parts.slice(-2) : [defaultSchema, parts.at(-1)];
    return this.relKey(schema!, rel);
  }

  run(): void {
    // Pass 1: register every top-level object.
    for (const b of this.blocks) {
      if (!this.isBase(b.type)) continue;
      this.base.set(baseId(b.schema, b.type, b.name), this.keyFor(b));
      if (RELATION_TYPES.includes(b.type)) {
        const list = this.relations.get(b.schema) ?? [];
        list.push(b.name);
        this.relations.set(b.schema, list);
      }
    }

    // Pass 2: learn which table owns each index and sequence.
    for (const b of this.blocks) {
      if (b.type === "INDEX") {
        const owner = this.tableFromBody(String.raw`\bON (?:ONLY )?(${QUALIFIED})`, b.body, b.schema);
        if (owner) this.indexOwner.set(pairId(b.schema, b.name), owner);
      } else if (b.type === "SEQUENCE OWNED BY") {
        const m = new RegExp(`OWNED BY (${QUALIFIED})`).exec(b.body);
        const parts = m ? splitQualified(m[1]) : [];
        if (parts.length >= 3) {
          const owner = this.relKey(parts.at(-3)!, parts.at(-2));
          if (owner) this.seqOwner.set(pairId(b.schema, b.name), owner);
        }
      } else if (b.type === "SEQUENCE" && b.body.startsWith("ALTER TABLE")) {
        // identity column
        const owner = this.tableFromBody(`ALTER TABLE (?:ONLY )?(${QUALIFIED})`, b.body, b.schema);
        if (owner) this.seqOwner.set(pairId(b.schema, b.name), owner);
      }
    }

    // Pass 3: place every block, in dump order (which is dependency order).
    let prev: FileKey | undefined;
    for (const b of this.blocks) {
      let key = this.place(b);
      // pg_dump emits comments right after the object they describe.
      if (!key && META_TYPES.has(b.type) && prev) key = prev;
      if (!key) {
        this.unresolved.push(b);
        key = ["_unresolved", typeSlug(b.type), b.name];
      }
      const id = keyId(key);
      const entry = this.files.get(id) ?? { key, bodies: [] };
      entry.bodies.push(b.body);
      this.files.set(id, entry);
      prev = key;
    }
  }

  private place(b: Block): FileKey | undefined {
    const seq = this.seqOwner.get(pairId(b.schema, b.name));
    if (b.type === "SEQUENCE" && seq) return seq;
    if (this.isBase(b.type)) return this.base.get(baseId(b.schema, b.type, b.name));
    if (TABLE_PREFIXED.has(b.type)) return this.relByPrefix(b.schema, b.name);
    if (b.type === "INDEX") return this.indexOwner.get(pairId(b.schema, b.name));
    if (b.type === "INDEX ATTACH") {
      const m = new RegExp(`ATTACH PARTITION (${QUALIFIED})`).exec(b.body);
      if (!m) return undefined;
      const parts = splitQualified(m[1]);
      return this.indexOwner.get(pairId(parts.length > 1 ? parts.at(-2)! : b.schema, parts.at(-1)!));
    }
    if (b.type === "SEQUENCE OWNED BY") return seq ?? this.base.get(baseId(b.schema, "SEQUENCE", b.name));
    if (b.type === "STATISTICS") return this.tableFromBody(String.raw`\bFROM (${QUALIFIED})`, b.body, b.schema);
    if (META_TYPES.has(b.type)) return this.placeMeta(b);
    return undefined;
  }

  /**
   * COMMENT/ACL tags quote identifiers: 'TABLE "Care Plan"', 'COLUMN "Care Plan".contact',
   * 'FUNCTION f(a integer)' (with arg names, unlike the FUNCTION tag 'f(integer)').
   */
  private placeMeta(b: Block): FileKey | undefined {
    const kind = META_KINDS.find((k) => b.name.startsWith(`${k} `));
    if (!kind) return undefined;
    const rest = b.name.slice(kind.length + 1);
    if (kind === "COLUMN") {
      const parts = splitQualified(rest);
      return parts.length >= 2 ? this.relKey(b.schema, parts[0]) : undefined;
    }
    if (["CONSTRAINT", "TRIGGER", "POLICY", "RULE"].includes(kind)) {
      const i = rest.lastIndexOf(" ON ");
      return this.relKey(b.schema, unquote(i >= 0 ? rest.slice(i + 4) : rest));
    }
    if (FUNCTION_TYPES.has(kind)) return this.matchFunction(b.schema, rest);
    const name = unquote(rest);
    if (kind === "INDEX") return this.indexOwner.get(pairId(b.schema, name));
    if (kind === "SEQUENCE" && this.seqOwner.has(pairId(b.schema, name))) {
      return this.seqOwner.get(pairId(b.schema, name));
    }
    if (kind === "SCHEMA") return this.base.get(baseId("-", "SCHEMA", name));
    if (kind === "TYPE" || kind === "DOMAIN") {
      return this.base.get(baseId(b.schema, "TYPE", name)) ?? this.base.get(baseId(b.schema, "DOMAIN", name));
    }
    return this.base.get(baseId(b.schema, kind, name));
  }

  /** Match 'f(a integer, b text)' to the function tagged 'f(integer, text)'. */
  private matchFunction(schema: string, sig: string): FileKey | undefined {
    const splitArgs = (s: string): string[] => {
      const inner = s.replace(/\)$/, "").trim();
      return inner ? inner.split(",").map((a) => a.trim()) : [];
    };
    const open = sig.indexOf("(");
    const fname = unquote(open >= 0 ? sig.slice(0, open) : sig);
    const want = splitArgs(open >= 0 ? sig.slice(open + 1) : "");
    for (const [id, key] of this.base) {
      const [s, t, n] = id.split("\u0000");
      if (s !== schema || !FUNCTION_TYPES.has(t)) continue;
      const bopen = n.indexOf("(");
      const bname = bopen >= 0 ? n.slice(0, bopen) : n;
      const have = splitArgs(bopen >= 0 ? n.slice(bopen + 1) : "");
      if (
        bname === fname &&
        have.length === want.length &&
        want.every((w, i) => w === have[i] || w.endsWith(` ${have[i]}`))
      ) {
        return key;
      }
    }
    return undefined;
  }

  /**
   * Map keys to paths, de-duplicating names that only differ by case so the
   * repo still works on case-insensitive filesystems (Windows, macOS).
   */
  paths(out: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const seen = new Map<string, number>();
    const entries = [...this.files.values()].sort((a, b) => {
      const ka = [a.key[0], a.key[1] ?? "", a.key[2]];
      const kb = [b.key[0], b.key[1] ?? "", b.key[2]];
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
    for (const { key, bodies } of entries) {
      const [scope, dir, name] = key;
      const folder = dir ? join(out, safeFilename(scope), dir) : join(out, safeFilename(scope));
      let stem = safeFilename(name);
      const fold = join(folder, stem).toLowerCase();
      const n = (seen.get(fold) ?? 0) + 1;
      seen.set(fold, n);
      if (n > 1) stem = `${stem}~${n}`;
      result.set(join(folder, `${stem}.sql`), bodies);
    }
    return result;
  }
}

function prepareOut(out: string): void {
  if (existsSync(out)) {
    if (!existsSync(join(out, MARKER)) && readdirSync(out).length > 0) {
      throw new Error(`refusing to wipe ${out}: not empty and no ${MARKER} marker`);
    }
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, MARKER), "Generated by split-schema.ts; this folder is wiped on every run.\n");
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "schema" },
      strict: { type: "boolean", default: false },
    },
  });
  const text = readFileSync(positionals[0] ?? 0, "utf8"); // fd 0 = stdin
  const blocks = parseBlocks(text.split(/\r?\n/));
  if (blocks.length === 0) {
    console.error("no pg_dump blocks found in input");
    return 1;
  }

  const splitter = new Splitter(blocks);
  splitter.run();

  const out = values.out!;
  prepareOut(out);
  const files = splitter.paths(out);
  for (const [path, bodies] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${bodies.join("\n\n")}\n`);
  }

  console.error(`${blocks.length} objects -> ${files.size} files in ${out}/`);
  for (const b of splitter.unresolved) {
    console.error(`warning: couldn't place ${b.type} '${b.name}' (schema ${b.schema}); wrote it under ${out}/_unresolved/`);
  }
  return values.strict && splitter.unresolved.length > 0 ? 1 : 0;
}

if (import.meta.main ?? process.argv[1]?.endsWith("split-schema.ts")) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
