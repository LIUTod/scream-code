import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import {
  getRoleLabel,
  getSubagentProfiles,
  showSubagentModelBinder,
} from '#/tui/components/dialogs/subagent-model-binder';
import { DEFAULT_SUBAGENT_TYPES } from '#/tui/utils/subagent-slots';

import { makeMockSlashCommandHost } from '../fixtures/mock-host';

/**
 * `tui.toml` is read from the data dir; point it at a throwaway directory per
 * test so the binder's save path is exercised for real (render → parse).
 */
const pathsStub = { dataDir: '' };

vi.mock('#/utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/paths')>();
  return { ...actual, getDataDir: () => pathsStub.dataDir };
});

/** Legacy down-arrow sequence — what the picker's SearchableList matches. */
const DOWN = '\u001B[B';
const UP = '\u001B[A';
const ENTER = '\r';
const ESC = '\u001B';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

/** Last panel mounted on the editor — the flow's current screen. */
function currentPicker(host: ReturnType<typeof makeMockSlashCommandHost>): ChoicePickerComponent {
  const calls = vi.mocked(host.mountEditorReplacement).mock.calls;
  const panel = calls.at(-1)?.[0];
  if (!(panel instanceof ChoicePickerComponent)) throw new Error('no picker mounted');
  return panel;
}

function renderPicker(picker: ChoicePickerComponent): string {
  return strip(picker.render(100).join('\n'));
}

/** Move the cursor `index` rows down, then commit the row under it. */
function pick(picker: ChoicePickerComponent, index: number): void {
  for (let i = 0; i < index; i += 1) picker.handleInput(DOWN);
  picker.handleInput(ENTER);
}

function makeHost(appState: NonNullable<Parameters<typeof makeMockSlashCommandHost>[0]>['appState']) {
  return makeMockSlashCommandHost({ appState });
}

function readTuiToml(): string {
  return readFileSync(join(pathsStub.dataDir, 'tui.toml'), 'utf-8');
}

beforeEach(() => {
  pathsStub.dataDir = mkdtempSync(join(tmpdir(), 'scream-model-diy-'));
});

afterEach(() => {
  rmSync(pathsStub.dataDir, { recursive: true, force: true });
});

/**
 * The picker keeps its own row order, so these tests pin both halves of the
 * contract: the order users expect here, and membership that follows the shared
 * slot list (a profile added there can never go missing in this dialog).
 */
describe('subagent model binder rows', () => {
  it('renders every shared subagent type in the picker order', () => {
    const names = getSubagentProfiles().map((row) => row.name);

    expect(names).toEqual([
      'coder',
      'reviewer',
      'writer',
      'explore',
      'oracle',
      'plan',
      'verify',
      'worker',
      'designer',
    ]);
  });

  it('never drops a type the shared slot list knows about', () => {
    const shown = new Set(getSubagentProfiles().map((row) => row.name));

    for (const type of DEFAULT_SUBAGENT_TYPES) {
      expect(shown.has(type), `missing picker row for ${type}`).toBe(true);
    }
    expect(shown.size).toBe(DEFAULT_SUBAGENT_TYPES.length);
  });

  it('gives every row a label to render', () => {
    for (const row of getSubagentProfiles()) {
      expect(row.description.length, `empty description for ${row.name}`).toBeGreaterThan(0);
    }
  });
});

describe('/model diy menu', () => {
  it('opens on the three-entry menu', () => {
    const host = makeHost({});

    showSubagentModelBinder(host);

    const rendered = renderPicker(currentPicker(host));
    expect(rendered).toContain(t('modeldiy.entry_roles'));
    expect(rendered).toContain(t('modeldiy.entry_housekeeping'));
    expect(rendered).toContain(t('modeldiy.entry_profiles'));
    // Every entry carries its one-line explanation.
    expect(rendered).toContain(t('modeldiy.entry_roles_desc'));
    expect(rendered).toContain(t('modeldiy.entry_housekeeping_desc'));
    expect(rendered).toContain(t('modeldiy.entry_profiles_desc'));
    // Opening the dialog no longer lands on the profile list.
    expect(rendered).not.toContain(t('subagent.title'));
  });

  it('Esc on the menu restores the editor', () => {
    const host = makeHost({});

    showSubagentModelBinder(host);
    currentPicker(host).handleInput(ESC);

    expect(host.restoreEditor).toHaveBeenCalledTimes(1);
  });
});

describe('/model diy role bindings', () => {
  it('lists the three role classes with their current binding and scope', () => {
    const host = makeHost({
      modelTiers: { read: 'k2' },
      availableModels: { k2: { displayName: 'K2 Fleet', model: 'k2-model' } } as never,
    });

    showSubagentModelBinder(host);
    pick(currentPicker(host), 0);

    const rendered = renderPicker(currentPicker(host));
    for (const role of ['read', 'task', 'judge'] as const) {
      expect(rendered).toContain(getRoleLabel(role));
      expect(rendered).toContain(t(`modeldiy.role_${role}_desc`));
    }
    // Current binding on the bound role, follow-default on the unbound ones:
    // an unset tier consults config.toml before the main model.
    expect(rendered).toContain('K2 Fleet');
    expect(rendered).toContain(t('subagent.follow_default'));
    expect(rendered).not.toContain(t('subagent.follow_main'));
  });

  it('persists a role binding to tui.toml and AppState, then returns to the menu', async () => {
    const host = makeHost({
      availableModels: { k2: { displayName: 'K2 Fleet', model: 'k2-model' } } as never,
    });

    showSubagentModelBinder(host);
    pick(currentPicker(host), 0); // menu → roles
    pick(currentPicker(host), 0); // roles → bind "read"
    const mounted = vi.mocked(host.mountEditorReplacement).mock.calls.length;

    pick(currentPicker(host), 1); // model picker row 1 = the only alias

    await vi.waitFor(() => {
      expect(host.setAppState).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(vi.mocked(host.mountEditorReplacement).mock.calls.length).toBeGreaterThan(mounted);
    });

    expect(host.state.appState.modelTiers).toEqual({ read: 'k2' });
    const saved = readTuiToml();
    expect(saved).toContain('[modelTiers]');
    expect(saved).toContain('read = "k2"');
    // Back at the top-level menu after a one-shot binding.
    expect(renderPicker(currentPicker(host))).toContain(t('modeldiy.entry_profiles'));
  });

  it('clears a role binding when 跟随默认 is picked', async () => {
    const host = makeHost({
      modelTiers: { read: 'k2' },
      availableModels: { k2: { displayName: 'K2 Fleet', model: 'k2-model' } } as never,
    });
    // Seed a file so the clear path has something to remove.
    const { saveTuiConfig, DEFAULT_TUI_CONFIG } = await import('#/tui/config');
    await saveTuiConfig(
      { ...DEFAULT_TUI_CONFIG, modelTiers: { read: 'k2' } },
      join(pathsStub.dataDir, 'tui.toml'),
    );

    showSubagentModelBinder(host);
    pick(currentPicker(host), 0);
    pick(currentPicker(host), 0);
    const picker = currentPicker(host);
    // The cursor starts on the current binding (k2); step up to FOLLOW_MAIN.
    picker.handleInput(UP);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.setAppState).toHaveBeenCalled();
    });

    expect(host.state.appState.modelTiers).toEqual({});
    expect(readTuiToml()).not.toContain('read = "k2"');
  });

  it('rejects an alias that vanished while the picker was open', async () => {
    const host = makeHost({
      availableModels: { ghost: { displayName: 'Ghost', model: 'ghost-model' } } as never,
    });

    showSubagentModelBinder(host);
    pick(currentPicker(host), 0);
    pick(currentPicker(host), 0);
    const picker = currentPicker(host);
    // A provider reload between mounting and choosing: the alias is gone.
    host.state.appState.availableModels = {};

    pick(picker, 1);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        t('subagent.invalid_alias', { alias: 'ghost' }),
      );
    });
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.appState.modelTiers ?? {}).toEqual({});
    expect(readTuiToml()).not.toContain('[modelTiers]');
  });
});

describe('/model diy housekeeping binding', () => {
  it('opens the model picker directly and persists the compaction model', async () => {
    const host = makeHost({
      availableModels: {
        k2: { displayName: 'K2 Fleet', model: 'k2-model' },
        mini: { displayName: 'Mini', model: 'mini-model' },
      } as never,
    });

    showSubagentModelBinder(host);
    pick(currentPicker(host), 1); // menu → housekeeping picker
    expect(renderPicker(currentPicker(host))).toContain(t('modeldiy.housekeeping_title'));
    // The clear option on the housekeeping picker must not claim the main
    // model — config.toml `housekeeping_model` is tried first. The cursor
    // starts on it (nothing is bound), which pins the exact row text.
    expect(renderPicker(currentPicker(host))).toContain(
      `❯ ${t('subagent.follow_default')}`,
    );

    pick(currentPicker(host), 2); // FOLLOW_MAIN, k2, mini

    await vi.waitFor(() => {
      expect(host.setAppState).toHaveBeenCalled();
    });

    expect(host.state.appState.modelTiers).toEqual({ housekeeping: 'mini' });
    const saved = readTuiToml();
    expect(saved).toContain('[modelTiers]');
    expect(saved).toContain('housekeeping = "mini"');
    // Housekeeping is one-shot: back on the menu.
    expect(renderPicker(currentPicker(host))).toContain(t('modeldiy.entry_roles'));
  });

  it('shows the current compaction model as the selected row', () => {
    const host = makeHost({
      modelTiers: { housekeeping: 'mini' },
      availableModels: { mini: { displayName: 'Mini', model: 'mini-model' } } as never,
    });

    showSubagentModelBinder(host);
    pick(currentPicker(host), 1);

    expect(renderPicker(currentPicker(host))).toContain('← current');
  });
});

describe('/model diy per-profile binding', () => {
  it('keeps the profile flow working one level deeper', async () => {
    const host = makeHost({
      availableModels: {
        k2: { displayName: 'K2 Fleet', model: 'k2-model' },
        sonnet: { displayName: 'Sonnet', model: 'sonnet-model' },
      } as never,
    });

    showSubagentModelBinder(host);
    pick(currentPicker(host), 2); // menu → profiles
    const profileList = currentPicker(host);
    expect(renderPicker(profileList)).toContain(t('subagent.title'));

    pick(profileList, 0); // bind "coder"
    expect(renderPicker(currentPicker(host))).toContain(
      t('subagent.bind_title', { profile: 'coder' }),
    );

    pick(currentPicker(host), 2); // FOLLOW_MAIN, k2, sonnet

    await vi.waitFor(() => {
      expect(host.setAppState).toHaveBeenCalled();
    });

    expect(host.state.appState.subagentModels).toEqual({ coder: 'sonnet' });
    const saved = readTuiToml();
    expect(saved).toContain('[subagentModels]');
    expect(saved).toContain('coder = "sonnet"');
    // Profile bindings return to their own list, unchanged from before.
    expect(renderPicker(currentPicker(host))).toContain(t('subagent.title'));
  });

  it('Esc walks back one level at a time', () => {
    const host = makeHost({});

    showSubagentModelBinder(host);
    pick(currentPicker(host), 2); // menu → profiles
    currentPicker(host).handleInput(ESC); // profiles → menu
    expect(vi.mocked(host.restoreEditor)).not.toHaveBeenCalled();

    currentPicker(host).handleInput(ESC); // menu → editor
    expect(host.restoreEditor).toHaveBeenCalledTimes(1);
  });
});
