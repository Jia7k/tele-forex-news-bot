const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// Only complete, comparable numbers can support a surprise-based outlook.
const parseValue = (value) => {
  const match = normalize(value).match(/^([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))\s*([KMBT%])?$/i);
  if (!match) return null;
  const suffix = (match[2] || '').toUpperCase();
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const number = Number(match[1].replace(/,/g, '')) * (multipliers[suffix] || 1);
  return Number.isFinite(number) ? { number, unit: suffix === '%' ? 'percent' : 'number' } : null;
};

const compareValues = (ev) => {
  const actual = parseValue(ev.actual);
  const forecast = parseValue(ev.forecast);
  if (!actual || !forecast || actual.unit !== forecast.unit) return null;
  const delta = actual.number - forecast.number;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(actual.number), Math.abs(forecast.number)) * 4;
  return Math.abs(delta) <= tolerance ? 0 : Math.sign(delta);
};

const QUALITATIVE_EVENT = /\b(speaks?|speech|testif\w*|statement|minutes|press conference|projections|meetings?|holiday|auction|report about)\b/i;
const AMBIGUOUS_EVENT = /\b(trade balance|current account|budget balance|inventor(?:y|ies)|oil|gas|rig count)\b/i;

// These are rate/USD-channel scenarios, not a fitted gold-price prediction model.
const RULES = [
  { category: 'labor-slack', higher: 'long', match: /\b(unemployment rate|unemployment claims|(?:initial |continuing )?jobless claims|challenger job cuts)\b/i },
  { category: 'rates', higher: 'short', match: /\b(federal funds rate|fed interest rate decision)\b/i },
  { category: 'inflation', higher: 'short', match: /\b(cpi|ppi|pce price index|gdp price index|gdp deflator|average hourly earnings|employment cost index|unit labor costs|ism (?:manufacturing |services )?prices)\b/i },
  { category: 'employment', higher: 'short', match: /\b(non[ -]?farm (?:employment change|payrolls?)|nfp|adp employment change|jolts job openings)\b/i },
  { category: 'activity', higher: 'short', match: /\b(gdp|retail sales|industrial production|durable goods orders|factory orders|pmi|ism (?:manufacturing|services)|consumer confidence|consumer sentiment|housing starts|building permits|(?:new|existing|pending) home sales|personal (?:income|spending))\b/i },
];

const getRule = (ev) => {
  if (normalize(ev.currency).toUpperCase() !== 'USD') return null;
  const name = normalize(ev.eventName);
  if (QUALITATIVE_EVENT.test(name) || AMBIGUOUS_EVENT.test(name)) return null;
  return RULES.find((rule) => rule.match.test(name)) || null;
};

const noBias = (reason) => ({
  bias: 'neutral',
  label: 'No clear bias',
  reason,
  action: 'No long/short setup from this release alone.',
});

const describeSurprise = (comparison) => (
  comparison === null ? '' : comparison === 0 ? 'The result is in line with forecast. ' :
    `The result is ${comparison > 0 ? 'above' : 'below'} forecast. `
);

const getSingleOutlook = (ev, phase) => {
  const rule = getRule(ev);
  const comparison = compareValues(ev);
  const name = normalize(ev.eventName);

  if (QUALITATIVE_EVENT.test(name)) {
    return noBias('The statement, speech, auction details or market context must be assessed; calendar numbers alone cannot establish gold direction.');
  }

  if (normalize(ev.currency).toUpperCase() !== 'USD') {
    const explanation = /\btrade balance\b/i.test(name) ?
      'This regional trade figure has limited direct relevance to gold; any effect through currencies is indirect and uncertain.' :
      'This non-US event has an indirect, context-dependent link to gold. Local-currency impact does not establish XAUUSD direction.';
    return noBias(`${phase === 'pre-release' ? '' : describeSurprise(comparison)}${explanation}`);
  }

  if (!rule) {
    return noBias(`${phase === 'pre-release' ? '' : describeSurprise(comparison)}This event has no reliable standalone directional rule for gold.`);
  }

  if (phase === 'pre-release') {
    const above = rule.higher === 'short' ? 'downside' : 'upside';
    const below = rule.higher === 'short' ? 'upside' : 'downside';
    return {
      bias: 'wait',
      label: 'Wait for release',
      reason: `Above forecast: potential ${above}; below forecast: potential ${below}. These scenarios depend on the USD and rate reaction.`,
      action: 'Wait for actual data and price confirmation.',
    };
  }

  if (comparison === null) {
    return {
      bias: 'wait',
      label: 'Wait for complete data',
      reason: 'A valid actual and a comparable forecast are required. Previous is not a substitute for consensus.',
      action: 'Wait for verified release values before choosing a direction.',
    };
  }

  if (comparison === 0) {
    return noBias('The result is in line with forecast. There is no directional surprise; revisions and other releases may still matter.');
  }

  const bias = comparison > 0 ? rule.higher : rule.higher === 'short' ? 'long' : 'short';
  const bearish = bias === 'short';
  const descriptions = {
    inflation: comparison > 0 ? 'Hotter-than-expected US inflation or wage growth' : 'Cooler-than-expected US inflation or wage growth',
    employment: comparison > 0 ? 'Stronger-than-expected US employment' : 'Weaker-than-expected US employment',
    'labor-slack': comparison > 0 ? 'More US labor-market weakness than expected' : 'Less US labor-market weakness than expected',
    activity: comparison > 0 ? 'Stronger-than-expected US activity' : 'Weaker-than-expected US activity',
    rates: comparison > 0 ? 'A higher-than-expected Fed rate' : 'A lower-than-expected Fed rate',
  };
  let reason = `${descriptions[rule.category]} can support ${bearish ? 'higher' : 'lower'} US rate expectations and a ${bearish ? 'stronger' : 'weaker'} USD, potentially ${bearish ? 'pressuring' : 'supporting'} gold.`;
  if (rule.category === 'rates') reason += ' Fed guidance can outweigh the rate surprise.';
  if (normalize(ev.impact).toLowerCase() === 'low') reason += ' This indicator may have only a limited effect.';

  return {
    bias,
    label: bearish ? 'Potential downside (bearish)' : 'Potential upside (bullish)',
    reason,
    action: bearish ?
      'Look for shorts only if gold weakens and USD/yields strengthen.' :
      'Look for longs only if gold strengthens and USD/yields weaken.',
  };
};

const sameReleaseTime = (a, b) => {
  const timestamp = (ev) => {
    const value = Number(ev.timestamp);
    return Number.isFinite(value) && value > 0 ? (value > 1e11 ? value : value * 1000) : null;
  };
  const aTime = timestamp(a);
  const bTime = timestamp(b);
  if (aTime !== null && bTime !== null) return aTime === bTime;
  return ['dateStr', 'timeText', 'year'].every((key) => normalize(a[key]) && normalize(a[key]) === normalize(b[key]));
};

const getGoldOutlook = (ev, { phase = 'release', contextEvents = [] } = {}) => {
  const outlook = getSingleOutlook(ev, phase);
  if (outlook.bias !== 'long' && outlook.bias !== 'short') return outlook;

  // Use all available same-time releases, including rows already sent or filtered out.
  const context = contextEvents.filter((other) => sameReleaseTime(ev, other) && getRule(other))
    .map((other) => getSingleOutlook(other, 'release'));
  if (context.some((other) => other.bias === 'wait')) {
    return {
      bias: 'wait',
      label: 'Wait for complete data',
      reason: 'Other same-time US releases still lack comparable actual/forecast data; the combined gold outlook is incomplete.',
      action: 'Wait for the remaining values and price confirmation.',
    };
  }
  if (context.some((other) => (other.bias === 'long' || other.bias === 'short') && other.bias !== outlook.bias)) {
    return noBias('Same-time US releases give conflicting gold signals. The combined data do not support a clear direction; wait for the market reaction.');
  }
  return outlook;
};

module.exports = { getGoldOutlook };
