import { describe, expect, it } from "vite-plus/test";

import { parseBanneretRelayAddress } from "./banneretRelay.ts";

describe("parseBanneretRelayAddress", () => {
  it.each([
    ["relay.example.com", "https://relay.example.com"],
    ["https://relay.example.com/", "https://relay.example.com"],
    ["https://Relay.Example.com:8443", "https://relay.example.com:8443"],
    ["http://127.0.0.1:41234", "http://127.0.0.1:41234"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://127.1.2.3:8080", "http://127.1.2.3:8080"],
    ["http://LOCALHOST:3000", "http://localhost:3000"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://[::1]:9000", "http://[::1]:9000"],
  ])("accepts %s as %s", (input, origin) => {
    expect(parseBanneretRelayAddress(input)).toEqual({ ok: true, origin });
  });

  it.each([
    ["http://relay.example.com", "The relay must use https."],
    ["http://10.0.0.5", "The relay must use https."],
    ["http://127.evil.example", "The relay must use https."],
    ["http://127.0.0.1.evil.example", "The relay must use https."],
    ["http://127.0.0.1.nip.io:8080", "The relay must use https."],
    ["http://localhost.evil.example", "The relay must use https."],
    ["ftp://relay.example.com", "The relay must use https."],
    [
      "https://ada:secret@relay.example.com",
      "The address must not contain a user name or password.",
    ],
    ["https://relay.example.com/relay/v1", "Enter only the relay's address, without a path."],
    ["https://relay.example.com/?x=1", "Enter only the relay's address, without a path."],
    ["https://relay.example.com/#top", "Enter only the relay's address, without a path."],
    ["https://", "That is not a web address."],
  ])("refuses %s", (input, message) => {
    expect(parseBanneretRelayAddress(input)).toEqual({ ok: false, message });
  });
});
