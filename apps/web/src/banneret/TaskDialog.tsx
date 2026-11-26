// Banneret Hub: the Task tab in a dialog, for when no thread or draft is open to hold a right panel
// (Board, Feed and Today are pages), as the Ports dialog does. Mounted once by WorkspacesHost.
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { TaskPanel } from "./TaskPanel";
import { openTaskDialog, useTaskDialogStore } from "./taskStore";

export function TaskDialogHost() {
  const surface = useTaskDialogStore((state) => state.surface);
  if (surface === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) openTaskDialog(null);
      }}
    >
      <DialogPopup className="h-[80vh] max-w-3xl overflow-hidden">
        <DialogTitle className="sr-only">Task</DialogTitle>
        <div className="flex min-h-0 flex-1 flex-col">
          <TaskPanel key={surface.id} surface={surface} threadRef={null} />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
