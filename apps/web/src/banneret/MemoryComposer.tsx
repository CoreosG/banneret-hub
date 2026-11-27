import { memo } from "react";
import type { ServerProvider } from "@t3tools/contracts";
import { ChatComposer as Composer, type ChatComposerProps } from "../components/chat/ChatComposer";
import { memoryThreadKey, useMemoryAvailability, openMemoryCommand } from "./memoryCommand";
export type { ChatComposerHandle } from "../components/chat/ChatComposer";

const memory = { name: "memory", description: "Search and review private Banneret notes" };
const commands = (list: ServerProvider["slashCommands"]) => [
  ...list.filter((c) => c.name !== "memory"),
  memory,
];
export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const ref = props.routeThreadRef;
  const enabled = useMemoryAvailability((s) => s.threads[memoryThreadKey(ref)]);
  if (!enabled) return <Composer {...props} />;
  const providers = props.providerStatuses.map((provider) => ({
    ...provider,
    slashCommands: commands(provider.slashCommands),
    ...(provider.workspaceSnapshots
      ? {
          workspaceSnapshots: provider.workspaceSnapshots.map((s) => ({
            ...s,
            slashCommands: commands(s.slashCommands),
          })),
        }
      : {}),
  }));
  const capture = props.captureDetachedSend;
  return (
    <Composer
      {...props}
      providerStatuses={providers}
      onSend={(...args) => {
        if (openMemoryCommand(props, props.promptRef.current)) args[0]?.preventDefault();
        else props.onSend(...args);
      }}
      {...(capture
        ? {
            captureDetachedSend: () => {
              const send = capture();
              return (...args: Parameters<typeof send>) => {
                if (
                  !args[3] &&
                  openMemoryCommand(
                    props,
                    args[4]?.prompt ?? props.promptRef.current,
                    Boolean(args[4]),
                  )
                )
                  args[0]?.preventDefault();
                else send(...args);
              };
            },
          }
        : {})}
    />
  );
});
export { ThreadTimeline } from "./chat/AgentSettings";
