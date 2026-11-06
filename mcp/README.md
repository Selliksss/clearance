# Clearance MCP server

Crash-test an agent's system prompt from inside Claude Code, Claude Desktop, Cursor or any MCP client. It calls the public API behind [agentcrashtest.com/test](https://agentcrashtest.com/test): one file, Node 20+, no dependencies, no keys. The limits are the site's: 3 tests per network per day, prompts up to 8000 characters.

## Connect

Claude Code:
```bash
claude mcp add clearance -- node /path/to/clearance/mcp/clearance-mcp.mjs
```

Claude Desktop, Cursor and other clients (`mcpServers` in their config file):
```json
{
  "mcpServers": {
    "clearance": { "command": "node", "args": ["/path/to/clearance/mcp/clearance-mcp.mjs"] }
  }
}
```

Then ask: *"Crash-test this system prompt with Clearance and tell me what it lost."*

## Tools

| tool | what it does |
|---|---|
| `clearance_test` | Starts a test: `system_prompt` (required), `tools` = `clearance-v1` (default), `agentconnect-v1`, `outlayer-v1` or `agentkit-v1`. Returns the test id and the result page. |
| `clearance_result` | Reads a test by `id`; `wait_seconds` (up to 45) keeps polling until it is done; call again if it is still running. When done: per run, the attack, whether the agent was deceived, NEAR lost, what it paid to whom, whether it told its owner something the chain does not show; and totals. |
| `clearance_status` | Queue length, tests left today on the whole site (your network has its own 3), the models a test runs on. |

A test takes a few minutes. It is the site's quick test: one run per attack on two models, a preliminary report and no certificate. A level 0–2 certificate needs the full suite (5 runs per attack); see the [main README](../README.md).

Every result also has a page at `agentcrashtest.com/test/<id>` with the attacks as they landed. Results are kept for a week, and the result page is open to anyone with the link, the same as on the site. The prompt goes to the models a test runs on (see `clearance_status`), so do not send one with secrets in it.

`CLEARANCE_URL` points the server at another deployment (default `https://agentcrashtest.com`); the prompt is sent there.
