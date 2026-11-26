// Banneret Hub: the Ports panel's data. Listing comes from the environment; labels and pinned
// forwards are this device's own preferences, so they live in local storage.
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { BANNERET_PORTS_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const listCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-ports:list",
  tag: BANNERET_PORTS_WS_METHODS.list,
});

export async function listListeningPorts(environmentId: EnvironmentId) {
  const result = await runAtomCommand(appAtomRegistry, listCommand, { environmentId, input: {} });
  if (result._tag === "Success") return result.value;
  throw Cause.squash(result.cause);
}

/**
 * The environment whose ports show in the Ports dialog: the way in when no thread or draft has a
 * right panel to hold them. The palette closes as its command runs, so the root renders the dialog.
 */
export const portsDialogEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("banneret-ports:dialog-environment"),
);

export function openPortsDialog(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(portsDialogEnvironmentAtom, environmentId);
}

const LABELS_KEY = "banneret:port-labels";
const PINS_KEY = "banneret:pinned-port-forwards";

export interface PinnedForward {
  readonly environmentId: EnvironmentId;
  readonly port: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full storage keep working, just without remembering.
  }
}

const labelKey = (environmentId: EnvironmentId, port: number) => `${environmentId}:${port}`;

export function readPortLabels(): Readonly<Record<string, string>> {
  return readJson<Record<string, string>>(LABELS_KEY, {});
}

export function portLabel(
  labels: Readonly<Record<string, string>>,
  environmentId: EnvironmentId,
  port: number,
): string | undefined {
  return labels[labelKey(environmentId, port)];
}

export function writePortLabel(environmentId: EnvironmentId, port: number, label: string) {
  const labels = { ...readPortLabels() };
  if (label.trim()) labels[labelKey(environmentId, port)] = label.trim();
  else delete labels[labelKey(environmentId, port)];
  writeJson(LABELS_KEY, labels);
  return labels;
}

export function readPinnedForwards(): ReadonlyArray<PinnedForward> {
  return readJson<PinnedForward[]>(PINS_KEY, []).filter(
    (pin) => typeof pin?.environmentId === "string" && Number.isInteger(pin?.port),
  );
}

export function setPinnedForward(environmentId: EnvironmentId, port: number, pinned: boolean) {
  const pins = readPinnedForwards().filter(
    (pin) => !(pin.environmentId === environmentId && pin.port === port),
  );
  const next = pinned ? [...pins, { environmentId, port }] : pins;
  writeJson(PINS_KEY, next);
  return next;
}
