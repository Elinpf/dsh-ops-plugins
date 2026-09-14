/**
 * HTTP API for the hub, built on bare `node:http` (no framework by design).
 *
 * Endpoints (default bind `127.0.0.1:3090`):
 *
 * - `GET /health`                        → `{ok:true}`, no auth
 * - `GET /`                              → the static web UI, no auth (it holds no secrets)
 * - `GET /entries`                       → `[{kind,name,envelope,tiers:{ro?:{probe?},rw?:{probe?}},updatedAt}]`
 *                                          (read+; field values never appear here)
 * - `GET /entries/:kind/:name/:tier`     → `{kind,name,tier,fields,envelope,probe?}` (read+; audited as `resolve`)
 * - `PUT /entries/:kind/:name/:tier`     → upsert, body `{fields,envelope?,probe?}` (admin)
 * - `DELETE /entries/:kind/:name/:tier`  → `{ok:true}` / 404 (admin; last tier removes the entry)
 * - `GET /audit?limit=N`                 → recent N audit records (admin, default 100)
 * - `POST /requests`                     → queue a tier-registration request, body
 *                                          `{kind,name,tier,fields,envelope?,reason?}` (admin)
 * - `GET /requests?status=pending`       → request list, metadata only — field
 *                                          names + byte sizes, never values (read+)
 * - `GET /requests/:id`                  → full request incl. field values, for
 *                                          pre-approval review (admin)
 * - `POST /requests/:id/decide`          → `{approved:boolean}`; approval writes the
 *                                          tier, either way the request's fields are
 *                                          wiped (admin; 409 unless pending)
 *
 * Auth: two Bearer tokens — admin (everything) and read (`GET /entries*`
 * only). Comparisons use `crypto.timingSafeEqual`. Every error response is
 * JSON `{ok:false,error}` and `error` never contains field values.
 *
 * @module
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { EntryEnvelope, HubStore, ProbeState, TierName } from './store.js'
import { NAME_PATTERN } from './store.js'
import { WEB_UI_HTML } from './web.js'

export { NAME_PATTERN }

const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface HubServerOptions {
  store: HubStore
  adminToken: string
  readToken: string
}

type Role = 'admin' | 'read'

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function tokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function roleOf(req: IncomingMessage, opts: HubServerOptions): Role | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  if (tokenEqual(token, opts.adminToken)) return 'admin'
  if (tokenEqual(token, opts.readToken)) return 'read'
  return null
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new HttpError(400, 'request body must be a JSON object')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, 'request body must be a JSON object')
  return parsed
}

/** Keep only the three known envelope keys, and only when they are strings. */
function sanitizeEnvelope(raw: unknown): EntryEnvelope {
  if (!isPlainObject(raw)) throw new HttpError(400, 'envelope must be a JSON object')
  const out: EntryEnvelope = {}
  if (typeof raw.name === 'string') out.name = raw.name
  if (typeof raw.description === 'string') out.description = raw.description
  if (typeof raw.environment === 'string') out.environment = raw.environment
  return out
}

function sanitizeProbe(raw: unknown): ProbeState {
  if (!isPlainObject(raw)) throw new HttpError(400, 'probe must be a JSON object')
  const { status, detail, probedAt } = raw
  if (status !== 'verified' && status !== 'mismatch' && status !== 'unverifiable') {
    throw new HttpError(400, "probe.status must be 'verified', 'mismatch' or 'unverifiable'")
  }
  if (typeof probedAt !== 'string') throw new HttpError(400, 'probe.probedAt must be a string')
  if (detail !== undefined && typeof detail !== 'string') throw new HttpError(400, 'probe.detail must be a string')
  const out: ProbeState = { status, probedAt }
  if (typeof detail === 'string') out.detail = detail
  return out
}

/** Strip a path segment to a validated kind/name, or throw 400. */
function segment(raw: string, what: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, `invalid ${what}`)
  }
  if (!NAME_PATTERN.test(decoded)) throw new HttpError(400, `invalid ${what}: must match ${NAME_PATTERN.source}`)
  return decoded
}

function tierOf(raw: string): TierName {
  if (raw === 'ro' || raw === 'rw') return raw
  throw new HttpError(400, "tier must be 'ro' or 'rw'")
}

export function createHubServer(opts: HubServerOptions): Server {
  const { store } = opts

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // Unauthenticated surface: health probe and the static UI shell.
    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true })
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(WEB_UI_HTML)
      return
    }

    const role = roleOf(req, opts)
    if (!role) throw new HttpError(401, 'missing or invalid bearer token')

    if (method === 'GET' && path === '/entries') {
      // Listing never exposes field values — tiers carry only probe state.
      const list = store.list().map((e) => ({
        kind: e.kind,
        name: e.name,
        envelope: e.envelope,
        tiers: {
          ...(e.tiers.ro ? { ro: { ...(e.tiers.ro.probe ? { probe: e.tiers.ro.probe } : {}) } } : {}),
          ...(e.tiers.rw ? { rw: { ...(e.tiers.rw.probe ? { probe: e.tiers.rw.probe } : {}) } } : {}),
        },
        updatedAt: e.updatedAt,
      }))
      return send(res, 200, list)
    }

    if (method === 'GET' && path === '/audit') {
      if (role !== 'admin') throw new HttpError(403, 'read token cannot access admin endpoints')
      const raw = url.searchParams.get('limit')
      let limit = 100
      if (raw !== null) {
        limit = Number.parseInt(raw, 10)
        if (!Number.isFinite(limit) || limit < 1) throw new HttpError(400, 'limit must be a positive integer')
        limit = Math.min(limit, 1000)
      }
      return send(res, 200, await store.readAudit(limit))
    }

    const parts = path.split('/').filter((p) => p !== '')

    if (parts[0] === 'requests' && parts.length === 1) {
      if (method === 'GET') {
        // Metadata only — the reviewer fetches values per request (admin).
        const raw = url.searchParams.get('status')
        if (raw !== null && raw !== 'pending' && raw !== 'approved' && raw !== 'rejected') {
          throw new HttpError(400, "status must be 'pending', 'approved' or 'rejected'")
        }
        const list = store.listRequests(raw ?? undefined).map((r) => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          tier: r.tier,
          envelope: r.envelope,
          ...(r.reason !== undefined ? { reason: r.reason } : {}),
          status: r.status,
          createdAt: r.createdAt,
          ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
          fields: Object.fromEntries(
            Object.entries(r.fields).map(([k, v]) => [k, typeof v === 'string' ? v.length : JSON.stringify(v).length]),
          ),
        }))
        return send(res, 200, list)
      }

      if (role !== 'admin') throw new HttpError(403, 'read token cannot access admin endpoints')

      if (method === 'POST') {
        const body = await readBody(req)
        const kind = segment(String(body.kind ?? ''), 'kind')
        const name = segment(String(body.name ?? ''), 'name')
        const tier = tierOf(String(body.tier ?? ''))
        if (!isPlainObject(body.fields)) throw new HttpError(400, 'fields must be a JSON object')
        const envelope = body.envelope === undefined ? {} : sanitizeEnvelope(body.envelope)
        if (body.reason !== undefined && typeof body.reason !== 'string') throw new HttpError(400, 'reason must be a string')
        const request = store.putRequest({ kind, name, tier, fields: body.fields, envelope, reason: body.reason as string | undefined })
        await store.save()
        await store.audit(role, 'request', kind, name, tier)
        return send(res, 200, { ok: true, id: request.id })
      }

      throw new HttpError(405, 'method not allowed')
    }

    if (parts[0] === 'requests' && parts.length === 2 && method === 'GET') {
      // Full field values for pre-approval review — admin only.
      if (role !== 'admin') throw new HttpError(403, 'read token cannot review request contents')
      const request = store.getRequest(parts[1])
      if (!request) throw new HttpError(404, 'request not found')
      return send(res, 200, request)
    }

    if (parts[0] === 'requests' && parts.length === 3 && parts[2] === 'decide') {
      if (role !== 'admin') throw new HttpError(403, 'read token cannot access admin endpoints')
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      const body = await readBody(req)
      if (typeof body.approved !== 'boolean') throw new HttpError(400, 'approved must be a boolean')
      const request = store.decideRequest(parts[1], body.approved)
      if (!request) {
        const existing = store.getRequest(parts[1])
        throw existing
          ? new HttpError(409, `request already ${existing.status}`)
          : new HttpError(404, 'request not found')
      }
      await store.save()
      await store.audit(role, body.approved ? 'approve' : 'reject', request.kind, request.name, request.tier)
      return send(res, 200, { ok: true })
    }

    if (parts[0] === 'entries' && parts.length === 4) {
      const kind = segment(parts[1], 'kind')
      const name = segment(parts[2], 'name')
      const tier = tierOf(parts[3])

      if (method === 'GET') {
        const entry = store.getEntry(kind, name)
        const tierData = entry?.tiers[tier]
        if (!entry || !tierData) throw new HttpError(404, 'entry not found')
        await store.audit(role, 'resolve', kind, name, tier)
        return send(res, 200, {
          kind,
          name,
          tier,
          fields: tierData.fields,
          envelope: entry.envelope,
          ...(tierData.probe ? { probe: tierData.probe } : {}),
        })
      }

      if (role !== 'admin') throw new HttpError(403, 'read token cannot access admin endpoints')

      if (method === 'PUT') {
        const body = await readBody(req)
        if (!isPlainObject(body.fields)) throw new HttpError(400, 'fields must be a JSON object')
        const envelope = body.envelope === undefined ? undefined : sanitizeEnvelope(body.envelope)
        const probe = body.probe === undefined ? undefined : sanitizeProbe(body.probe)
        store.putTier(kind, name, tier, { fields: body.fields, envelope, probe })
        await store.save()
        await store.audit(role, 'put', kind, name, tier)
        return send(res, 200, { ok: true })
      }

      if (method === 'DELETE') {
        if (!store.deleteTier(kind, name, tier)) throw new HttpError(404, 'entry not found')
        await store.save()
        await store.audit(role, 'delete', kind, name, tier)
        return send(res, 200, { ok: true })
      }

      throw new HttpError(405, 'method not allowed')
    }

    throw new HttpError(404, 'not found')
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message })
      // Deliberately generic: internal details (paths, key material) stay out of responses.
      send(res, 500, { ok: false, error: 'internal error' })
    })
  })
}
