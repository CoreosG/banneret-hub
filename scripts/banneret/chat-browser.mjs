// Browser test transport. Signing keys stay in the test runner. Each test owns a fake relay.
import {
  startFakeRelay,
  RelayClient,
  generateMachineKey,
} from "../../packages/banneret-relay-fake/src/index.ts";
import { callChannel } from "../../packages/contracts/src/banneretChat.ts";
let session;
async function enrol(relay, login) {
  const client = new RelayClient(relay.url),
    key = generateMachineKey();
  const start = await client.send(key, "POST", "/relay/v1/enroll/start", {
    body: {
      publicKey: key.publicKey,
      machine: {
        environmentId: "env_" + login,
        label: "Test laptop",
        kind: "laptop",
        hostname: "test-host",
        os: "Linux",
        hubVersion: "0.4.2",
        policyFingerprint: null,
        sandbox: { enabled: false, image: null },
      },
    },
  });
  relay.approve(start.body.confirmCode, { login, role: "founder" });
  const approved = await client.send(key, "POST", "/relay/v1/enroll/poll", {
    body: { pairingId: start.body.pairingId },
  });
  const call = async (method, path, body) => {
    const result = await client.send(key, method, "/relay/v1/" + path, {
      token: approved.body.token,
      device: approved.body.machineId,
      body,
    });
    if (result.status >= 400) throw new Error(JSON.stringify(result.body));
    return result;
  };
  const me = (await call("GET", "capabilities")).body.me;
  const run = async (action) => {
    try {
      const result = await callChannel(action, (method, path, body) =>
        call(method, "chat/" + path.replace(/\/members\/@me$/, "/members/" + me.id), body),
      );
      return { ok: true, value: result.body };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  };
  return Object.assign(run, { me, call });
}
export async function command(op, arg) {
  if (op === "start") {
    const relay = await startFakeRelay({ chat: true, autoApprove: false });
    session = { relay };
    try {
      const ada = await enrol(relay, "ada"),
        leo = await enrol(relay, "leo");
      session.ada = ada;
      session.leo = leo;
      const c = (
        await leo({
          kind: "create",
          name: "platform",
          purpose: "API changes and release coordination.",
          private: false,
        })
      ).value;
      await ada({ kind: "join", id: c.id });
      const root = (
        await leo({
          kind: "post",
          id: c.id,
          key: "launch",
          text: "The release candidate is ready for review.\n\n**API updates**\n- Uploads now resume after reconnecting\n- Large requests return a progress link",
        })
      ).value;
      await leo({
        kind: "post",
        id: c.id,
        root: root.id,
        key: "thread",
        text: "The migration finished on the test environment.",
      });
      await leo({
        kind: "post",
        id: c.id,
        key: "mention",
        text: "@ada could you check the upload flow before we release?",
      });
      await leo.call("PUT", "chat/handles/h_review", {
        name: "reviewer",
        threadRef: "review1",
        machineId: leo.me.machineId,
        provider: "codex",
      });
      await leo.call("POST", "chat/messages", {
        asHandle: "h_review",
        key: "review",
        conversationId: c.id,
        text: "The upload check passed.",
        card: {
          title: "Upload verification",
          tone: "ok",
          fields: [{ label: "Checks", value: "12 passed" }],
          links: [],
        },
      });
      await leo.call("PUT", "chat/messages/" + root.id + "/progress", {
        asHandle: "h_review",
        text: "Reviewing the release",
        state: "working",
        steps: [
          { title: "Run upload checks", state: "done" },
          { title: "Review results", state: "working" },
        ],
      });
      const kim = await enrol(relay, "kim");
      await kim.call("PUT", "chat/me/settings", { agentsReadMyDms: true });
      return {
        id: c.id,
        root: root.id,
        people: [ada.me, leo.me, kim.me].map(({ id, login }) => ({
          id,
          login,
          role: "founder",
          machines: [],
          sessions: [],
        })),
      };
    } catch (e) {
      await relay.close();
      throw e;
    }
  }
  if (op === "stop") {
    await session?.relay.close();
    session = undefined;
    return;
  }
  if (op === "leo") return session.leo(arg);
  if (op === "call") return session.ada(arg);
  throw new Error("Unknown chat test command.");
}
