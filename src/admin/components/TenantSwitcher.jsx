import React, { useEffect, useState } from 'react';
import { Box, SingleSelect, SingleSelectOption, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

const ACTIVE_TENANT_STORAGE_KEY = 'strapi-active-tenant-id';

function patchGlobalFetchForActiveTenant() {
  if (typeof window === 'undefined' || window.__strapiActiveTenantFetchPatched) return;
  window.__strapiActiveTenantFetchPatched = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input, init) {
    const active = localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY);
    if (active) {
      const nextInit = init ? { ...init } : {};
      const headers = new Headers(nextInit.headers || {});
      headers.set('X-Active-Tenant-Id', active);
      nextInit.headers = headers;
      return originalFetch(input, nextInit);
    }
    return originalFetch(input, init);
  };
}

const TenantSwitcher = () => {
  const { get } = useFetchClient();
  const [tenants, setTenants] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState(
    () => localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY) || ''
  );
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    patchGlobalFetchForActiveTenant();
    let cancelled = false;

    (async () => {
      try {
        const res = await get('/api/editor-tenant-context/assigned');
        const payload = res?.data?.data ?? res?.data ?? {};
        if (cancelled) return;
        if (!payload.isEditor || !Array.isArray(payload.tenants) || payload.tenants.length === 0) {
          setVisible(false);
          return;
        }
        setTenants(payload.tenants);
        setVisible(payload.tenants.length > 1 || payload.tenants.length === 1);

        const stored = localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY);
        const validStored = payload.tenants.some((t) => t.tenantId === stored);
        const next = validStored ? stored : payload.tenants[0]?.tenantId;
        if (next) {
          localStorage.setItem(ACTIVE_TENANT_STORAGE_KEY, next);
          setActiveTenantId(next);
        }
      } catch {
        if (!cancelled) setVisible(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [get]);

  if (!visible || loading) return null;

  const handleChange = (value) => {
    const next = String(value || '');
    localStorage.setItem(ACTIVE_TENANT_STORAGE_KEY, next);
    setActiveTenantId(next);
    window.location.reload();
  };

  return (
    <Box paddingRight={2} paddingLeft={2} style={{ minWidth: 220 }}>
      <Typography variant="pi" textColor="neutral600" style={{ marginBottom: 4 }}>
        Active tenant
      </Typography>
      <SingleSelect
        size="S"
        value={activeTenantId}
        onChange={handleChange}
        placeholder="Select tenant"
      >
        {tenants.map((t) => (
          <SingleSelectOption key={t.tenantId} value={t.tenantId}>
            {t.name ? `${t.name} (${t.tenantId})` : t.tenantId}
          </SingleSelectOption>
        ))}
      </SingleSelect>
    </Box>
  );
};

export default TenantSwitcher;
