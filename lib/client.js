/**
 * lib/client.js —— notice-hub HTTP 客户端。
 *
 * 契约：docs/notice-hub-插件化与日程适配方案.md §6（lib/client.js）：
 *   - 鉴权仅经 `X-Token` 请求头（token 可空）；**绝不**放进 URL、日志或错误文案；
 *   - 失败重试 3 次，退避 2s / 4s / 8s；
 *   - 错误分类为中文可操作文案（unreachable / timeout / auth / not-found / server / bad-json / http）。
 *
 * fetchImpl 由宿主 `context.network.fetch` 注入（生产）或测试注入；
 * sleep 注入仅用于测试退避序列。
 */

'use strict';

const RETRY_DELAYS_MS = [2000, 4000, 8000]; // 重试 3 次，退避 2s/4s/8s
const DEFAULT_TIMEOUT_MS = 10_000;

/** 稳定错误码 → 中文可操作文案。message 永不含 token。 */
function classifyFailure(kind, detail) {
  switch (kind) {
    case 'unreachable':
      return {
        code: 'unreachable',
        retryable: true,
        message: `无法连接群务台（${detail.baseUrl}）：请确认群务台已启动，并检查地址与端口是否正确。`,
      };
    case 'timeout':
      return {
        code: 'timeout',
        retryable: true,
        message: `请求群务台超时（${Math.round((detail.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)} 秒）：群务台可能繁忙或卡住，请稍后重试或重启群务台。`,
      };
    case 'auth':
      return {
        code: 'auth',
        retryable: false,
        message: `群务台鉴权失败（HTTP ${detail.status}）：请核对访问令牌是否与群务台的 QQ_DIGEST_WEB_TOKEN 一致；若群务台未设令牌，请把令牌留空并在本机使用。`,
      };
    case 'not-found':
      return {
        code: 'not-found',
        retryable: false,
        message: `群务台接口不存在（HTTP ${detail.status}，${detail.path}）：请确认群务台版本支持该接口，或将插件切换到日历订阅（.ics）兜底。`,
      };
    case 'server':
      return {
        code: 'server',
        retryable: true,
        message: `群务台服务异常（HTTP ${detail.status}）：请查看群务台日志排查后端故障，稍后重试。`,
      };
    case 'bad-json':
      return {
        code: 'bad-json',
        retryable: false,
        message: `群务台返回的数据无法解析为 JSON：请确认地址指向群务台服务（${detail.baseUrl}），本次将尝试日历订阅（.ics）兜底。`,
      };
    default:
      return {
        code: 'http',
        retryable: false,
        message: `群务台请求失败（HTTP ${detail.status}）：请稍后重试；若持续失败请查看群务台日志。`,
      };
  }
}

/** 把底层异常归类（网络类 / 超时类 / HTTP 状态类 / JSON 解析类）。 */
function classifyError(error, detail = {}) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.noticeHubClassified) {
    return error;
  }
  const status = detail.status;
  const base = detail.baseUrl || '';
  let failure;
  if (detail.kind === 'bad-json') {
    failure = classifyFailure('bad-json', detail);
  } else if (typeof status === 'number') {
    if (status === 401 || status === 403) failure = classifyFailure('auth', detail);
    else if (status === 404) failure = classifyFailure('not-found', detail);
    else if (status >= 500) failure = classifyFailure('server', detail);
    else failure = classifyFailure('http', detail);
  } else {
    const name = String((error && error.name) || '');
    const raw = String((error && error.message) || error || '');
    if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|abort/i.test(raw)) {
      failure = classifyFailure('timeout', detail);
    } else {
      // fetch 失败（拒绝连接、DNS、socket 错误等）统一按不可达处理。
      failure = classifyFailure('unreachable', { ...detail, baseUrl: base });
    }
  }
  const err = new Error(failure.message);
  err.code = failure.code;
  err.retryable = failure.retryable;
  err.noticeHubClassified = true;
  err.cause = error;
  return err;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 创建客户端。
 * @param {object} options
 * @param {string} options.baseUrl 服务根地址（http(s)://）
 * @param {string} [options.token] QQ_DIGEST_WEB_TOKEN，可空
 * @param {(url: string, init?: object) => Promise<Response>} options.fetchImpl 宿主 network.fetch
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试注入
 * @param {number} [options.timeoutMs]
 */
function createClient(options) {
  const { fetchImpl, sleep = defaultSleep, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (typeof fetchImpl !== 'function') throw new Error('notice-hub client 需要 fetchImpl（宿主 context.network.fetch）。');
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const token = typeof options.token === 'string' ? options.token : '';

  /** 带重试的 GET。返回解析后的 JSON（json 模式）或文本（text 模式）。 */
  async function request(path, { mode = 'json', signal } = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {};
    // token 只经 X-Token 头传输；为空时不发该头（空 token 仅环回部署可用）。
    if (token) headers['X-Token'] = token;

    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const init = { method: 'GET', headers, redirect: 'manual' };
      if (signal) init.signal = signal;
      else if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);

      let response;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        lastError = classifyError(error, { baseUrl, path, timeoutMs });
        if (lastError.retryable && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw lastError;
      }

      if (!response || typeof response.status !== 'number') {
        lastError = classifyError(new Error('invalid response'), { baseUrl, path });
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        lastError = classifyError(new Error(`HTTP ${response.status}`), { baseUrl, path, status: response.status, timeoutMs });
        if (lastError.retryable && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw lastError;
      }

      if (mode === 'text') {
        try {
          return await response.text();
        } catch (error) {
          lastError = classifyError(error, { baseUrl, path, timeoutMs });
          if (lastError.retryable && attempt < RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[attempt]);
            continue;
          }
          throw lastError;
        }
      }

      let text;
      try {
        text = await response.text();
      } catch (error) {
        lastError = classifyError(error, { baseUrl, path, timeoutMs });
        if (lastError.retryable && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw lastError;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        // JSON 解析失败不重试（重试也无意义），交给上层走 ICS 兜底。
        throw classifyError(error, { baseUrl, path, status: undefined, json: true, kind: 'bad-json' }) || error;
      }
    }
    throw lastError || classifyError(new Error('unreachable'), { baseUrl, path });
  }

  return {
    baseUrl,
    /** GET /api/tasks → {stats, candidates[], today[], week[], later[], done[], pinned[]} */
    fetchTasks: (opts = {}) => request('/api/tasks', opts),
    /** GET /api/notices → {items:[{id,kind,created_at,summary,body}]} */
    fetchNotices: (opts = {}) => request('/api/notices', opts),
    /** GET /calendar.ics → ICS 文本 */
    fetchIcs: (opts = {}) => request('/calendar.ics', { ...opts, mode: 'text' }),
  };
}

module.exports = {
  RETRY_DELAYS_MS,
  DEFAULT_TIMEOUT_MS,
  createClient,
  classifyError,
};
