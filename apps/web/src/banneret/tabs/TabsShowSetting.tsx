// Banneret Hub: Settings → Appearance → "Tabs show": a tab per chat, or per workspace (project).
import { SettingsRow } from "../../components/settings/settingsLayout";
import { useSearchableSetting } from "../../components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useProjectWorkspaces } from "./useProjectWorkspaces";
import type { TabsMode } from "./workspaceTabs.logic";
import { showChatTabs, showWorkspaceTabs } from "./workspaceTabsActions";
import { useWorkspaceTabsStore } from "./workspaceTabsStore";

const LABELS: Record<TabsMode, string> = { chats: "Chats", workspaces: "Workspaces" };

export function TabsShowSetting() {
  const searchableSetting = useSearchableSetting();
  const mode = useWorkspaceTabsStore((state) => state.mode);
  const workspaces = useProjectWorkspaces();
  return (
    <SettingsRow
      {...searchableSetting("tabs-show")}
      description="Chats gives each open chat a tab. Workspaces gives each project a tab and lists only that project's chats in the sidebar, for wide windows."
      control={
        <div className="w-full sm:w-40">
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value === mode) return;
              if (value === "workspaces") showWorkspaceTabs(workspaces);
              if (value === "chats") showChatTabs();
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Tabs show">
              <SelectValue>{LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="chats">{LABELS.chats}</SelectItem>
              <SelectItem value="workspaces">{LABELS.workspaces}</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
