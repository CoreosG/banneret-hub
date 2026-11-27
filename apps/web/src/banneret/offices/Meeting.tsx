import { officeMeetingUrlValid } from "@t3tools/contracts";
import { readLocalApi } from "../../localApi";

export function Meeting({ url }: { url?: string | undefined }) {
  if (!url || !officeMeetingUrlValid(url)) return null;
  return (
    <a
      className="text-sm underline"
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        const api = readLocalApi();
        if (api) {
          e.preventDefault();
          void api.shell.openExternal(url);
        }
      }}
    >
      Meeting link
    </a>
  );
}
