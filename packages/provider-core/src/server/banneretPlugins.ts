export interface SoloPluginServers {
  readonly pluginClaude?: Record<
    string,
    { type: "http"; url: string; headers: Record<string, string> }
  >;
  readonly pluginCodex?: Record<string, { url: string; http_headers: Record<string, string> }>;
}
