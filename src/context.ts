/**
 * 上下文注入模块 — 启动时自动收集项目信息，注入到 system prompt。
 *
 * 策略：
 * - 探测项目类型（Node/Go/Python/Rust/Java...），多类型共存也支持
 * - 对每个类型收集：配置文件 + 入口文件前 N 行
 * - 通用收集：目录结构 + Git 状态 + README
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  收集内容                     Token 预算                    │
 * │  ├─ 目录结构（2~3层）         ~200 tokens                   │
 * │  ├─ Git 状态                 ~100 tokens                   │
 * │  ├─ 项目类型 + 配置          ~200 tokens                   │
 * │  ├─ 入口文件（前30行）       ~200 tokens                   │
 * │  └─ README（前15行）         ~100 tokens                   │
 * │  总计                        ~800 tokens                   │
 * └─────────────────────────────────────────────────────────────┘
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ─── 常量 ───────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  "__pycache__", ".cache", "logs", ".turbo", ".vercel",
  ".serverless", "target", ".gradle", ".idea", ".vscode",
]);

const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".7z",
  ".mp3", ".mp4", ".mov", ".avi",
  ".pdf", ".exe", ".dll", ".so", ".dylib",
  ".lock",
]);

/** 项目类型标记：文件名 → 类型描述 + 相关文件 */
interface ProjectMarker {
  name: string;
  configs: string[];      // 配置文件（读前50行）
  entries: string[];      // 入口文件模式（读前30行，支持 * 通配）
  dependencies?: string[]; // 依赖文件
}

const PROJECT_MARKERS: Record<string, ProjectMarker> = {
  "package.json": {
    name: "Node.js / TypeScript",
    configs: ["package.json", "tsconfig.json", ".eslintrc.*", "vite.config.*", "next.config.*"],
    entries: ["src/index.ts", "src/index.js", "src/main.ts", "src/app.ts", "index.ts", "index.js", "server.ts"],
    dependencies: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  },
  "go.mod": {
    name: "Go",
    configs: ["go.mod", "go.sum"],
    entries: ["main.go", "cmd/*/main.go"],
  },
  "Cargo.toml": {
    name: "Rust",
    configs: ["Cargo.toml", "Cargo.lock"],
    entries: ["src/main.rs", "src/lib.rs"],
  },
  "requirements.txt": {
    name: "Python (pip)",
    configs: ["requirements.txt", "setup.py", "setup.cfg"],
    entries: ["main.py", "app.py", "src/main.py", "run.py"],
  },
  "pyproject.toml": {
    name: "Python (modern)",
    configs: ["pyproject.toml"],
    entries: ["src/*/main.py", "main.py", "app.py"],
  },
  "pom.xml": {
    name: "Java / Maven",
    configs: ["pom.xml"],
    entries: ["src/main/java/**/*Application.java", "src/main/java/**/Main.java"],
  },
  "build.gradle": {
    name: "Java / Gradle",
    configs: ["build.gradle", "build.gradle.kts", "settings.gradle"],
    entries: ["src/main/java/**/*Application.java", "src/main/java/**/Main.java"],
  },
  "Makefile": {
    name: "C/C++ (Make)",
    configs: ["Makefile", "CMakeLists.txt"],
    entries: ["src/main.c", "src/main.cpp", "main.c", "main.cpp"],
  },
  "deno.json": {
    name: "Deno",
    configs: ["deno.json", "deno.jsonc"],
    entries: ["src/index.ts", "main.ts", "index.ts"],
  },
  "Gemfile": {
    name: "Ruby",
    configs: ["Gemfile", "Gemfile.lock"],
    entries: ["lib/**/version.rb", "bin/*", "app.rb"],
  },
};

/** 通用文件：几乎所有项目都可能有的信息文件 */
const GENERIC_INFO_FILES = [
  "README.md", "README", "CHANGELOG.md", "CONTRIBUTING.md",
  ".gitignore", ".env.example", "docker-compose.yml", "Dockerfile",
];

// ─── 公开接口 ───────────────────────────────────────

export interface ProjectContext {
  summary: string;
  directoryTree: string;
  gitStatus: string | null;
  packageInfo: string | null;
  projectTypes: string[];
  entryContents: string | null;
}

export function collectProjectContext(rootDir = "."): ProjectContext {
  const dirTree = collectDirectoryTree(rootDir);
  const git = collectGitStatus(rootDir);

  // 探测项目类型 + 收集相关文件
  const { types, configSum, entrySum } = detectAndCollectTypes(rootDir);

  // 通用文件
  const genericSum = collectGenericFiles(rootDir);

  // 组装 summary
  const parts: string[] = [];

  // 项目概览
  if (types.length > 0) {
    parts.push(`## 项目类型\n${types.join(" + ")}`);
  } else {
    parts.push(`## 项目概览\n项目根目录: ${path.resolve(rootDir)}`);
  }

  if (configSum) parts.push(`\n## 配置信息\n${configSum}`);
  if (entrySum) parts.push(`\n## 入口文件\n${entrySum}`);
  if (genericSum) parts.push(`\n## 项目文档\n${genericSum}`);

  if (git) {
    parts.push(`\n## Git 状态\n当前分支: ${git.branch}`);
    if (git.changedFiles.length > 0) {
      parts.push(`未提交变更: ${git.changedFiles.slice(0, 10).join(", ")}`);
    }
  }

  parts.push(`\n## 目录结构（${dirTree.totalFiles} 文件, ${dirTree.totalDirs} 目录）`);

  return {
    summary: parts.join("\n"),
    directoryTree: dirTree.tree,
    gitStatus: git ? formatGitStatus(git) : null,
    packageInfo: configSum || null,
    projectTypes: types,
    entryContents: entrySum || null,
  };
}

// ─── 项目类型探测 ───────────────────────────────────

function detectAndCollectTypes(rootDir: string): {
  types: string[];
  configSum: string;
  entrySum: string;
} {
  const types: string[] = [];
  const configParts: string[] = [];
  const entryParts: string[] = [];

  for (const [marker, info] of Object.entries(PROJECT_MARKERS)) {
    const markerPath = path.join(rootDir, marker);
    if (!fs.existsSync(markerPath)) continue;

    types.push(info.name);

    // 读配置文件（前 50 行）
    for (const cf of info.configs) {
      const matches = globFirst(rootDir, cf);
      for (const m of matches) {
        const content = readFirstLines(path.join(rootDir, m), 50);
        if (content) configParts.push(`### ${m}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    // 读入口文件（前 30 行）
    for (const ep of info.entries) {
      const matches = globFirst(rootDir, ep);
      for (const m of matches) {
        const content = readFirstLines(path.join(rootDir, m), 30);
        if (content) entryParts.push(`### ${m}\n\`\`\`\n${content}\n\`\`\``);
      }
    }
  }

  return {
    types,
    configSum: configParts.join("\n"),
    entrySum: entryParts.join("\n"),
  };
}

// ─── 通用文件收集 ───────────────────────────────────

function collectGenericFiles(rootDir: string): string {
  const parts: string[] = [];
  for (const name of GENERIC_INFO_FILES) {
    const filePath = path.join(rootDir, name);
    if (!fs.existsSync(filePath)) continue;

    // README 读前 15 行，其他读前 10 行
    const maxLines = name.startsWith("README") ? 15 : 10;
    const content = readFirstLines(filePath, maxLines);
    if (content) parts.push(`### ${name}\n\`\`\`\n${content}\n\`\`\``);
  }
  return parts.join("\n");
}

// ─── 工具函数 ───────────────────────────────────────

/** 读文件前 N 行 */
function readFirstLines(filePath: string, maxLines: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > 50 * 1024) return `(文件过大, ${(stat.size / 1024).toFixed(0)}KB, 跳过预览)`;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").slice(0, maxLines);
    return lines.join("\n");
  } catch {
    return null;
  }
}

/** 简单通配符匹配：支持 * 和 ** */
function globFirst(rootDir: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    // 精确匹配
    const fullPath = path.join(rootDir, pattern);
    return fs.existsSync(fullPath) ? [pattern] : [];
  }

  // 通配符匹配（简化版，只支持 * 和 **）
  const parts = pattern.split("/");
  const results: string[] = [];
  globWalk(rootDir, rootDir, parts, 0, results);
  return results.slice(0, 3); // 最多 3 个匹配
}

function globWalk(
  rootDir: string,
  currentDir: string,
  patternParts: string[],
  index: number,
  results: string[],
) {
  if (index >= patternParts.length) return;
  if (results.length >= 3) return;

  const part = patternParts[index];

  if (part === "**") {
    // ** 匹配任意层级
    const entries = safeReaddir(currentDir);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = path.join(currentDir, entry);
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          globWalk(rootDir, fullPath, patternParts, index, results); // 继续当前层级
          globWalk(rootDir, fullPath, patternParts, index + 1, results); // 跳到下一层
        }
      } catch { /* skip */ }
    }
  } else if (part.includes("*")) {
    // 单层通配
    const regex = new RegExp("^" + part.replace(/\*/g, ".*") + "$");
    const entries = safeReaddir(currentDir);
    const isLast = index === patternParts.length - 1;
    for (const entry of entries) {
      if (regex.test(entry)) {
        const fullPath = path.join(currentDir, entry);
        if (isLast) {
          results.push(path.relative(rootDir, fullPath));
        } else {
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              globWalk(rootDir, fullPath, patternParts, index + 1, results);
            }
          } catch { /* skip */ }
        }
      }
    }
  } else {
    // 精确匹配目录名
    const nextDir = path.join(currentDir, part);
    if (!fs.existsSync(nextDir)) return;
    globWalk(rootDir, nextDir, patternParts, index + 1, results);
  }
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// ─── 目录树收集 ─────────────────────────────────────

interface DirTreeResult {
  tree: string;
  totalFiles: number;
  totalDirs: number;
}

function collectDirectoryTree(
  rootDir: string,
  maxDepth = 3,
  maxTopEntries = 30,
): DirTreeResult {
  const root = path.resolve(rootDir);
  const lines: string[] = [];
  let totalFiles = 0;
  let totalDirs = 0;

  if (!fs.existsSync(root)) {
    return { tree: "(目录不存在)", totalFiles: 0, totalDirs: 0 };
  }

  lines.push(path.basename(root) + "/");

  try {
    walkTree(root, root, "", 0, maxDepth, maxTopEntries, lines, {
      incFiles: () => totalFiles++,
      incDirs: () => totalDirs++,
    });
  } catch { /* 容错 */ }

  return { tree: lines.join("\n"), totalFiles, totalDirs };
}

function walkTree(
  rootDir: string,
  currentDir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
  maxTopEntries: number,
  lines: string[],
  counters: { incFiles: () => void; incDirs: () => void },
) {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (depth === 0 && entries.length > maxTopEntries) {
    lines.push(`${prefix}  ... (${entries.length} 个条目，仅显示前 ${maxTopEntries} 个)`);
    entries = entries.slice(0, maxTopEntries);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      counters.incDirs();
      lines.push(`${prefix}${connector}${entry.name}/`);
      if (depth < maxDepth) {
        walkTree(rootDir, path.join(currentDir, entry.name), prefix + childPrefix, depth + 1, maxDepth, maxTopEntries, lines, counters);
      } else {
        lines.push(`${prefix}${childPrefix}[+]`);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      counters.incFiles();
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }
}

// ─── Git 状态收集 ───────────────────────────────────

interface GitInfo {
  branch: string;
  changedFiles: string[];
  recentCommits: string[];
}

function collectGitStatus(rootDir: string): GitInfo | null {
  const gitDir = path.join(rootDir, ".git");
  if (!fs.existsSync(gitDir)) return null;

  try {
    let branch = "(unknown)";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: rootDir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch { branch = "(detached HEAD)"; }

    let changedFiles: string[] = [];
    try {
      const status = execSync("git status --short", {
        cwd: rootDir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
      });
      changedFiles = status.split("\n").filter(Boolean).map(l => l.trim()).slice(0, 20);
    } catch { /* ok */ }

    let recentCommits: string[] = [];
    try {
      const log = execSync("git log --oneline -5", {
        cwd: rootDir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
      });
      recentCommits = log.split("\n").filter(Boolean);
    } catch { /* ok */ }

    return { branch, changedFiles, recentCommits };
  } catch {
    return null;
  }
}

function formatGitStatus(git: GitInfo): string {
  const parts = [`分支: ${git.branch}`];
  if (git.changedFiles.length > 0) { parts.push("未提交变更:"); for (const f of git.changedFiles) parts.push(`  ${f}`); }
  else parts.push("工作区干净");
  if (git.recentCommits.length > 0) { parts.push("最近提交:"); for (const c of git.recentCommits) parts.push(`  ${c}`); }
  return parts.join("\n");
}
