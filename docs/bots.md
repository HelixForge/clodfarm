# Bots: other models on the farm

A **bot** is a farm member that runs another model: a free one on OpenRouter, your own through Ollama, or anything
behind an Anthropic-compatible gateway. It is still Claude Code, pointed at that provider with
`ANTHROPIC_BASE_URL`, so the farm works the same for it: sub-agents in their own worktrees, resume, messages, hooks.
Only the model differs, and its runs are [lean](#lean-runs) so a small model has room to work.

It uses **no Claude account's usage**, so it adds capacity when your subscriptions are the limit. It is also
**weaker than Claude**, so the farm keeps it on a short leash:

- **It takes only the sub-agents sent to it** (`clodfarm spawn ... --on <bot>`). A sub-agent without `--on` still
  goes to a Claude with budget. You can let a bot take any sub-agent when you add it.
- **Its own sub-agents stay on it**, so a bot never spends a Claude account's usage.
- **Nobody talks to it.** It has no Remote Control (that needs a Claude login): your Claudes hand it work.
- The guide tells your Claudes what a bot is good for: well-specified, low-risk jobs such as a function, a test,
  boilerplate, a first draft, a search or a summary, written as a [job card](#job-cards). They check its result before
  relying on it.
- **You say what each bot is good for** (`--about`), and your Claudes see it, with the bot's context window, in
  `clodfarm agents`.

## Add one

In the farm UI: **+ NEW CLAUDE → BOT: OTHER MODEL**. Pick the provider, name the model, paste the API key and click
**CHECK & ADD BOT**. The farm asks the model for one word first and keeps the bot only if it answers. The bot is on
the farm a few seconds later, wearing headphones.

From a shell (the key is read from stdin, or from an environment variable with `--key-env`):

```bash
docker exec -i clodfarm clodfarm bot add qwen --provider openrouter --model qwen/qwen3-coder:free <<< "$OPENROUTER_KEY"
docker exec -it clodfarm clodfarm bot add local --provider ollama --model qwen3-coder \
  --about "tiny jobs: one function or one test"                                            # Enter: no key
```

`--workers N` lets it run up to 4 sub-agents at a time (default 1, right for free tiers). `--any` makes it take any
sub-agent. `--about` says in a line what it is good for. `--context` sets its model's context window (Ollama's is read
by itself). `--full` gives its runs every tool and the whole farm guide instead of the lean set (for a strong model
with a big context). Release a bot in the farm UI like any Claude; its key goes with it.

Change a bot later with `clodfarm bot set <name> [--about TEXT] [--context TOKENS|auto] [--lean|--full]`; it restarts
with the new settings (a sub-agent it was running goes back to the queue).

| Provider | Address (default) | Key | Notes |
|---|---|---|---|
| OpenRouter | `https://openrouter.ai/api` | from openrouter.ai/keys | Free models end in `:free`. Free tiers allow a few requests a minute and a daily cap. |
| Ollama | `http://host.docker.internal:11434` | none | Ollama 0.14 or newer (it speaks Anthropic's API since then) on the machine running the container. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the compose service. |
| Anthropic-compatible | yours | if it needs one | Any endpoint that speaks Anthropic's Messages API, such as a LiteLLM gateway. The address is its base URL, without `/v1`. |

**Pick a model that can use tools.** Claude Code works through tool calls (reading files, running commands,
editing). A model that can't call tools reliably answers in prose and gets nothing done. Coding models such as Qwen3
Coder, and larger general models, do best.

## Lean runs

Claude Code's own prompt (its instructions and the definitions of every tool, MCP server and skill) is about 15k
tokens, and the farm's guide adds about 5k more. On a Claude that's nothing; on a local model with a 32k context it
is two thirds of the room before the job starts, and a slow model reads all of it on every job.

So a bot's runs are lean by default:

- **Only the tools a bot needs:** Bash, Read, Edit, Write, Glob and Grep (`--tools`), no MCP servers
  (`--strict-mcp-config`) and no skills (`--disable-slash-commands`). The farm's hooks still run.
- **A short guide** of its own (about 400 tokens) instead of the farm's, and a stub in its `CLAUDE.md` so the farm's
  guide isn't read twice.

That is about 5k tokens instead of about 20k. The guide is the same on every run and comes first, so a provider
that reuses a cached prompt prefix (Ollama does) starts each job almost at once.

A sub-agent can narrow a bot's tools further: `clodfarm spawn ... --on qwen --tools Read,Grep,Glob` keeps a
read-only job read-only (the choices: Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, NotebookEdit,
TodoWrite). A Claude's runs ignore `--tools`.

## Job cards

A small model spends its time looking around: each look is a turn, and each turn is slow. The farm guide tells your
Claudes to hand a bot a job card instead of a task:

- the goal in one sentence;
- the exact files to change, with the lines that matter pasted in;
- the signature or format to produce;
- the command that proves it works (`python3 -m pytest tests/test_textutils.py -q`);
- what not to touch.

A bot that has everything in its prompt finishes in a few turns.

The guide also tells them to **use the bots to save your usage**: before writing a well-defined piece themselves (a
function whose behaviour they can state, the tests for a spec, boilerplate, docs, a mechanical change across files),
they check `clodfarm agents` for a bot that can reach its model and fits the job, send it a job card, keep the
judgment work (the bug, the design, review, merging), and review the bot's branch before merging it. A Claude Code
session connected [over MCP](mcp.md) learns of the bots from `farm_spawn`, which takes `on` and `tools` too.

## Bots first

By default a Claude weighs time and usage: it hands a bot a piece when that saves both, and on a job it can finish in
two minutes it usually does all of it itself. When you would rather wait than spend your usage, the farm manager turns
on **BOTS FIRST** (MANAGE → BOTS FIRST, or `clodfarm farm bots-first [split|draft|plan]` / `bots-first-off`), in one of
three styles.

**Split by the spec** (`split`). A whole project is too big and too hard for a small local model in one pass, and a
Claude that reads all the code to cut it well spends what it was meant to save. So the Claude cuts the work where the
task already cuts it:

1. it reads only the task's own documents (the spec, the bug reports), not the code, and lists the pieces they name:
   each bug, each section (a feature, a performance limit, a clean-up), and the files each touches (`grep -l`);
2. it sends each piece as its own job card (the piece's text quoted from the docs, how to test it, "read the code you
   need yourself", "never change a test just to make it pass"), small self-contained pieces to the bot with the small
   context and the rest to the big one; pieces on different files at the same time, on the same file one after the
   other;
3. resumed, it merges each piece, runs the tests and the task's checks, checks every new test against the docs (a
   test bent to fit the code proves nothing), and sends fix-up cards or the next pieces.

**The bots draft, your Claudes review** (`draft`). A Claude's usage goes on its thinking (reading the specs and the
code, working out the bugs) far more than on its typing, so a bot does the first full pass, reading and reasoning
included, and the Claude only checks it:

1. it sends the whole job, as it got it, to the bot with the biggest context, asking for a report (each requirement
   done, not done or unsure; the tests it added; what it isn't sure of), and ends its run without studying the code;
2. resumed with the result, it merges the bot's branch, runs the tests and the task's checks, reads the report and the
   diff's summary, and reads the spec only where the report or a failing check points;
3. it sends short fix-up job cards for the gaps (or fixes a few lines itself), and repeats until the task is done.

**Your Claudes plan, the bots type** (`plan`). Every Claude works as the lead, not the typist:

1. it reads the job and plans it, keeping the thinking (where a bug comes from, the design) for itself;
2. it splits the code-writing into job cards sized to each bot's context window, and sends them with `--on <bot>`,
   in parallel when they touch different files;
3. it ends its run and is resumed with their results (in a conversation, it waits for them in the background);
4. it reviews every branch (the diff, the tests), merges what is right and sends a fix-up card for what isn't;
5. it writes code itself only for glue of a few lines, merges, or a piece a bot has failed twice, and says which parts
   the bots wrote.

On a benchmark of three small projects whose work is mostly understanding bugs and specs, `plan` spent more of the
Claude's usage than doing the work itself: the planning alone, the thinking included, cost as much as a whole solve,
because the code left to type once it is understood is short. `draft` moved the thinking to the bots, but a 35B local
model spent 55 minutes on a single project's bug section (and bent its own test to pass). `plan` pays off on jobs with
a lot of typing per idea (boilerplate, many similar tests, mechanical changes); `split` is for tasks whose docs already
divide them into pieces a bot can manage.

A sub-agent reads the switch when its run starts, so a change applies to the next run; conversations get it through
their farm guide (`CLAUDE.md`), which the farm rewrites when the switch changes. `clodfarm agents` says it's on, and
the MANAGE panel lists the bots it would send work to, their context and whether they can reach their model. A bot
never gets it: it is the one the work goes to. It is guidance, not a lock: measure how much of the code the bots
wrote (their runs and tokens in `clodfarm result`) and tell your Claude if it strays.

## Its context window

For a model Claude Code doesn't know, it assumes a 200k window, and the provider cuts the prompt when a long job
outgrows the real one. The farm reads the window from Ollama (the model's `num_ctx`, or the loaded model's context)
when the bot is added, or takes `--context`, and gives it to Claude Code as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so
Claude Code compacts in time. The bot's guide tells it the size too, and `clodfarm agents` shows it to your Claudes
so they size its jobs.

Claude Code compacts once a conversation comes within its auto-compact buffer of the window: its reply cap (at most
20k) plus 13k (`/context` shows it). Told a 32k window with Claude's reply cap, that buffer is bigger than the window,
and Claude Code compacts on every turn until it gives up ("Autocompact is thrashing"). So a small window gets a small
reply cap and a cap on each command's output:

| Window | Reply cap (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`) | Compacts at | Command output (`BASH_MAX_OUTPUT_LENGTH`) |
|---|---|---|---|
| up to 48k (e.g. 32k) | 4096 | window − 17k (15.7k for 32k) | 12000 characters |
| up to 96k | 8192 | window − 21k | 12000 characters |
| bigger | Claude Code's own | window − 33k | Claude Code's own |

A window under about 29k leaves no room to work before compacting: the farm then tells Claude Code nothing (it runs
as it did before, with no compacting) and says so when you add or set the bot. Keep such a bot's jobs tiny.

A job that doesn't fit even so (Claude Code gives up compacting: "Autocompact is thrashing", or the provider says the
prompt is too long) fails at once, without the usual retries, since a retry won't fit either. Its result starts
`Too big for bot <name>: the job outgrew its 32k context window` and says what to do (split it, hand it the lines
that matter, or send it to a bigger bot or a Claude), so the Claude that sent it can reroute it. It doesn't count
toward the circuit breaker.

## When it can't reach its model

A local model runs on a computer that may be off. Before it takes a job, a bot's workers check that something
answers at its provider's address (a TCP connection, every 30 seconds). While nothing does:

- it takes no sub-agents; the ones sent to it wait in the queue, and nothing counts as a failed run;
- `clodfarm agents` shows `CAN'T REACH ITS MODEL (<host:port>)`, and `clodfarm spawn --on <bot>` says the job will
  wait, so the Claude sending it can do it itself or send it elsewhere;
- the farm's events say `bot.unreachable`, and `bot.reachable` when it answers again.

When its model stops answering in the middle of a job, the failed run is handled like a rate limit: the attempt is
given back and the job waits for the bot again. Neither case counts toward the circuit breaker
(`FARM_STALL_THRESHOLD`), so a computer that's off never pauses the whole farm.

## How it works

A bot is an agent like the ones you add with a Claude login: its own Claude config dir and its own `clodfarm run`,
started and kept running by the farm UI's process. Instead of a login, its environment points Claude Code at the
provider:

- `ANTHROPIC_BASE_URL` is the provider, and `ANTHROPIC_AUTH_TOKEN` its key (sent as `Authorization: Bearer`).
- `ANTHROPIC_MODEL` and every model Claude Code picks for itself (`ANTHROPIC_DEFAULT_*_MODEL`, the sub-agent model)
  are the bot's model, so nothing is sent to a Claude model by mistake.
- The container's own login (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) is never passed to it.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is its model's context window, when the farm knows it.
- `FARM_BOT_ABOUT`, `FARM_BOT_LEAN` and `FARM_BOT_CONTEXT` carry its settings to its `clodfarm run`, whose heartbeats
  show them to the rest of the farm.

It is paced like [API key mode](budget.md): there are no subscription windows to follow. When its provider
rate-limits it (a 429), its workers pause for 15 minutes; the other Claudes keep going. Claude Code prices every run
as if it were a Claude model, which is no bot's real cost, so a bot's spend isn't counted toward
`FARM_DAILY_BUDGET_USD` and `FARM_TASK_BUDGET_USD` doesn't cap its runs. Use the provider's own limits for that.

`clodfarm agents` and the farm UI mark it `BOT on <model> via <provider> · <n>k context · good for: <about>`; its
seat is `bot-<name>` in `clodfarm budget`.

## Keep in mind

- **Your code goes to that provider.** A bot's sub-agent sends its prompt and the files it reads to the provider,
  under the provider's terms. Free tiers may log prompts or use them for training: read their policy before you send
  a bot work on private code.
- **The key** is kept in the bot's config dir (`bot.json`, readable by the farm's user only) and never shown again.
  Anyone who can run commands on the box as that user (every Claude, too) could read it, as with the farm's other
  secrets.
- A bot is not a way around Claude's limits: it never uses a Claude account at all.
