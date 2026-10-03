import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    projects: [
      {
        test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        // Commands against real temporary git repositories.
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e.test.ts'],
          environment: 'node',
          globalSetup: ['test/setup/build.ts'],
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli/main.ts'],
      // Ratchet: raise these when coverage grows, never lower them.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
})
