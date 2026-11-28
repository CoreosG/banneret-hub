import type { AgentAskPolicy } from "@t3tools/contracts";
import { useState } from "react";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import { handles, useChatRead } from "./client";

export function AskSettings({
  enterprise,
  policy,
  save,
}: {
  enterprise: EnterpriseFeed;
  policy: AgentAskPolicy;
  save: (policy: AgentAskPolicy) => void;
}) {
  const [scope, setScope] = useState("person");
  const people = enterprise.feed.team?.value?.people ?? [];
  // The relay saves no new rule naming an outside collaborator or their agent.
  const members = people.filter((p) => p.admission !== "outside");
  const outsiders = new Set(people.filter((p) => p.admission === "outside").map((p) => p.login));
  const roles = [...new Map(members.map((p) => [p.role.id, p.role])).values()];
  const agents = useChatRead(() => handles(enterprise.target), enterprise.feed.chatRevision ?? 0);
  const options =
    scope === "role"
      ? roles.map((r) => ({ id: r.id, label: r.name }))
      : scope === "agent"
        ? (agents.value ?? [])
            .filter((h) => !outsiders.has(h.owner))
            .map((h) => ({ id: h.id, label: h.login }))
        : members.map((p) => ({ id: p.id, label: p.login }));
  return (
    <section className="grid gap-3">
      <label>
        Asks from other people's agents{" "}
        <select
          value={policy.default}
          onChange={(e) =>
            save({ ...policy, default: e.target.value === "off" ? "off" : "approve" })
          }
        >
          <option value="approve">Ask me each time</option>
          <option value="off">Off</option>
        </select>
      </label>
      <form
        key={[policy.maxTokens, policy.maxSeconds, policy.usageWindowBelowPercent].join(":")}
        className="grid gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const guard = data.get("usage");
          const { usageWindowBelowPercent: _, ...rest } = policy;
          save({
            ...rest,
            maxTokens: Number(data.get("tokens")),
            maxSeconds: Number(data.get("seconds")),
            ...(guard ? { usageWindowBelowPercent: Number(guard) } : {}),
          });
        }}
      >
        <label>
          Maximum tokens{" "}
          <input name="tokens" type="number" min={1} required defaultValue={policy.maxTokens} />
        </label>
        <label>
          Maximum seconds{" "}
          <input name="seconds" type="number" min={1} required defaultValue={policy.maxSeconds} />
        </label>
        <label>
          Auto-accept only below usage (%){" "}
          <input
            name="usage"
            type="number"
            min={0}
            max={100}
            defaultValue={policy.usageWindowBelowPercent}
          />
        </label>
        <button>Save limits</button>
      </form>
      <h3>Auto-accept rules</h3>
      <ul>
        {policy.auto.map((r, i) => (
          <li key={JSON.stringify(r)}>
            {"person" in r.from
              ? r.from.person.login
              : "agent" in r.from
                ? (new Map(agents.value?.map((h) => [h.id, h.login])).get(r.from.agent) ??
                  r.from.agent)
                : r.from.role.name}{" "}
            · {r.kinds.join(", ")}{" "}
            <button
              onClick={() =>
                save({ ...policy, auto: policy.auto.filter((_, index) => i !== index) })
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const id = data.get("subject");
          const entry = options.find((o) => o.id === id);
          if (!entry) return;
          const kind = data.get("kind");
          const rule: AgentAskPolicy["auto"][number] =
            scope === "agent"
              ? { from: { agent: entry.id }, kinds: ["question"] }
              : scope === "role"
                ? { from: { role: { id: entry.id, name: entry.label } }, kinds: ["question"] }
                : {
                    from: { person: { id: entry.id, login: entry.label } },
                    kinds: [kind === "review" || kind === "handoff" ? kind : "question"],
                  };
          if (!policy.auto.some((existing) => JSON.stringify(existing) === JSON.stringify(rule)))
            save({ ...policy, auto: [...policy.auto, rule] });
        }}
      >
        <label>
          From{" "}
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="person">Person</option>
            <option value="agent">Agent</option>
            <option value="role">Role</option>
          </select>
        </label>
        <select aria-label="Rule subject" name="subject" key={scope}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select aria-label="Auto-accept kind" name="kind" key={"kind:" + scope}>
          <option value="question">Questions</option>
          {scope === "person" && (
            <>
              <option value="review">Reviews</option>
              <option value="handoff">Hand-offs</option>
            </>
          )}
        </select>
        <button disabled={!options.length}>Add rule</button>
      </form>
      {agents.error && <p role="alert">{agents.error}</p>}
    </section>
  );
}
