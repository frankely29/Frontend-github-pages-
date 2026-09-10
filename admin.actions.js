(function () {
  function createAdminActions(request) {
    return {
      setUserAdmin(userId, isAdmin) {
        return request(`/admin/users/${encodeURIComponent(userId)}/set-admin`, {
          method: 'POST',
          body: { is_admin: !!isAdmin },
        });
      },
      setUserSuspended(userId, isSuspended) {
        return request(`/admin/users/${encodeURIComponent(userId)}/set-suspended`, {
          method: 'POST',
          body: { is_suspended: !!isSuspended },
        });
      },
      clearPoliceReport(reportId) {
        return request(`/admin/reports/police/${encodeURIComponent(reportId)}/clear`, {
          method: 'POST',
        });
      },
      clearPickupLog(reportId) {
        return request(`/admin/reports/pickups/${encodeURIComponent(reportId)}/clear`, {
          method: 'POST',
        });
      },
      voidRecordedTrip(tripId, reason) {
        return request(`/admin/pickup-recording/trips/${encodeURIComponent(tripId)}/void`, {
          method: 'POST',
          body: { reason },
        });
      },
      fetchUserDetail(userId) {
        return request(`/admin/users/${encodeURIComponent(userId)}`);
      },
      grantComp(userId, durationUnit, durationValue, reason) {
        return request(`/admin/users/${encodeURIComponent(userId)}/comp/grant`, {
          method: 'POST',
          body: {
            duration_unit: String(durationUnit),
            duration_value: Number(durationValue),
            reason: String(reason || ''),
          },
        });
      },
      extendComp(userId, durationUnit, durationValue) {
        return request(`/admin/users/${encodeURIComponent(userId)}/comp/extend`, {
          method: 'POST',
          body: {
            duration_unit: String(durationUnit),
            duration_value: Number(durationValue),
          },
        });
      },
      revokeComp(userId) {
        return request(`/admin/users/${encodeURIComponent(userId)}/comp/revoke`, {
          method: 'POST',
          body: {},
        });
      },
      createAccessToken({ accessDays = null, redeemByDays = null, maxUses = 1, note = '' } = {}) {
        // access_days / redeem_by_days are omitted rather than sent as null when
        // unlimited: the server treats an absent field as "no limit", and that
        // is the difference between a code that grants forever and one that
        // fails validation.
        const body = { max_uses: Number(maxUses) || 1, note: String(note || '') };
        if (accessDays !== null && accessDays !== '' && Number(accessDays) > 0) {
          body.access_days = Number(accessDays);
        }
        if (redeemByDays !== null && redeemByDays !== '' && Number(redeemByDays) > 0) {
          body.redeem_by_days = Number(redeemByDays);
        }
        return request('/admin/access_tokens', { method: 'POST', body });
      },
      listAccessTokens({ limit = 200, offset = 0, includeInactive = true } = {}) {
        const params = new URLSearchParams();
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        params.set('include_inactive', includeInactive ? 'true' : 'false');
        return request(`/admin/access_tokens?${params.toString()}`);
      },
      revokeAccessToken(code) {
        return request(`/admin/access_tokens/${encodeURIComponent(code)}/revoke`, {
          method: 'POST',
          body: {},
        });
      },
      listComps({ limit = 100, offset = 0, search = '' } = {}) {
        const params = new URLSearchParams();
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        const trimmed = String(search || '').trim();
        if (trimmed) params.set('search', trimmed);
        return request(`/admin/comps?${params.toString()}`);
      },
    };
  }

  window.AdminActions = {
    createAdminActions,
  };
})();
