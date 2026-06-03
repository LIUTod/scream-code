/**
 * /screamdog slash command — toggle the Scream Dog desktop pet.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SlashCommandHost } from './dispatch';

const PET_DIR = join(homedir(), '.scream-code', 'pet');
const STATE_FILE = join(tmpdir(), 'scream-pet-state.json');
const PID_FILE = join(PET_DIR, 'pid');

let petProcess: ChildProcess | null = null;

// ── PID file helpers ────────────────────────────────────────────────────

async function readPid(): Promise<number | null> {
  try {
    return Number((await readFile(PID_FILE, 'utf8')).trim());
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── State file ──────────────────────────────────────────────────────────

function writePetState(state: string): void {
  writeFile(STATE_FILE, JSON.stringify({ state }) + '\n').catch(() => {});
}

// ── Launch / Kill ───────────────────────────────────────────────────────

async function launchPet(): Promise<string> {
  if (petProcess) return '🐶 尖叫狗已经在运行了。';

  // Check PID file in case ScreamCode restarted while pet was running.
  const existingPid = await readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    return '🐶 尖叫狗已经在运行了。';
  }
  // Clean up stale PID file.
  if (existingPid !== null) {
    rm(PID_FILE, { force: true }).catch(() => { /* best effort */ });
  }

  if (!existsSync(join(PET_DIR, 'main.js'))) {
    return '未找到尖叫狗文件。请将 scream-pet-ts 放入 ~/.scream-code/pet/';
  }

  petProcess = spawn('npx', ['electron', '.'], {
    cwd: PET_DIR,
    stdio: 'ignore',
    detached: true,
  });

  if (petProcess.pid) {
    await writeFile(PID_FILE, String(petProcess.pid));
  }

  petProcess.on('exit', () => {
    petProcess = null;
    void rm(PID_FILE, { force: true });
  });
  petProcess.unref();

  writePetState('idle');
  return '🐶 尖叫狗已唤醒！';
}

async function killPet(): Promise<string> {
  // Try the in-memory handle first.
  if (petProcess) {
    petProcess.kill();
    petProcess = null;
    rm(PID_FILE, { force: true }).catch(() => { /* best effort */ });
    writePetState('quit');
    return '🐶 尖叫狗已休息。';
  }

  // Fall back to PID file.
  const pid = await readPid();
  if (pid !== null && isProcessAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* best effort */ }
    rm(PID_FILE, { force: true }).catch(() => { /* best effort */ });
    writePetState('quit');
    return '🐶 尖叫狗已休息。';
  }

  return '🐶 尖叫狗没有在运行。';
}

// ── Public API ──────────────────────────────────────────────────────────

export function syncPetState(streamingPhase: string): void {
  if (!petProcess) return;
  writePetState(streamingPhase === 'idle' ? 'idle' : 'run');
}

export async function handleScreamdogCommand(host: SlashCommandHost): Promise<void> {
  // Check PID file to determine current state — even across restarts.
  const pid = await readPid();
  if ((petProcess || (pid && isProcessAlive(pid)))) {
    host.showStatus(await killPet());
  } else {
    host.showStatus(await launchPet());
  }
}
