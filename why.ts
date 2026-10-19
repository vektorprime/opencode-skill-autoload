// Shows how the plugin would score prompts, using the same config and ranking code.
//
//   opencode api skill.list > skills.json        (run it twice if the first list is empty)
//   node why.ts skills.json "squash my last 3 commits" ["another prompt" ...]
//   node why.ts skills.json --exclude git-workflow "commit these changes"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, SkillIndex, type SkillLike, type VectorStore } from "./core.ts";

const args = process.argv.slice(2);
const skillsPath = args.shift();
if (!skillsPath || !args.length) {
  console.error('usage: node why.ts <skills.json from `opencode api skill.list`> [--exclude id,id] "prompt" ...');
  process.exit(2);
}
let exclude = new Set<string>();
const prompts: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exclude") exclude = new Set(args[++i].split(","));
  else prompts.push(args[i]);
}

const raw = JSON.parse(readFileSync(skillsPath, "utf8"));
const skills: SkillLike[] = Array.isArray(raw) ? raw : raw.data;
const cfg = loadConfig();

// File-backed vector cache so repeated runs skip re-embedding.
const cachePath = join(tmpdir(), "skill-autoload-why-cache.json");
const cache: Record<string, unknown> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
const store: VectorStore = {
  get: async (k) => cache[k],
  set: async (k, v) => void (cache[k] = v),
  remove: async (k) => void delete cache[k],
};

const index = new SkillIndex(cfg, store);
const t = Date.now();
await index.sync(skills);
writeFileSync(cachePath, JSON.stringify(cache));
const docs = [...index.entries.values()].reduce((n, e) => n + e.docs.length, 0);
const skipped = skills.filter((s) => !index.entries.has(s.id)).map((s) => s.id);
console.log(
  `${index.entries.size} of ${skills.length} skills indexed (${docs} docs) in ${Date.now() - t}ms` +
    (skipped.length ? ` | not considered: ${skipped.join(", ")}` : "") +
    (exclude.size ? ` | already loaded: ${[...exclude].join(", ")}` : ""),
);

for (const prompt of prompts) {
  const r = await index.rank(prompt, { exclude });
  console.log(`\n> ${prompt}\n  picked: ${r.picks.join(", ") || "(none)"}   [embed ${r.ms.embed}ms, rerank ${r.ms.rerank}ms]${r.rerankError ? `  rerank error: ${r.rerankError}` : ""}`);
  for (const s of r.scored.sort((a, b) => b.embed - a.embed).slice(0, 6)) {
    const rr = s.rerank === undefined ? "    -" : s.rerank.toFixed(3);
    console.log(`  ${s.picked ? "*" : " "} ${s.id.padEnd(40)} embed ${s.embed.toFixed(3)}  rerank ${rr}  ${s.why ?? ""}${exclude.has(s.id) ? "(loaded)" : ""}`);
  }
}
