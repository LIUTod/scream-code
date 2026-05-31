import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Only install git hooks when running in a real git repository.
// Users who download source archives (instead of git clone) will
// lack a .git directory — skip silently instead of spamming errors.
if (existsSync('.git')) {
  execSync('simple-git-hooks', { stdio: 'inherit' });
}
