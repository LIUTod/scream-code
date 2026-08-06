import { copyFileSync } from 'node:fs';

// tsdown (dts: true) emits dist/index.d.mts for ESM; the package exports
// dist/index.d.ts, so the build renames it. This lives in a plain .mjs file
// because an inline `node -e "require('fs').copyFileSync(...)"` breaks under
// Windows cmd quoting (the original build script failed there).
copyFileSync('dist/index.d.mts', 'dist/index.d.ts');
