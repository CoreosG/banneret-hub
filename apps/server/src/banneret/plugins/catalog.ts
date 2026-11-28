import { readCapped } from "../relay/RelayClient.ts";
import type { ListedTool } from "./levels.ts";

// A Streamable HTTP POST may return JSON or SSE. Only its matching reply is a catalog.
export async function rpcResponse(response: Response, id: unknown) {
  const bytes = await readCapped(response, 4 * 1024 * 1024);
  if (!bytes) throw new Error("Plugin catalog is too large.");
  const body = new TextDecoder().decode(bytes);
  const messages = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? body
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n"),
        )
        .filter(Boolean)
    : [body];
  for (const message of messages) {
    const rpc = JSON.parse(message);
    if (rpc?.id !== id) continue;
    return rpc;
  }
  throw new Error("Missing plugin response.");
}
export async function catalog(response: Response, id: unknown) {
  const rpc = await rpcResponse(response, id);
  if (rpc.error) return { error: rpc.error };
  const tools: unknown = rpc.result?.tools;
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool?.name === "string"))
    throw new Error("Invalid plugin catalog.");
  const cursor: unknown = rpc.result.nextCursor;
  if (cursor !== undefined && typeof cursor !== "string") throw new Error("Invalid plugin cursor.");
  return {
    result: { ...rpc.result, tools: tools as ListedTool[] },
    tools: tools as ListedTool[],
    cursor,
  };
}
