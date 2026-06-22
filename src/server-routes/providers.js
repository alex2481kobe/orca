// Provider profiles API route group (/api/providers/*) extracted from
// server.js. ctx-threaded. Self-contained: always responds.

// Provider CONFIG metadata (where the endpoint points + which env var/secret it
// reads) is host-level info, not workflow data. Operator/paired clients get a
// whitelist view: enough status to act, none of the workstation-specific
// command, URL, environment, or secret reference details.
const OPERATOR_PROVIDER_FIELDS = [
  'id',
  'displayName',
  'kind',
  'enabled',
  'installPolicy',
  'updatePolicy',
];
const OPERATOR_PROVIDER_HEALTH_FIELDS = [
  'providerId',
  'kind',
  'status',
  'enabled',
  'installPolicy',
  'updatePolicy',
  'dryRunOnly',
  'networkProbe',
];

function pickFields(source, fields) {
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

function credentialPresence(credential) {
  if (!credential || typeof credential !== 'object') return undefined;
  return { present: Boolean(credential.present) };
}

function redactProviderForOperator(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const out = pickFields(profile, OPERATOR_PROVIDER_FIELDS);
  const credential = credentialPresence(profile.credential);
  if (credential) out.credential = credential;
  return out;
}

function redactProviderListForOperator(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    schemaVersion: result.schemaVersion,
    generatedAt: result.generatedAt,
    profiles: Array.isArray(result.profiles) ? result.profiles.map(redactProviderForOperator) : [],
  };
}

function redactProviderHealthForOperator(health) {
  if (!health || typeof health !== 'object') return health;
  const out = pickFields(health, OPERATOR_PROVIDER_HEALTH_FIELDS);
  const credential = credentialPresence(health.credential);
  if (credential) out.credential = credential;
  return out;
}

export async function handleProvidersApi(ctx, req, res, method, parts) {
  const { providerProfiles, sendJson, sendBodyError, parseJsonBody, rejectSpoofedActor, requireAdminAuth, hasAdminAuth } = ctx;
  const isAdmin = typeof hasAdminAuth === 'function' && hasAdminAuth(req);
  if (parts.length === 2 && method === 'GET') {
    try {
      const result = await providerProfiles.listProfiles();
      return sendJson(res, 200, isAdmin ? result : redactProviderListForOperator(result));
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not list provider profiles.' });
    }
  }

  if (parts.length === 3 && parts[2] === 'export' && method === 'GET') {
    if (!requireAdminAuth(req, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.exportProfiles());
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message || 'Could not export provider profiles.' });
    }
  }

  if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'dry-run' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.importDryRun(body));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not dry-run provider import.',
        errors: error.errors || [],
      });
    }
  }

  if (parts.length === 4 && parts[2] === 'import' && parts[3] === 'apply' && method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    const body = await parseJsonBody(req);
    if (body === null) return sendBodyError(req, res);
    if (rejectSpoofedActor(body, res)) return;
    try {
      return sendJson(res, 200, await providerProfiles.importApply(body, {
        actor: body.actor || 'dashboard',
        approved: body.approved,
      }));
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.message || 'Could not apply provider import.',
        errors: error.errors || [],
        requiresApproval: error.requiresApproval || false,
        risk: error.risk || null,
      });
    }
  }

  if (parts.length >= 3) {
    const providerId = parts[2];
    if (parts.length === 3 && method === 'GET') {
      try {
        const profile = await providerProfiles.getProfile(providerId);
        return sendJson(res, 200, isAdmin ? profile : redactProviderForOperator(profile));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not load provider profile.' });
      }
    }
    if (parts.length === 3 && method === 'PATCH') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.updateProfile(providerId, body, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not update provider profile.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    if (parts.length === 4 && parts[3] === 'health' && method === 'GET') {
      try {
        const result = await providerProfiles.health(providerId);
        return sendJson(res, 200, isAdmin ? result : redactProviderHealthForOperator(result));
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message || 'Could not check provider health.' });
      }
    }
    if (parts.length === 4 && parts[3] === 'secret' && method === 'POST') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.setSecret(providerId, body.secret, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not set provider secret.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
    if (parts.length === 4 && parts[3] === 'secret' && method === 'DELETE') {
      if (!requireAdminAuth(req, res)) return;
      const body = await parseJsonBody(req);
      if (body === null) return sendBodyError(req, res);
      if (rejectSpoofedActor(body, res)) return;
      try {
        return sendJson(res, 200, await providerProfiles.deleteSecret(providerId, {
          actor: body.actor || 'dashboard',
          approved: body.approved,
        }));
      } catch (error) {
        return sendJson(res, error.status || 500, {
          error: error.message || 'Could not delete provider secret.',
          requiresApproval: error.requiresApproval || false,
          risk: error.risk || null,
        });
      }
    }
  }

  return sendJson(res, 404, { error: 'Provider API route not found.' });
}
