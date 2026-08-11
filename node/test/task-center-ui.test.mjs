import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Task Center controls are wired to existing DOM elements without exposing record deletion", async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile(path.join(root, "assets", "index.html"), "utf8"),
    fs.readFile(path.join(root, "assets", "app.js"), "utf8"),
    fs.readFile(path.join(root, "assets", "app.css"), "utf8"),
  ]);
  const referencedIds = new Set([...script.matchAll(/\$\("#([A-Za-z][A-Za-z0-9_-]*)"\)/g)].map((match) => match[1]));
  for (const id of referencedIds) assert.match(html, new RegExp(`id=["']${id}["']`), `missing DOM element #${id}`);
  assert.match(html, /data-view="tasks"/);
  assert.match(html, /data-view-panel="tasks"/);
  assert.match(script, /\/api\/v1\/agent\/tasks\/cleanup-preview/);
  assert.match(script, /\/api\/v1\/agent\/session/);
  assert.match(script, /\/api\/v1\/sessions\/recover/);
  assert.match(script, /if \(await restoreBrowserSession\(\)\) return true;/);
  assert.match(script, /\/logs\?stream=/);
  assert.match(html, /id="taskObserverState"/);
  assert.match(html, /id="taskGpuPanel"/);
  assert.match(html, /id="taskGpuSummary"/);
  assert.match(script, /function renderTaskGpu\(record\)/);
  assert.match(script, /gpu_visibility/);
  assert.match(script, /未记录任务绑定/);
  assert.match(script, /function scheduleTaskStatusPolling\(delay = 5000\)/);
  assert.match(script, /async function refreshSelectedTaskStatus\(\)/);
  assert.match(script, /TASK_CANCELLABLE_STATUSES\.has\(taskStatusOf\(state\.selectedTask\)\)/);
  const statusPolling = script.match(/function scheduleTaskStatusPolling\(delay = 5000\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(statusPolling, /taskLogFollow/, "task status observation must not depend on log auto-follow");
  assert.match(script, /const action = record\.pinned \? "unpin" : "pin"/);
  assert.doesNotMatch(script, /delete-record/);
  assert.doesNotMatch(html, /id="deleteTask"/);
  assert.match(styles, /data-view="tasks"[^}]*\.task-center/);
  assert.match(styles, /max-height:\s*650px/);
  assert.match(styles, /data-view="files"\]\s+\.workspace-grid\s*\{\s*flex:\s*0 0 500px;\s*height:\s*500px;\s*min-height:\s*500px;/);
  assert.match(styles, /data-view="tasks"\]\s+\.task-center\s*\{\s*flex:\s*0 0 540px;\s*height:\s*540px;\s*min-height:\s*540px;/);
});
