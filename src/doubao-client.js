import { getDoubaoAuth } from './doubao-auth.js';
import { doubaoConfig, doubaoRequestParams } from './doubao-config.js';

const ORIGIN = 'https://www.doubao.com';
const upstreamError = (message, code, status = 502) => Object.assign(new Error(message), {
  code, status, type: status === 401 ? 'authentication_error' : 'upstream_error',
});

export function createDoubaoClient({ cfg = doubaoConfig, loadAuth = getDoubaoAuth,
  fetchImpl = (...args) => fetch(...args), getParams = doubaoRequestParams } = {}) {
  const getAuth = () => loadAuth(cfg);
  async function exchange(path, body, signal) {
    signal?.throwIfAborted();
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !path.startsWith('/')) throw new Error('豆包请求路径无效');
    url.search = new URLSearchParams(getParams(cfg));
    const auth = await getAuth();
    if (!auth) throw upstreamError('豆包登录未配置或已过期，请刷新本机豆包授权', 'doubao_auth_missing', 401);
    const cookie = auth.cookieHeader(url);
    if (!cookie) throw upstreamError('豆包未提供有效登录会话，请刷新本机豆包授权', 'doubao_auth_missing', 401);
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { cookie, 'content-type': 'application/json', 'Agw-Js-Conv': 'str',
          origin: ORIGIN, referer: ORIGIN + '/',
          'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/${cfg.clientVersion || '2.34.6'}` },
        body: JSON.stringify(body),
      });
    } catch {
      combined.throwIfAborted();
      throw upstreamError('无法连接豆包上游，请稍后重试', 'doubao_network');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status === 401 || response.status === 403 ? 401 : 502;
      throw upstreamError(`豆包上游请求失败（HTTP ${response.status}）`, 'doubao_http', status);
    }
    return { response, signal: combined };
  }
  async function request(path, body = {}, options = {}) {
    const { response } = await exchange(path, body, options.signal);
    let result;
    try { result = await response.json(); }
    catch { throw upstreamError('豆包接口未返回有效 JSON', 'doubao_invalid_response'); }
    if (!result || typeof result !== 'object' || (result.code !== 0 && result.code !== '0')) {
      const rawCode = result?.code;
      const code = (typeof rawCode === 'number' || typeof rawCode === 'string') && /^-?\d{1,16}$/.test(String(rawCode))
        ? String(rawCode) : 'unknown';
      throw upstreamError(`豆包接口返回错误（code ${code}）`, 'doubao_api_error');
    }
    return result.data;
  }
  return { getAuth, request, openStream: exchange };
}
