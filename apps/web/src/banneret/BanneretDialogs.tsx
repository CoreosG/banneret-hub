import { PinnedPortForwardsRestorer } from "../components/ports/PinnedPortForwardsRestorer";
import { PortsDialogHost } from "../components/ports/PortsDialog";
import { WorkspacesHost } from "./WorkspacesHost";

export function BanneretDialogs() {
  return (
    <>
      <PinnedPortForwardsRestorer />
      <PortsDialogHost />
      <WorkspacesHost />
    </>
  );
}
