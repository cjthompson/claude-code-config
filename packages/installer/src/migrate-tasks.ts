#!/usr/bin/env node --experimental-strip-types
/**
 * One-off migration script: reads docs/TASKS.md files from repos in ~/dev/personal/
 * and inserts them into ~/.claude/tasks.db, then deletes the source files.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, existsSync, rmdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

const DB = join(homedir(), ".claude", "tasks.db");
const SEARCH_ROOT = join(homedir(), "dev", "personal");

interface Task {
  seq: number | null;
  type: string;
  title: string;
  priority: string;
  status: string;
  tags: string[];
  reqs: string[];
  created: string;
  updated: string | null;
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function runSql(statements: string): string {
  // Write SQL to a temp file and execute via stdin to avoid shell escaping issues
  const tmpFile = join(tmpdir(), `migrate-tasks-${Date.now()}.sql`);
  writeFileSync(tmpFile, statements, "utf-8");
  try {
    return execSync(`sqlite3 '${DB}' < '${tmpFile}'`, { encoding: "utf-8" }).trim();
  } finally {
    unlinkSync(tmpFile);
  }
}

function getProjectId(repoPath: string): string {
  try {
    const remote = execSync("git remote get-url origin 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    return remote.replace(/\.git$/, "");
  } catch {
    return basename(repoPath);
  }
}

function parseTasks(content: string): Task[] {
  const tasks: Task[] = [];
  const entries = content.split(/^---\s*$/m).filter((e) => e.trim());

  for (const entry of entries) {
    const lines = entry.trim().split("\n");

    // Find heading line
    const headingLine = lines.find((l) => /^## (fix|task|todo): /.test(l));
    if (!headingLine) continue;

    const headingMatch = headingLine.match(/^## (fix|task|todo): (.+)$/);
    if (!headingMatch) continue;

    const type = headingMatch[1];
    const title = headingMatch[2];

    // Find metadata line (may or may not have ID)
    const metaLine = lines.find(
      (l) => l.startsWith("**ID:**") || l.startsWith("**Date:**")
    );
    if (!metaLine) continue;

    // Extract ID if present
    let seq: number | null = null;
    const idMatch = metaLine.match(/\*\*ID:\*\* #(\d+)/);
    if (idMatch) seq = parseInt(idMatch[1], 10);

    // Extract date
    const dateMatch = metaLine.match(/\*\*Date:\*\* (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
    const created = dateMatch ? dateMatch[1] : "1970-01-01 00:00";

    // Extract priority
    const priorityMatch = metaLine.match(/\*\*Priority:\*\* (high|medium|low)/);
    const priority = priorityMatch ? priorityMatch[1] : "medium";

    // Extract tags
    const tagsMatch = metaLine.match(/\*\*Tags:\*\* (.+)$/);
    let tags: string[] = [];
    if (tagsMatch && tagsMatch[1] !== "—") {
      tags = tagsMatch[1]
        .split(/[\s,]+/)
        .filter((t) => t.startsWith("#"))
        .map((t) => t.replace(/,$/, ""));
    }

    // Find status line
    const statusLine = lines.find((l) => l.startsWith("**Status:**"));
    let status = "pending";
    let updated: string | null = null;
    if (statusLine) {
      const statusMatch = statusLine.match(
        /\*\*Status:\*\* (pending|completed|in_progress|cancelled)(?:\s*\((.+?)\))?/
      );
      if (statusMatch) {
        status = statusMatch[1];
        if (statusMatch[2]) updated = statusMatch[2];
      }
    }

    // Find requirements
    const reqsStartIdx = lines.findIndex((l) => l.startsWith("### Requirements"));
    const reqs: string[] = [];
    if (reqsStartIdx >= 0) {
      for (let i = reqsStartIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("- ")) {
          reqs.push(line.slice(2));
        } else if (line.startsWith("###") || line.startsWith("---")) {
          break;
        }
      }
    }

    tasks.push({ seq, type, title, priority, status, tags, reqs, created, updated });
  }

  return tasks;
}

function buildInsertSql(project: string, tasks: Task[]): string {
  const lines: string[] = [];

  // Determine starting seq for tasks without IDs
  const maxExistingSeq = tasks
    .filter((t) => t.seq !== null)
    .reduce((max, t) => Math.max(max, t.seq!), 0);
  let nextSeq = maxExistingSeq;

  for (const task of tasks) {
    const seq = task.seq ?? ++nextSeq;
    if (task.seq === null) nextSeq = Math.max(nextSeq, seq);

    const tagsJson = JSON.stringify(task.tags);
    const reqsJson = JSON.stringify(task.reqs);
    const inChangelog = task.status === "completed" ? 1 : 0;
    const updatedVal = task.updated ? `'${sqlEscape(task.updated)}'` : "NULL";

    lines.push(
      `INSERT OR IGNORE INTO tasks(project,seq,type,title,priority,status,tags,reqs,created,updated,in_changelog) VALUES('${sqlEscape(project)}',${seq},'${task.type}','${sqlEscape(task.title)}','${task.priority}','${task.status}','${sqlEscape(tagsJson)}','${sqlEscape(reqsJson)}','${task.created}',${updatedVal},${inChangelog});`
    );
  }

  return lines.join("\n");
}

// Main
console.log("Initializing database...");
runSql(
  `CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,project TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL CHECK(type IN('fix','task','todo')),title TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN('high','medium','low')),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','completed','cancelled')),tags TEXT DEFAULT '[]',reqs TEXT DEFAULT '[]',created TEXT NOT NULL,updated TEXT,in_changelog INTEGER NOT NULL DEFAULT 0,UNIQUE(project,seq));`
);

const dirs = readdirSync(SEARCH_ROOT).filter((d) => {
  const full = join(SEARCH_ROOT, d);
  return statSync(full).isDirectory();
});

let totalMigrated = 0;
let filesDeleted = 0;

for (const dir of dirs) {
  const repoPath = join(SEARCH_ROOT, dir);
  const tasksFile = join(repoPath, "docs", "TASKS.md");

  if (!existsSync(tasksFile)) continue;

  const project = getProjectId(repoPath);
  console.log(`\n[${dir}] project="${project}"`);

  const content = readFileSync(tasksFile, "utf-8");
  const tasks = parseTasks(content);
  console.log(`  Parsed ${tasks.length} tasks`);

  if (tasks.length > 0) {
    const sql = buildInsertSql(project, tasks);
    runSql(sql);
    console.log(`  Inserted ${tasks.length} tasks`);
    totalMigrated += tasks.length;
  }

  // Delete the file
  unlinkSync(tasksFile);
  console.log(`  Deleted ${tasksFile}`);
  filesDeleted++;

  // Remove docs/ dir if empty
  const docsDir = join(repoPath, "docs");
  try {
    const remaining = readdirSync(docsDir);
    if (remaining.length === 0) {
      rmdirSync(docsDir);
      console.log(`  Removed empty ${docsDir}`);
    }
  } catch {
    // dir already gone or not empty
  }
}

console.log(`\nMigration complete: ${totalMigrated} tasks from ${filesDeleted} files.`);

// Summary
try {
  const summary = runSql(
    `SELECT project || ': ' || count(*) || ' tasks (' || SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) || ' completed, ' || SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) || ' pending)' FROM tasks GROUP BY project;`
  );
  console.log("\nDatabase summary:");
  for (const line of summary.split("\n")) {
    console.log(`  ${line}`);
  }
} catch {
  // empty
}
