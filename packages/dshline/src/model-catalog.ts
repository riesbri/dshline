/**
 * The one native model-catalog read.
 *
 * Two surfaces ask the same question of `ctx.llm` — which exact routes exist
 * right now — and then project the answer differently: `/model` shows the
 * current Agent's choices, and the subagent authorization editor shows
 * candidates for a Host setting. Neither projection is allowed to become a
 * second source of truth, so the read itself lives here once.
 *
 * Route catalogs are independent, so every provider read begins before any is
 * awaited. `Promise.all` over the mapped array keeps `listProviders()` order no
 * matter which adapter settles first, and a provider whose listing fails is
 * recorded rather than silently dropped: an unreachable route must not hide the
 * ones that work. A failure here is ADVISORY — it says what the live catalog
 * could not answer, and never authorizes or deauthorizes anything. The Host
 * setting is the only authorization authority.
 * @module dshline/model-catalog
 */

import type { Context } from '@deepseek-ai/cordis'

/** One route a mounted adapter currently advertises. */
export interface ModelCatalogRoute {
  /** Provider ROUTE key, the value `listModels` and `GenerateOptions.provider` take. */
  readonly provider: string
  /** Provider display name, for a label a person reads. */
  readonly providerName: string
  /** Provider-owned model id. */
  readonly model: string
  /** Provider-owned display name, which may equal the id. */
  readonly modelName: string
}

/** What one catalog read found, and which provider routes it could not reach. */
export interface ModelCatalogReading {
  /** Every advertised route, in `listProviders()` order. */
  readonly routes: ModelCatalogRoute[]
  /** Route keys whose listing failed, in `listProviders()` order. */
  readonly failedProviders: string[]
}

/**
 * Stable identity for one exact `provider/model` route.
 *
 * The NUL separator cannot appear in a provider or model id, so two different
 * routes never collide. The result is OPAQUE: it is a Map/Set key and is never
 * parsed back into a route — the route object is always kept beside it.
 * @param provider - provider route key.
 * @param model - provider-owned model id.
 * @returns the opaque identity key.
 */
export function modelRouteKey(provider: string, model: string): string {
  return `${provider}\0${model}`
}

/**
 * Every model the mounted adapters currently advertise.
 *
 * `listProviders()` returns `{ id, name }` where **`id`** is the route key
 * `listModels` takes, and `name` is a label for humans. Every read begins
 * before any is awaited, and a failed route is recorded in
 * {@link ModelCatalogReading.failedProviders} rather than rejecting the whole
 * catalog.
 * @param ctx - context carrying the llm registry.
 * @returns the advertised routes in provider order, and the routes that failed.
 */
export async function readModelCatalog(ctx: Context): Promise<ModelCatalogReading> {
  const routes: ModelCatalogRoute[] = []
  const failedProviders: string[] = []
  const catalogs = await Promise.all(ctx.llm.listProviders().map(async provider => {
    try {
      return { provider, models: await ctx.llm.listModels(provider.id) }
    } catch {
      return { provider, models: undefined }
    }
  }))
  for (const { provider, models } of catalogs) {
    if (models === undefined) {
      failedProviders.push(provider.id)
      continue
    }
    for (const model of models) {
      routes.push({
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name,
      })
    }
  }
  return { routes, failedProviders }
}
