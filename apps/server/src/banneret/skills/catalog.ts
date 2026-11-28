// @effect-diagnostics nodeBuiltinImport:off - read bounded SKILL.md files from the calling checkout.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadId, EnvironmentId } from "@t3tools/contracts";
import { BanneretEnrolment } from "../relay/Enrolment.ts";
import { BanneretRelayFeed } from "../relay/RelayFeed.ts";
import { memoryAccess, unavailable } from "../memory/access.ts";
import { defaultText } from "./defaults.ts";
import { parseSkill, skillName } from "./format.ts";

export const defaults = defaultText.map((text) => ({
  ...parseSkill(text),
  layer: "default",
  trust: "trusted",
}));
type Skill = ReturnType<typeof parseSkill> & {
  layer: string;
  trust: string;
  locked?: boolean;
  key?: string;
};

export function mergeSkills(...layers: ReadonlyArray<Skill>[]) {
  const effective = new Map<string, Skill>();
  for (const layer of layers)
    for (const skill of layer) {
      if (!effective.get(skill.name)?.locked) effective.set(skill.name, skill);
    }
  return effective;
}

export async function projectSkills(root: string) {
  const dir = NodePath.join(await NodeFSP.realpath(root).catch(() => root), "skills");
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (!entries.length || (await NodeFSP.realpath(dir)) !== dir) return [];
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !skillName.test(entry.name)) continue;
    const file = NodePath.join(dir, entry.name, "SKILL.md");
    const stat = await NodeFSP.lstat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > 65536) continue;
    const skill = parseSkill(await NodeFSP.readFile(file, "utf8"));
    if (skill.name === entry.name) skills.push({ ...skill, layer: "project", trust: "trusted" });
  }
  return skills;
}

const companyCatalog = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      text: Schema.String,
      locked: Schema.Boolean,
    }),
  ),
});
const advertised = Schema.is(
  Schema.Struct({ skills: Schema.Struct({ registry: Schema.Literal(true) }) }),
);
export const skillCatalog = Effect.fn("BanneretSkills.catalog")(
  function* (thread: ThreadId, environment: EnvironmentId) {
    const access = yield* memoryAccess(thread, environment, "skills");
    // Skills owned elsewhere leave only the person's own and the checkout's.
    const registry = !(
      access.origin && (yield* (yield* BanneretRelayFeed).elsewhere(access.origin))?.skills
    );
    let company: Skill[] = [];
    if (access.origin && registry) {
      const relay = yield* (yield* BanneretEnrolment).relay(access.origin);
      if (!relay) return yield* unavailable();
      const caps = yield* relay.signedGet("/relay/v1/capabilities");
      if (caps.status !== 200) return yield* unavailable();
      if (advertised(caps.body)) {
        const reply = yield* relay.signedGet("/relay/v1/skills");
        if (reply.status !== 200) return yield* unavailable();
        const data = yield* Schema.decodeUnknownEffect(companyCatalog)(reply.body);
        company = yield* Effect.try({
          try: () =>
            data.skills.map((entry) => {
              const skill = parseSkill(entry.text);
              if (entry.name !== skill.name || entry.description !== skill.description)
                throw new Error("Invalid company skill.");
              return { ...skill, locked: entry.locked, layer: "company", trust: "trusted" };
            }),
          catch: unavailable,
        });
      }
    }
    const project = yield* Effect.tryPromise({
      try: () => projectSkills(access.root),
      catch: unavailable,
    });
    const notes = yield* access.open((s) =>
      s
        .list(false)
        .filter(
          (row) =>
            row.kind === "skill" && !["proposed", "disputed", "archived"].includes(row.trust),
        )
        .map((row) => ({
          ...parseSkill(row.text),
          layer: row.scope,
          trust: row.trust,
          key: row.key,
        })),
    );
    const skills = mergeSkills(
      registry ? defaults : [],
      company,
      project,
      notes.filter((s) => s.layer === "project"),
      notes.filter((s) => s.layer === "personal"),
    );
    return { access, skills };
  },
  Effect.mapError(() => unavailable()),
);

export const describeSkill = (skill: Skill) => ({
  name: skill.name,
  description: skill.description,
  layer: skill.layer,
  trust: skill.trust,
  locked: skill.locked ?? false,
});
