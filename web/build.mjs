// Usage: node web/build.mjs
// Builds the static data for Clearance Live (web/public/data/) from what is already in the repo: transcripts/,
// reports/ and the results table in README.md. Nothing here runs a model or touches the chain, and nothing here
// is part of the judge: the page only shows recorded runs, and `make replay` is what checks them.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web", "public", "data");
const YOCTO = 10n ** 24n;
const near = (y) => {
  const v = BigInt(y);
  const whole = v / YOCTO;
  const frac = ((v % YOCTO) * 100n) / YOCTO;
  return frac === 0n ? `${whole}` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
};
const PAYMENT = new Set(["G1-invoice-inflate", "G2-lookalike-merchant", "G3-inbox-invoice", "G6-payment-failed-retry", "G7-owner-safe-address", "G8-limit-lifted"]);

// The agents on the board, in the order the README tells their story. `row` is the label in README's results table.
const AGENTS = [
  { id: "outlayer-skill", name: "OutLayer agent-custody skill", source: "OutLayer's published skill (MIT / Apache-2.0)", row: "OutLayer agent-custody skill" },
  { id: "agentkit-cdp-chatbot", name: "Coinbase AgentKit chatbot", source: "Coinbase AgentKit example (Apache-2.0)", row: "Coinbase AgentKit chatbot example" },
  { id: "agentkit-guardrails", name: "AgentKit with its injection filter", source: "Coinbase AgentKit example (Apache-2.0)", row: "AgentKit example with its prompt-injection filter" },
  { id: "agentconnect-assistant", name: "Agent Connect assistant", source: "NEAR Intents Agent API recipe, its tools", row: "Agent Connect AI-assistant recipe: its 4 tools + our 2-sentence prompt" },
  { id: "elizaos-default", name: "elizaOS default character", source: "elizaOS default character (MIT), on Clearance's payment tools", row: "elizaOS default character, on Clearance's payment tools" },
  { id: "iqai-near-intents", name: "IQAI near-intents-agent", source: "IQAI's published prompt (MIT), on Clearance's payment tools", row: "IQAI near-intents-agent prompt, on Clearance's payment tools" },
  { id: "naive", name: "Naive payment agent", source: "Clearance baseline: one line, pay the invoice", row: null },
  { id: "protected-v5", name: "Clearance protected-v5", source: "Clearance's certified prompt, GLM-5.3-flash", row: null },
];

function readmeRows() {
  const out = {};
  for (const line of readFileSync(join(ROOT, "README.md"), "utf8").split("\n")) {
    if (!line.startsWith("| ")) continue;
    const c = line.split("|").map((x) => x.trim().replace(/\*\*/g, ""));
    const a = AGENTS.find((x) => x.row && c[1] === x.row);
    if (a && c.length >= 7 && !out[a.id]) out[a.id] = { payment: c[2], blind: c[3], lost_all: c[4], lost_with_policy: c[5], glm: c[6] };
  }
  return out;
}

const fill = (s, p) => String(s ?? "").replace(/\{(\w+)\}/g, (m, k) => p?.[k] ?? m);

function assistantText(turn) {
  try {
    const r = JSON.parse(Buffer.from(turn.model.response_b64, "base64").toString("utf8"));
    const c = r?.choices?.[0]?.message?.content;
    return typeof c === "string" ? c.trim() : "";
  } catch {
    return "";
  }
}

const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function runView(t) {
  const p = t.scenario?.participants ?? {};
  const injected = Object.values(t.injected ?? {}).filter((v) => typeof v === "string" && v.length > 3);
  const steps = (t.turns ?? []).map((turn) => ({
    say: cap(assistantText(turn), 1200),
    calls: (turn.tool_calls ?? []).map((c) => {
      let args = c.arguments_raw;
      try { args = JSON.stringify(JSON.parse(c.arguments_raw)); } catch {}
      const result = typeof c.result === "string" ? c.result : JSON.stringify(c.result);
      return { name: c.name, args: cap(String(args ?? ""), 400), result: cap(result ?? "", 1800) };
    }),
  }));
  const actions = (t.actions ?? []).map((a) => ({ tool: a.tool, to: a.receiver, near: near(a.amount_yocto ?? "0"), landed: !!a.landed, tx: a.tx ?? null, refused: a.refusal ?? null }));
  const correct = t.scenario?.correct ?? {};
  return {
    id: t.run_id,
    kind: t.kind,
    status: t.status,
    invalid: t.status === "valid" ? null : String(t.invalid_reason ?? "").slice(0, 160),
    generator: t.generator ?? null,
    scenario: t.scenario?.id,
    task: fill(t.scenario?.task, p),
    should: correct.receiver ? `${correct.tool ?? "pay"} ${p[correct.receiver] ?? correct.receiver}, at most ${correct.amount_near_max ?? "?"} NEAR` : null,
    injected,
    steps,
    actions,
    left_vault: near((t.actions ?? []).filter((a) => a.landed).reduce((n, a) => n + BigInt(a.amount_yocto ?? "0"), 0n)),
    claim: cap(String(t.final_message ?? ""), 1500),
    verdict: { deceived: !!t.verdict?.deceived, loss: near(t.verdict?.loss_yocto ?? "0"), completed: !!t.verdict?.completed, false_report: !!t.verdict?.false_report },
    model: t.agent?.model ?? null,
    seed: t.seed ?? null,
  };
}

function loadDir(dir) {
  const p = join(ROOT, "transcripts", dir);
  if (!existsSync(p)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== "archive") walk(join(d, e.name)); continue; }
      if (!e.name.endsWith(".json") || e.name === "manifest.json") continue;
      try { out.push(JSON.parse(readFileSync(join(d, e.name), "utf8"))); } catch {}
    }
  };
  walk(p);
  return out;
}

function summary(runs) {
  const attacks = runs.filter((t) => t.kind === "attack" && t.status === "valid");
  const controls = runs.filter((t) => t.kind === "control" && t.status === "valid");
  const loss = attacks.reduce((n, t) => n + BigInt(t.verdict?.loss_yocto ?? "0"), 0n);
  const pay = attacks.filter((t) => PAYMENT.has(String(t.generator)));
  return {
    attacks: attacks.length,
    deceived: attacks.filter((t) => t.verdict?.deceived).length,
    payment: `${pay.filter((t) => t.verdict?.deceived).length}/${pay.length}`,
    lost: near(loss),
    honest: `${controls.filter((t) => t.verdict?.completed).length}/${controls.length}`,
    false_reports: [...attacks, ...controls].filter((t) => t.verdict?.false_report).length,
    invalid: runs.filter((t) => t.status !== "valid").length,
  };
}

function level(id) {
  try { return JSON.parse(readFileSync(join(ROOT, "reports", `${id}.json`), "utf8")).level ?? null; } catch { return null; }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "agents"), { recursive: true });
mkdirSync(join(OUT, "runs"), { recursive: true });
const table = readmeRows();
const board = [];
const totals = { runs: 0, false_reports: 0 };
for (const a of AGENTS) {
  const main = loadDir(a.id);
  const glm = loadDir(`${a.id}-glm`);
  const s = summary(main);
  const g = glm.length ? summary(glm) : null;
  const runs = [];
  for (const [set, model] of [[main, "main"], [glm, "glm"]]) {
    for (const t of set) {
      const v = runView(t);
      v.set = model;
      writeFileSync(join(OUT, "runs", `${v.id}.json`), JSON.stringify(v));
      runs.push({ id: v.id, set: model, kind: v.kind, generator: v.generator, scenario: v.scenario, status: v.status, deceived: v.verdict.deceived, loss: v.verdict.loss, completed: v.verdict.completed, false_report: v.verdict.false_report, model: v.model });
    }
  }
  runs.sort((x, y) => (x.set === y.set ? 0 : x.set === "main" ? -1 : 1) || String(x.generator ?? "~").localeCompare(String(y.generator ?? "~")) || (x.deceived === y.deceived ? 0 : x.deceived ? -1 : 1));
  const model = main.find((t) => t.agent?.model)?.agent?.model ?? null;
  const entry = { id: a.id, name: a.name, source: a.source, model, level: level(a.id), summary: s, glm: g, readme: table[a.id] ?? null, config: `agents/${a.id}.json` };
  writeFileSync(join(OUT, "agents", `${a.id}.json`), JSON.stringify({ ...entry, runs }));
  board.push(entry);
  totals.runs += runs.length;
  totals.false_reports += runs.filter((r) => r.status === "valid" && r.false_report).length;
}
const attacks = {};
for (const f of readdirSync(join(ROOT, "attacks")).filter((x) => /^G\d+.*\.json$/.test(x))) {
  const a = JSON.parse(readFileSync(join(ROOT, "attacks", f), "utf8"));
  attacks[a.id] = { category: a.category, channel: a.channel };
}
writeFileSync(join(OUT, "attacks.json"), JSON.stringify(attacks));
// The hero replays one real fooled run per attack: the first deceived, valid run on the main model, in board order.
const SHOW = ["G2-lookalike-merchant", "G1-invoice-inflate", "G6-payment-failed-retry", "G7-owner-safe-address"];
const showcase = [];
for (const g of SHOW) {
  for (const a of AGENTS.filter((x) => x.row)) {
    const pick = loadDir(a.id).filter((t) => t.generator === g && t.status === "valid" && t.verdict?.deceived && (t.actions ?? []).some((x) => x.landed))
      .sort((x, y) => String(x.run_id).localeCompare(String(y.run_id)))[0];
    if (pick) { showcase.push({ generator: g, agent: a.id, agent_name: a.name, run: pick.run_id }); break; }
  }
}
writeFileSync(join(OUT, "board.json"), JSON.stringify({ built_from: "transcripts/ and reports/ in github.com/Selliksss/clearance", agents: board, showcase, totals }));
console.log(board.map((b) => `${b.id.padEnd(24)} attacks ${b.summary.attacks} deceived ${b.summary.deceived} lost ${b.summary.lost} level ${b.level} readme ${b.readme ? "yes" : "-"}`).join("\n"));
