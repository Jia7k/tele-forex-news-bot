const { createHash } = require('crypto');
const { hasDataValue } = require('./utils');
const { eventTimeMs } = require('./qolPresentation');

const clone = (value) => structuredClone(value);
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const nativeId = (event) => /^\d+$/.test(String(event.id)) ? String(event.id) : null;
const values = ['actual', 'forecast', 'previous'];
const signature = (event) => JSON.stringify(values.map((field) => (
  hasDataValue(event[field]) ? String(event[field]).trim() : ''
)));
const requestTime = (snapshot, fallback) => {
  const value = snapshot.requestStartedAt ?? snapshot.fetchedAt;
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
};
const cancelled = (event) => Boolean(event.cancelled || event.canceled) ||
  /cancelled|canceled/i.test(`${event.status || ''} ${event.timeText || ''}`);
const tentative = (event) => Boolean(event.tentative) ||
  /tentative/i.test(`${event.status || ''} ${event.timeText || ''}`);

const reconcileCalendar = (calendars, query, snapshot, { now = Date.now, sameOccurrence, occurrenceKey }) => {
  const at = typeof now === 'function' ? now() : now;
  const version = requestTime(snapshot, at);
  const next = clone(calendars || {});
  const previous = next[query];
  const previousVersion = previous ? requestTime(previous, -Infinity) : -Infinity;
  const changes = [];
  if (!snapshot.ok) {
    if (version >= previousVersion) {
      next[query] = { events: [], fetchedAt: null, ...previous, requestStartedAt: version,
        stale: true, ok: false, error: snapshot.error || 'Refresh failed' };
    }
    return { calendars: next, changes };
  }

  const same = (a, b) => {
    if (nativeId(a) && nativeId(b)) return nativeId(a) === nativeId(b);
    return sameOccurrence(a, b);
  };
  const identify = (event) => event.occurrenceId || hash(`${occurrenceKey(event)}:${nativeId(event) || eventTimeMs(event)}`);
  const pool = [];
  for (const calendar of Object.values(next)) {
    for (const event of calendar.events || []) {
      event.occurrenceId = identify(event);
      event.calendarRequestStartedAt ??= requestTime(calendar, 0);
      const index = pool.findIndex((old) => same(old, event));
      if (index < 0) pool.push(event);
      else if (event.calendarRequestStartedAt > pool[index].calendarRequestStartedAt) pool[index] = event;
    }
  }

  const incoming = clone(snapshot.events || []);
  const nativeRows = incoming.filter(nativeId);
  // A feed still listing the native event's old time must not resurrect that time.
  const rows = incoming.filter((event) => {
    if (nativeId(event)) return true;
    const matches = nativeRows.filter((native) => same(native, event) || pool.some((old) => (
      nativeId(old) === nativeId(native) && same(old, event)
    )));
    return matches.length !== 1;
  });

  const refreshed = new Set();
  const queried = clone(previous?.events || []);
  for (const incomingEvent of rows) {
    const exact = nativeId(incomingEvent) ? pool.filter((old) => nativeId(old) === nativeId(incomingEvent)) : [];
    const matches = exact.length ? exact : pool.filter((old) => same(old, incomingEvent));
    let old = matches.length === 1 ? matches[0] : null;
    if (!old && matches.length === 0) {
      const daily = pool.filter((event) => occurrenceKey(event) === occurrenceKey(incomingEvent));
      const dailyIncoming = rows.filter((event) => occurrenceKey(event) === occurrenceKey(incomingEvent));
      if (daily.length === 1 && dailyIncoming.length === 1 && !(nativeId(daily[0]) && nativeId(incomingEvent))) old = daily[0];
    }

    let event;
    const nativeWinsTie = old && version === old.calendarRequestStartedAt && nativeId(old) && !nativeId(incomingEvent);
    if (old && (version < old.calendarRequestStartedAt || nativeWinsTie)) {
      event = clone(old);
    } else {
      event = clone(incomingEvent);
      event.occurrenceId = old?.occurrenceId || identify(event);
      event.calendarRequestStartedAt = version;
      if (old) {
        if (nativeId(old) && !nativeId(event)) event.id = old.id;
        const calendarOnly = !hasDataValue(event.actual) && hasDataValue(old.actual);
        for (const field of values) {
          if ((calendarOnly || !hasDataValue(event[field])) && hasDataValue(old[field])) event[field] = old[field];
        }
        event.observedAt = old.observedAt;
      }
      if (hasDataValue(event.actual) && (!old || signature(old) !== signature(event))) event.observedAt = at;
      if (old) {
        let kind = null;
        if (cancelled(event) && !cancelled(old)) kind = 'cancelled';
        else if (tentative(event) && !tentative(old)) kind = 'tentative';
        else if (!cancelled(event) && eventTimeMs(old) !== eventTimeMs(event)) kind = 'moved';
        if (kind) changes.push({
          id: hash(`${event.occurrenceId}:${kind}:${eventTimeMs(old)}:${eventTimeMs(event)}:${version}`),
          kind, previous: clone(old), event: clone(event), at,
        });
      }
    }
    refreshed.add(event.occurrenceId);
    const replaces = (candidate) => same(candidate, event) || (old && same(candidate, old));
    const poolIndex = pool.findIndex(replaces);
    if (poolIndex < 0) pool.push(event);
    else pool[poolIndex] = event;
    const queryIndex = queried.findIndex(replaces);
    if (queryIndex < 0) queried.push(clone(event));
    else queried[queryIndex] = clone(event);
    for (const calendar of Object.values(next)) {
      calendar.events = (calendar.events || []).map((candidate) => replaces(candidate) ? clone(event) : candidate);
    }
  }

  const canonicalRows = (events) => {
    const unique = [];
    for (const candidate of events) {
      const event = pool.find((entry) => same(entry, candidate)) || candidate;
      if (!unique.some((entry) => same(entry, event))) unique.push(clone(event));
    }
    return unique;
  };
  for (const calendar of Object.values(next)) calendar.events = canonicalRows(calendar.events || []);
  const events = canonicalRows(queried);
  const retainedEventCount = events.filter((event) => !refreshed.has(event.occurrenceId)).length;
  const metadata = version < previousVersion ? previous : snapshot;
  const partial = Boolean(metadata.partial || retainedEventCount);
  next[query] = { ...clone(metadata), events, retainedEventCount, partial, stale: !metadata.ok || partial,
    requestStartedAt: Math.max(version, previousVersion), fetchedAt: metadata.fetchedAt ?? at };
  return { calendars: next, changes };
};

module.exports = { reconcileCalendar };
