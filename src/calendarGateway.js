const createCalendarGateway = ({ fetchSnapshot, qol, onChange = () => {} }) => {
  const inFlight = new Map();
  const refresh = (query) => {
    if (inFlight.has(query)) return inFlight.get(query);
    const task = Promise.resolve().then(async () => {
      let snapshot;
      try {
        snapshot = await fetchSnapshot(query, { cacheBust: true });
      } catch (error) {
        snapshot = { ok: false, events: [], authoritative: false, error: error.message };
      }
      const changes = qol.observeCalendar(query, snapshot);
      if (changes?.length) onChange(changes);
      const cached = qol.getCalendar(query);
      const accepted = cached || snapshot;
      return { ...snapshot, ...accepted, events: accepted.events, partial: Boolean(accepted.partial),
        stale: !accepted.ok || Boolean(accepted.stale || accepted.partial) };
    }).finally(() => { inFlight.delete(query); });
    inFlight.set(query, task);
    return task;
  };
  return { refresh, cached: (query) => qol.getCalendar(query) };
};

module.exports = { createCalendarGateway };
