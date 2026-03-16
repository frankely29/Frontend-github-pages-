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
    };
  }

  window.AdminActions = {
    createAdminActions,
  };
})();
