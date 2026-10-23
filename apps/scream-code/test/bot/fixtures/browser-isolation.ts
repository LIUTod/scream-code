import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';

export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function inspect(entry: string) {
  try {
    const info = await fs.lstat(entry);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${entry}`);
    if (info.isFile() && info.nlink !== 1) throw new Error(`Hard links are not allowed: ${entry}`);
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Check EVERY existing component before the first mkdir, then create one level at a time. */
export async function directoryWithoutSymlink(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const components: string[] = [];
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    components.push(current);
    const info = await inspect(current);
    if (info !== undefined && !info.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
  for (const component of components) {
    if (await inspect(component) === undefined) {
      try { await fs.mkdir(component, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const info = await inspect(component);
    if (!info?.isDirectory()) throw new Error(`Not a directory: ${component}`);
  }
}

/** All paths owned by this fixture must stay under its disposable root. */
export class FixtureFiles {
  constructor(readonly root: string) {}

  async assertTree(directory = this.root): Promise<void> {
    if (directory !== this.root && !within(this.root, directory)) throw new Error('Path escapes fixture root');
    await directoryWithoutSymlink(directory);
    for (const name of await fs.readdir(directory)) {
      const entry = path.join(directory, name);
      const info = await inspect(entry);
      if (info?.isDirectory()) {
        // Package-manager caches inside HOME legitimately contain .bin symlinks;
        // every file this fixture writes is still opened with O_NOFOLLOW.
        if (name === '.npm' || name === '.cache') continue;
        await this.assertTree(entry);
      }
      else if (info !== undefined && !info.isFile() && !(entry === path.join(this.root, 'fixture.sock') && info.isSocket())) {
        throw new Error(`Unsupported fixture entry: ${entry}`);
      }
    }
  }

  async open(file: string, flags: number): Promise<fs.FileHandle> {
    if (!within(this.root, file)) throw new Error('Path escapes fixture root');
    await directoryWithoutSymlink(path.dirname(file));
    await inspect(file);
    // Do not truncate before verifying the opened inode (also reject hard links).
    const handle = await fs.open(file, (flags & ~constants.O_TRUNC) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error(`Not a private regular file: ${file}`);
      if ((flags & constants.O_TRUNC) !== 0) await handle.truncate(0);
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async write(file: string, content: string, exclusive = false): Promise<void> {
    const handle = await this.open(file, constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : constants.O_TRUNC));
    try { await handle.writeFile(content); } finally { await handle.close(); }
  }
}
