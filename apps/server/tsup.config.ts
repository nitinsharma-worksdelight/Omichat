import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/worker.ts', 'src/db/migrate-cli.ts', 'src/db/seed-cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // Workspace packages are TypeScript source, so bundle them; everything in node_modules stays external.
  noExternal: [/^@omni\//],
});
