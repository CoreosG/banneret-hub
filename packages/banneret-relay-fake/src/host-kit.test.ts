// @effect-diagnostics nodeBuiltinImport:off - the Linux kit is an external CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- the external distro Python executable is Linux-only.
it.skipIf(NodeOS.platform() !== "linux")(
  "exercises the Linux host kit against the fake relay",
  async () => {
    const suite = NodeURL.fileURLToPath(
      new URL("../../../scripts/banneret/pool/test_pool.py", import.meta.url),
    );
    const { stderr } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "/usr/bin/python3",
      ["-B", suite],
      {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    expect(stderr).toContain("OK");
  },
);
