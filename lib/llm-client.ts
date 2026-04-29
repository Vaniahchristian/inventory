type Provider = {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  // ms to wait after a 429 before this provider is tried again
  rateLimitCooldownMs: number
}

export type LlmResult = {
  content: string
  provider: string
}

type CallOptions = {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
}

// Shared within the Node.js process — all concurrent batch requests see the same state.
// When a provider hits its rate limit we record when it becomes available again so
// subsequent requests skip it instead of hammering it and piling up 429s.
const providerAvailableAt: Record<string, number> = {}

// Groq's free tier resets every 60 seconds (RPM window).
// We add 3 seconds of margin so retries don't race the reset boundary.
const GROQ_RATE_LIMIT_COOLDOWN_MS = 63_000

function getProviders(): Provider[] {
  const providers: Provider[] = []

  if (process.env.LLM_API_KEY) {
    providers.push({
      name: 'openrouter/deepseek',
      baseUrl: (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL || 'deepseek/deepseek-chat-v3-0324',
      rateLimitCooldownMs: 5_000,
    })
  }

  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      rateLimitCooldownMs: GROQ_RATE_LIMIT_COOLDOWN_MS,
    })
  }

  return providers
}

export async function callLlm(
  messages: { role: 'system' | 'user'; content: string }[],
  opts: CallOptions = {}
): Promise<LlmResult | null> {
  const providers = getProviders()
  if (!providers.length) return null

  const timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 20000)
  const retries = opts.retries ?? Math.max(1, Number(process.env.LLM_RETRY_ATTEMPTS ?? 2))
  const retryDelayMs = opts.retryDelayMs ?? Math.max(250, Number(process.env.LLM_RETRY_DELAY_MS ?? 2000))

  for (const provider of providers) {
    // Skip providers that are still in their rate-limit cooldown window
    const availableAt = providerAvailableAt[provider.name] ?? 0
    if (availableAt > Date.now()) {
      const secsLeft = Math.ceil((availableAt - Date.now()) / 1000)
      console.log(`[llm-client] ${provider.name} cooling down (${secsLeft}s left), skipping`)
      continue
    }

    const result = await tryProvider(provider, messages, { timeoutMs, retries, retryDelayMs })
    if (result) return result
    console.log(`[llm-client] ${provider.name} failed, trying next provider`)
  }

  return null
}

async function tryProvider(
  provider: Provider,
  messages: { role: string; content: string }[],
  opts: { timeoutMs: number; retries: number; retryDelayMs: number }
): Promise<LlmResult | null> {
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)

    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          ...(process.env.LLM_REFERER ? { 'HTTP-Referer': process.env.LLM_REFERER } : {}),
          ...(process.env.LLM_APP_NAME ? { 'X-Title': process.env.LLM_APP_NAME } : {}),
        },
        body: JSON.stringify({ model: provider.model, temperature: 0, messages }),
        signal: controller.signal,
      })

      if (!res.ok) {
        // Hard failures — skip this provider, no retry
        if (res.status === 402 || res.status === 401) {
          console.log(`[llm-client] ${provider.name} rejected (${res.status}), skipping`)
          return null
        }

        if (res.status === 429) {
          // Use Retry-After if the provider sends it (Groq does), otherwise use the
          // configured cooldown. Open the circuit so all concurrent batch requests
          // skip this provider instead of piling up more 429s.
          const retryAfterSecs = Number(res.headers.get('retry-after') ?? 0)
          const cooldownMs = retryAfterSecs > 0
            ? retryAfterSecs * 1000 + 1000   // add 1s margin
            : provider.rateLimitCooldownMs
          providerAvailableAt[provider.name] = Date.now() + cooldownMs
          console.log(
            `[llm-client] ${provider.name} rate limited (429),` +
            ` circuit open for ${Math.ceil(cooldownMs / 1000)}s` +
            (retryAfterSecs > 0 ? ' (from Retry-After header)' : ' (default cooldown)')
          )
          return null
        }

        // 5xx — retry with backoff within this provider
        if (res.status >= 500 && attempt < opts.retries) {
          console.log(`[llm-client] ${provider.name} status ${res.status}, retry ${attempt}/${opts.retries}`)
          await sleep(opts.retryDelayMs * attempt)
          continue
        }

        console.log(`[llm-client] ${provider.name} status ${res.status}, giving up`)
        return null
      }

      const data = await res.json()
      const content = String(data?.choices?.[0]?.message?.content ?? '').trim()
      if (!content) return null

      // Successful response — clear any stale cooldown for this provider
      delete providerAvailableAt[provider.name]
      return { content, provider: provider.name }
    } catch (e: any) {
      const msg: string = e?.message ?? String(e)
      const isTransient =
        msg.toLowerCase().includes('fetch failed') ||
        msg.toLowerCase().includes('network') ||
        msg.toLowerCase().includes('etimedout') ||
        e?.name === 'AbortError'

      if (isTransient && attempt < opts.retries) {
        console.log(`[llm-client] ${provider.name} transient error, retry ${attempt}/${opts.retries}: ${msg}`)
        await sleep(opts.retryDelayMs * attempt)
        continue
      }
      console.log(`[llm-client] ${provider.name} exception: ${msg}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return null
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
