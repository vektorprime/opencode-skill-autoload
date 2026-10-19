// Ranking tests. Needs the embedding and rerank servers (see README).
import { SkillIndex } from "../core.ts";
import { checker, memoryStore, sampleSkills, serverConfig } from "./helpers.ts";

const { check, done } = checker();
const skills = sampleSkills();
const cfg = serverConfig();
const store = memoryStore();

const index = new SkillIndex(cfg, store);
await index.sync(skills);
check("built-in skills are not indexed", index.entries.size === skills.length - 1 && !index.entries.has("opencode"), `${index.entries.size} indexed`);

// Messages and the skills they should get
const cases: [string, string[]][] = [
  ["squash my last 3 commits and force push to my branch", ["git-workflow"]],
  ["I have merge conflicts after pulling main, help me fix them", ["git-workflow"]],
  ["my container exits right after docker compose up", ["docker-compose"]],
  ["add a pytest fixture that mocks the database client", ["python-testing"]],
  ["add an index to the users table with a migration", ["sql-migrations"]],
  ["set up three-point lighting and render the scene in Blender", ["blender-modeling"]],
  ["what is the capital of France?", []],
  ["write a short poem about autumn", []],
];
for (const [message, want] of cases) {
  const r = await index.rank(message);
  check(`"${message}" -> ${want.join(", ") || "nothing"}`, JSON.stringify(r.picks) === JSON.stringify(want), `picked: ${r.picks.join(", ") || "nothing"}`);
}

// A skill already loaded keeps winning, so a weaker one doesn't take its place
const loaded = await index.rank("commit these changes", { exclude: new Set(["git-workflow"]) });
check("loaded skill is not picked again and blocks weaker matches", loaded.picks.length === 0, `picked: ${loaded.picks.join(", ")}`);

// Saved embeddings are reused
const warm = new SkillIndex(cfg, store);
const t = Date.now();
await warm.sync(skills);
check("second start reuses saved embeddings", Date.now() - t < 500);

// Reranker down: no crash, and only a clear embedding match can still be picked
const noRerank = new SkillIndex({ ...cfg, rerankUrl: "http://127.0.0.1:9/v1/rerank" }, store);
noRerank.entries = index.entries;
const r1 = await noRerank.rank("squash my last 3 commits and force push to my branch");
check("reranker down is handled", !!r1.rerankError && r1.picks.every((id) => id === "git-workflow"), `picked: ${r1.picks.join(", ") || "nothing"}`);

// Embedding server down: rank throws (the plugin catches it and sends the message unchanged)
const noEmbed = new SkillIndex({ ...cfg, embedUrl: "http://127.0.0.1:9/v1" }, store);
noEmbed.entries = index.entries;
let threw = false;
try {
  await noEmbed.rank("squash my commits");
} catch {
  threw = true;
}
check("embedding server down throws", threw);

// force and deny
const tuned = new SkillIndex({ ...cfg, force: { "sql-migrations": ["\\bpostgres\\b"] }, deny: ["git-workflow"] }, store);
await tuned.sync(skills);
check("force picks a skill on a pattern match", (await tuned.rank("is postgres any good?")).picks.includes("sql-migrations"));
check("denied skill is never picked", (await tuned.rank("squash my last 3 commits")).picks.length === 0);

// includeBuiltin brings built-in skills back
const withBuiltin = new SkillIndex({ ...cfg, includeBuiltin: true }, store);
await withBuiltin.sync(skills);
check("includeBuiltin indexes built-in skills", withBuiltin.entries.has("opencode"));

done();
