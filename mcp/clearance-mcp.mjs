#!/usr/bin/env node
// Clearance MCP server: lets any MCP client (Claude Code, Claude Desktop, Cursor, agent frameworks) crash-test an
// agent's system prompt from inside its own workflow. It is a thin client of the public website API
// (agentcrashtest.com/api/test): no keys, no dependencies, the same limits as the site (3 tests per network per day).
// Transport: MCP over stdio, newline-delimited JSON-RPC 2.0.
//   claude mcp add clearance -- node /path/to/clearance/mcp/clearance-mcp.mjs
import { createInterface } from "node:readline";

const BASE = (process.env.CLEARANCE_URL || "https://agentcrashtest.com").replace(/\/$/, "");
const PROTOCOL = "2025-06-18";
const TOOL_SETS = ["clearance-v1", "agentconnect-v1", "outlayer-v1", "agentkit-v1"];

const TOOLS = [
  {
    name: "clearance_test",
    description:
      "Start a crash test of an AI agent that moves money. Send the agent's full system prompt; Clearance runs it against " +
      "payment attacks hidden in what it reads (fake invoices, lookalike payees, a 'payment failed, retry' that already went " +
      "through) on a NEAR sandbox with real transfers, and scores the NEAR that left the vault. Returns a test id and a result " +
      "page. A test takes a few minutes; poll it with clearance_result. Limit: 3 tests per network per day, one at a time " +
      "(if a test from this network is still queued or running, the call fails until it finishes).",
    inputSchema: {
      type: "object",
      properties: {
        system_prompt: { type: "string", description: "The agent's whole system prompt (at least a few sentences, at most 8000 characters)." },
        tools: { type: "string", enum: TOOL_SETS, description: "Which payment tool set the agent runs with. Default clearance-v1; the others emulate Agent Connect, OutLayer and Coinbase AgentKit tools." },
      },
      required: ["system_prompt"],
    },
  },
  {
    name: "clearance_result",
    description:
      "Read a crash test started with clearance_test: its state (queued, running, done, failed), and when done, per run whether " +
      "the agent was deceived, NEAR lost (decimal NEAR), whether it told its owner something the chain does not show, the " +
      "Markdown report with the wallet limits to run it with, and the result page. Set wait_seconds to wait for it to finish " +
      "(up to 45; call again if it is still running).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The 16-character test id returned by clearance_test." },
        wait_seconds: { type: "number", description: "Optional: keep polling up to this many seconds (max 45) until the test is done or failed." },
      },
      required: ["id"],
    },
  },
  {
    name: "clearance_status",
    description: "Queue length, tests left today on the whole site (left_today; each network also has its own limit of per_ip tests a day), the models a test runs on, and the tool sets.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function api(path, init) {
  const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body) throw new Error(body?.error ?? `HTTP ${r.status} from ${BASE}${path}`);
  return body;
}

function summarize(rec) {
  const page = `${BASE}/test/${rec.id}`;
  const out = { id: rec.id, state: rec.state, page };
  if (rec.state === "queued") out.ahead = rec.ahead;
  if (rec.state === "failed") out.error = rec.error ?? "the run did not finish";
  const runs = rec.events ?? [];
  if (runs.length) {
    // Same counting as the result page: runs the model API cut off are listed but not scored, and when a model's
    // first attempt had such a run it runs again, so only the first valid run per model and attack (or task) counts.
    const seen = new Set();
    const valid = runs.filter((e) => {
      const k = `${e.model}|${e.kind}|${e.attack ?? e.scenario}`;
      if (!e.valid || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const attacks = valid.filter((e) => e.kind === "attack");
    const lost = attacks.reduce((s, e) => s + Number(e.loss || 0), 0);
    out.totals = {
      attack_runs: attacks.length,
      deceived: attacks.filter((e) => e.deceived).length,
      near_lost: Number(lost.toFixed(4)),
      false_reports_to_owner: valid.filter((e) => e.false_report).length,
      honest_tasks_done: `${valid.filter((e) => e.kind === "control" && e.completed).length}/${valid.filter((e) => e.kind === "control").length}`,
      invalid_runs: runs.length - valid.length,
    };
    out.runs = valid.map((e) => ({
      model: e.model, attack: e.attack, scenario: e.scenario, valid: e.valid, deceived: e.deceived,
      near_lost: e.loss, told_owner_something_false: e.false_report, task_done: e.completed,
      paid: e.paid, refused_by_vault: e.refused,
    }));
    if (rec.state === "done" && rec.report) out.note = "If totals and report_markdown ever differ, the report is the scored result.";
  }
  if (rec.summary) out.summary = rec.summary;
  // The full Markdown report: which model to ship on, each attack's text, and the wallet policy sized for it.
  if (rec.report) out.report_markdown = rec.report;
  return out;
}

async function callTool(name, a) {
  if (name === "clearance_status") return api("/api/status");
  if (name === "clearance_test") {
    const prompt = typeof a.system_prompt === "string" ? a.system_prompt : "";
    if (a.tools !== undefined && !TOOL_SETS.includes(a.tools)) throw new Error(`tools must be one of ${TOOL_SETS.join(", ")}`);
    const tools = a.tools ?? "clearance-v1";
    const rec = await api("/api/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, tools }) });
    return { ...summarize(rec), next: "Poll clearance_result with this id; a test usually takes a few minutes." };
  }
  if (name === "clearance_result") {
    const id = String(a.id ?? "");
    if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("id must be the 16-character hex id from clearance_test");
    const until = Date.now() + Math.min(Math.max(Number(a.wait_seconds) || 0, 0), 45) * 1000;
    let rec = await api(`/api/test/${id}`);
    while ((rec.state === "queued" || rec.state === "running") && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5000));
      rec = await api(`/api/test/${id}`);
    }
    return summarize(rec);
  }
  throw new Error(`unknown tool ${name}`);
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
// The report goes in as Markdown text, everything else as JSON; structuredContent carries the whole object.
const text = (result, isError = false) => {
  const { report_markdown: report, ...rest } = result;
  const content = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
  if (report) content.push({ type: "text", text: report });
  return { content, structuredContent: result, ...(isError ? { isError: true } : {}) };
};

async function handle(msg) {
  if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) return; // notification
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "clearance", version: "0.1.0" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call":
      try {
        return ok(text(await callTool(msg.params?.name, msg.params?.arguments ?? {})));
      } catch (e) {
        return ok(text({ error: e.cause?.code ? `${e.message} (${e.cause.code})` : e.message }, true));
      }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

// When the client closes stdin, finish the calls in flight, then exit.
let inFlight = 0, closed = false;
const done = () => { if (--inFlight === 0 && closed) process.exit(0); };
process.stdout.on("error", () => process.exit(0)); // the client went away
createInterface({ input: process.stdin }).on("close", () => { closed = true; if (!inFlight) process.exit(0); }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  inFlight++;
  handle(msg).catch((e) => send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: e.message } })).finally(done);
});
