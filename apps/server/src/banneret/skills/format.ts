import { parse } from "yaml";

export const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseSkill(text: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(text);
  if (!front || !text.slice(front[0].length).trim())
    throw new Error("Include SKILL.md frontmatter and instructions.");
  const meta = parse(front[1]!, { maxAliasCount: 0 }) as Record<string, unknown> | null;
  if (
    typeof meta?.name !== "string" ||
    !skillName.test(meta.name) ||
    meta.name.length > 96 ||
    typeof meta.description !== "string" ||
    !meta.description.trim()
  )
    throw new Error("Give the skill a lowercase hyphenated name and a description.");
  return { name: meta.name, description: meta.description, text };
}
