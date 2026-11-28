// @effect-diagnostics globalFetch:off - plugin calls preserve the MCP session and disable redirects.
export async function forward(
  request: Request,
  endpoint: string,
  token: string,
  signal: AbortSignal,
  body?: string,
) {
  const headers = transportHeaders(request);
  if (token) headers.set("Authorization", "Bearer " + token);
  const response = await fetch(endpoint, {
    method: request.method,
    headers,
    redirect: "error",
    signal,
    ...(request.method === "POST" ? { body: body ?? (await request.arrayBuffer()) } : {}),
  });
  const returned = new Headers();
  for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) {
    const value = response.headers.get(name);
    if (value) returned.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: returned });
}

function transportHeaders(request: Request) {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
export function storedTransport(request: Request, endpoint: string, body: string) {
  return { endpoint, body, headers: Object.fromEntries(transportHeaders(request)) };
}
export type StoredTransport = ReturnType<typeof storedTransport>;
