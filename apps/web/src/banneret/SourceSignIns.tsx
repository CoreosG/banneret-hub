// Banneret Hub: this machine's sign-ins to company servers, in Settings and in a thread that needs one.
// The machine holds the sign-in. This page sends a pasted token or address once and never gets one back.
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SignInAction, SourceSignIn, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { connectionAtomRuntime } from "../connection/runtime";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";

const feed = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "Company sign-ins",
  tag: "plugins.signIns",
});
const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Change a company sign-in",
  tag: "plugins.signIn",
});

export type SignInAct = (action: SignInAction) => Promise<void>;

const STATES: Record<SourceSignIn["state"], { label: string; tone: string }> = {
  network: { label: "No sign-in needed", tone: "text-muted-foreground" },
  signed_in: { label: "Signed in", tone: "text-success" },
  signed_out: { label: "Signed out", tone: "text-muted-foreground" },
  expired: { label: "Expired", tone: "text-warning" },
  refused: { label: "Refused", tone: "text-destructive" },
};

const explain = ({ state, title }: SourceSignIn) =>
  ({
    network: `${title} knows this machine by your company network.`,
    signed_in: "Agents in your chats use it as you. The sign-in stays on this machine.",
    signed_out: `Agents cannot use ${title} until you sign in.`,
    expired: "Your sign-in ended or was withdrawn. Sign in again.",
    refused: `${title} refused your sign-in. Try again, or ask your company's admin.`,
  })[state];

const needsPerson = (row: SourceSignIn) => row.state !== "network" && row.state !== "signed_in";

/** One company server, its state and what the person can do about it. */
function SignInCard({
  row,
  act,
  heading,
}: {
  row: SourceSignIn;
  act: SignInAct;
  heading?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const target = { relayOrigin: row.relayOrigin, sourceId: row.sourceId };
  async function run(action: SignInAction) {
    setBusy(true);
    setProblem("");
    try {
      await act(action);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not change the sign-in.");
    }
    setBusy(false);
  }
  /** Sends what the form holds once, then empties the field. */
  const submit = (action: (value: Redacted.Redacted<string>) => SignInAction) =>
    async function (event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const form = event.currentTarget;
      const value = String(new FormData(form).get("value") ?? "").trim();
      if (!value) return;
      await run(action(Redacted.make(value)));
      form.reset();
    };
  const state = STATES[row.state];
  return (
    <section
      aria-label={heading ?? row.title}
      className={cn(
        "grid min-w-0 gap-2 p-3 text-sm",
        heading && "my-2 rounded-lg border border-warning/40 bg-card",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {heading && <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-warning" />}
        <strong className="min-w-0 break-words">{heading ?? row.title}</strong>
        <span data-slot="sign-in-state" className={cn("ml-auto shrink-0 text-xs", state.tone)}>
          {state.label}
        </span>
      </header>
      <p className="text-muted-foreground text-xs">
        {explain(row)}{" "}
        <span className="break-all">
          {row.company}, {row.address}.
        </span>
      </p>
      <fieldset disabled={busy} className="grid min-w-0 gap-2">
        {row.state === "signed_in" && row.auth !== "none" && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="justify-self-start"
            aria-label={`Sign out of ${row.title}`}
            onClick={() => void run({ kind: "sign_out", ...target })}
          >
            Sign out
          </Button>
        )}
        {needsPerson(row) && row.auth === "oauth" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {row.authorizationUrl && (
                <Button
                  size="xs"
                  render={<a href={row.authorizationUrl} target="_blank" rel="noreferrer" />}
                >
                  Open sign-in page
                </Button>
              )}
              <Button
                type="button"
                variant={row.authorizationUrl ? "outline" : "default"}
                size="xs"
                onClick={() => void run({ kind: "start", ...target })}
              >
                {row.authorizationUrl ? "Start again" : `Sign in to ${row.title}`}
              </Button>
            </div>
            {row.authorizationUrl && (
              <form
                className="grid min-w-0 gap-1"
                onSubmit={submit((callbackUrl) => ({ kind: "finish", callbackUrl }))}
              >
                <p className="text-muted-foreground text-xs">
                  Using another device? After you sign in, its browser shows a page that will not
                  load. Copy that page's address and paste it here.
                </p>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Input
                    name="value"
                    className="min-w-0 max-w-md flex-1"
                    aria-label={`Address from the ${row.title} sign-in`}
                    autoComplete="off"
                    placeholder="http://127.0.0.1:…"
                  />
                  <Button type="submit" variant="outline" size="xs">
                    Finish sign-in
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
        {needsPerson(row) && row.auth === "bearer_per_person" && (
          <form
            className="grid min-w-0 gap-1"
            onSubmit={submit((token) => ({ kind: "token", ...target, token }))}
          >
            {row.help && <p className="break-words text-xs">{row.help}</p>}
            <div className="flex min-w-0 flex-wrap gap-2">
              <Input
                name="value"
                type="password"
                autoComplete="new-password"
                className="min-w-0 max-w-md flex-1"
                aria-label={`Access token for ${row.title}`}
              />
              <Button type="submit" size="xs">
                Save token
              </Button>
            </div>
          </form>
        )}
      </fieldset>
      {heading && (
        <p className="text-muted-foreground text-xs">
          Then send your next message. If this chat still lacks its tools, start a new chat.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-destructive text-xs">
          {problem}
        </p>
      )}
    </section>
  );
}

/** What a thread shows: only the servers that wait on the person. */
export function SignInPrompts({ rows, act }: { rows: readonly SourceSignIn[]; act: SignInAct }) {
  return rows
    .filter(needsPerson)
    .map((row) => (
      <SignInCard
        key={row.relayOrigin + row.sourceId}
        row={row}
        act={act}
        heading={`${row.title} needs your sign-in`}
      />
    ));
}

const actOn =
  (environmentId: EnvironmentId): SignInAct =>
  async (action) => {
    const result = await runAtomCommand(appAtomRegistry, command, {
      environmentId,
      input: { action },
    });
    if (result._tag === "Success") return;
    const error = Cause.squash(result.cause);
    throw new Error(
      typeof error === "object" &&
        error !== null &&
        "detail" in error &&
        typeof error.detail === "string"
        ? error.detail
        : "Could not reach this machine.",
    );
  };

export function ThreadSignIns({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const result = useAtomValue(feed({ environmentId, input: { threadId } }));
  return result._tag === "Success" ? (
    <SignInPrompts rows={result.value} act={actOn(environmentId)} />
  ) : null;
}

/** One machine's "Signed in to" list. Nothing shows for a machine without company servers. */
export function SignInSettingsList({
  label,
  rows,
  act,
}: {
  label: string;
  rows: readonly SourceSignIn[];
  act: SignInAct;
}) {
  return rows.length ? (
    <SettingsSection title={`Company servers on ${label}`}>
      {rows.map((row) => (
        <SignInCard key={row.relayOrigin + row.sourceId} row={row} act={act} />
      ))}
    </SettingsSection>
  ) : null;
}

function MachineSignIns({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const result = useAtomValue(feed({ environmentId, input: {} }));
  return result._tag === "Success" ? (
    <SignInSettingsList label={label} rows={result.value} act={actOn(environmentId)} />
  ) : null;
}

export function CompanySignInSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  return scope.kind === "all" || scope.kind === "environment"
    ? connectedEnvironments.map(({ environmentId, label }) => (
        <MachineSignIns key={environmentId} environmentId={environmentId} label={label} />
      ))
    : null;
}
