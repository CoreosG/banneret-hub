import { memo } from "react";
import type { ServerProvider } from "@t3tools/contracts";
import { ChatComposer as Composer, type ChatComposerProps } from "../components/chat/ChatComposer";
import { memoryThreadKey, useMemoryAvailability, openMemoryCommand } from "./memoryCommand";
import { isWorkflowPhrase } from "./WorkflowReview";
import { useSwitchBanner } from "./ProviderSwitchNotice";
export type { ChatComposerHandle } from "../components/chat/ChatComposer";

const memory = { name: "memory", description: "Search and review private Banneret notes" };
const commands = (list: ServerProvider["slashCommands"]) => [
  ...list.filter((c) => c.name !== "memory"),
  memory,
];
export const ChatComposer = memo(function ChatComposer(given: ChatComposerProps) {
  const switching = useSwitchBanner(given);
  const props = switching ? { ...given, bannerItems: [...given.bannerItems, switching] } : given;
  const ref = props.routeThreadRef;
  const enabled = useMemoryAvailability((s) => s.threads[memoryThreadKey(ref)]);
  const providers = enabled
    ? props.providerStatuses.map((provider) => ({
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
      }))
    : props.providerStatuses;
  // The workflow phrase is read in every chat, new ones too, to run it or point to it.
  const intercept = (prompt: string, detached = false) =>
    (enabled || isWorkflowPhrase(prompt)) && openMemoryCommand(props, prompt, detached);
  const capture = props.captureDetachedSend;
  return (
    <Composer
      {...props}
      providerStatuses={providers}
      onSend={(...args) => {
        if (intercept(props.promptRef.current)) args[0]?.preventDefault();
        else props.onSend(...args);
      }}
      {...(capture
        ? {
            captureDetachedSend: () => {
              const send = capture();
              return (...args: Parameters<typeof send>) => {
                if (
                  !args[3] &&
                  intercept(args[4]?.prompt ?? props.promptRef.current, Boolean(args[4]))
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
