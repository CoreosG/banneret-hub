// Banneret Hub: whether the `/` company search is open, and whether there is a company to search.
// One host owns the dialog; the `/` key, the header button and the palette open it through here.
// States: closed, open. Open only while available; close, Escape, a result or losing the company close.
import { create } from "zustand";

interface CompanySearchState {
  /** An Enterprise workspace this machine has joined is active, outside Settings and Usage. */
  readonly available: boolean;
  readonly open: boolean;
}

export const useCompanySearchStore = create<CompanySearchState>(() => ({
  available: false,
  open: false,
}));

export function openCompanySearch(): void {
  if (useCompanySearchStore.getState().available) useCompanySearchStore.setState({ open: true });
}

export function closeCompanySearch(): void {
  useCompanySearchStore.setState({ open: false });
}

/** Set by the host only. Losing the company also closes the dialog. */
export function setCompanySearchAvailable(available: boolean): void {
  useCompanySearchStore.setState(available ? { available } : { available, open: false });
}
