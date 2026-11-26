import type { Plugin } from "vite-plus";

export declare const OFFICIAL_NAME: string;
export declare const BRAND_NAME: string;
export declare const SCHEME: string;
export declare const SCHEME_RULES: ReadonlyArray<
  readonly [pattern: RegExp, replacement: string, files: ReadonlyArray<string>]
>;
export declare const CLI_NAME: string;
export declare const ENV_RENAMES: Readonly<Record<string, string>>;
export declare function titleServerEntry(code: string, file: string): string;
export declare function rebrandText(text: string, options?: { readonly cli?: boolean }): string;
export declare function hashCatalogSource(source: unknown, dataFormat: "ICU" | "JSX"): string;
export declare function catalogKeyRenames(
  englishCatalog: Record<string, unknown>,
): Map<string, string>;
export declare function rebrandCatalog(
  catalog: Record<string, unknown>,
  renames: ReadonlyMap<string, string>,
): Record<string, unknown>;
export declare function banneretBrandPlugin(options?: {
  readonly vite?: boolean;
  readonly cli?: boolean;
}): Plugin;
