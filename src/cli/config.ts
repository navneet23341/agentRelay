import fs from 'fs';
import path from 'path';

export const PROJECT_CONFIG_FILE = '.relay.json';
export const LOCAL_CONFIG_FILE = '.relay.local.json';

export interface ProjectConfig {
  projectId: string;
}

export interface LocalConfig {
  activeTaskId?: string;
  activePhaseId?: string;
}

export function getProjectConfig(cwd: string = process.cwd()): ProjectConfig | null {
  const filePath = path.join(cwd, PROJECT_CONFIG_FILE);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveProjectConfig(projectId: string, cwd: string = process.cwd()): void {
  const filePath = path.join(cwd, PROJECT_CONFIG_FILE);
  const data: ProjectConfig = { projectId };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function getLocalConfig(cwd: string = process.cwd()): LocalConfig | null {
  const filePath = path.join(cwd, LOCAL_CONFIG_FILE);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLocalConfig(update: Partial<LocalConfig>, cwd: string = process.cwd()): void {
  const current = getLocalConfig(cwd) || {};
  const merged = { ...current, ...update };
  const filePath = path.join(cwd, LOCAL_CONFIG_FILE);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

export function ensureGitignoreEntry(
  entry: string = LOCAL_CONFIG_FILE,
  cwd: string = process.cwd()
): boolean {
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim());
    if (lines.includes(entry)) {
      return false; // Already present
    }
    const trailingNewline = content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${trailingNewline}${entry}\n`, 'utf-8');
    return true;
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`, 'utf-8');
    return true;
  }
}

export function resolveProjectId(override?: string, cwd: string = process.cwd()): string {
  if (override && override.trim()) {
    return override.trim();
  }
  const config = getProjectConfig(cwd);
  if (config && config.projectId) {
    return config.projectId;
  }
  throw new Error(
    'No project ID found. Run "relay init" in this repository or specify --project <id>.'
  );
}

export function resolveTaskId(override?: string, cwd: string = process.cwd()): string {
  if (override && override.trim()) {
    return override.trim();
  }
  const localConfig = getLocalConfig(cwd);
  if (localConfig && localConfig.activeTaskId) {
    return localConfig.activeTaskId;
  }
  throw new Error(
    'No active task found. Run "relay task start <id>" or specify --task <id>.'
  );
}
