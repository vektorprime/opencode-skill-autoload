// Shared test setup: sample skills, server addresses and a tiny check helper.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, type Config, type SkillLike, type VectorStore } from "../core.ts";

const skillsDir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "skills");

/** The sample skills, shaped like `opencode api skill.list` output, plus one fake built-in skill. */
export function sampleSkills(): SkillLike[] {
  const skills: SkillLike[] = readdirSync(skillsDir).map((id) => {
    const path = join(skillsDir, id, "SKILL.md");
    const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    const [, front, body] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
    const description = front.match(/^description:\s*(.*)$/m)![1].trim();
    return { id, name: id, description, path, content: body.trim() };
  });
  skills.push({
    id: "opencode",
    name: "OpenCode",
    description: "Use for questions about OpenCode itself: configuration, plugins, MCP servers and the CLI.",
    path: "/builtin/opencode.md",
    content: "# OpenCode\n\n## Configuration\n\nOpenCode reads opencode.json from the project and from ~/.config/opencode. Plugins, MCP servers and providers are configured there.",
  });
  return skills;
}

/** Defaults, with the server addresses taken from EMBED_URL / RERANK_URL when set. */
export function serverConfig(): Config {
  return {
    ...DEFAULTS,
    embedUrl: process.env.EMBED_URL ?? DEFAULTS.embedUrl,
    rerankUrl: process.env.RERANK_URL ?? DEFAULTS.rerankUrl,
  };
}

export function memoryStore(): VectorStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k) => data[k],
    set: async (k, v) => void (data[k] = v),
    remove: async (k) => void delete data[k],
  };
}

export function checker() {
  let failures = 0;
  return {
    check(name: string, ok: boolean, detail = "") {
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
    },
    done() {
      console.log(failures ? `\n${failures} failed` : "\nall passed");
      process.exit(failures ? 1 : 0);
    },
  };
}
