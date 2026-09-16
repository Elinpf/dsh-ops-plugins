/**
 * Minimal HTTP client for the hub's `/cases` routes. Bearer-token auth,
 * JSON in/out, errors surface as thrown Errors with the hub's message.
 *
 * @module @elinpf/dsh-ops-knowledge/client
 */

import type { CaseIndexRow, CaseInput, CaseRecord } from './types.js'

export class KnowledgeClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(opts: { baseUrl: string; token: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      throw new Error(`hub unreachable: ${(err as Error).message}`)
    }
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`hub returned non-JSON (HTTP ${res.status})`)
    }
    if (!res.ok) {
      const message = (parsed as { error?: string }).error ?? `HTTP ${res.status}`
      throw new Error(`hub: ${message}`)
    }
    return parsed as T
  }

  listCases(): Promise<CaseIndexRow[]> {
    return this.request('GET', '/cases')
  }

  getCase(id: string): Promise<CaseRecord> {
    return this.request('GET', `/cases/${encodeURIComponent(id)}`)
  }

  /** Create (no id) or update (id given) a case. Returns the case id. */
  async putCase(input: CaseInput, id?: string): Promise<string> {
    if (id === undefined) {
      const res = await this.request<{ id: string }>('POST', '/cases', input)
      return res.id
    }
    await this.request('PUT', `/cases/${encodeURIComponent(id)}`, input)
    return id
  }

  hit(id: string): Promise<void> {
    return this.request('POST', `/cases/${encodeURIComponent(id)}/hit`)
  }
}
