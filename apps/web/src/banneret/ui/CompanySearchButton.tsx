// Fork UI kit: the page header's way into the `/` company search, with the key as its hint. It shows
// only while there is a company to search (the search host says so).
import { SearchIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { openCompanySearch, useCompanySearchStore } from "../companySearchStore";

export function CompanySearchButton() {
  const available = useCompanySearchStore((state) => state.available);
  if (!available) return null;
  return (
    <Button size="sm" variant="outline" onClick={openCompanySearch} aria-keyshortcuts="/">
      <SearchIcon aria-hidden />
      Search
      <Kbd className="-me-1">/</Kbd>
    </Button>
  );
}
