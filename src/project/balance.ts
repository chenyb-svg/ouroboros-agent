// =============================================================================
// Account balance — reads the configured model provider's /user/balance endpoint
// (DeepSeek: GET {baseUrl}/user/balance with a Bearer key). Amounts come back as
// STRINGS from balance_infos; we prefer the CNY entry, else the first one.
//
// Extracted as a standalone function so tests can mock fetch without booting an
// engine; engine.ts's `balance` serve case is a thin wrapper around it.
// =============================================================================

export interface BalanceResult {
  balance?: string;
  currency?: string;
  grantedBalance?: string;
  toppedUpBalance?: string;
  isAvailable?: boolean;
  error?: string;
}

export interface FetchBalanceOptions {
  baseUrl: string;
  apiKey?: string;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export async function fetchBalance(opts: FetchBalanceOptions): Promise<BalanceResult> {
  const { baseUrl, apiKey } = opts;
  if (!apiKey) return { error: "未配置 DEEPSEEK_API_KEY（请在 .env 设置后重启应用）" };
  try {
    const f = opts.fetchImpl ?? fetch;
    const resp = await f(`${baseUrl.replace(/\/+$/, "")}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { error: `余额接口返回 HTTP ${resp.status}` };
    const json = (await resp.json()) as any;
    const infos: any[] = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
    const info = infos.find((i: any) => i?.currency === "CNY") ?? infos[0];
    return {
      balance: info?.total_balance,
      currency: info?.currency,
      grantedBalance: info?.granted_balance,
      toppedUpBalance: info?.topped_up_balance,
      isAvailable: !!json?.is_available,
      error: infos.length === 0 ? "余额接口未返回 balance_infos" : undefined,
    };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" ? "余额请求超时" : `余额请求失败: ${e?.message ?? e}`;
    return { error: msg };
  }
}
