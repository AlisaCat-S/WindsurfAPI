/**
 * Dashboard API route handlers.
 * All routes are under /dashboard/api/*.
 */

import { config } from '../config.js';
import {
  getAccountList, getAccountCount, addAccountByKey, addAccountByToken,
  removeAccount, setAccountStatus, resetAccountErrors, updateAccountLabel,
  isAuthenticated,
} from '../auth.js';
import { getLsStatus, stopLanguageServer, startLanguageServer, isLanguageServerRunning } from '../langserver.js';
import { getStats, resetStats, recordRequest } from './stats.js';
import { getLogs, subscribeToLogs, unsubscribeFromLogs } from './logger.js';
import { getProxyConfig, setGlobalProxy, setAccountProxy, removeProxy } from './proxy-config.js';

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Password',
  });
  res.end(data);
}

function checkAuth(req) {
  const pw = req.headers['x-dashboard-password'] || '';
  // If dashboard password is set, use it
  if (config.dashboardPassword) return pw === config.dashboardPassword;
  // Otherwise fall back to API key (if set)
  if (config.apiKey) return pw === config.apiKey;
  // No password and no API key = open access
  return true;
}

/**
 * Handle all /dashboard/api/* requests.
 */
export async function handleDashboardApi(method, subpath, body, req, res) {
  if (method === 'OPTIONS') return json(res, 204, '');

  // Auth check (except for auth verification endpoint)
  if (subpath !== '/auth' && !checkAuth(req)) {
    return json(res, 401, { error: 'Unauthorized. Set X-Dashboard-Password header.' });
  }

  // ─── Auth ─────────────────────────────────────────────
  if (subpath === '/auth') {
    const needsAuth = !!(config.dashboardPassword || config.apiKey);
    if (!needsAuth) return json(res, 200, { required: false });
    return json(res, 200, { required: true, valid: checkAuth(req) });
  }

  // ─── Overview ─────────────────────────────────────────
  if (subpath === '/overview' && method === 'GET') {
    const stats = getStats();
    return json(res, 200, {
      uptime: process.uptime(),
      startedAt: stats.startedAt,
      accounts: getAccountCount(),
      authenticated: isAuthenticated(),
      langServer: getLsStatus(),
      totalRequests: stats.totalRequests,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      successRate: stats.totalRequests > 0
        ? ((stats.successCount / stats.totalRequests) * 100).toFixed(1)
        : '0.0',
    });
  }

  // ─── Accounts ─────────────────────────────────────────
  if (subpath === '/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  if (subpath === '/accounts' && method === 'POST') {
    try {
      let account;
      if (body.api_key) {
        account = addAccountByKey(body.api_key, body.label);
      } else if (body.token) {
        account = await addAccountByToken(body.token, body.label);
      } else {
        return json(res, 400, { error: 'Provide api_key or token' });
      }
      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // PATCH /accounts/:id
  const accountPatch = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountPatch && method === 'PATCH') {
    const id = accountPatch[1];
    if (body.status) setAccountStatus(id, body.status);
    if (body.label) updateAccountLabel(id, body.label);
    if (body.resetErrors) resetAccountErrors(id);
    return json(res, 200, { success: true });
  }

  // DELETE /accounts/:id
  const accountDel = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountDel && method === 'DELETE') {
    const ok = removeAccount(accountDel[1]);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  // ─── Stats ────────────────────────────────────────────
  if (subpath === '/stats' && method === 'GET') {
    return json(res, 200, getStats());
  }

  if (subpath === '/stats' && method === 'DELETE') {
    resetStats();
    return json(res, 200, { success: true });
  }

  // ─── Logs ─────────────────────────────────────────────
  if (subpath === '/logs' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const level = url.searchParams.get('level') || null;
    return json(res, 200, { logs: getLogs(since, level) });
  }

  if (subpath === '/logs/stream' && method === 'GET') {
    req.socket.setKeepAlive(true);
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Send existing logs first
    const existing = getLogs();
    for (const entry of existing.slice(-50)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);

    const cb = (entry) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    subscribeToLogs(cb);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeFromLogs(cb);
    });
    return;
  }

  // ─── Proxy ────────────────────────────────────────────
  if (subpath === '/proxy' && method === 'GET') {
    return json(res, 200, getProxyConfig());
  }

  if (subpath === '/proxy/global' && method === 'PUT') {
    setGlobalProxy(body);
    return json(res, 200, { success: true, config: getProxyConfig() });
  }

  if (subpath === '/proxy/global' && method === 'DELETE') {
    removeProxy('global');
    return json(res, 200, { success: true });
  }

  const proxyAccount = subpath.match(/^\/proxy\/accounts\/([^/]+)$/);
  if (proxyAccount && method === 'PUT') {
    setAccountProxy(proxyAccount[1], body);
    return json(res, 200, { success: true });
  }
  if (proxyAccount && method === 'DELETE') {
    removeProxy('account', proxyAccount[1]);
    return json(res, 200, { success: true });
  }

  // ─── Config ───────────────────────────────────────────
  if (subpath === '/config' && method === 'GET') {
    return json(res, 200, {
      port: config.port,
      defaultModel: config.defaultModel,
      maxTokens: config.maxTokens,
      logLevel: config.logLevel,
      lsBinaryPath: config.lsBinaryPath,
      lsPort: config.lsPort,
      codeiumApiUrl: config.codeiumApiUrl,
      hasApiKey: !!config.apiKey,
      hasDashboardPassword: !!config.dashboardPassword,
    });
  }

  // ─── Language Server ──────────────────────────────────
  if (subpath === '/langserver/restart' && method === 'POST') {
    if (!body.confirm) {
      return json(res, 400, { error: 'Send { confirm: true } to restart language server' });
    }
    stopLanguageServer();
    setTimeout(async () => {
      await startLanguageServer({
        binaryPath: config.lsBinaryPath,
        port: config.lsPort,
        apiServerUrl: config.codeiumApiUrl,
      });
    }, 2000);
    return json(res, 200, { success: true, message: 'Restarting language server...' });
  }

  json(res, 404, { error: `Dashboard API: ${method} ${subpath} not found` });
}
