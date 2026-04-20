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
