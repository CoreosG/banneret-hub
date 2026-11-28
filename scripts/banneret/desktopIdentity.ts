import { BRAND_NAME, OFFICIAL_NAME } from "./brand.mjs";

export const desktopProtocol = () => ({ name: BRAND_NAME, schemes: ["banneret", "banneret-dev"] });

export function brandUsageDescriptions(info: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(info).map(([key, value]) => [
      key,
      key.endsWith("UsageDescription") && typeof value === "string"
        ? value.replaceAll(OFFICIAL_NAME, BRAND_NAME)
        : value,
    ]),
  );
}
