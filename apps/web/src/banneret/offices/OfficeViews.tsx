import { MeetingEditor, PresenceForm, SharingForm } from "./OfficeSettings";
import { OfficeChat, RoomChannel, Message } from "./OfficeChat";
import { Meeting } from "./Meeting";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import * as Schema from "effect/Schema";
import { usePoolResources } from "../ui/MachineResources";
import {
  allBoardCards,
  type PoolResources,
  type BanneretTeam,
  type BanneretBoardEntry,
  type OfficeSummary,
} from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { drawSprite, personForLogin, spriteSize } from "./sprites";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import type { RelayTarget } from "../enrolmentStore";
import { useRoomSessions } from "./useRoomSessions";
import { ChevronRightIcon } from "lucide-react";
import { useUrlSearch } from "../useUrlSearch";
import { rememberFilters } from "../filterMemory";
import { FilterBox } from "../ui/FilterBox";
import { AgentCounts, Claims, DeskDetails, labels, states } from "./DeskDetails";
import { QuietLine } from "../ui/QuietLine";
import { groupBy } from "effect/Array";
import {
  createAgentIndex,
  needsAgent,
  useAgentIndex,
  useAgentPage,
  type AgentIndex,
} from "./agentIndex";

const TeamOffice = lazy(() => import("./office/TeamOffice"));

type Person = BanneretTeam["people"][number];
type Office = NonNullable<BanneretTeam["office"]>;
type Counts = OfficeSummary["hallway"]["counts"];
type Props = { enterprise: EnterpriseFeed; people: readonly Person[]; office: Office };
const countText = (counts?: Counts) =>
  states
    .filter((k) => counts?.[k])
    .map((k) => counts?.[k] + " " + labels[k].toLowerCase())
    .join(" · ");
const value = (v: unknown) => (typeof v === "string" ? v : "");

function PersonSprite({ login }: { login: string }) {
  return (
    <canvas
      aria-hidden
      width={spriteSize}
      height={spriteSize}
      className="mr-1 inline-block size-8 align-middle"
      ref={(node) => {
        const ctx = node?.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, spriteSize, spriteSize);
          drawSprite(
            ctx,
            personForLogin(login),
            0,
            0,
            1,
            document.documentElement.classList.contains("dark") ? "dark" : "light",
            "full",
          );
        }
      }}
    />
  );
}

function Select({
  label,
  selected,
  options,
  change,
}: {
  label: string;
  selected: string;
  options: readonly (readonly [string, string])[];
  change: (s: string) => void;
}) {
  return (
    <select
      className="rounded-md border bg-background px-2 py-1 text-sm"
      aria-label={label}
      value={selected}
      onChange={(e) => change(e.target.value)}
    >
      <option value="">
        {label === "Presence" ? "Any presence" : "All " + label.toLowerCase()}
      </option>
      {options.map(([k, v]) => (
        <option value={k} key={k}>
          {v}
        </option>
      ))}
    </select>
  );
}

function Hallway({
  target,
  revision,
  people,
  index,
  hasBoardDesk,
  pool,
  flags,
}: {
  people: readonly Person[];
  index: AgentIndex;
  hasBoardDesk: (p: Person) => boolean;
  pool: PoolResources | null;
  flags: readonly string[];
  target: RelayTarget;
  revision: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { sessions, retry } = useRoomSessions(target, null, revision, open);
  const indexState = useAgentIndex(index);
  const owned = groupBy(sessions ?? [], (s) => s.personId);
  const desks = open ? people.filter((p) => Object.hasOwn(owned, p.id) || !hasBoardDesk(p)) : [];
  useAgentPage(
    index,
    open &&
      (desks.slice(0, 12).some((p) => needsAgent(indexState, p.id)) ||
        (desks.length < 12 && people.some((p) => needsAgent(indexState, p.id)))),
  );
  return (
    <details className="rounded-lg border p-3" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Hallway</summary>
      {open &&
        (sessions ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {desks.slice(0, 12).map((p) => (
              <article
                key={p.id}
                data-person={p.login}
                className="min-w-0 space-y-1 rounded-md border p-3 text-sm"
              >
                <DeskDetails
                  p={p}
                  counts={indexState.byPerson.get(p.id)?.counts}
                  agents={Object.hasOwn(owned, p.id) ? owned[p.id]! : []}
                  cards={[]}
                  flags={flags}
                  pool={pool}
                  target={target}
                  visible
                />
              </article>
            ))}
            {desks.length > 12 && <p>{desks.length - 12} more</p>}
          </div>
        ) : sessions === null ? (
          <button onClick={retry}>Retry hallway</button>
        ) : (
          "Loading agents…"
        ))}
    </details>
  );
}

function Room({
  room,
  board,
  people,
  initialOpen,
  founder,
  index,
  revision,
  seatFor,
  target,
  state,
  flags,
  pool,
}: {
  room: OfficeSummary["rooms"][number];
  board: BanneretBoardEntry | undefined;
  people: readonly Person[];
  initialOpen: boolean;
  founder: boolean;
  index: AgentIndex;
  revision: string | undefined;
  seatFor: (p: Person, board: string) => string | undefined;
  target: RelayTarget;
  state: string;
  flags: readonly string[];
  pool: PoolResources | null;
}) {
  const [override, toggle] = useState<boolean>();
  const open = override ?? initialOpen;
  const ref = useRef<HTMLElement>(null);
  const [visible, show] = useState(false);
  const { sessions, retry } = useRoomSessions(target, room.board, revision, open && visible);
  const indexState = useAgentIndex(index);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribe to the scroll viewport
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) =>
      show(entries[0]?.isIntersecting ?? false),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const owned = groupBy(sessions ?? [], (s) => s.personId);
  const claims = groupBy(
    (board?.board?.cards ?? []).filter((c) => c.lease),
    (c) => c.lease!.holder.login,
  );
  const desks = people.flatMap((p) => {
    const agents = (Object.hasOwn(owned, p.id) ? owned[p.id] : undefined) ?? [];
    const cards = (Object.hasOwn(claims, p.login) ? claims[p.login] : undefined) ?? [];
    if (!cards.length && !agents.length) return [];
    const seated =
      (p.presence === "available" || p.presence === "focusing") &&
      seatFor(p, room.board) === room.board;
    const counts = indexState.byPerson.get(p.id)?.counts;
    if (state && !counts?.[state as keyof Counts]) return [];
    return [{ p, counts, cards, agents, seated }];
  });
  const needed =
    visible &&
    open &&
    (desks.slice(0, 12).some((d) => needsAgent(indexState, d.p.id)) ||
      (!!state && people.some((p) => owned[p.id] && needsAgent(indexState, p.id))));
  useAgentPage(index, needed);
  return (
    <section
      ref={ref}
      className="rounded-lg border bg-card"
      aria-label={board?.title ?? room.board}
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2">
        <button
          className="flex flex-1 flex-wrap items-baseline gap-2 text-start"
          type="button"
          aria-expanded={open}
          onClick={() => toggle(!open)}
        >
          <ChevronRightIcon
            aria-hidden
            className={open ? "size-4 rotate-90 self-center" : "size-4 self-center"}
          />
          <strong>{board?.title ?? room.board}</strong>
          <span className="text-xs text-muted-foreground">
            {room.desks} desks · {room.active} active
            {countText(room.counts) && " · " + countText(room.counts)}
          </span>
        </button>
        <RoomChannel board={room.board} title={board?.title ?? room.board} />
        {flags.includes("meeting_links") && (
          <>
            <Meeting url={room.meetingUrl} />
            {founder && <MeetingEditor target={target} board={room.board} url={room.meetingUrl} />}
          </>
        )}
      </header>
      {open && (
        <div className="border-t p-3">
          {!sessions ? (
            sessions === null ? (
              <button onClick={retry}>Retry room</button>
            ) : (
              <p>Loading desks…</p>
            )
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {desks.slice(0, 12).map(({ p, counts, cards, agents, seated }) => (
                  <article
                    key={p.id}
                    data-person={p.login}
                    className="min-w-0 space-y-1 rounded-md border p-3 text-sm"
                  >
                    {seated && <PersonSprite login={p.login} />}
                    <DeskDetails {...{ p, counts, agents, cards, flags, target, visible, pool }} />
                  </article>
                ))}
              </div>
              {desks.length > 12 && <p>{desks.length - 12} more</p>}
              {!desks.length && <p>No matching desks.</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function OfficeViews({ enterprise, office, people }: Props) {
  const community = office.preset === "community";
  const [showMachines, setShowMachines] = useState(false);
  const machinesVisible = !community || showMachines;
  const pool = usePoolResources(
    enterprise.target,
    machinesVisible && enterprise.feed.sections.includes("pool"),
  );
  const [raw, set] = useUrlSearch();
  const filters = {
    q: value(raw.q) || value(raw.person),
    board: value(raw.board),
    state: value(raw.state),
    presence: value(raw.presence),
  };
  const update = (patch: Partial<typeof filters>) => {
    rememberFilters(enterprise.workspace.id, "team", { ...filters, ...patch });
    set({ ...filters, ...patch, person: undefined }, { replace: true });
  };

  const preferenceKey = "banneret.team.view." + enterprise.workspace.id;
  const simple = useMediaQuery("(prefers-reduced-motion: reduce), (forced-colors: active)");
  const [preferred, rememberView] = useLocalStorage(preferenceKey, "", Schema.String);
  const list = raw.view === "list" || (!raw.view && (!!raw.person || preferred === "List"));
  const showOffice =
    raw.view === "office" || (!raw.view && !raw.person && !simple && preferred === "Office");
  const selection = JSON.stringify(filters);
  const [position, scroll] = useState({ selection, start: 0 });
  const start = position.selection === selection ? position.start : 0;
  const { summary } = office;
  const flags = machinesVisible ? office.flags : office.flags.filter((f) => f !== "sharing");
  const [cached, setCached] = useState(() => ({
    revision: office.revision,
    index: createAgentIndex(enterprise.target, summary),
  }));
  if (cached.revision !== office.revision)
    setCached({ revision: office.revision, index: createAgentIndex(enterprise.target, summary) });
  const { index } = cached;
  const indexState = useAgentIndex(index);
  const { byPerson, error } = indexState;
  const me = people.find((p) => p.login === enterprise.enrolment.me?.login);
  const boards = enterprise.feed.board?.value?.boards ?? [];
  const boardById = new Map(boards.map((b) => [b.id, b]));
  const claims = boards.flatMap((b) =>
    (b.board?.cards ?? []).flatMap((c) =>
      c.lease ? [{ board: b.id, login: c.lease.holder.login }] : [],
    ),
  );
  const cardsByLogin = groupBy(
    allBoardCards(enterprise.feed.board?.value).filter((c) => c.lease),
    (c) => c.lease!.holder.login,
  );
  const cardsFor = (login: string) =>
    Object.hasOwn(cardsByLogin, login) ? cardsByLogin[login]! : [];
  const candidates = people.filter(
    (p) =>
      (!filters.presence || p.presence === filters.presence) &&
      [p.login, p.displayName].some((n) => n?.toLowerCase().includes(filters.q.toLowerCase())),
  );
  const matches = candidates.filter((p) => {
    const a = byPerson.get(p.id);
    return (
      (!filters.state || !!a?.counts[filters.state as keyof Counts]) &&
      (!filters.board ||
        a?.rooms.some((r) => r.board === filters.board) ||
        claims.some((c) => c.board === filters.board && c.login === p.login))
    );
  });
  const unresolved = (p: Person) => needsAgent(indexState, p.id);
  const filterPerson = Boolean(filters.q || filters.presence);
  const more = list
    ? matches.slice(start, start + 25).some(unresolved) ||
      (matches.length < start + 25 && candidates.some(unresolved))
    : (!!me && unresolved(me)) || (filterPerson && candidates.some(unresolved));
  useAgentPage(index, more || (showOffice && !!filters.state && candidates.some(unresolved)));
  function hasDesk(p: Person, board: string) {
    return (
      byPerson.get(p.id)?.rooms.some((r) => r.board === board) ||
      claims.some((c) => c.login === p.login && c.board === board)
    );
  }
  function seatFor(p: Person, here: string) {
    const has = (board: string) => here === board || hasDesk(p, board);
    return p.seatBoard && has(p.seatBoard)
      ? p.seatBoard
      : summary.rooms.find((r) => has(r.board))?.board;
  }
  const hasBoardDesk = (p: Person) =>
    summary.rooms.some((r) => hasDesk(p, r.board)) || unresolved(p);
  const roomList = summary.rooms.filter(
    (r) =>
      (!filters.board || r.board === filters.board) &&
      (!filters.state || r.counts[filters.state as keyof Counts] > 0) &&
      (!filterPerson || candidates.some((p) => hasDesk(p, r.board))),
  );
  return (
    <OfficeChat enterprise={enterprise}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Team view" className="flex rounded-md border">
          {["Floor", "List", "Office"].map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={name === (list ? "List" : showOffice ? "Office" : "Floor")}
              className="px-3 py-1 text-sm aria-pressed:bg-accent"
              onClick={() => {
                rememberView(name);
                scroll({ selection, start: 0 });
                set({ view: name.toLowerCase() }, { replace: true });
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {flags.includes("meeting_links") && (
          <>
            <Meeting url={summary.office.meetingUrl} />
            {enterprise.enrolment.me?.role === "founder" && (
              <MeetingEditor
                target={enterprise.target}
                board={null}
                url={summary.office.meetingUrl}
              />
            )}
          </>
        )}
      </div>
      {showOffice && me && (
        <details className="max-h-64 overflow-auto">
          <summary className="cursor-pointer text-sm">My office</summary>
          <div className="grid max-w-xl gap-4 py-2">
            {flags.some((f) => f === "presence" || f === "status") && (
              <PresenceForm enterprise={enterprise} person={me} />
            )}
            {office.flags.includes("sharing") && <SharingForm enterprise={enterprise} />}
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {community && office.flags.includes("sharing") && (
          <label>
            <input
              type="checkbox"
              checked={showMachines}
              onChange={(e) => setShowMachines(e.target.checked)}
            />{" "}
            Show machines
          </label>
        )}
        <FilterBox
          placeholder="Find a person"
          label="Find a person"
          value={filters.q}
          onChange={(q) => update({ q })}
        />
        <Select
          label="Boards"
          selected={filters.board}
          options={summary.rooms.map((r) => [r.board, boardById.get(r.board)?.title ?? r.board])}
          change={(board) => update({ board })}
        />
        <Select
          label="Agent states"
          selected={filters.state}
          options={states.map((k) => [k, labels[k]])}
          change={(state) => update({ state })}
        />
        {flags.includes("presence") && (
          <Select
            label="Presence"
            selected={filters.presence}
            options={["available", "focusing", "away", "off"].map((k) => [k, k])}
            change={(presence) => update({ presence })}
          />
        )}
      </div>
      {error && <button onClick={() => index.retry()}>Retry agent counts</button>}
      {!people.length ? (
        <QuietLine fact="Nobody is here yet." />
      ) : showOffice ? (
        <Suspense fallback={<p>Loading office…</p>}>
          <TeamOffice
            pool={pool}
            index={index}
            cardsFor={cardsFor}
            viewer={me?.login}
            target={enterprise.target}
            office={{ ...office, flags }}
            rooms={roomList}
            boards={boardById}
            people={filters.state ? matches : candidates}
            seatFor={seatFor}
            hallway={!filters.board && !filters.state}
            hasBoardDesk={hasBoardDesk}
            openList={(board) => set({ view: "list", board }, { replace: true })}
          />
        </Suspense>
      ) : list ? (
        <div
          key={selection}
          role="list"
          aria-label="Team members"
          className="max-h-[1008px] min-h-0 flex-1 overflow-auto"
          onScroll={(e) => {
            const next = Math.max(0, Math.floor(e.currentTarget.scrollTop / 48) - 2);
            if (next !== start) scroll({ selection, start: next });
          }}
        >
          <div style={{ height: matches.length * 48, position: "relative" }}>
            {matches.slice(start, start + 25).map((p, i) => (
              <div
                key={p.id}
                role="listitem"
                data-person={p.login}
                className="absolute flex h-12 w-full items-center gap-3 border-b px-3 text-sm"
                style={{ top: (start + i) * 48 }}
              >
                <strong>{p.displayName ?? p.login}</strong>
                <Message person={p} target={enterprise.target} />
                {flags.includes("presence") && p.presence}
                {flags.includes("status") && <span className="truncate">{p.status?.text}</span>}
                <div className="flex min-w-0 gap-2 overflow-x-auto">
                  <Claims cards={cardsFor(p.login)} login={p.login} target={enterprise.target} />
                </div>
                <span className="ml-auto">
                  <AgentCounts counts={byPerson.get(p.id)?.counts} />
                </span>
              </div>
            ))}
          </div>
          {!matches.length && <QuietLine fact="No matching people." />}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {!filters.board && !filters.state && (
            <Hallway
              people={candidates}
              {...{ hasBoardDesk, index, pool, flags }}
              target={enterprise.target}
              revision={office.files["team.hallway"]}
            />
          )}
          {roomList.map((room) => (
            <Room
              founder={enterprise.enrolment.me?.role === "founder"}
              pool={pool}
              key={room.board}
              revision={office.files["team.room." + room.board]}
              index={index}
              seatFor={seatFor}
              room={room}
              board={boardById.get(room.board)}
              flags={flags}
              target={enterprise.target}
              people={candidates}
              state={filters.state}
              initialOpen={Boolean(
                filters.q ||
                filters.presence ||
                filters.board ||
                filters.state ||
                byPerson.get(me?.id ?? "")?.rooms.some((r) => r.board === room.board) ||
                claims.some((c) => c.board === room.board && c.login === me?.login),
              )}
            />
          ))}
          {!roomList.length && <QuietLine fact="No matching rooms." />}
        </div>
      )}
    </OfficeChat>
  );
}
