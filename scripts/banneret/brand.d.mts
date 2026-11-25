import type { Plugin } from "vite-plus";

export declare const OFFICIAL_NAME: string;
export declare const BRAND_NAME: string;
export declare function rebrandText(text: string): string;
export declare function hashCatalogSource(source: unknown, dataFormat: "ICU" | "JSX"): string;
export declare function catalogKeyRenames(
  englishCatalog: Record<string, unknown>,
): Map<string, string>;
export declare function rebrandCatalog(
  catalog: Record<string, unknown>,
  renames: ReadonlyMap<string, string>,
): Record<string, unknown>;
export declare function banneretBrandPlugin(options?: { readonly vite?: boolean }): Plugin;
