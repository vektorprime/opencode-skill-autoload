// Runs the plugin (index.ts) against a fake OpenCode. Needs the embedding and rerank servers.
import plugin from "../index.ts";
import { checker, sampleSkills, serverConfig } from "./helpers.ts";

const { check, done } = checker();
const skills = sampleSkills();
const { embedUrl, rerankUrl } = serverConfig();
const storage: Record<string, unknown> = {};
const posted: any[] = [];

type Fakes = { mode?: string; note?: boolean; context?: () => Promise<unknown>; list?: () => Promise<unknown>; synthetic?: (i: any) => unknown };

async function start(f: Fakes = {}) {
  const hooks: Record<string, (e: any) => unknown> = {};
  const register = async (name: string, cb: (e: any) => unknown) => ((hooks[name] = cb), { dispose: async () => {} });
  const ctx: any = {
    options: { embedUrl, rerankUrl, timeoutMs: 1500, log: false, mode: f.mode ?? "directive", note: f.note ?? true },
    storage: {
      get: async (k: string) => storage[k],
      set: async (k: string, v: unknown) => void (storage[k] = v),
      remove: async (k: string) => void delete storage[k],
    },
    skill: { list: f.list ?? (async () => ({ data: skills })) },
    session: {
      context: f.context ?? (async () => []),
      synthetic: f.synthetic ?? (async (i: any) => void posted.push(i)),
      hook: (n: string, cb: any) => register(`session.${n}`, cb),
    },
    tool: { hook: (n: string, cb: any) => register(`tool.${n}`, cb) },
  };
  await plugin.setup(ctx);
  await new Promise((r) => setTimeout(r, 300));
  return hooks;
}

const message = (text: string, attached?: { id: string }[]) => ({
  sessionID: "ses_test",
  messageID: "msg_test",
  prompt: { text, ...(attached ? { skills: attached } : {}) },
  delivery: "steer",
});
const timed = async (fn: () => unknown) => {
  const t = Date.now();
  await fn();
  return Date.now() - t;
};
const GIT = "squash my last 3 commits and force push to my branch";

// Index the sample skills once so later tests start warm.
{
  const hooks = await start();
  await hooks["session.prompt"](message("warm up"));
  await new Promise((r) => setTimeout(r, 8000));
}

// Directive mode (default)
{
  posted.length = 0;
  const hooks = await start();
  const e = message(GIT);
  await hooks["session.prompt"](e);
  check(
    "directive: asks the model to load the skill, leaves the message alone",
    posted.length === 1 && posted[0].resume === false && posted[0].text.includes('"git-workflow"') && e.prompt.skills === undefined,
  );
}
{
  posted.length = 0;
  const hooks = await start();
  await hooks["session.prompt"](message(GIT));
  await hooks["session.prompt"](message(GIT));
  check("directive: asks again if the model didn't load it", posted.length === 2);
}
{
  posted.length = 0;
  const hooks = await start();
  await hooks["session.prompt"](message(GIT));
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "ses_test", status: "completed", input: { id: "git-workflow" } });
  await hooks["session.prompt"](message(GIT));
  check("directive: stops asking once the model loaded it", posted.length === 1);
}
{
  posted.length = 0;
  const history = [{ type: "assistant", content: [{ type: "tool", name: "skill", state: { input: { id: "git-workflow" } } }] }];
  const hooks = await start({ context: async () => history });
  await hooks["session.prompt"](message(GIT));
  check("directive: a load in the session history counts", posted.length === 0);
}
{
  posted.length = 0;
  const hooks = await start();
  await hooks["session.prompt"](message("what is the capital of France?"));
  check("off-topic message: nothing posted", posted.length === 0);
}

// Attach mode
{
  posted.length = 0;
  const hooks = await start({ mode: "attach" });
  const e = message(GIT);
  await hooks["session.prompt"](e);
  check("attach: skill added to the message", JSON.stringify(e.prompt.skills) === '[{"id":"git-workflow"}]');
  check("attach: one note posted", posted.length === 1 && posted[0].text === "skill-autoload attached: git-workflow");
}
{
  posted.length = 0;
  const hooks = await start({ mode: "attach", note: false });
  await hooks["session.prompt"](message(GIT));
  check("attach: note can be turned off", posted.length === 0);
}
{
  const hooks = await start({ mode: "attach" });
  const e = message("@opencode how do I add an MCP server?", [{ id: "opencode" }]);
  await hooks["session.prompt"](e);
  check("attach: a skill you attached yourself is kept", e.prompt.skills?.[0]?.id === "opencode");
}

// Never blocks or breaks a message
{
  const hooks = await start({ context: () => new Promise(() => {}) });
  const e = message(GIT);
  const ms = await timed(() => hooks["session.prompt"](e));
  check("stuck session read: message released at the time limit", ms < 2000, `${ms} ms`);
}
{
  const hooks = await start({ list: async () => { throw new Error("boom"); } });
  let threw = false;
  try {
    await hooks["session.prompt"](message(GIT));
  } catch {
    threw = true;
  }
  check("failing skill list: message still goes through", !threw);
}
for (const [label, synthetic] of [
  ["hangs", () => new Promise(() => {})],
  ["throws", () => { throw new Error("nope"); }],
] as const) {
  const hooks = await start({ synthetic });
  let threw = false;
  const ms = await timed(async () => {
    try {
      await hooks["session.prompt"](message(GIT));
    } catch {
      threw = true;
    }
  });
  check(`posting that ${label}: message still goes through quickly`, !threw && ms < 2500, `${ms} ms`);
}

done();
