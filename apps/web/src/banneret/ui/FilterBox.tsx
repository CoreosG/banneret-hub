// Fork UI kit: the text filter box of Board, Map and Feed. It keeps what is typed and reports each
// change; the page puts it in the URL. A new value from outside (a link, Back) replaces the draft.
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { cn } from "../../lib/utils";

export function FilterBox(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly placeholder?: string;
  readonly className?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  const [seen, setSeen] = useState(props.value);
  if (props.value !== seen) {
    setSeen(props.value);
    if (props.value !== draft.trim()) setDraft(props.value);
  }
  return (
    <InputGroup className={cn("w-full max-w-64", props.className)}>
      <InputGroupAddon>
        <SearchIcon aria-hidden className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        nativeInput
        type="search"
        size="sm"
        aria-label={props.label}
        placeholder={props.placeholder ?? "Filter"}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          props.onChange(event.target.value.trim());
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || draft === "") return;
          event.stopPropagation();
          setDraft("");
          props.onChange("");
        }}
      />
    </InputGroup>
  );
}
