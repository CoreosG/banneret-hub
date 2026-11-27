import * as Schema from "effect/Schema";
import { parse, stringify } from "yaml";
import type { Proposal } from "./store.ts";

class MemoryFileError extends Schema.TaggedError<
  MemoryFileError,
  { readonly brand: unique symbol }
>()("MemoryFileError", { message: Schema.String }) {}
export const isMemoryFileError = Schema.is(MemoryFileError);

const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_|github_pat_|sk-(?:ant-)?|xox[baprs]-|glpat-|AIza)[A-Za-z0-9_-]{16,}/,
  /(?:\b|_)(?:token|password|api[_-]?key|secret|authorization)["']?\s*[:=]\s*["']?(?:bearer\s+)?[A-Za-z0-9+/_=.-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

export function scanMemory(value: string) {
  if (secretPatterns.some((pattern) => pattern.test(value)))
    throw new MemoryFileError({
      message: "Refused: this note appears to contain a token, password or private key.",
    });
}

export function formatNote(row: Record<string, unknown>) {
  const {
    key,
    kind,
    scope,
    source,
    createdAt,
    confirmedAt,
    lastUsedAt,
    useCount,
    pinned,
    disputedAt,
    disputeReason,
    trust,
    text,
  } = row;
  const header = stringify({
    name: key,
    description: String(text).split("\n")[0]?.slice(0, 160),
    type: kind,
    key,
    kind,
    scope,
    source,
    created: createdAt,
    confirmedAt,
    lastUsedAt,
    useCount,
    pinned,
    disputedAt,
    disputeReason,
    trust,
  });
  return `---\n${header}---\n${text}\n`;
}

export function parseNote(filename: string, content: string) {
  if (!/^[^/\\\x00-\x1f]+\.md$/i.test(filename))
    throw new MemoryFileError({ message: "Choose a Markdown file." });
  scanMemory(filename + "\n" + content);
  const normalized = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)^---[ \t]*(?:\n|$)/m.exec(normalized);
  let meta: Record<string, unknown> = {};
  if (normalized.startsWith("---\n")) {
    if (!match || match.index !== 0)
      throw new MemoryFileError({ message: "Incomplete frontmatter." });
    try {
      const value: unknown = parse(match[1]!, { maxAliasCount: 0 });
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      meta = value as Record<string, unknown>;
    } catch {
      throw new MemoryFileError({ message: "Invalid note frontmatter." });
    }
  }
  const text = normalized
    .slice(normalized.startsWith("---\n") ? match![0].length : 0)
    .replace(/\n$/, "");
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 96)
      .replace(/^-|-$/g, "");
  const key = meta.key ?? slug(typeof meta.name === "string" ? meta.name : filename.slice(0, -3));
  const kind = meta.kind ?? meta.type ?? "project";
  if (
    typeof key !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) ||
    key.length > 96 ||
    !text.trim() ||
    text.length > 4096
  )
    throw new MemoryFileError({
      message: "A note needs a valid key and 1 to 4096 characters of text.",
    });
  if (kind !== "project" && kind !== "reference" && kind !== "feedback" && kind !== "user")
    throw new MemoryFileError({ message: "Unknown note type." });
  const note: Proposal = {
    key,
    text,
    kind,
    scope: meta.scope === "personal" ? "personal" : "project",
    source: typeof meta.source === "string" ? meta.source.slice(0, 512) : filename,
    why: "Imported from " + filename,
  };
  return { note, meta };
}

export function parseImport(name: string, content: string) {
  if (!/^(?:AGENTS|CLAUDE)\.md$/i.test(name) || content.length <= 4096)
    return [parseNote(name, content).note];
  scanMemory(content);
  const parts: Proposal[] = [];
  let rest = content.replaceAll("\r\n", "\n");
  while (rest.length) {
    let end = Math.min(4096, rest.length);
    if (end < rest.length) {
      const newline = rest.lastIndexOf("\n", end - 1);
      if (newline >= 0) end = newline + 1;
      else if (/[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
    }
    const part = rest.slice(0, end);
    rest = rest.slice(end);
    if (part.trim()) {
      const stem = name.slice(0, -3).toLowerCase();
      parts.push({
        key: stem + "-" + (parts.length + 1),
        kind: "project",
        scope: "project",
        source: name,
        why: "Imported from " + name,
        text: part,
      });
    }
  }
  if (!parts.length) throw new MemoryFileError({ message: "The rules file is empty." });
  return parts;
}
