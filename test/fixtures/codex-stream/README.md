# Raw JSONL files — Codex POC

Each file is the raw output, unedited, of `codex exec --json` via `scripts/codex-poc.ts`.
The matching `.stderr.log` file (when present) is the separate stderr log for that same run.

| file | purpose |
|---|---|
| `success-test-*.jsonl` | the main success test: set_status + publish_artifact |
| `timeout-short-*.jsonl` | request_action — doesn't actually block (see the report) |
| `blocking-short-*.jsonl` | request_screen, tool_timeout_sec=15, nobody answered — a real timeout |
| `blocking-real-*.jsonl` | request_screen, tool_timeout_sec=180, the human actually answered after ~38 seconds |
| `full-kinds-*.jsonl` | agent_message + command_execution + file_change in the same turn |
| `error-badmodel-*.jsonl` | a model that doesn't exist in the config — falls back silently, no error |
| `error-noauth-*.jsonl` | CODEX_HOME without auth.json — real item.type=error + turn.failed |
| `reasoning-test-*.jsonl` | gpt-5.6-terra, effort=high, model_reasoning_summary=detailed — still no item.type=reasoning (ENGINES.md limitation 6) |

See the full report in the published artifact (the path is in the report to request_review).
