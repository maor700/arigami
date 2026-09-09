# קבצי JSONL גולמיים — POC Codex

כל קובץ הוא הפלט הגולמי, ללא עריכה, של `codex exec --json` דרך `scripts/codex-poc.ts`.
קובץ `.stderr.log` תואם (כשקיים) הוא הלוג הנפרד ל-stderr של אותה הרצה.

| קובץ | מטרה |
|---|---|
| `success-test-*.jsonl` | מבחן ההצלחה המרכזי: set_status + publish_artifact |
| `timeout-short-*.jsonl` | request_action — לא חוסם בפועל (ראו הדוח) |
| `blocking-short-*.jsonl` | request_screen, tool_timeout_sec=15, אף אחד לא ענה — טיים-אאוט אמיתי |
| `blocking-real-*.jsonl` | request_screen, tool_timeout_sec=180, מאור ענה בפועל אחרי ~38 שניות |
| `full-kinds-*.jsonl` | agent_message + command_execution + file_change באותו תור |
| `error-badmodel-*.jsonl` | מודל לא-קיים בקונפיג — נופל חזרה בשקט, לא שגיאה |
| `error-noauth-*.jsonl` | CODEX_HOME בלי auth.json — item.type=error + turn.failed אמיתיים |
| `reasoning-test-*.jsonl` | gpt-5.6-terra, effort=high, model_reasoning_summary=detailed — עדיין בלי item.type=reasoning (ENGINES.md מגבלה 6) |

ראו את הדוח המלא ב-artifact שפורסם (הנתיב בדיווח ל-request_review).
