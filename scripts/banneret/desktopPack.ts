// Banneret Hub: every desktop bundle gets the fork's identity rewrite, ahead of its own plugins.
import type { PackUserConfig } from "vite-plus/pack";

import { banneretBrandPlugin } from "./brand.mjs";

export const banneretDesktopPack = (entries: ReadonlyArray<PackUserConfig>): PackUserConfig[] =>
  entries.map((entry) => ({ ...entry, plugins: [banneretBrandPlugin(), entry.plugins] }));
