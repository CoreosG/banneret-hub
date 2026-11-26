// Banneret Hub: the Ports panel in a dialog, for when no thread or draft is open to hold it.
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";

import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { openPortsDialog, portsDialogEnvironmentAtom } from "~/state/banneretPorts";
import { useEnvironment } from "~/state/environments";

import PortsPanel from "./PortsPanel";

export function PortsDialogHost() {
  const environmentId = useAtomValue(portsDialogEnvironmentAtom);
  const environment = useEnvironment(environmentId);
  const gt = useGT();
  if (environmentId === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) openPortsDialog(null);
      }}
    >
      <DialogPopup className="h-[70vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {gt("Ports on {environment}", { environment: environment?.label ?? environmentId })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <PortsPanel key={environmentId} environmentId={environmentId} visible />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
