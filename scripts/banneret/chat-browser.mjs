// Browser test transport. Signing keys stay in the test runner. Each test owns a fake relay.
import {
  startFakeRelay,
  RelayClient,
  generateMachineKey,
} from "../../packages/banneret-relay-fake/src/index.ts";
import { callChannel } from "../../packages/contracts/src/banneretChat.ts";
const sessions = new Map();
async function enrol(relay, login, admission = "member") {
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
  relay.approve(start.body.confirmCode, {
    login,
    admission,
    role: admission === "outside" ? "outside" : "founder",
  });
  const approved = await client.send(key, "POST", "/relay/v1/enroll/poll", {
    body: { pairingId: start.body.pairingId },
  });
  const call = async (method, path, body) => {
    const result = await client.send(key, method, "/relay/v1/" + path, {
      token: approved.body.token,
      device: approved.body.machineId,
      body,
    });
    if (result.status >= 400)
      throw Object.assign(new Error(result.body.error.message), { code: result.body.error.code });
    return result;
  };
  const me = (await call("GET", "capabilities")).body.me;
  const run = async (action) => {
    try {
      const result = await callChannel(action, (method, path, body, namespace) =>
        call(
          method,
          (namespace === "roles" ? "" : "chat/") +
            path.replace(/\/members\/@me$/, "/members/" + me.id),
          body,
        ),
      );
      return { ok: true, value: result.body };
    } catch (error) {
      return { ok: false, message: error.message, code: error.code };
    }
  };
  return Object.assign(run, { me, call });
}
export async function command(operation, arg) {
  const [key, op] = operation.includes(":") ? operation.split(":") : ["chat", operation];
  let session = sessions.get(key);
  if (op === "outsideStart") {
    const relay = await startFakeRelay({ chat: true, autoApprove: false });
    try {
      const ana = await enrol(relay, "ana");
      const guest = await enrol(relay, "rosa-dev", "outside");
      await enrol(relay, "kim");
      const { body: channel } = await ana.call("POST", "chat/conversations", {
        kind: "channel",
        name: "launch",
        template: "shared",
      });
      await ana.call("PUT", "chat/conversations/" + channel.id + "/members/" + guest.me.id, {});
      sessions.set(key, { relay, ada: guest });
      return guest.me;
    } catch (error) {
      await relay.close();
      throw error;
    }
  }
  if (op === "start") {
    const relay = await startFakeRelay({ chat: true, autoApprove: false });
    session = { relay };
    sessions.set(key, session);
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
          template: "team",
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
      await kim.call("PUT", "chat/me/settings", {
        ...(await kim.call("GET", "chat/me/settings")).body,
        agentsReadMyDms: true,
        agentWakeDefault: "everyone",
      });
      return {
        id: c.id,
        root: root.id,
        people: [ada.me, leo.me, kim.me].map(({ id, login, role, admission }) => ({
          id,
          login,
          role,
          admission,
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
    sessions.delete(key);
    return;
  }
  if (op === "ask") {
    await session.leo.call("POST", "chat/asks", {
      to: { kind: "person", person: session.ada.me.id },
      question: "Which build should I publish?",
      choices: ["Linux", "Mac"],
      asHandle: "h_review",
      key: "build",
    });
    return (await session.ada.call("GET", "needs")).body.items.find(
      (item) => item.kind === "chat_ask",
    );
  }
  if (op === "leo" && arg.kind === "threadChat" && arg.thread === "review1") {
    const response = arg.settings
      ? await session.leo.call("PUT", "chat/handles/h_review", {
          threadRef: arg.thread,
          machineId: session.leo.me.machineId,
          provider: "codex",
          ...arg.settings,
        })
      : await session.leo.call("GET", "chat/handles");
    return {
      ok: true,
      value: arg.settings ? response.body : response.body.items.find((h) => h.id === "h_review"),
    };
  }
  if (op === "leo") return session.leo(arg);
  if (op === "call") return session.ada(arg);
  throw new Error("Unknown chat test command.");
}
