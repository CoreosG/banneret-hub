// Banneret Hub: the Task tab in a dialog, for when no thread or draft is open to hold a right panel
// (Board, Feed, Today and Map are pages), as the Ports dialog does, and the Release dialog. Mounted
// once by WorkspacesHost.
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { ReleaseDialogHost } from "./LeaseControls";
import { TaskPanel } from "./TaskPanel";
import { openTaskDialog, useTaskDialogStore } from "./taskStore";

export function TaskDialogHost() {
  const surface = useTaskDialogStore((state) => state.surface);
  return (
    <>
      {surface === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) openTaskDialog(null);
          }}
        >
          {/* Sized to its content; only an embedded issue thread takes the tall height, and the 404
              case is narrower. The header's end padding keeps its link clear of the close button. */}
          <DialogPopup className="max-h-[80vh] max-w-3xl overflow-hidden has-[[data-task-narrow]]:max-w-xl has-[[data-task-thread]]:h-[80vh]">
            <DialogTitle className="sr-only">Task</DialogTitle>
            <div className="flex min-h-0 flex-1 flex-col [&_[data-testid=task-header]]:pe-12">
              <TaskPanel key={surface.id} surface={surface} threadRef={null} />
            </div>
          </DialogPopup>
        </Dialog>
      )}
      <ReleaseDialogHost />
    </>
  );
}
