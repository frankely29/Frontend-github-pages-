(function () {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return esc(value);
    return esc(date.toLocaleString());
  }

  function boolText(value, yes = 'Yes', no = 'No') {
    return value ? yes : no;
  }

  function badge(label, tone = 'muted') {
    return `<span class="adminPill ${esc(tone)}">${esc(label)}</span>`;
  }

  function boolBadge(value, yes = 'Yes', no = 'No') {
    return badge(value ? yes : no, value ? 'yes' : 'no');
  }

  function statusBadge(status) {
    const normalized = String(status || 'pending').toLowerCase();
    if (normalized === 'pass') return badge('Pass', 'yes');
    if (normalized === 'fail') return badge('Fail', 'no');
    return badge('Pending', 'warn');
  }

  function formatValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return boolText(value);
    if (Array.isArray(value)) return value.length ? value.map((entry) => formatValue(entry)).join(', ') : '—';
    if (typeof value === 'object') {
      return Object.entries(value)
        .map(([k, v]) => `${toLabel(k)}: ${formatValue(v)}`)
        .join(' • ') || '—';
    }
    return String(value);
  }

  function toLabel(key) {
    return String(key || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function keyValueRows(obj) {
    const entries = Object.entries(obj || {});
    if (!entries.length) return '<div class="adminMuted">No details returned.</div>';
    return entries
      .map(([k, v]) => `<div class="adminKV"><span>${esc(toLabel(k))}</span><strong>${esc(formatValue(v))}</strong></div>`)
      .join('');
  }

  function statCard(label, value, tone = '') {
    return `<div class="adminCard ${esc(tone)}"><div class="adminCardLabel">${esc(label)}</div><div class="adminCardValue">${esc(formatValue(value))}</div></div>`;
  }

  function collapsible(title, content, className = '') {
    return `<details class="adminDetails ${esc(className)}"><summary>${esc(title)}</summary><div class="adminDetailsBody">${content}</div></details>`;
  }

  window.AdminComponents = {
    esc,
    badge,
    boolBadge,
    boolText,
    collapsible,
    formatDateTime,
    formatValue,
    keyValueRows,
    statCard,
    statusBadge,
    toLabel,
  };
})();
