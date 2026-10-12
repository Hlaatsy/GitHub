import { type Logger } from '../lib/logger';
import { PaymentError } from './errors';

export interface HttpOptions {
  timeoutMs: number;
  logger: Logger;
  /** Retry once on a timeout, network error or 5xx. Only for idempotent calls. */
  retryTransient?: boolean;
}

export interface HttpResponse {
  status: number;
  text: string;
}

/**
 * Provider HTTP call with the same error mapping as the Ozow adapter:
 * timeouts and 5xx are transient (the caller answers 503 so the provider
 * redelivers); 4xx is returned to the caller to interpret.
 */
export async function providerRequest(url: string, init: RequestInit, options: HttpOptions): Promise<HttpResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new PaymentError(timedOut ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNAVAILABLE', timedOut ? `${new URL(url).host} did not respond within ${options.timeoutMs} ms` : `Could not reach ${new URL(url).host}`, {
          cause: error,
        });
      }
      if (response.status >= 500) {
        throw new PaymentError('GATEWAY_UNAVAILABLE', `${new URL(url).host} responded with HTTP ${response.status}`);
      }
      return { status: response.status, text: await response.text() };
    } catch (error) {
      if (!options.retryTransient || !(error instanceof PaymentError) || !error.transient || attempt >= 1) throw error;
      options.logger.warn({ host: new URL(url).host, code: error.code }, 'payment provider call failed; retrying');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Never send a customer to a checkout host we did not expect. */
export function assertCheckoutHost(value: string, allowedHost: RegExp, provider: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentError('GATEWAY_REJECTED', `${provider} returned an invalid checkout URL`);
  }
  if (url.protocol !== 'https:' || !allowedHost.test(url.hostname) || url.username || url.password) {
    throw new PaymentError('GATEWAY_REJECTED', `Unexpected ${provider} checkout host ${url.hostname}`);
  }
  return url.toString();
}

/** Ordered key/value pairs from a form body; repeated keys are refused (parameter pollution). */
export function parseFormPairs(rawBody: Buffer, contentType: string | undefined): Array<[string, string]> {
  const type = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new PaymentError('PAYLOAD_INVALID', `Unsupported content type ${type || '(none)'}`);
  }
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(rawBody.toString('utf8'))) {
    if (seen.has(key)) throw new PaymentError('PAYLOAD_INVALID', `Duplicate field ${key}`);
    seen.add(key);
    pairs.push([key, value]);
  }
  return pairs;
}
