/**
 * esbuild config: bundles src/client.ts → lib/client.js
 * in the DSH ModuleLoader lazy-CJS format (same shape as ops-trace-ui).
 */

import { build } from 'esbuild'

// The package name — must match package.json "name"
const PACKAGE_ID = '@deepseek-ai/dsh-ops-panel'

// Baseline modules the browser shell seeds into the module table.
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

await build({
  entryPoints: ['src/client.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: EXTERNALS,
  outfile: 'lib/client.js',
  sourcemap: true,
  banner: {
    js: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PACKAGE_ID) + ', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: '\nreturn module.exports; } });',
  },
  logLevel: 'info',
})

console.log('✓ lib/client.js built (ModuleLoader lazy-CJS format)')
