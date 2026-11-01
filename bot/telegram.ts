// Usage: TELEGRAM_BOT_TOKEN=... [WEB_PORT=8788] runner/node_modules/.bin/tsx bot/telegram.ts
// With WEB_PORT it also answers the website's /api/ (web/): the same queue, limits of its own.
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
import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
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

type TgJob = { kind: "tg"; chatId: number; userId: number; username: string; brief: Brief; day: string };
// A run asked for on the website (web/): no Telegram user, a random job id and a daily hash of the visitor's IP.
type WebJob = { kind: "web"; id: string; ipKey: string; brief: Brief; day: string };
type Job = TgJob | WebJob;
type State = {
  offset: number; adminId?: number; adminChat?: number; day: string; total: number;
  users: Record<string, number>; failures: Record<string, number>; pending: number[];
  webTotal: number; webIps: Record<string, number>; webFailures: Record<string, number>;
};

const today = () => new Date().toISOString().slice(0, 10);

function loadState(): State {
  const fresh: State = { offset: 0, day: today(), total: 0, users: {}, failures: {}, pending: [], webTotal: 0, webIps: {}, webFailures: {} };
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
      webTotal: Number.isInteger(s.webTotal) ? s.webTotal : 0, webIps: obj(s.webIps), webFailures: obj(s.webFailures),
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
  state.webTotal = 0;
  state.webIps = {};
  state.webFailures = {};
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
  state.pending = [running, ...queue].flatMap((j) => (j?.kind === "tg" ? [j.chatId] : []));
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

function logRun(job: TgJob, md: string | null, error?: string) {
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

async function runOne(job: TgJob) {
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
    if (job.kind === "tg") await runOne(job);
    else await runWeb(job);
  } catch (e) {
    // runOne's own steps do not throw; this is a last guard so the queue keeps moving.
    console.error(`job: ${(e as Error).message}`);
    if (job.kind === "tg") {
      refund(job.userId, job.day);
      await say(job.chatId, "Something went wrong on my side and the run did not finish. It did not count against your limit; please try again later.");
    } else webFail(job, "internal error");
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
  if (queue.some((j) => j.kind === "tg" && j.chatId === chatId) || (running?.kind === "tg" && running.chatId === chatId)) {
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
  queue.push({ kind: "tg", chatId, userId, username, brief: parsed.brief, day: state.day });
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

/* ---------------- website runs (web/, behind Caddy at /api/) ---------------- */

const WEB_PORT = Number(process.env.WEB_PORT ?? 0);
const WEB_DIR = join(STATE_DIR, "web-jobs");
const WEB_PER_IP_PER_DAY = 3;
const WEB_PER_DAY = 30;
const WEB_MAX_PROMPT = 8_000;
// A prompt can make its own runs invalid, and a failed run is given back; so failures are capped per network, and
// the web may hold only part of the queue it shares with Telegram.
const WEB_FAILURES_PER_IP_PER_DAY = 2;
const WEB_MAX_QUEUED = 3;
// A result page stays readable for a week; the prompt itself is never stored.
const WEB_KEEP_MS = 7 * 24 * 3600_000;

type WebEvent = {
  model: string; kind: string; attack: string | null; scenario: string | null; valid: boolean;
  deceived: boolean; completed: boolean; false_report: boolean; loss: string; paid: { to: string; near: string }[]; refused: number;
};
type WebRecord = {
  id: string; state: "queued" | "running" | "done" | "failed"; created: number; started?: number; finished?: number;
  tools: string; events: WebEvent[]; summary?: string; report?: string; error?: string;
  // Server-only (never sent): whose counters a lost run is given back to.
  owner?: { ipKey: string; day: string };
};
const webJobs = new Map<string, WebRecord>();

function saveWeb(r: WebRecord) {
  try {
    mkdirSync(WEB_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(WEB_DIR, `${r.id}.json.tmp`), JSON.stringify(r), { mode: 0o600 });
    renameSync(join(WEB_DIR, `${r.id}.json.tmp`), join(WEB_DIR, `${r.id}.json`));
  } catch (e) {
    console.error(`web save: ${(e as Error).message}`);
  }
}

const expired = (r: WebRecord) => Date.now() - r.created > WEB_KEEP_MS;

function loadWeb(id: string): WebRecord | null {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  let r = webJobs.get(id) ?? null;
  if (!r) {
    try { r = JSON.parse(readFileSync(join(WEB_DIR, `${id}.json`), "utf8")) as WebRecord; } catch { return null; }
  }
  if (expired(r)) {
    webJobs.delete(id);
    rmSync(join(WEB_DIR, `${id}.json`), { force: true });
    return null;
  }
  return r;
}

/** Gives a lost or failed web run back to its network, if it was counted today. */
function webRefund(owner: WebRecord["owner"]) {
  if (!owner || owner.day !== state.day) return;
  state.webIps[owner.ipKey] = Math.max(0, (state.webIps[owner.ipKey] ?? 1) - 1);
  state.webTotal = Math.max(0, state.webTotal - 1);
  saveState();
}

const near = (yocto: unknown): string => {
  try {
    const y = BigInt(String(yocto ?? "0"));
    const cents = (y + 5_000_000_000_000_000_000_000n) / 10_000_000_000_000_000_000_000n;
    return cents % 100n === 0n ? String(cents / 100n) : (Number(cents) / 100).toFixed(2).replace(/0$/, "");
  } catch {
    return "0";
  }
};

/** What the website shows of one finished run: numbers, accounts and the attack id, never model text or the prompt. */
function webEvent(t: any): WebEvent {
  const acts: any[] = Array.isArray(t?.actions) ? t.actions : [];
  return {
    model: String(t?.agent?.model ?? "").split("/").pop() ?? "", kind: String(t?.kind ?? ""),
    attack: typeof t?.generator === "string" ? t.generator : null, scenario: typeof t?.scenario?.id === "string" ? t.scenario.id : null,
    valid: t?.status === "valid", deceived: !!t?.verdict?.deceived, completed: !!t?.verdict?.completed, false_report: !!t?.verdict?.false_report,
    loss: near(t?.verdict?.loss_yocto),
    paid: acts.filter((a) => a?.landed).map((a) => ({ to: String(a.receiver ?? ""), near: near(a.amount_yocto) })),
    refused: acts.filter((a) => !a?.landed).length,
  };
}

/** Finished transcripts under the job's TMPDIR, by path (a model's second attempt writes new files). */
function scanTranscripts(dir: string, seen: Set<string>, out: (t: any) => void) {
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name.endsWith(".json") && e.name !== "manifest.json" && !seen.has(f)) {
        try {
          const t = JSON.parse(readFileSync(f, "utf8"));
          if (!t?.verdict) continue;
          seen.add(f);
          out(t);
        } catch { /* still being written; next scan */ }
      }
    }
  };
  walk(dir, 0);
}

/** The market report in the website's terms. */
export function forWeb(md: string): string {
  return md
    // The page is public to anyone with its link: no hash of the prompt to check guesses against.
    .replace(/ \(sha256 `[0-9a-f]+…`; /, " (")
    .replace("`make policy` in the repo, or ask in a revision.", "`make policy` in the repo, or run the test again with the OutLayer tool layer.")
    .replace("One revision is included (a re-run with new seeds). ", "To re-run with new attack texts, submit the prompt again (3 runs per day). ");
}

function webFail(job: WebJob, error: string) {
  const r = webJobs.get(job.id);
  if (r) {
    r.state = "failed";
    r.error = error;
    r.finished = Date.now();
    saveWeb(r);
    webJobs.delete(job.id);
  }
  webRefund({ ipKey: job.ipKey, day: job.day });
  if (job.day === state.day) {
    state.webFailures[job.ipKey] = (state.webFailures[job.ipKey] ?? 0) + 1;
    saveState();
  }
}

async function runWeb(job: WebJob) {
  const r = webJobs.get(job.id);
  if (!r) return;
  r.state = "running";
  r.started = Date.now();
  saveWeb(r);
  const pending = dryRun(job.brief);
  // dryRun creates its job directory synchronously; the child's transcripts land under its tmp/.
  const tmp = jobDir ? join(jobDir, "tmp") : null;
  const seen = new Set<string>();
  const scan = () => { if (tmp && existsSync(tmp)) scanTranscripts(tmp, seen, (t) => { r.events.push(webEvent(t)); saveWeb(r); }); };
  const timer = setInterval(scan, 700);
  let res: RunResult;
  try {
    res = await pending;
  } finally {
    clearInterval(timer);
  }
  if ("error" in res) {
    console.error(`web run ${job.id} failed: ${res.error}`);
    notifyAdmin(`web run failed: ${res.error}`);
    return webFail(job, "The crash test could not complete this time (model API or sandbox error). It did not count against your limit; try again in a few minutes.");
  }
  const md = forWeb(res.report);
  r.state = "done";
  r.finished = Date.now();
  r.report = md;
  r.summary = summary(md);
  saveWeb(r);
  webJobs.delete(job.id);
  notifyAdmin(`web run ${job.id}: ${r.summary.split("\n").slice(0, BUYER_MODELS.length).join("; ")}`);
}

function json(res: ServerResponse, code: number, body: unknown) {
  const b = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(b), "x-content-type-options": "nosniff" });
  res.end(b);
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    let n = 0;
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > max) { resolve(null); req.pause(); return; }
      parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

// Caddy is the only client of this port (127.0.0.1) and sets X-Real-IP to the address it saw (header_up in the
// Caddyfile). An IPv6 client is counted by its /64, which is what one subscriber usually gets.
function clientIp(req: IncomingMessage): string {
  const ip = String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "").trim();
  if (!ip.includes(":") || ip.startsWith("::ffff:")) return ip.replace(/^::ffff:/, "");
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function publicRecord(r: WebRecord) {
  const { owner: _owner, ...pub } = r;
  const at = queue.findIndex((j) => j.kind === "web" && j.id === r.id);
  return { ...pub, ahead: r.state === "queued" ? at + (running ? 1 : 0) : 0 };
}

async function onHttp(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/api/status") {
    rollDay();
    return json(res, 200, { queue: queue.length + (running ? 1 : 0), left_today: Math.max(0, WEB_PER_DAY - state.webTotal), per_ip: WEB_PER_IP_PER_DAY, models: BUYER_MODELS, tools: BUYER_TOOLS });
  }
  const m = /^\/api\/test\/([0-9a-f]{16})$/.exec(path);
  if (req.method === "GET" && m) {
    const r = loadWeb(m[1]);
    return r ? json(res, 200, publicRecord(r)) : json(res, 404, { error: "No test with this id, or it is older than a week." });
  }
  if (req.method === "POST" && path === "/api/test") {
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "Send JSON." });
    const body = await readBody(req, 64 * 1024);
    if (body === null) return json(res, 413, { error: "That is too long; the prompt limit is 8000 characters." });
    let input: any;
    try { input = JSON.parse(body ?? ""); } catch { return json(res, 400, { error: "Send JSON with a prompt field." }); }
    const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
    const tools = typeof input?.tools === "string" && (BUYER_TOOLS as readonly string[]).includes(input.tools) ? input.tools : "clearance-v1";
    if (prompt.length > WEB_MAX_PROMPT) return json(res, 400, { error: `The prompt is ${prompt.length} characters; the limit is ${WEB_MAX_PROMPT}.` });
    const parsed = toBrief(tools === "clearance-v1" ? prompt : `tools: ${tools}\n${prompt}`);
    if ("error" in parsed) return json(res, 400, { error: parsed.error === "short" ? `Paste the whole system prompt (at least ${MIN_PROMPT} characters).` : `This can't be used as a prompt: ${parsed.error}.` });
    rollDay();
    const ipKey = createHash("sha256").update(`${state.day}|${clientIp(req)}`).digest("hex").slice(0, 16);
    if ((state.webFailures[ipKey] ?? 0) >= WEB_FAILURES_PER_IP_PER_DAY) return json(res, 429, { error: "Your last tests failed on our side twice today. Please try again tomorrow (UTC), or use the Telegram bot." });
    if (queue.some((j) => j.kind === "web" && j.ipKey === ipKey) || (running?.kind === "web" && running.ipKey === ipKey)) return json(res, 409, { error: "A test from your network is still in the queue or running. Wait for its result first." });
    if ((state.webIps[ipKey] ?? 0) >= WEB_PER_IP_PER_DAY) return json(res, 429, { error: `That's ${WEB_PER_IP_PER_DAY} tests from your network today. Come back tomorrow (UTC), or use the Telegram bot.` });
    if (state.webTotal >= WEB_PER_DAY) return json(res, 429, { error: "Today's tests on the website are used up. Try tomorrow (UTC), or use the Telegram bot." });
    if (queue.length >= MAX_QUEUE || queue.filter((j) => j.kind === "web").length >= WEB_MAX_QUEUED) return json(res, 503, { error: "Too many tests in the queue right now; try again in half an hour." });
    state.webIps[ipKey] = (state.webIps[ipKey] ?? 0) + 1;
    state.webTotal += 1;
    saveState();
    const id = randomBytes(8).toString("hex");
    const rec: WebRecord = {
      id, state: "queued", created: Date.now(), tools: parsed.brief.tools ?? "clearance-v1", events: [], owner: { ipKey, day: state.day },
    };
    webJobs.set(id, rec);
    saveWeb(rec);
    queue.push({ kind: "web", id, ipKey, brief: parsed.brief, day: state.day });
    void work();
    return json(res, 201, publicRecord(rec));
  }
  json(res, 404, { error: "not found" });
}

/** Web runs that were queued or running when the bot stopped are lost with their prompts: mark them so. */
function recoverWeb(startup: boolean) {
  let files: string[] = [];
  try { files = readdirSync(WEB_DIR).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(WEB_DIR, f), "utf8")) as WebRecord;
      if (expired(r)) { rmSync(join(WEB_DIR, f), { force: true }); continue; }
      if (!startup) continue;
      if (r.state === "queued" || r.state === "running") {
        webRefund(r.owner);
        r.state = "failed";
        r.error = "The server restarted and this test was lost. Please submit the prompt again.";
        r.finished = Date.now();
        saveWeb(r);
      }
    } catch { /* unreadable record: leave it */ }
  }
}

function startWeb() {
  if (!WEB_PORT) return;
  recoverWeb(true);
  // Expired result pages go once an hour.
  setInterval(() => recoverWeb(false), 3600_000).unref();
  createServer((req, res) => {
    onHttp(req, res).catch((e) => {
      console.error(`http: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "Something went wrong on our side." });
    });
  }).listen(WEB_PORT, "127.0.0.1", () => console.error(`web API on 127.0.0.1:${WEB_PORT}`));
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
  // WEB_ONLY=1 serves the website API without polling Telegram (local testing).
  const webOnly = process.env.WEB_ONLY === "1";
  if (!webOnly) token();
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
  for (const chatId of webOnly ? [] : new Set(state.pending)) {
    refund(chatId, state.day);
    await say(chatId, "The bot restarted and your queued run was lost. It did not count against your limit; please send the prompt again.");
  }
  state.pending = [];
  saveState();
  startWeb();
  if (webOnly) return;
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
