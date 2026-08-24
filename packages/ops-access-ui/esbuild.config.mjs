/**
 * esbuild config: bundles src/client.ts → lib/client.js
 * in the DSH ModuleLoader lazy-CJS format.
 *
 * The output wraps the CJS bundle in:
 *   window.__ModuleLoader__.load({ id: "...", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     // ...bundle...
 *     return module.exports;
 *   } });
 *
 * Baseline externals (provided by the browser module table) stay external;
 * everything else is inlined.
 */

import { build } from 'esbuild'

// The package name — must match package.json "name"
const PACKAGE_ID = '@deepseek-ai/dsh-ops-access-ui'

// Baseline modules the browser shell seeds into the module table.
// These stay external; the factory's `require` resolves them at runtime.
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-tool/client',
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
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: '\nreturn module.exports; } });',
  },
  logLevel: 'info',
})

console.log('✓ lib/client.js built (ModuleLoader lazy-CJS format)')
