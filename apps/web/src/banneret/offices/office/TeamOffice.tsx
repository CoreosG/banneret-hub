import { RoomChannel } from "../OfficeChat";
import { Link } from "@tanstack/react-router";
import { PersonRoomAgents } from "../AgentDetails";
import { DeskDetails } from "../DeskDetails";
import { type AgentIndex, needsAgent, useAgentIndex, useAgentPage } from "../agentIndex";
import {
  type BanneretBoardCard,
  type PoolResources,
  officeMeetingUrlValid,
} from "@t3tools/contracts";
import { Meeting } from "../Meeting";
import { LinkIcon } from "lucide-react";
import type { BanneretBoardEntry, BanneretTeam, OfficeSummary } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { observeResize } from "../../../lib/observeResize";
import type { RelayTarget } from "../../enrolmentStore";
import { useRoomSessions } from "../useRoomSessions";
import type { Theme } from "../sprites";
import { frameQueue, intersects, pixelRatio, packRooms, zoomSteps } from "./camera";
import { detailFor, dimensions, layout, type Desk, type Item, type Person } from "./layout";
import { officePaint } from "./paint";

type Room = OfficeSummary["rooms"][number];
type Props = {
  target: RelayTarget;
  office: NonNullable<BanneretTeam["office"]>;
  rooms: readonly Room[];
  boards: ReadonlyMap<string, BanneretBoardEntry>;
  people: readonly Person[];
  seatFor: (p: Person, board: string) => string | undefined;
  index: AgentIndex;
  cardsFor: (login: string) => readonly BanneretBoardCard[];
  pool: PoolResources | null;
  viewer: string | undefined;
  hallway: boolean;
  hasBoardDesk: (p: Person) => boolean;
  openList: (board: string | undefined) => void;
};
type Draw = (c: CanvasRenderingContext2D) => void;
function renderer() {
  const dirty = new Map<string, Draw>();
  const versions = new Map<string, { signature: string; paint: ReturnType<typeof officePaint> }>();
  let canvas: HTMLCanvasElement | null = null;
  const clears = new Set<Draw>();
  const frames = frameQueue(() => {
    const ctx = canvas?.getContext("2d");
    if (ctx) for (const clear of clears) clear(ctx);
    clears.clear();
    if (ctx) for (const draw of dirty.values()) draw(ctx);
    dirty.clear();
  });
  return {
    attach(node: HTMLCanvasElement | null) {
      canvas = node;
    },
    set(key: string, signature: string, paint: ReturnType<typeof officePaint>, draw: Draw) {
      const last = versions.get(key);
      if (last?.signature === signature && last.paint === paint) return;
      versions.set(key, { signature, paint });
      dirty.set(key, draw);
      frames.request();
    },
    remove(key: string, clear: Draw) {
      versions.delete(key);
      dirty.delete(key);
      clears.add(clear);
      frames.request();
    },
    cancel() {
      versions.clear();
      clears.clear();
      frames.cancel();
      dirty.clear();
    },
  };
}
function OfficeRoom({
  room,
  boardId,
  x,
  y,
  footprint,
  visibleCount,
  width,
  height,
  zoom,
  ratio,
  paint,
  render,
  props,
  open,
  picked,
  close,
}: {
  room: Room;
  boardId: string | null;
  x: number;
  y: number;
  footprint: { width: number; height: number };
  visibleCount: number;
  width: number;
  height: number;
  zoom: number;
  ratio: number;
  paint: ReturnType<typeof officePaint>;
  render: ReturnType<typeof renderer>;
  props: Props;
  picked: Item | null;
  close: () => void;
  open: (item: Item) => void;
}) {
  const { office, target, boards, people } = props;
  const key = boardId === null ? "team.hallway" : "team.room." + boardId;
  const { sessions, retry } = useRoomSessions(target, boardId, office.files[key], zoom >= 0.5);
  const board = boards.get(boardId ?? "");
  const meeting =
    office.flags.includes("meeting_links") &&
    room.meetingUrl &&
    officeMeetingUrlValid(room.meetingUrl);
  const title = board?.title ?? boardId ?? "Hallway";
  const selectedPerson = picked?.personId
    ? people.find((p) => picked.personId === p.id)
    : undefined;
  const indexState = useAgentIndex(props.index);
  useAgentPage(props.index, !!selectedPerson && needsAgent(indexState, selectedPerson.id));
  const desks: Desk[] = [];
  const owned = new Map<string, NonNullable<typeof sessions>[number][]>();
  for (const session of sessions ?? []) {
    const group = owned.get(session.personId);
    if (group) group.push(session);
    else owned.set(session.personId, [session]);
  }
  if (zoom >= 0.5)
    for (const p of people) {
      const agents = owned.get(p.id) ?? [];
      const claims = board?.board?.cards.filter((c) => c.lease?.holder.login === p.login) ?? [];
      const here =
        boardId === null
          ? !props.hasBoardDesk(p)
          : !!(agents.length || claims.length) && props.seatFor(p, boardId) === boardId;
      const seated = here && (p.presence === "available" || p.presence === "focusing");
      if (!claims.length && !agents.length && !(boardId === null && here)) continue;
      desks.push({
        person: p,
        presence: office.flags.includes("presence") ? p.presence : undefined,
        seated,
        sessions: agents,
        info: [
          p.login,
          office.flags.includes("presence") && p.presence,
          office.flags.includes("status") && p.status?.text,
          ...(office.flags.includes("sharing") ? p.machines.map((machine) => machine.label) : []),
          ...claims.map((c) => c.task.title),
          agents.length + " agents",
        ]
          .filter(Boolean)
          .join(" · "),
      });
      if (desks.length > 12) break;
    }
  const shown = desks.slice(0, 12);
  const detail = detailFor(zoom, shown, visibleCount);
  const { tiles, items } = layout(shown, detail, props.viewer);
  const count = shown.length;
  const stats = Object.entries(room.counts)
    .filter(([, n]) => n)
    .map(([s, n]) => n + " " + (s === "notHeardFrom" ? "not heard from" : s))
    .join(" · ");
  const activity =
    boardId === null
      ? stats || count
        ? "Hallway desks"
        : "Quiet"
      : room.active
        ? room.active + " active"
        : "Quiet";
  const summary = [activity, stats].filter(Boolean).join(" · ");
  const roomItem = {
    id: "room",
    label: title,
    info: summary,
    x: detail === "mark" ? 4 : dimensions(count).width / 2,
    y: detail === "mark" ? 4 : 14,
  };
  // The canvas and HTML share CSS viewport coordinates. Each mounted room owns one disjoint cell.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- draw this room into the shared canvas and erase its previous footprint
  useLayoutEffect(() => {
    const signature = JSON.stringify([
      x,
      y,
      width,
      height,
      zoom,
      ratio,
      detail,
      count,
      room.counts,
      footprint.width,
      footprint.height,
      tiles,
    ]);
    render.set(key, signature, paint, (c) => {
      c.setTransform(ratio, 0, 0, ratio, 0, 0);
      c.clearRect(x, y, footprint.width * zoom, footprint.height * zoom);
      c.translate(x, y);
      c.scale(zoom, zoom);
      if (detail === "mark") c.scale(footprint.width / 514, footprint.height / 276);
      paint(c, key, count, detail, tiles, room.counts);
    });
  }, [
    render,
    key,
    x,
    y,
    width,
    height,
    zoom,
    ratio,
    detail,
    count,
    room.counts,
    tiles,
    paint,
    footprint.width,
    footprint.height,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- erase the old canvas rectangle when a room leaves or moves
  useLayoutEffect(() => {
    return () =>
      render.remove(key, (c) => {
        c.setTransform(ratio, 0, 0, ratio, 0, 0);
        c.clearRect(x, y, footprint.width * zoom, footprint.height * zoom);
      });
  }, [render, key, x, y, zoom, ratio, footprint.width, footprint.height]);
  function button(item: Item, kind: "room" | "more" | "sprite") {
    const left = x + item.x * zoom,
      top = y + item.y * zoom;
    const label =
      kind === "room"
        ? [title, summary, meeting && "Meeting link"].filter(Boolean).join(" · ")
        : item.label;
    return (
      <button
        type="button"
        key={item.id}
        tabIndex={-1}
        data-office-target={key + "/" + item.id}
        aria-label={label}
        aria-description={item.info}
        onClick={() => {
          if (kind === "more") props.openList(boardId ?? undefined);
          else open({ ...item, id: key + "/" + item.id });
        }}
        className={
          "group forced-colors:border forced-colors:bg-[Canvas] absolute z-10 min-h-6 min-w-6 rounded hover:ring-2 focus-visible:ring-2 focus-visible:ring-inset " +
          (detail === "mark"
            ? "flex flex-col items-start justify-start overflow-hidden px-2 py-1 text-left text-xs"
            : kind === "sprite"
              ? ""
              : "bg-card/95 px-2 text-xs shadow-sm")
        }
        style={{
          left,
          top,
          width: detail === "mark" ? (footprint.width - 4) * zoom : undefined,
          height: detail === "mark" ? (footprint.height - 4) * zoom : undefined,
          transform: detail === "mark" ? "" : "translate(-50%, -50%)",
        }}
      >
        {detail !== "mark" && item.id.startsWith("desk/") && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-full left-1/2 w-max max-w-32 -translate-x-1/2 truncate rounded bg-card/90 px-1 text-3xs"
          >
            {item.label}
            {item.presence && <span className="ml-1 rounded bg-accent px-1">{item.presence}</span>}
          </span>
        )}
        {kind === "sprite" && item.id.startsWith("agent/") && (
          <span aria-hidden className="hidden text-xs forced-colors:block">
            {item.label}
          </span>
        )}
        {kind === "sprite" && (
          <span className="pointer-events-none absolute bottom-full left-1/2 z-20 hidden w-max max-w-48 -translate-x-1/2 rounded-md border bg-popover p-2 text-xs shadow group-hover:block group-focus-visible:block">
            {label}
            <br />
            {item.info}
          </span>
        )}
        {kind !== "sprite" &&
          (kind === "room" ? (
            <>
              {title}
              {meeting && <LinkIcon aria-hidden className="ml-1 inline size-3" />}
              <span className="ml-1 text-muted-foreground">
                {sessions === null
                  ? "Retry"
                  : detail === "mark"
                    ? stats || "Quiet"
                    : activity === "Quiet"
                      ? "Quiet"
                      : ""}
              </span>
            </>
          ) : (
            item.label
          ))}
      </button>
    );
  }
  return (
    <>
      {picked && (!picked.personId || selectedPerson) && (
        <aside
          aria-label={selectedPerson?.displayName ?? selectedPerson?.login ?? title}
          className="absolute top-2 right-2 z-30 max-h-[95%] w-72 max-w-full space-y-2 overflow-auto rounded-md border bg-card p-3 text-sm shadow"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
          }}
          onWheel={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button autoFocus onClick={close} className="float-right">
            Close
          </button>
          {selectedPerson ? (
            <>
              <DeskDetails
                p={selectedPerson}
                counts={indexState.byPerson.get(selectedPerson.id)?.counts}
                agents={owned.get(selectedPerson.id) ?? []}
                cards={props.cardsFor(selectedPerson.login)}
                flags={office.flags}
                target={target}
                visible
                pool={props.pool}
              />
              {indexState.byPerson
                .get(selectedPerson.id)
                ?.rooms.filter((r) => r.board !== boardId)
                .map((r) => (
                  <PersonRoomAgents
                    key={r.board}
                    board={r.board}
                    target={target}
                    title={boards.get(r.board)?.title ?? r.board}
                    revision={office.files["team.room." + r.board]}
                    personId={selectedPerson.id}
                  />
                ))}
              {boardId !== null && Object.values(office.summary.hallway.counts).some(Boolean) && (
                <PersonRoomAgents
                  board={null}
                  title="Hallway"
                  target={target}
                  revision={office.files["team.hallway"]}
                  personId={selectedPerson.id}
                />
              )}
            </>
          ) : (
            <>
              <strong>{title}</strong>
              {boardId !== null && (
                <>
                  <p>This room represents a board on the relay, not a repository.</p>
                  <Link className="underline" to="/board" search={() => ({ board: boardId })}>
                    Open {title} board
                  </Link>
                  <RoomChannel board={boardId} title={title} />
                </>
              )}
            </>
          )}
          {sessions === null && <button onClick={retry}>Retry room</button>}
          {office.flags.includes("meeting_links") && (
            <Meeting
              url={
                room.meetingUrl ??
                (selectedPerson || boardId === null ? office.summary.office.meetingUrl : undefined)
              }
            />
          )}
        </aside>
      )}
      {button(roomItem, "room")}
      {items.map((item) => button(item, "sprite"))}
      {detail !== "mark" &&
        (desks.length > 12 || room.active > 12) &&
        button(
          {
            id: "more",
            label: "More desks",
            info: title,
            x: dimensions(count).width / 2,
            y: dimensions(count).height - 20,
          },
          "more",
        )}
    </>
  );
}
export default function TeamOffice(props: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [render] = useState(renderer);
  const pendingFocus = useRef<string | null>(null);
  const canvasNode = useRef<HTMLCanvasElement>(null);
  const [camera, move] = useState({ x: 0, y: 0, width: 0, height: 0, zoom: 1 });
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const [visible, show] = useState(() => !document.hidden);
  const [picked, pick] = useState<{ boardId: string | null; item: Item } | null>(null);
  const [palette, setPalette] = useState(() => ({ theme, paint: officePaint(theme) }));
  if (palette.theme !== theme) setPalette({ theme, paint: officePaint(theme) });
  const slots: { room: Room; boardId: string | null }[] = props.rooms.map((room) => ({
    room,
    boardId: room.board,
  }));
  if (props.hallway)
    slots.push({
      boardId: null,
      room: { board: "", active: 0, desks: 0, counts: props.office.summary.hallway.counts },
    });
  const grid = packRooms(
    slots.map(({ room, boardId }) =>
      camera.zoom < 0.5
        ? { width: 514, height: 276 }
        : dimensions(
            Math.min(props.people.length, boardId === null ? props.people.length : room.desks),
          ),
    ),
  );
  const maxX = Math.max(0, grid.width * camera.zoom - camera.width);
  const maxY = Math.max(0, grid.height * camera.zoom - camera.height);
  const x = Math.min(camera.x, maxX),
    y = Math.min(camera.y, maxY);
  const ratio = pixelRatio(camera.width, camera.height, window.devicePixelRatio);
  const rooms = slots.flatMap(({ room, boardId }, i) => {
    const point = grid.positions[i]!;
    return intersects({ ...camera, x, y }, point.x, point.y, point.width, point.height)
      ? [{ room, boardId, x: point.x, y: point.y, footprint: point }]
      : [];
  });
  function pan(dx: number, dy: number) {
    move((c) => ({
      ...c,
      x: Math.min(maxX, Math.max(0, c.x + dx)),
      y: Math.min(maxY, Math.max(0, c.y + dy)),
    }));
  }
  function zoom(direction: number) {
    move((c) => {
      const step =
        zoomSteps[Math.max(0, Math.min(2, zoomSteps.findIndex((z) => z === c.zoom) + direction))]!;
      return { ...c, zoom: step, x: (x * step) / c.zoom, y: (y * step) / c.zoom };
    });
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observe the map viewport, theme and document visibility
  useEffect(() => {
    const node = viewport.current!;
    render.attach(canvasNode.current);
    const stopResize = observeResize(node, () => {
      const width = node.clientWidth,
        height = node.clientHeight;
      move((c) => (c.width === width && c.height === height ? c : { ...c, width, height }));
    });

    const appearance = new MutationObserver(() =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light"),
    );
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    function visibility() {
      if (document.hidden) render.cancel();
      show(!document.hidden);
    }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopResize();
      appearance.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      render.cancel();
    };
  }, [render]);
  function close() {
    const id = picked?.item.id;
    pick(null);
    const target = Array.from(
      viewport.current?.querySelectorAll<HTMLElement>("[data-office-target]") ?? [],
    ).find((b) => b.dataset.officeTarget === id);
    (target ?? viewport.current)?.focus();
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      zoom(event.key === "-" ? -1 : 1);
      event.preventDefault();
      return;
    }
    const all = Array.from(
      viewport.current?.querySelectorAll<HTMLButtonElement>("[data-office-target]") ?? [],
    );
    const current = all.find((b) => b === document.activeElement);
    function focusTarget(button: HTMLButtonElement) {
      const left = button.offsetLeft,
        top = button.offsetTop;
      if (left < 12 || left > camera.width - 12 || top < 12 || top > camera.height - 12)
        pan(left - camera.width / 2, top - camera.height / 2);
      button.focus({ preventScroll: true });
    }
    if (event.key === "Enter" && !current) {
      all[0]?.click();
      return;
    }
    const dir = (
      { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<
        string,
        [number, number]
      >
    )[event.key];
    if (!dir) return;
    event.preventDefault();
    if (!current) {
      if (all[0]) focusTarget(all[0]);
      return;
    }
    const cx = current.offsetLeft,
      cy = current.offsetTop;
    const nearest = all
      .map((b) => {
        const dx = b.offsetLeft - cx,
          dy = b.offsetTop - cy;
        return {
          b,
          along: dx * dir[0] + dy * dir[1],
          distance: Math.hypot(dx, dy) + Math.abs(dx * dir[1] - dy * dir[0]),
        };
      })
      .filter((v) => v.along > 0)
      .sort((a, b) => a.distance - b.distance)[0];
    const outside = slots
      .flatMap(({ boardId }, i) => {
        const point = grid.positions[i]!;
        const key = (boardId === null ? "team.hallway" : "team.room." + boardId) + "/room";
        if (all.some((b) => b.dataset.officeTarget === key)) return [];
        const dx = (point.x + 84) * camera.zoom - x - cx,
          dy = (point.y + 14) * camera.zoom - y - cy;
        if (dx * dir[0] + dy * dir[1] <= 0) return [];
        return [{ key, point, distance: Math.hypot(dx, dy) + Math.abs(dx * dir[1] - dy * dir[0]) }];
      })
      .sort((a, b) => a.distance - b.distance)[0];
    if (outside && (!nearest || outside.distance < nearest.distance)) {
      pendingFocus.current = outside.key;
      move((c) => ({
        ...c,
        x: Math.max(0, Math.min(maxX, outside.point.x * c.zoom)),
        y: Math.max(0, Math.min(maxY, outside.point.y * c.zoom)),
      }));
    } else if (nearest) focusTarget(nearest.b);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus the target after panning mounts its button
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const button = Array.from(
      viewport.current?.querySelectorAll<HTMLButtonElement>("[data-office-target]") ?? [],
    ).find((b) => b.dataset.officeTarget === pendingFocus.current);
    if (button) {
      button.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  function separation() {
    const [a, b] = touches.current.values();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <button aria-label="Zoom out" disabled={camera.zoom === 0.25} onClick={() => zoom(-1)}>
          −
        </button>
        <span>{camera.zoom * 100}%</span>
        <button aria-label="Zoom in" disabled={camera.zoom === 1} onClick={() => zoom(1)}>
          +
        </button>
        <span>
          Showing {rooms.length} of {slots.length} rooms. Use Floor for everyone.
        </span>
      </div>
      <div
        ref={viewport}
        role="group"
        aria-label="Office map. Use arrow keys to explore."
        tabIndex={0}
        onKeyDown={keys}
        className="relative min-h-64 flex-1 touch-none overflow-clip rounded-lg border bg-muted/40"
        onWheel={(e) => {
          if (e.deltaY) zoom(e.deltaY > 0 ? -1 : 1);
        }}
        onPointerDown={(e) => {
          if (e.target instanceof Element && e.target.closest("button")) return;
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          pinch.current = separation();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const previous = touches.current.get(e.pointerId);
          if (!previous) return;
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const distance = separation();
          if (distance && pinch.current) {
            const factor = distance / pinch.current;
            if (factor > 1.4 || factor < 0.7) {
              zoom(factor > 1 ? 1 : -1);
              pinch.current = distance;
            }
          } else pan(previous.x - e.clientX, previous.y - e.clientY);
        }}
        onLostPointerCapture={(e) => {
          touches.current.delete(e.pointerId);
          pinch.current = separation();
        }}
      >
        <canvas
          role="img"
          aria-label="Isometric team office"
          ref={canvasNode}
          width={Math.floor(camera.width * ratio)}
          height={Math.floor(camera.height * ratio)}
          className="absolute inset-0 size-full [image-rendering:pixelated]"
        />
        {visible &&
          rooms.map((r) => (
            <OfficeRoom
              key={r.boardId === null ? "hallway" : "board/" + r.boardId}
              {...r}
              props={props}
              picked={picked?.boardId === r.boardId ? picked.item : null}
              close={close}
              open={(item) => pick({ item, boardId: r.boardId })}
              ratio={ratio}
              zoom={camera.zoom}
              x={r.x * camera.zoom - x}
              y={r.y * camera.zoom - y}
              render={render}
              paint={palette.paint}
              width={camera.width}
              height={camera.height}
              visibleCount={rooms.length}
            />
          ))}
      </div>
    </section>
  );
}
