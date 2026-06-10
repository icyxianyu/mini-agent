#!/usr/bin/env npx tsx
/**
 * Mini Agent CLI — 全局入口。
 * 只做三件事：1.定位项目根目录 2.加载.env 3.转发到 src/index.ts
 *
 * 安装: cd <项目目录> && pnpm link --global
 * 使用: mini-agent                   → 等同 pnpm dev
 *       mini-agent -w /path/to/proj  → 指定工作区
 *       mini-agent -m deepseek       → 临时覆盖模型
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── 定位项目根目录 ──────────────────────────────────

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== resolve(dir, "..")) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const PROJECT_ROOT = findProjectRoot(dirname(fileURLToPath(import.meta.url)));

// ─── 参数解析 ───────────────────────────────────────

let workspace = "";
let model = "";

const raw = process.argv.slice(2);
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === "--workspace" || raw[i] === "-w") workspace = raw[++i] ?? "";
  else if (raw[i] === "--model" || raw[i] === "-m") model = raw[++i] ?? "";
  else if (raw[i] === "--help" || raw[i] === "-h") {
    console.log("mini-agent — 全局启动 src/index.ts REPL\n  -w 指定工作区  -m 指定模型");
    process.exit(0);
  }
}

// ─── 加载 env（必须在 import src/index.ts 之前）─────────

function loadEnv(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const workspaceRoot = resolve(workspace || process.cwd());
loadEnv(join(workspaceRoot, ".env"));
loadEnv(join(PROJECT_ROOT, ".env"));

process.env.WORKSPACE_ROOT = workspaceRoot;
if (model) process.env.LLM_MODEL = model;

// ─── 转发到 src/index.ts ─────────────────────────────

await import("../src/index.js");
