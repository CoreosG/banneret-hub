// Banneret Hub: the note shown where a person would look for something their company's relay says
// Banneret does not own. A relay without `owners` shows none.
import { ownedElsewhereNote, type RelayCapability } from "@t3tools/contracts";

import { QuietLine } from "./ui/QuietLine";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

export function OwnedElsewhere(props: {
  readonly capabilities: ReadonlyArray<RelayCapability>;
  readonly className?: string;
}) {
  const enterprise = useEnterpriseFeed();
  return props.capabilities.map((capability) => {
    const owner = enterprise?.feed.elsewhere?.[capability];
    return owner ? (
      <QuietLine
        key={capability}
        fact={ownedElsewhereNote(capability, owner, enterprise.workspace.name)}
        {...(props.className && { className: props.className })}
      />
    ) : null;
  });
}
