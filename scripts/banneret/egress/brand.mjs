// Source-specific substitutions run before bundling, alongside the fork's identity rewrites.
// An upstream change to any anchor fails the build and names the affected file.
const repo = "https://github.com/CoreosG/banneret-hub";
const localApp =
  '((typeof location !== "undefined" && /^https?:$/.test(location.protocol)) ? location.origin : "http://127.0.0.1:3793")';
const rules = {
  "packages/shared/src/connectAuth.ts": [['"https://app.t3.codes"', localApp]],
  "packages/shared/src/providerAuthReturnUrl.ts": [
    [' || url.origin === "https://app.t3.codes"', ""],
  ],
  "apps/server/src/cloud/publicConfig.ts": [
    ['"https://nightly.app.t3.codes"', "DEFAULT_HOSTED_APP_URL"],
  ],
  "apps/web/src/hostedPairing.ts": [
    [
      "originFromUrl(configuredHostedAppUrl())",
      'originFromUrl(import.meta.env.VITE_HOSTED_APP_URL || "")',
    ],
    [
      'new URL("/pair", configuredHostedAppUrl())',
      'new URL("/pair", import.meta.env.VITE_HOSTED_APP_URL || input.host)',
    ],
  ],
  "apps/web/src/components/onboarding/WelcomePage.tsx": [
    [
      "<TelemetryNotice environmentId={environmentId} />",
      '<p className="text-2xs">Banneret Hub does not send product analytics.</p>',
    ],
  ],
  "apps/web/src/components/settings/SettingsPanels.tsx": [
    [
      'gt("How we handle your data, including the anonymous usage data T3 Code collects.")',
      '"How Banneret Hub handles your data."',
    ],
  ],
  "apps/web/src/components/settings/MobileAppSettingsRow.tsx": [
    [
      'gt("Connect to your server from your phone or tablet.")',
      '"Pair directly with your server. T3 Connect shares account and tunnel details with its relay. Mobile push shares device tokens. Both require an opt-in build."',
    ],
  ],
  "apps/web/src/branding.ts": [
    ["https://t3.codes/mobile", repo + "/blob/main/docs/banneret/mobile.md"],
  ],
  "apps/web/src/lib/bootError.ts": [["https://t3.codes/download", repo + "/releases/latest"]],
  "apps/server/src/project/ManagedProjectFolders.ts": [["https://t3.codes", repo]],
  "packages/contracts/src/t3ProjectFile.ts": [["See https://t3.codes", "See " + repo]],
  "apps/server/src/telemetry/AnalyticsService.ts": [
    ["Option.getOrElse(telemetryConfig.enabled, () => enabledByDefault)", "false"],
  ],
  "apps/desktop/src/updates/DesktopUpdatePolicy.ts": [
    ["feedUrl: updates.feedUrl", "feedUrl: undefined"],
  ],
  // The legacy npm service constructor is exported for upstream source tests. Delay its
  // Effect.fn registration so the bundler can remove its unused npm command and HTTP fallback.
  "apps/server/src/cloud/npmRelease.ts": [
    ['export const make = Effect.fn("NpmRelease.make")(', "export const make = () => Effect.gen("],
  ],
  "apps/server/src/policy/managedUpdates.ts": [
    ["const feedUrl = document?.limits?.updates?.feedUrl;", "const feedUrl = undefined;"],
  ],
  "packages/shared/src/cliRelease.ts": [
    ["baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL", "CLI_RELEASE_DEFAULT_BASE_URL"],
  ],
  "apps/web/src/components/desktopUpdate.logic.ts": [
    ["import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY", '"CoreosG/banneret-hub"'],
  ],
};

export function brandEgress(code, file) {
  const path = file.replaceAll("\\", "/");
  for (const [suffix, edits] of Object.entries(rules)) {
    if (!path.endsWith("/" + suffix)) continue;
    for (const [from, to] of edits) {
      if (!code.includes(from))
        throw new Error("Update Banneret egress rewrite for " + suffix + ": " + from);
      code = code.replaceAll(from, to);
    }
    break;
  }
  return code.replaceAll("pingdotgg/t3code", "CoreosG/banneret-hub");
}
