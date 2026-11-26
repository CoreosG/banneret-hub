import { describe, expect, it } from "vite-plus/test";

import { linkOriginLabel } from "./linkOriginLabel";

describe("linkOriginLabel", () => {
  it("shows only the environment of a link's session name", () => {
    expect(linkOriginLabel({ label: "T3 Code · banneret-dev" })).toBe("banneret-dev");
    expect(linkOriginLabel({ label: "Banneret Hub · DESKTOP-SM5UK2D" })).toBe("DESKTOP-SM5UK2D");
  });

  it("keeps any other label whole", () => {
    expect(linkOriginLabel({ label: "Link · via banneret-dev" })).toBe("Link · via banneret-dev");
    expect(linkOriginLabel({ label: "banneret-dev" })).toBe("banneret-dev");
    expect(linkOriginLabel(undefined)).toBeUndefined();
  });
});
