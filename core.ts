// Skill ranking against a remote OpenAI-compatible embedding server and a /v1/rerank server.
// No OpenCode imports, so the plugin and the `why` CLI share it and Node can run it directly.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  enabled: boolean;
  /** OpenAI-compatible base (`.../v1`) or the full `.../v1/embeddings` URL. */
  embedUrl: string;
  embedModel?: string;
  /** Full rerank URL (`.../v1/rerank`). Empty string disables reranking. */
  rerankUrl: string;
  rerankModel?: string;
  apiKey?: string;
  /** jina-embeddings-v5 retrieval expects these prefixes. */
  queryPrefix: string;
  documentPrefix: string;
  /** Skill bodies are split on headings into chunks of at most this many characters. */
  chunkChars: number;
  /** How many skills (by embedding score) go to the reranker. */
  shortlist: number;
  /** Body chunks per shortlisted skill sent to the reranker, besides its summary. */
  chunksPerSkill: number;
  /** A skill must be within this embedding distance of the best skill to be picked. */
  margin: number;
  /** Reranker relevance (0..1) that confirms a skill... */
  rerankMin: number;
  /** ...as long as its embedding similarity is at least this. */
  embedFloor: number;
  /** The top skill is picked on embedding alone at or above this similarity... */
  embedStrong: number;
  /** ...and only if it leads the runner-up (loaded skills included) by at least this much. */
  embedGap: number;
  /** When the reranker is unreachable, the top skill needs this similarity (and embedGap). */
  embedOnlyMin: number;
  /** Most skills attached to one prompt. */
  maxSkills: number;
  maxQueryChars: number;
  /** Budget for one prompt's ranking; on timeout the prompt goes through untouched. */
  timeoutMs: number;
  /** Skill IDs never auto-attached. */
  deny: string[];
  /** Skill ID -> regexes (case-insensitive). A match always attaches the skill. */
  force: Record<string, string[]>;
  /** Also attach skills that set `metadata.opencode/autoinvoke: false`. */
  includeManualOnly: boolean;
  /** Consider OpenCode's built-in skills (path `/builtin/...`). Off: only your own skills are indexed. */
  includeBuiltin: boolean;
  /**
   * "directive": a context message tells the model to load the picked skills with its skill tool
   * (each load shows in the chat). "attach": the skills are attached to the prompt directly.
   */
  mode: "directive" | "attach";
  /** Attach mode only: post a one-line context note listing the attached skills. */
  note: boolean;
  /** JSONL decision log path, `true` for the default path, or `false`. */
  log: boolean | string;
}

export const DEFAULTS: Config = {
  enabled: true,
  embedUrl: "http://127.0.0.1:8011/v1",
  rerankUrl: "http://127.0.0.1:8012/v1/rerank",
  queryPrefix: "Query: ",
  documentPrefix: "Document: ",
  chunkChars: 1200,
  shortlist: 4,
  chunksPerSkill: 2,
  margin: 0.12,
  rerankMin: 0.2,
  embedFloor: 0.3,
  embedStrong: 0.47,
  embedGap: 0.04,
  embedOnlyMin: 0.5,
  maxSkills: 2,
  maxQueryChars: 1500,
  timeoutMs: 4000,
  deny: [],
  force: {},
  includeManualOnly: false,
  includeBuiltin: false,
  mode: "directive",
  note: true,
  log: true,
};

export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** DEFAULTS <- skill-autoload.json beside this file <- plugin options from opencode.json(c). */
export function loadConfig(options?: Record<string, unknown>): Config {
  let file: Partial<Config> = {};
  const path = join(PLUGIN_DIR, "skill-autoload.json");
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`[skill-autoload] ignoring unreadable ${path}: ${err}`);
    }
  }
  const cfg = { ...DEFAULTS, ...file, ...(options ?? {}) } as Config;
  if (process.env.SKILL_AUTOLOAD_DISABLE === "1") cfg.enabled = false;
  return cfg;
}

export interface SkillLike {
  id: string;
  name: string;
  description?: string;
  content: string;
  autoinvoke?: boolean;
  path?: string;
}

/** OpenCode ships built-in skills with virtual paths like `/builtin/opencode.md`. */
export const isBuiltin = (s: SkillLike) => /^[\\/]builtin[\\/]/.test(s.path ?? "");

/** Persists embeddings across restarts (backed by ctx.storage in the plugin). */
export interface VectorStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

interface Doc {
  kind: "summary" | "chunk";
  text: string;
  vec: Float32Array;
}

interface Entry {
  skill: SkillLike;
  hash: string;
  docs: Doc[];
}

export interface Scored {
  id: string;
  embed: number;
  rerank?: number;
  picked: boolean;
  why?: string;
}

export interface RankResult {
  picks: string[];
  scored: Scored[];
  ms: { embed: number; rerank: number };
  rerankError?: string;
}

// ---------------------------------------------------------------- documents

const cleanHeading = (h: string) =>
  h
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/^\d+(\.\d+)*\.?\s*/, "")
    .trim();

function headings(content: string): string[] {
  const all = [...content.matchAll(/^#{1,3} +(.+)$/gm)].map((m) => cleanHeading(m[1]));
  return [...new Set(all.filter((h) => h && !/table of contents/i.test(h)))];
}

export function summaryDoc(s: SkillLike, size: number): string {
  return `${s.name}: ${s.description ?? ""}\nCovers: ${headings(s.content).join("; ")}`.slice(0, size);
}

export function chunkDocs(s: SkillLike, size: number): string[] {
  const sections = s.content.replace(/\r\n/g, "\n").split(/\n(?=#{1,3} )/);
  const packed: string[] = [];
  let cur = "";
  for (const sec of sections) {
    if (cur && cur.length + sec.length > size) {
      packed.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + sec;
  }
  if (cur.trim()) packed.push(cur);
  const out: string[] = [];
  for (const p of packed) for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
  return out.filter((c) => c.trim().length > 80).map((c) => `${s.name}\n${c}`);
}

// ---------------------------------------------------------------- HTTP

function headers(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function postJson(cfg: Config, url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: headers(cfg), body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const embeddingsUrl = (u: string) => (/\/embeddings\/?$/.test(u) ? u : u.replace(/\/+$/, "") + "/embeddings");

/** Batches of 32, up to 4 requests in flight. */
export async function embed(cfg: Config, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 32) batches.push(texts.slice(i, i + 32));
  const results: Float32Array[][] = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = next++;
      const body: Record<string, unknown> = { input: batches[b] };
      if (cfg.embedModel) body.model = cfg.embedModel;
      const json = await postJson(cfg, embeddingsUrl(cfg.embedUrl), body, signal);
      results[b] = [...json.data].sort((x: any, y: any) => x.index - y.index).map((r: any) => normalize(Float32Array.from(r.embedding)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
  return results.flat();
}

/** Returns relevance per document, in input order. Accepts Jina/Cohere and TEI response shapes. */
export async function rerank(cfg: Config, query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
  const body: Record<string, unknown> = { query, documents, top_n: documents.length };
  if (cfg.rerankModel) body.model = cfg.rerankModel;
  const json = await postJson(cfg, cfg.rerankUrl, body, signal);
  const results: any[] = Array.isArray(json) ? json : json.results;
  const scores = new Array<number>(documents.length).fill(0);
  for (const r of results) scores[r.index] = r.relevance_score ?? r.score ?? 0;
  return scores;
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.7);
  return `${t.slice(0, head)}\n…\n${t.slice(t.length - (max - head))}`;
}

// ---------------------------------------------------------------- index

export class SkillIndex {
  cfg: Config;
  store?: VectorStore;
  entries = new Map<string, Entry>();
  #queue: Promise<void> = Promise.resolve();

  constructor(cfg: Config, store?: VectorStore) {
    this.cfg = cfg;
    this.store = store;
  }

  /** Embeds new or changed skills and drops removed ones. Calls are serialized. */
  sync(skills: SkillLike[]): Promise<void> {
    // Skills left out here are never embedded, ranked or attached.
    const wanted = this.cfg.includeBuiltin ? skills : skills.filter((s) => !isBuiltin(s));
    const run = this.#queue.then(() => this.#sync(wanted));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #sync(skills: SkillLike[]): Promise<void> {
    const seen = new Set<string>();
    const pending: { skill: SkillLike; hash: string; texts: string[]; prev?: Entry }[] = [];
    for (const skill of skills) {
      seen.add(skill.id);
      const hash = createHash("sha1")
        .update(JSON.stringify([this.cfg.embedUrl, this.cfg.embedModel, this.cfg.documentPrefix, this.cfg.chunkChars, skill.name, skill.description, skill.content]))
        .digest("hex");
      const prev = this.entries.get(skill.id);
      if (prev?.hash === hash) {
        prev.skill = skill;
        continue;
      }
      const texts = [summaryDoc(skill, this.cfg.chunkChars), ...chunkDocs(skill, this.cfg.chunkChars)];
      const stored = await this.#load(hash, texts.length);
      if (stored) this.#set(skill, hash, texts, stored, prev);
      else pending.push({ skill, hash, texts, prev });
    }
    if (pending.length) {
      // One embedding pass over every changed skill, so batches run in parallel across skills.
      const vecs = await embed(this.cfg, pending.flatMap((p) => p.texts.map((t) => this.cfg.documentPrefix + t)));
      let at = 0;
      for (const p of pending) {
        const mine = vecs.slice(at, (at += p.texts.length));
        await this.#save(p.hash, mine);
        this.#set(p.skill, p.hash, p.texts, mine, p.prev);
      }
    }
    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.entries.delete(id);
  }

  #set(skill: SkillLike, hash: string, texts: string[], vecs: Float32Array[], prev?: Entry) {
    const docs = texts.map((text, i) => ({ kind: i === 0 ? "summary" : "chunk", text, vec: vecs[i] }) as Doc);
    this.entries.set(skill.id, { skill, hash, docs });
    if (prev) this.store?.remove(`vec/${prev.hash}`).catch(() => {});
  }

  async #load(hash: string, n: number): Promise<Float32Array[] | undefined> {
    const raw = (await this.store?.get(`vec/${hash}`).catch(() => undefined)) as { n: number; dim: number; b64: string } | undefined;
    if (!raw || raw.n !== n) return undefined;
    // Copy into a fresh ArrayBuffer: a decoded Buffer may sit at an offset that isn't 4-byte aligned.
    const all = new Float32Array(Uint8Array.from(Buffer.from(raw.b64, "base64")).buffer);
    return Array.from({ length: n }, (_, i) => all.slice(i * raw.dim, (i + 1) * raw.dim));
  }

  async #save(hash: string, vecs: Float32Array[]): Promise<void> {
    const dim = vecs[0]?.length ?? 0;
    const all = new Float32Array(vecs.length * dim);
    vecs.forEach((v, i) => all.set(v, i * dim));
    await this.store?.set(`vec/${hash}`, { n: vecs.length, dim, b64: Buffer.from(all.buffer).toString("base64") }).catch(() => {});
  }

  /**
   * Ranks every indexed skill, then picks. Skills that can't be picked (already in context, denied,
   * manual-only) still take part in ranking, so a matching one keeps winning the margin test instead
   * of letting a runner-up through.
   */
  async rank(query: string, opts: { exclude?: Set<string>; signal?: AbortSignal } = {}): Promise<RankResult> {
    const cfg = this.cfg;
    const exclude = new Set(opts.exclude ?? []);
    const all = [...this.entries.values()];
    for (const e of all) if (cfg.deny.includes(e.skill.id) || (!cfg.includeManualOnly && e.skill.autoinvoke === false)) exclude.add(e.skill.id);
    const q = clip(query, cfg.maxQueryChars);

    const forced = all
      .filter((e) => !exclude.has(e.skill.id) && (cfg.force[e.skill.id] ?? []).some((re) => new RegExp(re, "i").test(query)))
      .map((e) => e.skill.id);

    const t0 = Date.now();
    const [qv] = await embed(cfg, [cfg.queryPrefix + q], opts.signal);
    const ranked = all
      .map((e) => {
        const sims = e.docs.map((d) => ({ d, sim: dot(qv, d.vec) }));
        const best = Math.max(...sims.map((s) => s.sim));
        const chunks = sims.filter((s) => s.d.kind === "chunk").sort((a, b) => b.sim - a.sim);
        return { e, best, sims, chunks };
      })
      .sort((a, b) => b.best - a.best);
    const tEmbed = Date.now() - t0;
    const top = ranked[0];
    const scored = new Map<string, Scored>(ranked.map((r) => [r.e.skill.id, { id: r.e.skill.id, embed: r.best, picked: false }]));
    if (!top) return { picks: [], scored: [], ms: { embed: tEmbed, rerank: 0 } };

    const candidates = ranked
      .slice(0, cfg.shortlist)
      .filter((r) => !exclude.has(r.e.skill.id) && r.best >= top.best - cfg.margin && r.best >= cfg.embedFloor);

    let rerankError: string | undefined;
    const t1 = Date.now();
    if (candidates.length && cfg.rerankUrl) {
      const docs = candidates.flatMap((r) => [
        { id: r.e.skill.id, text: r.sims[0].d.text },
        ...r.chunks.slice(0, cfg.chunksPerSkill).map((c) => ({ id: r.e.skill.id, text: c.d.text })),
      ]);
      try {
        const scores = await rerank(cfg, q, docs.map((d) => d.text), opts.signal);
        docs.forEach((d, i) => {
          const s = scored.get(d.id)!;
          s.rerank = Math.max(s.rerank ?? 0, scores[i]);
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        rerankError = String(err);
      }
    }
    const tRerank = Date.now() - t1;

    // Embedding-only acceptance needs a decisive winner, not a near-tie between generic skills.
    const clearTop = top.best - (ranked[1]?.best ?? 0) >= cfg.embedGap;
    for (const r of candidates) {
      const s = scored.get(r.e.skill.id)!;
      const isTop = r === top && clearTop;
      if (s.rerank !== undefined) {
        if (s.rerank >= cfg.rerankMin) s.why = "rerank";
        else if (isTop && r.best >= cfg.embedStrong) s.why = "embed-strong";
      } else if (isTop && r.best >= cfg.embedOnlyMin) {
        s.why = "embed-only";
      }
      s.picked = !!s.why;
    }
    for (const id of forced) {
      if (exclude.has(id)) continue;
      const s = scored.get(id)!;
      s.picked = true;
      s.why = "force";
    }

    const picks = [...scored.values()]
      .filter((s) => s.picked)
      .sort((a, b) => Number(b.why === "force") - Number(a.why === "force") || (b.rerank ?? 0) - (a.rerank ?? 0) || b.embed - a.embed)
      .slice(0, Math.max(cfg.maxSkills, forced.length))
      .map((s) => s.id);
    for (const s of scored.values()) if (!picks.includes(s.id)) s.picked = false;

    return { picks, scored: [...scored.values()], ms: { embed: tEmbed, rerank: tRerank }, rerankError };
  }
}
