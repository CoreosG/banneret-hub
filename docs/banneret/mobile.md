# Mobile access

Pair the stock app directly with your Banneret server over LAN or Tailscale. Get the app from the [Apple App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).

## Optional T3 services

- **T3 Connect** sends account, device and tunnel information to the configured relay and identity provider. Hub releases omit that configuration. To opt in when building a client, uncomment the Clerk and relay settings in `.env.example` in your own `.env`. Set `VITE_HOSTED_APP_URL` for the web build and `BANNERET_HOSTED_APP_URL` on the packaged server to the approval site you intend to use. Sign in and link the environment to create its tunnel.
- **Mobile relay notifications** send device tokens and Live Activity registrations to the configured relay. Fork mobile builds require `EXPO_PUBLIC_BANNERET_MOBILE_PUSH=1` as well as relay configuration and sign-in. Leave this unset for direct pairing. The separately distributed stock app controls its own network settings. Signing in to T3 Connect there uses T3's service.

- **Mobile crash reports** send startup timings, errors, stack traces and an install ID to the relay. A fork mobile build must enable `EXPO_PUBLIC_BANNERET_CRASH_REPORTS=1`. On that build you can turn off **Send crash reports** in Diagnostics.

The app uses a company's Banneret relay only when you join that workspace. Its setup is independent of T3 Connect.
