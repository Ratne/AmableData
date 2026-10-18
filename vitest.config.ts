import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'examples/apps/*/test/**/*.test.ts',
      'packages/app-cli/template/test/**/*.test.ts',
      'scripts/test/**/*.test.mjs',
    ],
  },
});
