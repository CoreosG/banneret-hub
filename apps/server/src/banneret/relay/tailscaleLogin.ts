// @effect-diagnostics nodeBuiltinImport:off - reads this host's Tailscale CLI on demand.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

const status = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      BackendState: Schema.Literal("Running"),
      Self: Schema.Struct({ UserID: Schema.Number }),
      User: Schema.Record(Schema.String, Schema.Struct({ LoginName: Schema.String })),
    }),
  ),
);

const readStatus = async () =>
  (
    await NodeUtil.promisify(NodeChildProcess.execFile)("tailscale", ["status", "--json"], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout;

export async function readTailscaleLogin(read = readStatus): Promise<string | null> {
  try {
    const value = status(await read());
    return value.User[String(value.Self.UserID)]?.LoginName.trim() || null;
  } catch {
    return null;
  }
}
