// Banneret Hub: the provider switch notice, in the thread and on the composer. It is worked out from
// the stored handoff, or from the picked model, each time it is drawn.
import { useAtomValue } from "@effect/atom-react";
import { resolveHandoffEndpoints, type HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  isProviderHandoff,
  providerHandoffEnds,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderSwitchSide,
  type ServerProvider,
  type SwitchNotice,
} from "@t3tools/contracts";
import { ArrowRightLeftIcon } from "lucide-react";
import type { ComponentType } from "react";

import type { ChatComposerProps } from "../components/chat/ChatComposer";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { useComposerDraftStore } from "../composerDraftStore";
import { connectionAtomRuntime } from "../connection/runtime";
import { draftModelSelectionApplies, threadHasStarted } from "../lib/chatThreadActions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useChatRead } from "./chat/client";
import { countLabel } from "./countLabel";

export { isProviderHandoff };

type HandoffItem = Extract<OrchestrationV2TurnItem, { type: "handoff" }>;
type NoticeInput = Parameters<typeof command.run>[1]["input"];

const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:switch-notice",
  tag: "memory.switchNotice",
});
// The timeline mounts rows again as it scrolls, so a row starts with its last answer, not empty.
const answers = new Map<string, SwitchNotice>();

/** The driver on each side, or null unless the provider itself changes. */
function changedDrivers(
  providers: ReadonlyArray<ServerProvider>,
  from: ProviderInstanceId,
  to: ProviderInstanceId,
) {
  const driverOf = (id: ProviderInstanceId) =>
    providers.find((provider) => provider.instanceId === id)?.driver;
  const source = driverOf(from);
  const target = driverOf(to);
  return source === undefined || target === undefined || source === target
    ? null
    : { from: source, to: target };
}

function useSwitchNotice(environmentId: EnvironmentId, input: NoticeInput | null) {
  const allowed = useAtomValue(command.permissionAtom(environmentId));
  const key = allowed && input ? JSON.stringify([environmentId, input]) : "";
  const read = useChatRead(async () => {
    // With nothing to ask, never settle: settling would render every composer once more.
    if (!key || !input) return new Promise<null>(() => {});
    const result = await runAtomCommand(appAtomRegistry, command, { environmentId, input });
    // The divider above still says what happened when this cannot be read.
    if (result._tag !== "Success") return null;
    answers.set(key, result.value);
    return { key, notice: result.value };
  }, key);
  if (!key) return null;
  return (read.value?.key === key ? read.value.notice : answers.get(key)) ?? null;
}

const partlyKnown = (name: string) =>
  `${name} isn't fully integrated: the Hub does not know which files it reads.`;

function SideFiles({ side, lead }: { side: ProviderSwitchSide; lead: string }) {
  return (
    <>
      {side.integrated ? <p>{lead}</p> : <p>{partlyKnown(side.name)}</p>}
      {side.project && <p>Project: {side.project}.</p>}
      {side.personal && <p>Personal: {side.personal}.</p>}
    </>
  );
}

function SwitchNoticeCard({ notice, resumed }: { notice: SwitchNotice; resumed: boolean }) {
  const { from, to, notes, carried } = notice;
  const term = "font-medium text-muted-foreground";
  return (
    <section
      aria-label="Provider switch"
      className="@container mb-2 rounded-lg border border-border bg-card p-3 text-xs wrap-anywhere"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <strong className="text-sm">Now on {to.name}.</strong>
        <span className="text-muted-foreground">
          {resumed ? "Resumed its earlier session." : "New session."}
        </span>
        <span className="ml-auto text-2xs text-muted-foreground">From Banneret Hub</span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 @md:grid-cols-[8rem_minmax(0,1fr)]">
        {carried && (
          <>
            <dt className={term}>Carried over</dt>
            <dd>
              {carried.items} of {countLabel(carried.of, "history item")}
              {resumed ? " since it last ran" : ""}. Attachments, reasoning and tool state were not.
            </dd>
          </>
        )}
        {notes !== null && (
          <>
            <dt className={term}>Banneret memory</dt>
            <dd>{countLabel(notes, "Banneret note")} available.</dd>
          </>
        )}
        <dt className={term}>Now applies</dt>
        <dd>
          <SideFiles side={to} lead={`${to.name}'s own instructions.`} />
        </dd>
        <dt className={term}>Instead of</dt>
        <dd className="text-muted-foreground">
          <SideFiles side={from} lead={`${from.name}'s own instructions.`} />
        </dd>
      </dl>
      {(to.project || to.personal || from.project || from.personal) && (
        <p className="mt-2 text-2xs text-muted-foreground">
          These are the file names each provider looks for. The Hub has not checked which files
          exist.
        </p>
      )}
    </section>
  );
}

interface RowProps {
  readonly environmentId: EnvironmentId;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
}
type DividerRow = ComponentType<{
  readonly environmentId: EnvironmentId;
  readonly endpoints: ReturnType<typeof resolveHandoffEndpoints>;
  readonly failed: boolean;
}>;

function ProviderSwitchRow({
  item,
  environmentId,
  runs,
  Row,
}: RowProps & { readonly item: HandoffItem; readonly Row: DividerRow }) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const ends = providerHandoffEnds(item, runs);
  const drivers = ends && changedDrivers(providers, ends.from, ends.to);
  const notice = useSwitchNotice(
    environmentId,
    drivers && { threadId: item.threadId, ...drivers, handoffId: item.contextHandoffId },
  );
  return (
    <>
      <Row
        environmentId={environmentId}
        endpoints={resolveHandoffEndpoints(item, runs)}
        failed={item.status === "failed"}
      />
      {ends && notice && <SwitchNoticeCard notice={notice} resumed={ends.resumed} />}
    </>
  );
}

/** The upstream timeline's one call: its own divider, with the notice under it. */
export const providerSwitchRow = (props: RowProps, item: HandoffItem, Row: DividerRow) => (
  <ProviderSwitchRow environmentId={props.environmentId} runs={props.runs} item={item} Row={Row} />
);

function switchComposerLine(notice: SwitchNotice, resumed: boolean) {
  const { to } = notice;
  return {
    title: `Switching to ${to.name} ${resumed ? "resumes its earlier session" : "starts a new session"}.`,
    description: to.integrated
      ? `${to.name} follows its own instruction files.`
      : partlyKnown(to.name),
  };
}

/** The composer line for a picked provider that the next message will switch to. */
export function useSwitchBanner(props: ChatComposerProps): ComposerBannerStackItem | null {
  const picked = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(props.composerDraftTarget);
    return draft?.activeProvider &&
      draftModelSelectionApplies(draft, threadHasStarted(props.activeThread))
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const to = (picked ?? props.activeThread?.modelSelection)?.instanceId;
  // The run the next one follows, by the same test as the pending handoff divider.
  const from = props.activeThreadRuns.findLast(
    (run) =>
      run.status !== "rolled_back" &&
      (run.startedAt !== null || (run.status === "starting" && run.contextHandoffId !== null)),
  )?.modelSelection.instanceId;
  const drivers =
    from && to && !props.multipleModelSelections
      ? changedDrivers(props.providerStatuses, from, to)
      : null;
  const threadId = props.activeThreadId;
  const notice = useSwitchNotice(
    props.environmentId,
    drivers && threadId ? { threadId, ...drivers } : null,
  );
  if (!notice) return null;
  // A provider that already ran this thread keeps its conversation.
  const resumed = props.activeThreadRuns.some(
    (run) =>
      run.status !== "rolled_back" && run.startedAt !== null && run.providerInstanceId === to,
  );
  return {
    id: "banneret-provider-switch",
    variant: "info",
    icon: <ArrowRightLeftIcon />,
    ...switchComposerLine(notice, resumed),
  };
}
