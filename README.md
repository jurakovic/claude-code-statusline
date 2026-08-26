# Claude Code Statusline

A small, single-file Node.js statusline for [Claude Code](https://claude.ai/code),
trimmed from [ilia-pluzhnikov/claude-code-statusline](https://github.com/ilia-pluzhnikov/claude-code-statusline)
down to the segments that track spend: how much context you've burned, your
prompt-cache hit/write state, and your subscription rate limits. The model,
directory and git segments are gone.

No dependencies. No build step. Works on macOS, Linux, and Windows.

## Preview

```
██░░░ 480k/1M 48% ● │ cache 87% ↓75k +360 1h:42m │ 5h:35% (2h15m) │ 7d:42% (4d12h)
```

Each segment is color-coded so the shape of the line itself communicates urgency
at a glance. Segments only appear when they have something to say.

## What you see, left to right


| Segment | Meaning |
|---------|---------|
| `██░░░ 480k/1M 48%` | Context window usage — 5-cell bar with half-block precision (`█▌░`, ~10% per step in 5 cells), followed by the used percentage. When Claude Code provides absolute context counters, the bar is driven by `total_input_tokens / context_window_size` and the raw counts come before the percentage (`480k/1M 48%`). When only `remaining_percentage` is available, the bar falls back to `100 - remaining` and shows just the percentage |
| `●` | Absolute-token marker after the context bar. The bar is proportional, so a wide window hides how many tokens go over the wire on every request — 250k reads as a calm 25% of 1M. The dot is keyed on the raw `total_input_tokens` instead: yellow from 200k (where Claude Code's own `exceeds_200k_tokens` line sits), then amber, orange, vermilion and red at 350k / 500k / 650k / 800k. Hidden below 200k |
| `cache 87% ↓75k +360 1h:42m` | Prompt cache state. Read/write/input counters come from stdin `context_window.current_usage`; the session transcript only supplies the TTL bucket (`1h`/`5m`) and last-touch timestamp for the countdown. Hit ratio is `read / (input + write + read)`, colored from the shared ramp read backwards (a 70% hit ratio gets the color of 30% used) minus its cyan band: bold green at `≥90%`, green at 71–89%, lime at 61–70%, then yellow, amber, orange and vermilion every 10 points, red at `≤20%`, and bold red at `0%` for a full miss/invalidation. `↓` means tokens read from cache, `+` or `↑` means tokens written. The TTL label (`1h:` dim cyan, `5m:` yellow) is followed by the time left before the cache expires: dim while plenty remains, yellow under 25%, orange under 10%, red once expired. After `/compact`, `cache:reset` appears while stdin `current_usage` is null but the transcript shows earlier cache activity |
| `$3.46` | Session cost estimate — `cost.total_cost_usd`, which Claude Code computes client-side and warns may differ from the real bill. Shown only while tokens are paid for per use: when there are no `rate_limits` once a response has landed (API-key auth), or when a rate-limit bucket is at 100% (further usage bills as extra usage on accounts that have it enabled; the adjacent `5h:100%` tells you which case it is). `--cost` always shows it. Cyan under $1, then green, yellow from $5, orange from $10, red from $20; whole dollars from $100. A yellow `⚡` follows it in fast mode, which bills at a premium rate |
| `5h:35% (2h15m)` | 5-hour rate limit usage + reset countdown (`XhYm` / `Mm`) |
| `7d:42% (4d12h)` | 7-day rate limit usage + reset countdown: `NdXh` (`Nd` on a whole day; exactly 1 day renders as `24h` so the unit doesn't lie), `XhYm` / `Mm` below 1 day |

Rate limits come from the payload, which only refreshes when this session gets an
API response. A window whose reset time has already passed renders as `0%` with no
countdown instead of the stale pre-reset number; to see what other sessions have
used in the meantime, turn on [`--shared-rate-limits`](#options).

The context bar and rate-limit percentages share one color ramp:

| Used | Color |
|------|-------|
| < 15% | cyan |
| 15–29% | green |
| 30–39% | lime |
| 40–49% | yellow |
| 50–59% | amber |
| 60–69% | orange |
| 70–79% | vermilion |
| ≥ 80% | red, with a 💀 prefix on the context bar |

## Installation

1. **Clone or download** this repo.
2. **Drop `statusline.js`** anywhere you like. The natural location is `~/.claude/hooks/statusline.js`.
3. **Wire it up** in `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"/absolute/path/to/statusline.js\"",
       "refreshInterval": 60
     }
   }
   ```

   On Windows use forward slashes inside the JSON string: `"node \"C:/Users/you/.claude/hooks/statusline.js\""`.

   `refreshInterval: 60` re-runs the script every 60 seconds in addition to event-driven updates (new assistant message, `/compact`, permission mode change, vim mode toggle). Without it, the cache TTL countdown freezes in idle — Claude Code only refreshes the statusline on those events, so a value rendered 50 minutes ago will keep showing `60m remaining` until you press Enter. 60 seconds is enough to step through the color thresholds (dim → yellow → red) cleanly while staying cheap (the script only reads the last 16 KB of the session transcript). Requires Claude Code ≥2.1.97.

4. **Restart Claude Code.** That's it.

The script reads the standard Claude Code statusline JSON from stdin (session,
context window, rate limits, cost) and writes a single ANSI-coloured
line to stdout. It exits silently on any error so a broken statusline never blocks your
session.

## Options

Flags go at the end of the `command` string in `settings.json`, for example
`"command": "node \"/absolute/path/to/statusline.js\" --shared-rate-limits"`.

| Flag | Effect |
|------|--------|
| `--shared-rate-limits` | Share 5h/7d rate-limit readings across sessions. Rate limits are account-wide, but a session's payload only refreshes when that session gets an API response, so an idle session keeps showing numbers another session has already moved. With the flag on, every render publishes its reading to `<config dir>/statusline-ratelimits.json` (`CLAUDE_CONFIG_DIR`, else `~/.claude`, so separate accounts never pool their readings) and displays the newest observation of each bucket, whoever made it. Readings are ranked by when they were observed — the last API response in the transcript — and one that can't be dated is shown but never published. This is a shared last-known-good, not a live feed. Off by default: without the flag no file is read or written |
| `--cost` | Always show the session cost segment, not just while tokens are paid for per use |

## Optional companion hooks

### Why MD sync matters

Different coding agents read different memory files from your project root:

- **Claude Code** reads `CLAUDE.md`
- **OpenAI Codex** (and most agent-spec compliant tools) read `AGENTS.md`
- **Gemini CLI** reads `GEMINI.md`

If you use more than one agent on the same project, all three need to contain the
same project context — coding conventions, deploy instructions, "don't touch X"
rules. The moment they drift apart, one agent is following outdated rules while the
others aren't, and you start getting inconsistent behavior across tools without
knowing why. Worse: you update one file, forget the other two, and a week later a
different agent confidently violates a rule you thought you'd written down.

The drift detector turns this from an invisible bug into a visible one. The
`sync-md.js` hook below goes further and removes the manual work entirely: edit
`CLAUDE.md` and the other two regenerate from it automatically.

### The hooks

The statusline itself no longer shows git or MD-drift state. The
[`optional-hooks/`](./optional-hooks/) folder contains three small, independent hooks
that surface it at session start instead:

- **`md-sync-check.js`** — `SessionStart` hook. Warns Claude (via `additionalContext`) when the trio drifts.
- **`sync-md.js`** — `PostToolUse` hook. When you `Edit`/`Write` `CLAUDE.md`, it auto-mirrors the content into `AGENTS.md` and `GEMINI.md`, rewriting the per-file `Sync:` line.
- **`github-sync-check.js`** — `SessionStart` hook. Warns about uncommitted files and tells you when your branch has drifted from `origin/<branch>`. Runs `git fetch` in the background so the next session has fresh data.

See [`optional-hooks/README.md`](./optional-hooks/README.md) for installation snippets.
None of them are required for the statusline itself to work.

## How it stays fast

- **No subprocesses, no network.** Everything comes from stdin plus the session transcript.
- **Bounded transcript read.** Only the last 16 KB of the transcript is read, and only when the cache segment needs its TTL bucket or a `/compact` reset check, or `--shared-rate-limits` needs the time of the last response.
- **Shared rate limits stay cheap.** With `--shared-rate-limits`, each render reads one small JSON file and writes it only when this session holds a newer, different reading, via a temp file + rename so a concurrent reader never sees a partial file.
- **Stdin timeout (3s)** — if Claude Code never sends data, the script exits cleanly instead of hanging.

## Cross-platform notes

- **Path separators:** filesystem paths use `path.join` and `os.homedir()`;
  Claude transcript lookup intentionally mirrors Claude Code's project-slug
  convention by replacing drive colons, path separators, and dots with `-`.

## Customization

The script is a single file of dependency-free Node.js. Open it and tweak.
The most common customizations:

- **Hide the cache segment** — delete the `Prompt cache state` block. Useful if you don't run Claude Code in this terminal or don't want token counts visible.
- **Change the colour thresholds** — edit the `bands` ramp near the top.
- **Use a different separator** — change `' │ '` (the `│` character) on the final line.

## Requirements

- Node.js (any modern version — uses only built-in modules)
- Claude Code with statusline support (`statusLine` in `settings.json`)

## А еще я пишу статьи

А если хотите получше освоить Claude Code и вообще принцип работы AI, то у меня есть различные статьи на эту тему 
[https://ilia-pro-ai.com/](https://ilia-pro-ai.com/articles/)

<img width="1480" height="1123" alt="image" src="https://github.com/user-attachments/assets/cb8e6b16-2d60-4107-85c0-b01115cdb10e" />


## License

MIT — see [LICENSE](./LICENSE).

## Credits

Built by [Ilya Pluzhnikov](https://github.com/ilia-pluzhnikov).
PRs and forks welcome.
