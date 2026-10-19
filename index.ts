// OpenCode 2 plugin: picks the skills that match each prompt with a remote embedding server + reranker
// instead of the model. In "directive" mode (default) a context message tells the model to load them
// with its skill tool, so each load shows in the chat. In "attach" mode they're added to the prompt's
// `skills` attachments, so OpenCode loads them as if the user had typed @skill-id.
import type { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, SkillIndex, type RankResult, type SkillLike, type VectorStore } from "./core.ts";

const ID = "skill-autoload";

const plugin: Plugin.Plugin = {
  id: ID,
  async setup(ctx) {
    const cfg = loadConfig(ctx.options);
    if (!cfg.enabled) return;

    const logPath = typeof cfg.log === "string" ? cfg.log : join(homedir(), ".local", "state", "opencode", `${ID}.jsonl`);
    const log = (entry: Record<string, unknown>) => {
      if (!cfg.log) return;
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        if ((statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) > 5_000_000) renameSync(logPath, `${logPath}.1`);
        appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
      } catch {}
    };

    const store: VectorStore = {
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value as any),
      remove: (key) => ctx.storage.remove(key),
    };
    const index = new SkillIndex(cfg, store);

    // Skill discovery is lazy in OpenCode 2: the first list can come back empty, so never cache that.
    const refresh = async () => {
      const res: any = await ctx.skill.list();
      const skills: SkillLike[] = Array.isArray(res) ? res : (res?.data ?? []);
      if (skills.length) await index.sync(skills);
      return skills.length;
    };
    refresh().catch((err) => log({ event: "index-error", error: String(err) }));

    // Skills attached or loaded in each session, as a fallback when the context read fails.
    // Cleared on compaction so a summarized-away skill can be attached again.
    const ledger = new Map<string, Set<string>>();
    const remember = (sessionID: string, ids: string[]) => {
      const set = ledger.get(sessionID) ?? new Set<string>();
      for (const id of ids) set.add(id);
      ledger.set(sessionID, set);
    };

    const activeSkills = async (sessionID: string): Promise<Set<string>> => {
      const active = new Set(ledger.get(sessionID) ?? []);
      try {
        const res: any = await ctx.session.context({ sessionID } as any);
        const messages: any[] = Array.isArray(res) ? res : (res?.data ?? []);
        for (const m of messages) {
          if (m.type === "skill" && m.skill) active.add(m.skill);
          if (m.type === "user") for (const s of m.skills ?? []) active.add(s.id);
          if (m.type === "assistant")
            for (const part of m.content ?? [])
              if (part.type === "tool" && part.name === "skill" && typeof part.state?.input?.id === "string") active.add(part.state.input.id);
        }
      } catch (err) {
        log({ event: "context-error", sessionID, error: String(err) });
      }
      return active;
    };

    // Posts a context message that lands right before the user's message. The model reads it;
    // OpenChamber doesn't display it. Posted with resume: false so it never starts a model turn by
    // itself, and waited on for at most 1 s so the prompt is never held up by it.
    const postSynthetic = async (sessionID: string, text: string, description: string, picks: string[]) => {
      try {
        const call = Promise.resolve(
          ctx.session.synthetic({ sessionID, text, description, metadata: { [ID]: { picked: picks, mode: cfg.mode } }, resume: false, delivery: "steer" } as any),
        );
        call.catch((err: unknown) => log({ event: "synthetic-error", sessionID, error: String(err) }));
        await Promise.race([call.catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
      } catch (err) {
        // Must never block or fail the prompt.
        log({ event: "synthetic-error", sessionID, error: String(err) });
      }
    };

    const quoted = (ids: string[]) => ids.map((id) => `"${id}"`).join(", ");
    const directive = (ids: string[]) =>
      `<system-reminder>\n` +
      `skill-autoload matched ${ids.length === 1 ? "a skill" : "skills"} to the user's next message. ` +
      `Before doing anything else, load ${ids.length === 1 ? "it" : "each one"} with the skill tool: ${quoted(ids)}. ` +
      `Then follow ${ids.length === 1 ? "its" : "their"} instructions while you work on the request.\n` +
      `</system-reminder>`;

    await ctx.session.hook("prompt", async (event) => {
      const text = event.prompt.text?.trim();
      if (!text) return;
      const started = Date.now();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error(`timed out after ${cfg.timeoutMs}ms`)), cfg.timeoutMs);
      // Every step runs under one budget, so the prompt is never held longer than timeoutMs. Work that
      // outlives the budget (e.g. a first-time re-embed) finishes in the background but never edits the prompt.
      const work = (async () => {
        const count = await refresh();
        if (!count) return undefined;
        const exclude = await activeSkills(event.sessionID);
        for (const s of event.prompt.skills ?? []) exclude.add(s.id);
        return { exclude, result: await index.rank(text, { exclude, signal: abort.signal }) };
      })();
      work.catch(() => {});
      const budget = new Promise<never>((_, rej) => abort.signal.addEventListener("abort", () => rej(abort.signal.reason), { once: true }));
      let out: { exclude: Set<string>; result: RankResult } | undefined;
      try {
        out = await Promise.race([work, budget]);
      } catch (err) {
        return log({ event: "error", sessionID: event.sessionID, ms: Date.now() - started, error: String(err) });
      } finally {
        clearTimeout(timer);
      }
      if (!out) return log({ event: "skip", sessionID: event.sessionID, reason: "no skills discovered yet" });
      const { exclude, result } = out;

      let postMs: number | undefined;
      if (result.picks.length) {
        const picks = result.picks;
        event.metadata = { ...(event.metadata ?? {}), [ID]: { picked: picks, mode: cfg.mode } };
        const t = Date.now();
        if (cfg.mode === "attach") {
          event.prompt.skills = [...(event.prompt.skills ?? []), ...picks.map((id) => ({ id }) as any)];
          remember(event.sessionID, picks);
          if (cfg.note) {
            const line = `skill-autoload attached: ${picks.join(", ")}`;
            await postSynthetic(event.sessionID, line, line, picks);
          }
        } else {
          // The model loads them with its skill tool, which OpenChamber shows in the chat. They count as
          // loaded only once that happens (tool hook / session context), so an ignored request is repeated
          // on the next matching prompt.
          await postSynthetic(event.sessionID, directive(picks), `skill-autoload: load ${picks.join(", ")}`, picks);
        }
        postMs = Date.now() - t;
      }
      log({
        event: "rank",
        sessionID: event.sessionID,
        prompt: text.slice(0, 160),
        picked: result.picks,
        skipped: [...exclude],
        mode: cfg.mode,
        ms: { total: Date.now() - started, ...result.ms, post: postMs },
        rerankError: result.rerankError,
        top: result.scored
          .sort((a, b) => b.embed - a.embed)
          .slice(0, 5)
          .map((s) => ({ id: s.id, embed: +s.embed.toFixed(3), rerank: s.rerank === undefined ? undefined : +s.rerank.toFixed(3), why: s.why })),
      });
    });

    await ctx.tool.hook("execute.after", (event) => {
      const id = (event.input as any)?.id;
      if (event.tool === "skill" && event.status === "completed" && typeof id === "string") remember(event.sessionID, [id]);
    });

    await ctx.session.hook("compaction", (event) => {
      ledger.delete(event.sessionID);
    });
  },
};

export default plugin;
