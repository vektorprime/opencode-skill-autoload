# opencode-skill-autoload

An [OpenCode](https://opencode.ai) 2 plugin that picks the right skills for each message you send and tells the model to load them, so you don't have to rely on the model noticing them on its own.

It uses your own embedding and reranking servers. Nothing is sent to a cloud service.

## How it works

1. When you send a message, the plugin compares it with your skills using the embedding server.
2. The closest matches are double-checked by the reranker.
3. For each skill that passes, the model is asked to load it before it starts. You'll see the skill load in the chat.

Skills already loaded in the session aren't requested again, and OpenCode's built-in skills are ignored. If a server is down or slow, your message goes through unchanged.

## Requirements

- OpenCode 2 (tested with 2.0.32, including inside OpenChamber)
- Node.js 22.6+ (only for `why.ts` and the tests)
- An embedding server and a reranker with OpenAI-style `/v1/embeddings` and `/v1/rerank` endpoints. Tested with these models on llama.cpp:

```bash
llama-server --port 8011 -hf jinaai/jina-embeddings-v5-text-small-retrieval-GGUF:Q8_0 --embedding --pooling last -c 8192 -ub 2048
llama-server --port 8012 -hf Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp:Q8_0 --reranking --pooling rank -c 8192 -ub 2048
```

## Install

1. Copy this folder to `~/.config/opencode/plugins/skill-autoload/`.
2. Put your server addresses in `skill-autoload.json`.
3. Restart OpenCode. In OpenChamber the plugin appears under Settings → Plugins.

The first message after installing may go through without skills while your skills are indexed. This takes a few seconds and happens once.

## Settings

Set these in `skill-autoload.json`:

| Setting | Default | What it does |
|---|---|---|
| `embedUrl` | `http://127.0.0.1:8011/v1` | Embedding server |
| `rerankUrl` | `http://127.0.0.1:8012/v1/rerank` | Reranker. Set to `""` to skip it |
| `mode` | `"directive"` | `"directive"` asks the model to load the skills, and you see it in the chat. `"attach"` adds them to your message directly, which always works but isn't shown in OpenChamber |
| `maxSkills` | `1` | Most skills per message |
| `deny` | `[]` | Skills never to pick, by ID |
| `force` | `{}` | Always pick a skill when a message matches a pattern, e.g. `{"git-workflow": ["\\bgit\\b"]}` |
| `includeBuiltin` | `false` | Also consider OpenCode's built-in skills |
| `timeoutMs` | `4000` | Give up after this long and send the message unchanged |

The matching thresholds are explained in `core.ts` if you want to fine-tune them.

## Check what it picked

Every decision is logged to `~/.local/state/opencode/skill-autoload.jsonl`.

To try messages without OpenCode:

```bash
opencode api skill.list > skills.json
node why.ts skills.json "squash my last 3 commits"
```

If `skills.json` comes back empty, run the first command again.

## Tests

The tests use the sample skills in `test/fixtures` and need both servers running:

```bash
EMBED_URL=http://127.0.0.1:8011/v1 RERANK_URL=http://127.0.0.1:8012/v1/rerank npm test
```

## License

MIT
