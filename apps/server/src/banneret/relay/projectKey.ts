// @effect-diagnostics nodeBuiltinImport:off - Effect has no synchronous digest.
import * as NodeCrypto from "node:crypto";

import { parseGitRemoteRepository } from "@t3tools/shared/git";

/**
 * The relay's `projectKey` for a git remote: `sha256:` + hex of `host/owner/name`, lower case,
 * without scheme, credentials, port or `.git`. Null for a remote that names no host, such as a
 * local path, so no path can ever become a key.
 */
export function projectKeyFromRemote(remoteUrl: string): string | null {
  const repository = parseGitRemoteRepository(remoteUrl);
  if (repository === null || !repository.path.includes("/")) return null;
  const identity = `${repository.host}/${repository.path}`;
  return `sha256:${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`;
}
