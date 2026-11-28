// Banneret Hub: what the fork adds to the server's pack config.
import type { PackUserConfig } from "vite-plus/pack";

import { banneretBrandPlugin } from "./brand.mjs";

type ServerPack = PackUserConfig & {
  readonly deps: {
    readonly alwaysBundle: (id: string) => boolean;
    readonly neverBundle: (id: string) => boolean;
  };
};

export function banneretServerPack(packExecutable: boolean, pack: ServerPack): PackUserConfig {
  // SEA can't import zod from disk, so inline it there. Cursor's SDK still loads its own from disk.
  const inlined = (id: string) => packExecutable && /^zod(\/|$)/.test(id);
  const { alwaysBundle, neverBundle } = pack.deps;
  return {
    ...pack,
    plugins: [banneretBrandPlugin({ cli: true }), pack.plugins],
    deps: {
      ...pack.deps,
      alwaysBundle: (id: string) => inlined(id) || alwaysBundle(id),
      neverBundle: (id: string) => !inlined(id) && neverBundle(id),
    },
  };
}
