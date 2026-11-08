#!/usr/bin/env node
/**
 * Compare the snapshot on disk with the last commit and write a PR description
 * that says, in plain terms, what changed in each contract and whether it can
 * break the other side.
 *
 * Usage:
 *   node scripts/summarize.ts [--out pr-body.md] [--base HEAD]
 *
 * Inside GitHub Actions it also sets the step outputs `changed`, `breaking`, `review`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { QUALIFIED } from "./split-schema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Direction = "outbound" | "inbound";
const DIRECTIONS: Record<Direction, { title: string; flow: string; note: string }> = {
  outbound: { title: "Outbound", flow: "app DB → data warehouse", note: "the warehouse pipeline reads these" },
  inbound: { title: "Inbound", flow: "data warehouse → app DB", note: "the warehouse pipeline writes these" },
};

type Level = "breaking" | "review" | "safe" | "info";
const LEVELS: Level[] = ["breaking", "review", "safe", "info"];
const BADGE: Record<Level, string> = {
  breaking: "🔴 Breaking",
  review: "🟡 Review",
  safe: "🟢 Safe",
  info: "⚪ Info",
};
const KIND_LABEL: Record<string, string> = {
  tables: "table",
  views: "view",
  matviews: "materialized view",
  functions: "function",
  types: "type",
  sequences: "sequence",
  _schema: "schema",
};

const CREATE_RE = new RegExp(
  "^CREATE (?:OR REPLACE )?(?:UNIQUE )?" +
    "(?:TABLE|VIEW|MATERIALIZED VIEW|TYPE|DOMAIN|FUNCTION|PROCEDURE|AGGREGATE|SEQUENCE|SCHEMA) " +
    `(${QUALIFIED})`,
  "m",
);

export interface Change {
  level: Level;
  obj: string;
  text: string;
}

interface Column {
  type: string;
  notNull: boolean;
  default: string | null;
}

// ------------------------------------------------------------------ git helpers
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const hasCommit = (ref: string): boolean =>
  spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: ROOT }).status === 0;

function oldFiles(base: string, folder: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!hasCommit(base)) return files;
  for (const name of git("ls-tree", "-r", "--name-only", base, "--", folder).split("\n")) {
    if (name.endsWith(".sql")) files.set(name, git("show", `${base}:${name}`));
  }
  return files;
}

function newFiles(folder: string): Map<string, string> {
  const files = new Map<string, string>();
  const base = join(ROOT, folder);
  if (!existsSync(base)) return files;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sql")) {
        files.set(relative(ROOT, full).split(sep).join("/"), readFileSync(full, "utf8"));
      }
    }
  };
  walk(base);
  return files;
}

// ------------------------------------------------------------------ parsing
function objectName(path: string, sql: string): string {
  const m = CREATE_RE.exec(sql);
  if (m) return m[1];
  const parts = path.split("/");
  const stem = basename(path, ".sql");
  return parts.length > 2 ? `${parts[1]}.${stem}` : stem;
}

function kindOf(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? parts[2] : basename(path, ".sql");
}

export function parseColumns(sql: string): Map<string, Column> {
  const cols = new Map<string, Column>();
  const m = /^CREATE (?:FOREIGN )?TABLE [^\n]*\(\n(.*?)\n\)/ms.exec(sql);
  if (!m) return cols;
  for (const raw of m[1].split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line || line.startsWith("CONSTRAINT ")) continue;
    const cm = /^("(?:[^"]|"")*"|\S+)\s+(.*)$/.exec(line);
    if (!cm) continue;
    const [, name, rest] = cm;
    const dm = /\bDEFAULT (.+?)(?: NOT NULL)?$/.exec(rest);
    cols.set(name, {
      type: rest.split(/ (?:DEFAULT|NOT NULL|COLLATE|GENERATED)\b/)[0].trim(),
      notNull: /\bNOT NULL\b/.test(rest),
      default: dm ? dm[1] : null,
    });
  }
  return cols;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasIdentity = (sql: string, col: string): boolean =>
  new RegExp(`ALTER COLUMN ${escapeRe(col)} ADD GENERATED`).test(sql);

function parseEnum(sql: string): string[] | null {
  const m = /AS ENUM \((.*?)\);/s.exec(sql);
  return m ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1]) : null;
}

const describe = (c: Column): string => `\`${c.type}${c.notNull ? " NOT NULL" : ""}\``;

// ------------------------------------------------------------------ comparison
function compareTable(direction: Direction, obj: string, oldSql: string, newSql: string): Change[] {
  const out: Change[] = [];
  const a = parseColumns(oldSql);
  const b = parseColumns(newSql);
  for (const [name, col] of b) {
    if (a.has(name)) continue;
    const needsValue = col.notNull && col.default === null && !hasIdentity(newSql, name);
    if (direction === "inbound" && needsValue) {
      out.push({
        level: "breaking",
        obj,
        text: `Required column \`${name}\` ${describe(col)} added; the warehouse pipeline must start supplying it`,
      });
    } else {
      out.push({ level: "safe", obj, text: `Column \`${name}\` ${describe(col)} added` });
    }
  }
  for (const [name, col] of a) {
    if (!b.has(name)) out.push({ level: "breaking", obj, text: `Column \`${name}\` ${describe(col)} removed` });
  }
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y) continue;
    if (x.type !== y.type) {
      out.push({ level: "breaking", obj, text: `Column \`${name}\` type changed \`${x.type}\` → \`${y.type}\`` });
    }
    if (x.notNull && !y.notNull) {
      out.push({ level: direction === "outbound" ? "review" : "safe", obj, text: `Column \`${name}\` now allows NULL` });
    }
    if (!x.notNull && y.notNull) {
      out.push({ level: direction === "inbound" ? "breaking" : "safe", obj, text: `Column \`${name}\` is now NOT NULL` });
    }
    if (x.default !== y.default) {
      out.push({ level: "info", obj, text: `Column \`${name}\` default \`${x.default}\` → \`${y.default}\`` });
    }
  }
  if (out.length === 0) out.push({ level: "info", obj, text: "Indexes, constraints, triggers or comments changed" });
  return out;
}

function compareFile(direction: Direction, path: string, oldSql?: string, newSql?: string): Change[] {
  const kind = kindOf(path);
  const label = KIND_LABEL[kind] ?? kind.replace(/s$/, "");
  const Label = label[0].toUpperCase() + label.slice(1);
  const obj = objectName(path, newSql ?? oldSql ?? "");
  if (oldSql === undefined) {
    const cols = parseColumns(newSql ?? "");
    return [{ level: "safe", obj, text: `New ${label}${cols.size ? ` with ${cols.size} columns` : ""}` }];
  }
  if (newSql === undefined) return [{ level: "breaking", obj, text: `${Label} removed` }];
  if (kind === "tables") return compareTable(direction, obj, oldSql, newSql);
  if (kind === "types") {
    const ea = parseEnum(oldSql);
    const eb = parseEnum(newSql);
    if (ea && eb) {
      const changes: Change[] = [
        ...eb.filter((v) => !ea.includes(v)).map((v): Change => ({
          level: "review",
          obj,
          text: `Enum value \`${v}\` added; make sure the other side maps it`,
        })),
        ...ea.filter((v) => !eb.includes(v)).map((v): Change => ({
          level: "breaking",
          obj,
          text: `Enum value \`${v}\` removed`,
        })),
      ];
      if (changes.length) return changes;
    }
  }
  return [{ level: "review", obj, text: `${Label} definition changed` }];
}

export function collect(base: string): Record<Direction, Change[]> {
  const result = {} as Record<Direction, Change[]>;
  for (const folder of Object.keys(DIRECTIONS) as Direction[]) {
    const before = oldFiles(base, folder);
    const after = newFiles(folder);
    const changes: Change[] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (before.get(path) !== after.get(path)) {
        changes.push(...compareFile(folder, path, before.get(path), after.get(path)));
      }
    }
    result[folder] = changes.sort(
      (x, y) => LEVELS.indexOf(x.level) - LEVELS.indexOf(y.level) || (x.obj < y.obj ? -1 : x.obj > y.obj ? 1 : 0),
    );
  }
  return result;
}

// ------------------------------------------------------------------ output
export function render(result: Record<Direction, Change[]>): string {
  const every = Object.values(result).flat();
  const count = (l: Level) => every.filter((c) => c.level === l).length;
  const headline = LEVELS.filter((l) => count(l))
    .map((l) => `${count(l)} ${BADGE[l].split(" ")[1].toLowerCase()}`)
    .join(" · ");

  const lines = ["## Schema contract changes", ""];
  if (count("breaking")) {
    lines.push(
      "> [!CAUTION]",
      "> This PR contains **breaking** changes. Coordinate with the other side before the next pipeline run.",
      "",
    );
  } else if (count("review")) {
    lines.push("> [!WARNING]", "> Some changes need a quick check by the other side.", "");
  }
  lines.push(`**${headline || "No changes"}**`, "");
  for (const folder of Object.keys(DIRECTIONS) as Direction[]) {
    const { title, flow, note } = DIRECTIONS[folder];
    lines.push(`### ${title} (${flow})`, `_${note}_`, "");
    const changes = result[folder];
    if (!changes.length) {
      lines.push("No changes.", "");
      continue;
    }
    lines.push("| | Object | Change |", "|---|---|---|");
    for (const c of changes) lines.push(`| ${BADGE[c.level]} | \`${c.obj}\` | ${c.text} |`);
    lines.push("");
  }
  lines.push(
    "---",
    "_Opened automatically by the schema snapshot workflow. The **Files changed** tab " +
      "shows the exact DDL. Merging this PR records the new state as the baseline._",
  );
  return `${lines.join("\n")}\n`;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "HEAD" },
      out: { type: "string" },
    },
  });
  const result = collect(values.base!);
  const every = Object.values(result).flat();
  const body = render(result);
  if (values.out) writeFileSync(values.out, body);
  else process.stdout.write(body);

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    appendFileSync(
      ghOut,
      `changed=${every.length > 0}\n` +
        `breaking=${every.filter((c) => c.level === "breaking").length}\n` +
        `review=${every.filter((c) => c.level === "review").length}\n`,
    );
  }
  return 0;
}

if (import.meta.main ?? process.argv[1]?.endsWith("summarize.ts")) {
  process.exitCode = main();
}
