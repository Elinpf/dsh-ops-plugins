/**
 * Unit spec for ops-tool-prometheus: export shape, registration/HMR,
 * instant vs range query routing, URL encoding, bearer-token handling,
 * Prometheus error mapping, network/timeout classification, and the
 * result-size guards. All through an injected fake fetch — no network.
 */

import { describe, expect, it } from 'vitest'
import * as mod from '../src/index.ts'
import * as invariantMod from '../src/invariant.ts'
import * as typesMod from '../src/types.ts'
import { setup, jsonResponse, textResponse, writeTokenFile, DEFAULT_PROFILE } from './harness.ts'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect(mod.name).toBe('ops-tool-prometheus')
    expect(mod.inject).toEqual(['tools'])
    expect(mod.Config).toBeDefined()
    expect(typeof mod.apply).toBe('function')
    expect((mod as any).default).toBeUndefined()
  })

  it('./invariant entry is a function plugin: named exports, no default', () => {
    expect(invariantMod.name).toBe('ops-prometheus-invariant')
    expect(invariantMod.inject).toEqual(['invariants'])
    expect(typeof invariantMod.apply).toBe('function')
    expect((invariantMod as any).default).toBeUndefined()
  })

  it('./types entry carries zero runtime code', () => {
    expect(Object.keys(typesMod)).toHaveLength(0)
  })
})

// ── Registration ─────────────────────────────────────────────────────────────

describe('HMR unload', () => {
  it('apply registers the prometheus tool; running every effect disposer unregisters it', () => {
    const h = setup()
    h.tools.length = 0 // drop the directly-created test tool
    h.applyPlugin()
    expect(h.tools.some((t) => t.name === 'prometheus')).toBe(true)
    expect(h.effectCleanups.length).toBeGreaterThan(0)
    for (const dispose of h.effectCleanups) dispose()
    expect(h.tools.some((t) => t.name === 'prometheus')).toBe(false)
  })
})

// ── Instant query ────────────────────────────────────────────────────────────

describe('instant query', () => {
  it('happy path: GET /api/v1/query, vector formatted one line per series', async () => {
    const h = setup()
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(h.calls.resolve).toBe(1)
    expect(h.calls.fetch).toBe(1)
    const u = new URL(h.fetchCalls[0].url)
    expect(u.origin).toBe('http://prom.example.com:9090')
    expect(u.pathname).toBe('/api/v1/query')
    expect(u.searchParams.get('query')).toBe('up')
    expect(u.searchParams.has('time')).toBe(false)
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('up{instance="localhost:9090",job="prometheus"} = 1 @ 2025-09-11T09:20:00.000Z')
    // The display command names the profile, the query, and the target URL.
    expect(value.command).toBe("prometheus prod query='up' @ http://prom.example.com:9090/api/v1/query")
  })

  it('time selects an instant query at that timestamp', async () => {
    const h = setup()
    await h.runProm({ cluster: 'prod', query: 'up', time: '2026-09-10T00:00:00Z' })
    const u = new URL(h.fetchCalls[0].url)
    expect(u.pathname).toBe('/api/v1/query')
    expect(u.searchParams.get('time')).toBe('2026-09-10T00:00:00Z')
  })

  it('unix-second times pass through verbatim', async () => {
    const h = setup()
    await h.runProm({ cluster: 'prod', query: 'up', time: '1757582400' })
    expect(new URL(h.fetchCalls[0].url).searchParams.get('time')).toBe('1757582400')
  })

  it('the PromQL query is URL-encoded (special chars survive the round trip)', async () => {
    const h = setup()
    const query = 'sum(rate(http_requests_total{job="a b",code=~"5.."}[5m])) > 0'
    await h.runProm({ cluster: 'prod', query })
    const u = new URL(h.fetchCalls[0].url)
    expect(u.searchParams.get('query')).toBe(query)
    expect(h.fetchCalls[0].url).not.toContain('"a b"')
  })

  it('scalar and string results format as value @ timestamp', async () => {
    const h = setup({
      fetchImpl: () => jsonResponse({ status: 'success', data: { resultType: 'scalar', result: [1757582400, '42.5'] } }),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'scalar(some_metric)' })
    expect(value.stdout).toBe('42.5 @ 2025-09-11T09:20:00.000Z')
  })

  it('an empty vector says so plainly', async () => {
    const h = setup({
      fetchImpl: () => jsonResponse({ status: 'success', data: { resultType: 'vector', result: [] } }),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'no_such_metric' })
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toContain('empty result')
  })
})

// ── Range query ──────────────────────────────────────────────────────────────

describe('range query', () => {
  const RANGE_BODY = {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{
        metric: { __name__: 'up', instance: 'a' },
        values: [[1757582400, '1'], [1757582415, '1'], [1757582430, '0']],
      }],
    },
  }

  it('start+end+step route to /api/v1/query_range with all params', async () => {
    const h = setup({ fetchImpl: () => jsonResponse(RANGE_BODY) })
    const value = await h.runProm({ cluster: 'prod', query: 'up', start: '1757582400', end: '1757582430', step: '15s' })
    const u = new URL(h.fetchCalls[0].url)
    expect(u.pathname).toBe('/api/v1/query_range')
    expect(u.searchParams.get('start')).toBe('1757582400')
    expect(u.searchParams.get('end')).toBe('1757582430')
    expect(u.searchParams.get('step')).toBe('15s')
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toContain('up{instance="a"} — 3 points')
    expect(value.stdout).toContain('2025-09-11T09:20:00.000Z  1')
    expect(value.stdout).toContain('2025-09-11T09:20:30.000Z  0')
    expect(value.command).toContain('/api/v1/query_range')
  })

  it('time + start/end/step is rejected before any resolve or fetch', async () => {
    const h = setup()
    const value = await h.runProm({ cluster: 'prod', query: 'up', time: 'now', start: '1', end: '2', step: '15s' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('mutually exclusive')
    expect(h.calls.resolve).toBe(0)
    expect(h.calls.fetch).toBe(0)
  })

  it('a partial range (start+end, no step) is rejected before any resolve or fetch', async () => {
    const h = setup()
    const value = await h.runProm({ cluster: 'prod', query: 'up', start: '1', end: '2' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('start, end and step')
    expect(h.calls.resolve).toBe(0)
  })

  it('a series with many points is evenly sampled and says so', async () => {
    const values = Array.from({ length: 500 }, (_, i) => [1757582400 + i * 15, String(i % 2)] as [number, string])
    const h = setup({
      fetchImpl: () => jsonResponse({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { __name__: 'up' }, values }] } }),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up', start: '1', end: '2', step: '15s' })
    expect(value.stdout).toContain('500 points, showing 50 evenly sampled')
    // first and last points survive the sampling
    expect(value.stdout).toContain('2025-09-11T09:20:00.000Z')
    expect(value.stdout).toContain(new Date((1757582400 + 499 * 15) * 1000).toISOString())
  })
})

// ── Token handling ───────────────────────────────────────────────────────────

describe('bearer token', () => {
  it('sends Authorization: Bearer with the token file content (trimmed), never echoing it', async () => {
    const tokenFile = writeTokenFile('super-secret-token-123\n')
    const h = setup({ tokenFile })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(h.fetchCalls[0].headers.authorization).toBe('Bearer super-secret-token-123')
    // The token appears NOWHERE in the result envelope.
    expect(JSON.stringify(value)).not.toContain('super-secret-token-123')
  })

  it('no token field → no Authorization header', async () => {
    const h = setup()
    await h.runProm({ cluster: 'prod', query: 'up' })
    expect(h.fetchCalls[0].headers.authorization).toBeUndefined()
  })

  it('an unreadable token file fails without leaking its path', async () => {
    const h = setup({ tokenFile: '/nonexistent/definitely-missing-token-file' })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('could not be read')
    expect(JSON.stringify(value)).not.toContain('/nonexistent')
    expect(h.calls.fetch).toBe(0)
  })

  it('even a server error body echoing the token is scrubbed from the result', async () => {
    const tokenFile = writeTokenFile('super-secret-token-123')
    const h = setup({
      tokenFile,
      fetchImpl: () => jsonResponse({ status: 'error', errorType: 'bad_data', error: 'weird backend echoed super-secret-token-123' }, 400),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(1)
    expect(value.stderr).toContain('<token>')
    expect(JSON.stringify(value)).not.toContain('super-secret-token-123')
  })
})

// ── Prometheus / HTTP / network failures ─────────────────────────────────────

describe('failure mapping', () => {
  it('status:error maps to exitCode 1 with errorType+error on stderr', async () => {
    const h = setup({
      fetchImpl: () => jsonResponse({ status: 'error', errorType: 'bad_data', error: 'invalid parameter "step": cannot parse "x"' }, 400),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up', start: '1', end: '2', step: 'x' })
    expect(value.exitCode).toBe(1)
    expect(value.stderr).toContain('bad_data')
    expect(value.stderr).toContain('cannot parse')
    expect(value.error).toBe(value.stderr)
  })

  it('a non-JSON HTTP error (proxy page) maps to exitCode -1 naming the HTTP status', async () => {
    const h = setup({ fetchImpl: () => textResponse('<html>Bad Gateway</html>', 502, 'Bad Gateway') })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('HTTP 502')
  })

  it('a connection failure maps to exitCode -1 naming the cause', async () => {
    const h = setup({
      fetchImpl: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 10.0.0.1:9090') })),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('connection to the Prometheus server failed')
    expect(value.error).toContain('ECONNREFUSED')
  })

  it('a timeout maps to exitCode -1 with a timeoutSec hint', async () => {
    const h = setup({
      fetchImpl: () => Promise.reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('timed out')
    expect(value.error).toContain('timeoutSec')
  })

  it('a caller abort maps to exitCode -1 saying so', async () => {
    const h = setup({
      fetchImpl: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('aborted')
  })

  it('a 200 without a prometheus envelope is called out (wrong service?)', async () => {
    const h = setup({ fetchImpl: () => textResponse('{"hello":"world"}', 200) })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('not a prometheus API envelope')
  })

  it('unknown profile: resolve error passes through, fetch untouched', async () => {
    const h = setup({
      resolveImpl: async () => { throw new Error('unknown prometheus profile "nope". Available: prod') },
    })
    const value = await h.runProm({ cluster: 'nope', query: 'up' })
    expect(value.error).toContain('unknown prometheus profile "nope"')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.fetch).toBe(0)
  })

  it('a "prometheus/" name prefix is passed to resolve (core strips it)', async () => {
    const seen: Array<[string, string]> = []
    const h = setup({
      resolveImpl: async (kind, name) => {
        seen.push([kind, name])
        // Emulate core's stripKindPrefix.
        expect(name.startsWith('prometheus/')).toBe(true)
        return DEFAULT_PROFILE
      },
    })
    const value = await h.runProm({ cluster: 'prometheus/prod', query: 'up' })
    expect(seen).toEqual([['prometheus', 'prometheus/prod']])
    expect(value.exitCode).toBe(0)
  })

  it('ops-access absent: clean error, fetch untouched', async () => {
    const h = setup({ withOpsAccess: false })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.error).toContain('ops-access service unavailable')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.fetch).toBe(0)
  })

  it('success warnings land on stderr', async () => {
    const h = setup({
      fetchImpl: () => jsonResponse({ status: 'success', data: { resultType: 'vector', result: [] }, warnings: ['query would exceed the sample limit'] }),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.exitCode).toBe(0)
    expect(value.stderr).toContain('warning: query would exceed the sample limit')
  })
})

// ── Size guards ──────────────────────────────────────────────────────────────

describe('size guards', () => {
  it('stdout beyond ~100KB is truncated with a note', async () => {
    // 100 series × 50 points with long label values ≫ 100KB.
    const result = Array.from({ length: 100 }, (_, i) => ({
      metric: { __name__: 'big_metric', pod: `pod-${i}-${'x'.repeat(100)}` },
      values: Array.from({ length: 50 }, (_, j) => [1757582400 + j * 15, '1'] as [number, string]),
    }))
    const h = setup({
      fetchImpl: () => jsonResponse({ status: 'success', data: { resultType: 'matrix', result } }),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'big_metric', start: '1', end: '2', step: '15s' })
    expect(value.exitCode).toBe(0)
    expect(value.stdout.length).toBeLessThan(110 * 1024)
    expect(value.stdout).toContain('truncated')
  })

  it('more than 100 series are omitted with a note', async () => {
    const result = Array.from({ length: 150 }, (_, i) => ({
      metric: { __name__: 'up', pod: `pod-${i}` },
      value: [1757582400, '1'] as [number, string],
    }))
    const h = setup({
      fetchImpl: () => jsonResponse({ status: 'success', data: { resultType: 'vector', result } }),
    })
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    expect(value.stdout).toContain('+50 more series omitted')
  })
})

// ── timeoutSec passthrough ───────────────────────────────────────────────────

describe('timeoutSec', () => {
  it('a valid timeoutSec is accepted; out-of-range values are ignored', async () => {
    const h = setup()
    const ok = await h.runProm({ cluster: 'prod', query: 'up', timeoutSec: 120 })
    expect(ok.exitCode).toBe(0)
    expect(h.fetchCalls[0].signal).toBeInstanceOf(AbortSignal)
    const ignored = await h.runProm({ cluster: 'prod', query: 'up', timeoutSec: 0 })
    expect(ignored.exitCode).toBe(0)
    const tooBig = await h.runProm({ cluster: 'prod', query: 'up', timeoutSec: 601 })
    expect(tooBig.exitCode).toBe(0)
  })
})

// ── Render ───────────────────────────────────────────────────────────────────

describe('render', () => {
  it('is a pure function of (args, value) and surfaces failure parts', async () => {
    const h = setup()
    const value = await h.runProm({ cluster: 'prod', query: 'up' })
    const a = h.renderProm({ cluster: 'prod', query: 'up' }, value)
    const b = h.renderProm({ cluster: 'prod', query: 'up' }, value)
    expect(a).toBe(b)
    expect(a).toContain("$ prometheus prod query='up' @ http://prom.example.com:9090/api/v1/query")
    expect(a).toContain('up{instance="localhost:9090"')
    const err = h.renderProm({}, { exitCode: 1, stdout: '', stderr: 'boom', command: 'prometheus x' })
    expect(err).toContain('[stderr]')
    expect(err).toContain('[exit code: 1]')
  })
})
