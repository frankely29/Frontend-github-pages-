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
      fetchUserDetail(userId) {
        return request(`/admin/users/${encodeURIComponent(userId)}`);
      },
    };
  }

  window.AdminActions = {
    createAdminActions,
  };
})();
