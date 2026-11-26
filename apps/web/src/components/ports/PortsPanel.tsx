// Banneret Hub: VS Code-style Ports panel. Lists every port listening on the environment's host
// and forwards any of them to localhost on this computer through the desktop app's tunnel.
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ListeningPortsResult,
} from "@t3tools/contracts";
import { CableIcon, CopyIcon, GlobeIcon, PinIcon, PinOffIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import {
  listListeningPorts,
  portLabel,
  readPinnedForwards,
  readPortLabels,
  setPinnedForward,
  writePortLabel,
} from "~/state/banneretPorts";
import { useEnvironment } from "~/state/environments";
import {
  canForwardPorts,
  findPortForward,
  forwardedUrl,
  forwardPort,
  stopPortForward,
  useForwardLocality,
  usePortForwards,
} from "~/state/portForwards";
import { useEnvironmentScope } from "~/state/session";

const POLL_MS = 4_000;

function IconAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export default function PortsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
}) {
  const { environmentId, visible } = props;
  const environment = useEnvironment(environmentId);
  const forwards = usePortForwards();
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const forwardable =
    canOperate &&
    environment !== null &&
    environment.connection.phase === "connected" &&
    canForwardPorts(environment);
  const locality = useForwardLocality(forwardable ? environmentId : null);
  const sameMachine = locality === "local";
  const [listing, setListing] = useState<ListeningPortsResult | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [labels, setLabels] = useState(readPortLabels);
  const [pins, setPins] = useState(readPinnedForwards);
  const [editingPort, setEditingPort] = useState<number | null>(null);
  const [manualPort, setManualPort] = useState("");
  const [busyPort, setBusyPort] = useState<number | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setListing(await listListeningPorts(environmentId));
      setListError(null);
    } catch (error) {
      setListError(thrownErrorMessage(error, m) ?? String(error));
    } finally {
      setRefreshing(false);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the environment's listening ports while the panel is visible
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const tick = () =>
      listListeningPorts(environmentId).then(
        (next) => {
          if (cancelled) return;
          setListing(next);
          setListError(null);
        },
        (error: unknown) => {
          if (!cancelled) setListError(thrownErrorMessage(error, m) ?? String(error));
        },
      );
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [environmentId, visible]);

  const reportError = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? String(error),
    });

  const forwardOf = (port: number) => findPortForward(forwards, environmentId, port);
  const isPinned = (port: number) =>
    pins.some((pin) => pin.environmentId === environmentId && pin.port === port);

  const startForward = async (port: number) => {
    const existing = forwardOf(port);
    if (existing) return existing;
    setBusyPort(port);
    try {
      return await forwardPort(environmentId, port);
    } catch (error) {
      reportError(`Could not forward port ${port}`, error);
      return null;
    } finally {
      setBusyPort(null);
    }
  };

  const openInBrowser = async (port: number) => {
    let url = `http://localhost:${port}/`;
    if (!sameMachine) {
      const forward = await startForward(port);
      if (!forward) return;
      url = forwardedUrl(forward);
    }
    await readLocalApi()
      ?.shell.openExternal(url)
      .catch((error: unknown) => reportError("Unable to open in browser", error));
  };

  const togglePin = (port: number) => {
    const pinned = !isPinned(port);
    setPins(setPinnedForward(environmentId, port, pinned));
    if (pinned && !sameMachine && forwardable) void startForward(port);
  };

  const listed = listing?.ports ?? [];
  const extraPorts = [
    ...forwards.filter((f) => f.environmentId === environmentId).map((f) => f.remotePort),
    ...pins.filter((pin) => pin.environmentId === environmentId).map((pin) => pin.port),
  ].filter((port) => !listed.some((row) => row.port === port));
  const rows = [
    ...listed,
    ...[...new Set(extraPorts)].map((port) => ({
      port,
      pid: null,
      processName: null,
      loopbackOnly: true,
      stopped: true as const,
    })),
  ].toSorted((a, b) => a.port - b.port);

  const submitManual = () => {
    const port = Number(manualPort);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
    setManualPort("");
    void startForward(port);
  };

  const status = !forwardable
    ? "Forwarding needs the desktop app and permission to run terminals here."
    : sameMachine
      ? "This environment is this computer: its ports are already on localhost."
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2"
        data-surface-subheader
      >
        <IconAction label="Refresh ports" onClick={() => void refresh()}>
          <RefreshIcon refreshing={refreshing} />
        </IconAction>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Ports on {environment?.label ?? environmentId}
        </span>
        {forwardable && !sameMachine ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              submitManual();
            }}
          >
            <Input
              size="sm"
              inputMode="numeric"
              className="w-24"
              placeholder="Port"
              aria-label="Port to forward"
              value={manualPort}
              onChange={(event) => setManualPort(event.target.value.replace(/\D/g, ""))}
            />
            <Button type="submit" size="xs" variant="outline" disabled={!manualPort}>
              Forward
            </Button>
          </form>
        ) : null}
      </div>
      {status ? <p className="px-3 py-2 text-xs text-muted-foreground">{status}</p> : null}
      {listError ? <p className="px-3 py-2 text-xs text-destructive">{listError}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Port</th>
              <th className="px-2 py-1.5 font-medium">Label</th>
              <th className="px-2 py-1.5 font-medium">Process</th>
              <th className="px-2 py-1.5 font-medium">Forwarded to</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const forward = forwardOf(row.port);
              const isServer = listing?.serverPort === row.port;
              const label = portLabel(labels, environmentId, row.port);
              const stopped = "stopped" in row;
              return (
                <tr key={row.port} className="border-t border-border/40 hover:bg-accent/40">
                  <td className="px-3 py-1 font-mono tabular-nums">
                    {row.port}
                    {!stopped && !row.loopbackOnly ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="ml-1 text-muted-foreground" />}>
                          *
                        </TooltipTrigger>
                        <TooltipPopup>Listening on all interfaces</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </td>
                  <td className="px-2 py-1">
                    {editingPort === row.port ? (
                      <Input
                        size="sm"
                        autoFocus
                        defaultValue={label ?? ""}
                        aria-label={`Label for port ${row.port}`}
                        onBlur={(event) => {
                          setLabels(writePortLabel(environmentId, row.port, event.target.value));
                          setEditingPort(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setEditingPort(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="w-full truncate text-left text-foreground/80 hover:underline"
                        onClick={() => setEditingPort(row.port)}
                      >
                        {isServer
                          ? "Banneret server"
                          : (label ?? <span className="text-muted-foreground/60">Add label</span>)}
                      </button>
                    )}
                  </td>
                  <td className="max-w-40 truncate px-2 py-1 text-muted-foreground">
                    {stopped
                      ? "not listening"
                      : [row.processName, row.pid === null ? null : `(${row.pid})`]
                          .filter(Boolean)
                          .join(" ")}
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {sameMachine
                      ? `localhost:${row.port}`
                      : forward
                        ? `localhost:${forward.localPort}`
                        : ""}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    {!isServer && (sameMachine || forwardable) ? (
                      <IconAction
                        label="Open in browser"
                        disabled={busyPort === row.port}
                        onClick={() => void openInBrowser(row.port)}
                      >
                        <GlobeIcon className="size-3.5" />
                      </IconAction>
                    ) : null}
                    {forward || sameMachine ? (
                      <IconAction
                        label="Copy address"
                        onClick={() =>
                          void writeTextToClipboard(
                            `localhost:${forward?.localPort ?? row.port}`,
                          ).catch((error: unknown) => reportError("Failed to copy", error))
                        }
                      >
                        <CopyIcon className="size-3.5" />
                      </IconAction>
                    ) : null}
                    {!isServer && forwardable && !sameMachine ? (
                      <>
                        <IconAction
                          label={isPinned(row.port) ? "Stop keeping forwarded" : "Keep forwarded"}
                          onClick={() => togglePin(row.port)}
                        >
                          {isPinned(row.port) ? (
                            <PinOffIcon className="size-3.5" />
                          ) : (
                            <PinIcon className="size-3.5" />
                          )}
                        </IconAction>
                        <IconAction
                          label={forward ? "Stop forwarding" : "Forward port"}
                          disabled={busyPort === row.port}
                          onClick={() =>
                            forward
                              ? void stopPortForward(environmentId, row.port)
                              : void startForward(row.port)
                          }
                        >
                          <CableIcon className={forward ? "size-3.5 text-primary" : "size-3.5"} />
                        </IconAction>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {listing !== null && rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">No ports are listening.</p>
        ) : null}
      </div>
    </div>
  );
}
