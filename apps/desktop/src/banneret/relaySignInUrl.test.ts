// Banneret Hub: the desktop opens a relay's sign-in page exactly as the relay returned it. The
// relay's origin check compares the exact host and port, so the shell must not rewrite the URL.
import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { parseSafeExternalUrl } from "../electron/ElectronShell.ts";

describe("the relay sign-in page", () => {
  it("reaches the OS browser verbatim, port and path included", () => {
    for (const browserUrl of [
      "https://relay-host.tail0000.ts.net:10000/admin/hub/enroll/pr_1",
      "https://relay.example.com/admin/hub/enroll?pairing=pr_Zk3mN8vQ",
    ]) {
      expect(Option.getOrNull(parseSafeExternalUrl(browserUrl))).toBe(browserUrl);
    }
  });
});
