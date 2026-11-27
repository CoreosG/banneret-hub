// Banneret Hub: a page's filter state in the URL search params, so tabs, links and reloads keep it.
// A patch value of undefined removes that key.
import { useNavigate, useSearch } from "@tanstack/react-router";

export type SearchPatch = Readonly<Record<string, string | undefined>>;

export function useUrlSearch(): readonly [
  Readonly<Record<string, unknown>>,
  (patch: SearchPatch, options?: { readonly replace?: boolean }) => void,
] {
  const raw = useSearch({ strict: false }) as Readonly<Record<string, unknown>>;
  const navigate = useNavigate();
  const set = (patch: SearchPatch, options?: { readonly replace?: boolean }) => {
    void navigate({
      to: ".",
      search: (previous: Readonly<Record<string, unknown>>) => {
        const next: Record<string, unknown> = { ...previous };
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === "") delete next[key];
          else next[key] = value;
        }
        return next;
      },
      replace: options?.replace ?? false,
    } as never);
  };
  return [raw, set] as const;
}
