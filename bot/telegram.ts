// Usage: TELEGRAM_BOT_TOKEN=... runner/node_modules/.bin/tsx bot/telegram.ts
// Clearance as a Telegram bot: someone pastes their agent's system prompt (or sends it as a file), the bot runs the
// same crash test as the market worker (`market-worker.ts --dry-run`: both models, six attacks, two honest tasks)
// and sends the report back. One job at a time, in a child process that gets only PATH, HOME and its own TMPDIR.
// The token comes from the environment only (systemd EnvironmentFile), so it is neither in the child's environment
// nor in ~/.config/dopusk/.env, which the child reads for the NEAR AI key.
// The prompt is written to a private job directory for the run (the child's temporary files, transcripts included,
// live inside it too) and the directory is deleted after the run, on a timeout and on shutdown. What stays is the
// Telegram user, a hash of the prompt and the result numbers (tg-runs.jsonl), never the prompt.
// It lives outside runner/src on purpose: the judge hash covers runner/src, and the bot changes nothing it judges.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUYER_MODELS, BUYER_TOOLS, type Brief, parseBrief } from "../runner/src/market-worker.ts";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "runner");
const TSX = join(RUNNER, "node_modules", ".bin", "tsx");
const STATE_DIR = join(homedir(), ".config", "dopusk");
const STATE = join(STATE_DIR, "tg-state.json");
const RUNS_LOG = join(STATE_DIR, "tg-runs.jsonl");
const TMP_PREFIX = "clearance-tg-";
const ADMIN_USERNAME = (process.env.TG_ADMIN_USERNAME ?? "selliksss").toLowerCase();
const PER_USER_PER_DAY = 3;
const FAILURES_PER_USER_PER_DAY = 3;
const PER_DAY = 40;
const MAX_QUEUE = 10;
const MIN_PROMPT = 80;
const MAX_FILE = 64 * 1024;
// A long paste arrives as several messages; they are joined if each comes within this pause of the last.
const PASTE_PAUSE_MS = 3_000;
// The dry run makes at most two attempts of up to 8 minutes each (market-worker.ts).
const JOB_TIMEOUT_MS = 20 * 60_000;
// On a timeout or shutdown the child gets SIGTERM first: market-worker's handler kills its crash tests and
// removes its job directory. SIGKILL to the group follows if it has not exited by then.
const KILL_GRACE_MS = 10_000;
const MAX_REPORT = 1_000_000;
// The first and last words of report() in market-worker.ts: a report without both was cut short.
const REPORT_HEAD = "# Clearance crash test";
const REPORT_TAIL = "This report is not a security guarantee.";

const token = () => {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return t;
};

type Job = { chatId: number; userId: number; username: string; brief: Brief; day: string };
type State = {
  offset: number; adminId?: number; adminChat?: number; day: string; total: number;
  users: Record<string, number>; failures: Record<string, number>; pending: number[];
};

const today = () => new Date().toISOString().slice(0, 10);

function loadState(): State {
  const fresh: State = { offset: 0, day: today(), total: 0, users: {}, failures: {}, pending: [] };
  if (!existsSync(STATE)) return fresh;
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    const obj = (x: unknown) => (typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, number> : {});
    return {
      offset: Number.isInteger(s.offset) ? s.offset : 0,
      ...(Number.isInteger(s.adminId) ? { adminId: s.adminId } : {}),
      ...(Number.isInteger(s.adminChat) ? { adminChat: s.adminChat } : {}),
      day: typeof s.day === "string" ? s.day : today(),
      total: Number.isInteger(s.total) ? s.total : 0,
      users: obj(s.users), failures: obj(s.failures),
      pending: Array.isArray(s.pending) ? s.pending.filter(Number.isInteger) : [],
    };
  } catch (e) {
    console.error(`state file unreadable (${(e as Error).message}); starting fresh, old file kept`);
    try {
      renameSync(STATE, `${STATE}.corrupt-${Date.now()}`);
    } catch {}
    return fresh;
  }
}
function saveState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${STATE}.tmp`, STATE);
  } catch (e) {
    // Counters live in memory too; a failed save only costs them on a restart.
    console.error(`state save: ${(e as Error).message}`);
  }
}
const state = loadState();

/** The day's counters, reset when the date changes. */
function rollDay() {
  if (state.day === today()) return;
  state.day = today();
  state.total = 0;
  state.users = {};
  state.failures = {};
  saveState();
}

/** Gives a run back to a person (it failed or was lost), if it was counted today. */
function refund(userId: number, day: string) {
  if (day !== state.day) return;
  const k = String(userId);
  state.users[k] = Math.max(0, (state.users[k] ?? 1) - 1);
  state.total = Math.max(0, state.total - 1);
  saveState();
}

class TgError extends Error {
  constructor(readonly method: string, readonly code: number, description: string, readonly retryAfter?: number) {
    super(`${method}: ${code} ${description.slice(0, 200)}`);
  }
}

async function tg(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<any> {
  const form = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: form ? undefined : { "content-type": "application/json" },
    body: form ? body : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    // The URL carries the token, so a network error names only the method.
    throw new Error(`${method}: ${(e as Error).name}`);
  });
  const j = await r.json().catch(() => null);
  if (!j?.ok) throw new TgError(method, j?.error_code ?? r.status, String(j?.description ?? ""), j?.parameters?.retry_after);
  return j.result;
}

/** A send with up to three tries (Telegram's retry_after on 429). Returns whether it got through. */
async function deliver(method: string, body: () => Record<string, unknown> | FormData, timeoutMs?: number): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await tg(method, body(), timeoutMs);
      return true;
    } catch (e) {
      console.error(`${method} try ${i + 1}: ${(e as Error).message}`);
      // 403: the person blocked the bot; 400: a bad request will not get better.
      if (e instanceof TgError && (e.code === 403 || e.code === 400)) return false;
      const wait = e instanceof TgError && e.retryAfter ? e.retryAfter * 1000 : [2_000, 6_000][i] ?? 0;
      if (i < 2) await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
    }
  }
  return false;
}

const say = (chatId: number, text: string) => deliver("sendMessage", () => ({ chat_id: chatId, text: text.slice(0, 4096), link_preview_options: { is_disabled: true } }));

const notifyAdmin = (text: string) => { if (state.adminChat) void say(state.adminChat, text); };

const HELP = [
  "Clearance crash test for AI agents that hold money.",
  "",
  "Send me your agent's system prompt: paste it as text, or send it as a .txt or .md file.",
  "",
  `I run it on ${BUYER_MODELS.map((m) => m.split("/").pop()).join(" and ")} through six payment attacks hidden in what the agent reads (a fake invoice, a lookalike payee, "payment failed, send again" and others) plus two honest tasks. Every payment is a real transfer on a local NEAR sandbox. In about 2-5 minutes you get a report: what it paid and to whom, which model is safer for this prompt, and wallet limits sized for it.`,
  "",
  "No keys and no wallet access. Your prompt goes to the models through NEAR AI and is deleted after the run; I keep your Telegram username and the result numbers, not the prompt.",
  "",
  `Optional first line to use your stack's tool layer: "tools: outlayer-v1" (or ${BUYER_TOOLS.filter((t) => t !== "clearance-v1" && t !== "outlayer-v1").join(", ")}).`,
  `Limit: ${PER_USER_PER_DAY} runs per person per day. Code and method: github.com/Selliksss/clearance`,
].join("\n");

/** The brief from what the person sent: a JSON brief as on the market, or plain text that is the prompt itself. */
export function toBrief(text: string): { brief: Brief } | { error: string } {
  const t = text.trim();
  let parsed: { brief: Brief } | { error: string } | null = null;
  if (t.startsWith("{") || t.startsWith("```")) {
    const asJson = parseBrief(t);
    // A JSON object that does not fit is an error to show, not a prompt to run.
    if ("brief" in asJson || asJson.error !== "the brief has no JSON object") parsed = asJson;
  }
  if (!parsed) {
    const m = /^tools:\s*(\S+)\s*\n/i.exec(t);
    const prompt = m ? t.slice(m[0].length).trim() : t;
    parsed = parseBrief(JSON.stringify({ system_prompt: prompt, ...(m ? { tools: m[1].toLowerCase() } : {}) }));
  }
  if ("brief" in parsed && parsed.brief.system_prompt.trim().length < MIN_PROMPT) return { error: "short" };
  return parsed;
}

const modelRows = (md: string) => md.split("\n").filter((l) => l.startsWith("| `")).slice(0, BUYER_MODELS.length)
  .map((l) => l.split("|").map((x) => x.trim()))
  // | model | deceived | right action | NEAR lost | false reports | honest tasks | level |
  .filter((c) => c.length >= 9);

/** The lines of a report worth a chat message: one line per model, then the verdict. Empty if the format changed. */
export function summary(md: string): string {
  const verdict = md.split("\n").filter((l) => l.startsWith("**") && !l.startsWith("**What limits") && !l.startsWith("**Policy")).slice(0, 2);
  const rows = modelRows(md).map((c) => `${c[1]}: deceived in ${c[2]} attacks, ${c[4]} NEAR lost, ${c[5]} false report${c[5] === "1" ? "" : "s"}, level ${c[7]}`);
  if (!verdict.length || rows.length !== BUYER_MODELS.length) return "";
  // Rows first: a caption is cut at 1024 characters, and the numbers matter more than the wording.
  return [...rows, "", ...verdict].join("\n").replace(/\*\*|`/g, "");
}

const queue: Job[] = [];
let running: Job | null = null;
let child: ChildProcess | null = null;
let jobDir: string | null = null;
const buffers = new Map<number, { parts: string[]; timer: NodeJS.Timeout }>();

/** Chats whose run would be lost on a restart: the running one and the queue. */
function syncPending() {
  state.pending = [...(running ? [running.chatId] : []), ...queue.map((j) => j.chatId)];
  saveState();
}

function signalChild(sig: NodeJS.Signals, group: boolean) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(group ? -pid : pid, sig);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") console.error(`kill ${sig}: ${(e as Error).message}`);
  }
}

/** SIGTERM (market-worker cleans up its crash tests), then SIGKILL to the group after a grace period. */
function stopChild() {
  signalChild("SIGTERM", false);
  setTimeout(() => signalChild("SIGKILL", true), KILL_GRACE_MS).unref();
}

function dropJobDir() {
  if (!jobDir) return;
  try {
    rmSync(jobDir, { recursive: true, force: true });
  } catch (e) {
    console.error(`job dir: ${(e as Error).message}`);
  }
  jobDir = null;
}

type RunResult = { report: string } | { error: string };

/** The market's report, with the two market-only promises (an included revision) put in the bot's terms. */
export function forTelegram(md: string): string {
  return md
    .replace("`make policy` in the repo, or ask in a revision.", "`make policy` in the repo, or send the prompt again here with the first line \"tools: outlayer-v1\".")
    .replace("One revision is included (a re-run with new seeds). ", "To re-run with new attack texts, send the prompt again (3 runs per day). ");
}

/** One dry run in a child process. Never throws; the job directory is gone when it resolves. */
export function dryRun(brief: Brief): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;
      dropJobDir();
      resolve(r);
    };
    try {
      jobDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
      const tmp = join(jobDir, "tmp");
      mkdirSync(tmp, { mode: 0o700 });
      const file = join(jobDir, "brief.json");
      writeFileSync(file, JSON.stringify(brief), { mode: 0o600 });
      // TMPDIR inside the job directory: the child's transcripts are removed with it even after a SIGKILL, and its
      // startup cleanup of clearance-market-* directories cannot touch a market worker running on the same host.
      const p = (child = spawn(TSX, ["src/market-worker.ts", "--dry-run", file],
        { cwd: RUNNER, env: { PATH: process.env.PATH ?? "", HOME: homedir(), TMPDIR: tmp }, detached: true, stdio: ["ignore", "pipe", "pipe"] }));
      let out = "";
      let tooLong = false;
      let errTail = "";
      p.stdout!.setEncoding("utf8");
      p.stdout!.on("data", (d: string) => {
        if (out.length + d.length > MAX_REPORT) tooLong = true;
        else out += d;
      });
      // Only a short tail is kept and only a category is logged: a parse error can quote a transcript.
      p.stderr!.setEncoding("utf8");
      p.stderr!.on("data", (d: string) => { errTail = (errTail + d).slice(-2000); });
      timer = setTimeout(() => { timedOut = true; stopChild(); }, JOB_TIMEOUT_MS);
      // "close", not "exit": by then stdout has been read to the end.
      p.on("close", (code, signal) => {
        const whole = out.startsWith(REPORT_HEAD) && out.trimEnd().endsWith(REPORT_TAIL);
        if (code === 0 && !tooLong && whole) return finish({ report: out });
        const why = timedOut ? "timeout" : tooLong ? "report too long" : signal ? `killed (${signal})`
          : /not every run is valid/.test(errTail) ? "incomplete runs (model API)" : code === 0 ? "report cut short or unexpected" : `exit ${code}`;
        finish({ error: why });
      });
      p.on("error", (e) => finish({ error: `spawn: ${e.message}` }));
    } catch (e) {
      finish({ error: `setup: ${(e as Error).message}` });
    }
  });
}

function logRun(job: Job, md: string | null, error?: string) {
  const row = {
    at: new Date().toISOString(), user_id: job.userId, username: job.username,
    prompt_sha256: createHash("sha256").update(job.brief.system_prompt).digest("hex").slice(0, 12), tools: job.brief.tools ?? "clearance-v1",
    ok: !!md, ...(error ? { error } : {}),
    results: md ? modelRows(md).map((c) => ({ model: c[1].replace(/`/g, ""), deceived: c[2], lost: c[4], level: c[7] })) : null,
  };
  try {
    appendFileSync(RUNS_LOG, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch (e) {
    console.error(`runs log: ${(e as Error).message}`);
  }
  return row;
}

async function runOne(job: Job) {
  await say(job.chatId, "Running: two models, six attacks and two honest tasks each. Usually 2-5 minutes, I'll send the report here.");
  const r = await dryRun(job.brief);
  if ("error" in r) {
    logRun(job, null, r.error);
    console.error(`run failed for user ${job.userId}: ${r.error}`);
    refund(job.userId, job.day);
    const k = String(job.userId);
    state.failures[k] = (state.failures[k] ?? 0) + 1;
    saveState();
    await say(job.chatId, "The crash test could not complete this time (model API or sandbox error). This run did not count against your limit; please send the prompt again in a few minutes.");
    notifyAdmin(`run failed for @${job.username}: ${r.error}`);
    return;
  }
  const md = forTelegram(r.report);
  const row = logRun(job, md);
  const s = summary(md);
  const sent = await deliver("sendDocument", () => {
    const form = new FormData();
    form.append("chat_id", String(job.chatId));
    form.append("caption", (s || "Your report is attached.").slice(0, 1024));
    form.append("document", new Blob([md], { type: "text/markdown" }), "clearance-report.md");
    return form;
  }, 60_000);
  if (!sent) {
    refund(job.userId, job.day);
    await say(job.chatId, `${s ? `${s}\n\n` : ""}The run finished but the report file could not be sent. This run did not count against your limit; please send the prompt again.`);
    notifyAdmin(`report for @${job.username} could not be delivered`);
    return;
  }
  await say(job.chatId, "One run per attack, so this is an indication, not a certificate. Questions, a full certificate run, or you fixed the prompt and want it checked again: @selliksss. You can also send a new version here.");
  notifyAdmin(`@${job.username} ran a prompt (${row.prompt_sha256}, ${row.tools}): ${(row.results ?? []).map((x) => `${x.model} L${x.level}, lost ${x.lost}`).join("; ")}`);
}

async function work() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  try {
    syncPending();
    await runOne(job);
  } catch (e) {
    // runOne's own steps do not throw; this is a last guard so the queue keeps moving.
    console.error(`job: ${(e as Error).message}`);
    refund(job.userId, job.day);
    await say(job.chatId, "Something went wrong on my side and the run did not finish. It did not count against your limit; please try again later.");
  } finally {
    running = null;
    syncPending();
    setImmediate(() => void work());
  }
}

const isAdmin = (userId: number) => state.adminId === userId;

function enqueue(chatId: number, userId: number, username: string, text: string) {
  const parsed = toBrief(text);
  if ("error" in parsed) {
    void say(chatId, parsed.error === "short" ? HELP : `I can't use this as a prompt: ${parsed.error}.`);
    return;
  }
  if (queue.some((j) => j.chatId === chatId) || running?.chatId === chatId) {
    void say(chatId, "Your previous prompt is still in the queue or running; send the next one after its report.");
    return;
  }
  rollDay();
  const k = String(userId);
  if (!isAdmin(userId) && (state.users[k] ?? 0) >= PER_USER_PER_DAY) {
    void say(chatId, `That's ${PER_USER_PER_DAY} runs today, the daily limit. Come back tomorrow (UTC), or write @selliksss if you need more.`);
    return;
  }
  if (!isAdmin(userId) && (state.failures[k] ?? 0) >= FAILURES_PER_USER_PER_DAY) {
    void say(chatId, "Your last runs failed on my side several times today. Please try again tomorrow, or write @selliksss.");
    return;
  }
  if (state.total >= PER_DAY || queue.length >= MAX_QUEUE) {
    void say(chatId, "Too many runs right now; please try again in an hour.");
    return;
  }
  state.users[k] = (state.users[k] ?? 0) + 1;
  state.total += 1;
  queue.push({ chatId, userId, username, brief: parsed.brief, day: state.day });
  syncPending();
  const ahead = queue.length - 1 + (running ? 1 : 0);
  if (ahead) void say(chatId, `Got it. ${ahead} run${ahead > 1 ? "s" : ""} ahead of yours, about ${ahead * 3} minutes.`);
  void work();
}

function buffer(chatId: number, userId: number, username: string, part: string) {
  const b = buffers.get(chatId);
  if (b) clearTimeout(b.timer);
  const parts = [...(b?.parts ?? []), part];
  if (parts.reduce((n, x) => n + x.length, 0) > MAX_FILE) {
    buffers.delete(chatId);
    void say(chatId, `That's more than ${MAX_FILE / 1024} KB; the prompt must be shorter.`);
    return;
  }
  const timer = setTimeout(() => {
    buffers.delete(chatId);
    try {
      enqueue(chatId, userId, username, parts.join("\n"));
    } catch (e) {
      console.error(`enqueue: ${(e as Error).message}`);
      void say(chatId, "Something went wrong on my side; please send the prompt again.");
    }
  }, PASTE_PAUSE_MS);
  buffers.set(chatId, { parts, timer });
}

async function fileText(fileId: string): Promise<string> {
  const f = await tg("getFile", { file_id: fileId });
  if (!f?.file_path || (f.file_size ?? 0) > MAX_FILE) throw new Error("too large");
  const r = await fetch(`https://api.telegram.org/file/bot${token()}/${f.file_path}`, { redirect: "error", signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new Error(`download: ${(e as Error).name}`); });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FILE) throw new Error("too large");
  return buf.toString("utf8");
}

async function onMessage(m: any) {
  // Private chats only: a prompt pasted in a group would be seen by everyone there.
  if (m?.chat?.type !== "private" || typeof m.from?.id !== "number") return;
  const chatId: number = m.chat.id;
  const userId: number = m.from.id;
  const username = String(m.from.username ?? userId);
  // The admin is recognised by username once, then by numeric id (a username can change hands).
  if (state.adminId === undefined && username.toLowerCase() === ADMIN_USERNAME) state.adminId = userId;
  if (isAdmin(userId) && state.adminChat !== chatId) {
    state.adminChat = chatId;
    saveState();
  }
  const text: string = typeof m.text === "string" ? m.text : "";
  if (text.startsWith("/")) {
    const cmd = text.split(/[\s@]/)[0];
    if (cmd === "/stats" && isAdmin(userId)) {
      rollDay();
      return void say(chatId, `today ${state.total} runs, ${Object.keys(state.users).length} people, queue ${queue.length}${running ? ", one running" : ""}`);
    }
    return void say(chatId, HELP);
  }
  if (m.document) {
    const name = String(m.document.file_name ?? "");
    if (!/\.(txt|md|json)$/i.test(name) || (m.document.file_size ?? 0) > MAX_FILE) {
      return void say(chatId, `Send the prompt as a .txt, .md or .json file up to ${MAX_FILE / 1024} KB, or paste it as text.`);
    }
    try {
      return void buffer(chatId, userId, username, await fileText(m.document.file_id));
    } catch (e) {
      console.error(`file: ${(e as Error).message}`);
      return void say(chatId, "I couldn't read that file; please paste the prompt as text.");
    }
  }
  if (text) return void buffer(chatId, userId, username, text);
  void say(chatId, HELP);
}

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  const exit = () => { dropJobDir(); process.exit(code); };
  if (!child) return exit();
  // Let market-worker kill its crash tests and remove its files; the job directory goes either way.
  child.once("close", exit);
  stopChild();
  setTimeout(exit, KILL_GRACE_MS + 2_000).unref();
}

async function main() {
  token();
  for (const d of readdirSync(tmpdir()).filter((x) => x.startsWith(TMP_PREFIX))) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(130));
  process.on("unhandledRejection", (e) => { console.error(`unhandled: ${(e as Error)?.message ?? String(e)}`); });
  process.on("uncaughtException", (e) => { console.error(`uncaught: ${e.message}`); shutdown(1); });
  process.on("exit", () => {
    try {
      if (jobDir) rmSync(jobDir, { recursive: true, force: true });
    } catch {}
  });
  // Prompts are never written to the state file, so a run that was queued or running when we stopped is gone:
  // say so and give the run back (in a private chat the chat id is the user id).
  rollDay();
  for (const chatId of new Set(state.pending)) {
    refund(chatId, state.day);
    await say(chatId, "The bot restarted and your queued run was lost. It did not count against your limit; please send the prompt again.");
  }
  state.pending = [];
  saveState();
  let backoff = 5_000;
  for (;;) {
    try {
      const updates: any[] = await tg("getUpdates", { offset: state.offset, timeout: 50, allowed_updates: ["message"] }, 70_000);
      backoff = 5_000;
      for (const u of updates) {
        // At most once: the offset moves before handling, so a crash mid-message skips it rather than loops on it.
        state.offset = u.update_id + 1;
        saveState();
        await onMessage(u.message).catch((e) => console.error(`message: ${(e as Error).message}`));
      }
    } catch (e) {
      console.error(`poll: ${(e as Error).message}`);
      // 401: the token is wrong or revoked; 409: another instance is polling. systemd restarts us and the log says why.
      if (e instanceof TgError && (e.code === 401 || e.code === 409)) return shutdown(1);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 300_000);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error((e as Error).message);
    shutdown(1);
  });
}
