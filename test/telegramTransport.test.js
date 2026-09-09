const test = require('node:test');
const assert = require('node:assert/strict');

const { createTelegramTransport, splitTelegramHtml } = require('../src/telegramTransport');

const message = { message_id: 101, date: 1788912000, chat: { id: -42, type: 'group' }, text: 'Hello' };
const editedMessage = { ...message, text: 'Updated' };
const photoMessage = { ...message, photo: [{ file_id: 'photo-id', width: 100, height: 100 }] };

const apiError = (status, description, parameters) => Object.assign(new Error(description), {
  code: 'ETELEGRAM',
  response: { statusCode: status, body: { ok: false, error_code: status, description, parameters } },
});

const makeTransport = (responses = {}, overrides = {}) => {
  const calls = [];
  const waits = [];
  const logs = [];
  const defaults = {
    sendMessage: [message], sendPhoto: [photoMessage],
    editMessageText: [editedMessage], editMessageReplyMarkup: [editedMessage], answerCallbackQuery: [true],
  };
  const bot = Object.fromEntries(Object.entries(defaults).map(([method, fallback]) => {
    const queue = [...(responses[method] || fallback)];
    return [method, async (...args) => {
      calls.push({ method, args: structuredClone(args) });
      // The real SDK mutates its form options, including JSON serialization.
      const form = args.at(-1);
      if (form.reply_parameters) form.reply_parameters = JSON.stringify(form.reply_parameters);
      if (form.reply_markup) form.reply_markup = JSON.stringify(form.reply_markup);
      assert.ok(queue.length, `Unexpected ${method} call`);
      const result = queue.shift();
      if (result instanceof Error) throw result;
      return result;
    }];
  }));
  const transport = createTelegramTransport({
    bot,
    config: { mode: 'polling', chatId: -42, sendRetryAttempts: 2, sendRetryDelaySeconds: 2, ...overrides },
    delay: async (ms) => waits.push(ms),
    logger: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
    },
  });
  return { transport, calls, waits, logs };
};

test('send returns the actual Message and defaults to the flat telegram config chat', async () => {
  const { transport, calls } = makeTransport();
  assert.strictEqual(await transport.sendTelegramMessageResult('<b>Hello</b>'), message);
  assert.deepEqual(calls, [{ method: 'sendMessage', args: [-42, '<b>Hello</b>', { parse_mode: 'HTML' }] }]);
});

test('send passes silent, reply and inline keyboard options without mutating the caller', async () => {
  const options = {
    reply_parameters: { message_id: 90, allow_sending_without_reply: false },
    disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: 'Why', callback_data: 'why:90' }]] },
  };
  const original = structuredClone(options);
  const { transport, calls } = makeTransport();
  assert.strictEqual(await transport.sendTelegramMessageResult('Hello', -99, options), message);
  assert.deepEqual(calls, [{ method: 'sendMessage', args: [-99, 'Hello', {
    parse_mode: 'HTML',
    reply_parameters: { message_id: 90, allow_sending_without_reply: true },
    disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: 'Why', callback_data: 'why:90' }]] },
  }] }]);
  assert.deepEqual(options, original);
});

test('send preserves explicit audible notification options and nullish chat fallback', async () => {
  const { transport, calls } = makeTransport();
  await transport.sendTelegramMessageResult('Hello', null, { disable_notification: false });
  assert.deepEqual(calls[0].args, [-42, 'Hello', { parse_mode: 'HTML', disable_notification: false }]);
});

test('legacy text and photo methods retain boolean results and unchanged captions', async () => {
  const { transport, calls } = makeTransport();
  assert.equal(await transport.sendTelegramMessage('Hello'), true);
  assert.equal(await transport.sendTelegramPhoto('https://example.com/photo.png', '<b>Caption</b>', -99), true);
  assert.deepEqual(calls[1], { method: 'sendPhoto', args: [
    -99, 'https://example.com/photo.png', { caption: '<b>Caption</b>', parse_mode: 'HTML' },
  ] });
});

test('disabled mode performs no bot calls or delays for any transport method', async () => {
  const { transport, calls, waits } = makeTransport({}, { mode: 'disabled' });
  assert.equal(await transport.sendTelegramMessageResult('Hello'), null);
  assert.equal(await transport.sendTelegramMessage('Hello'), false);
  assert.equal(await transport.sendTelegramPhoto('photo', 'Caption'), false);
  assert.equal(await transport.editTelegramMessage('Updated', -42, 101), null);
  assert.equal(await transport.editTelegramReplyMarkup(-42, 101, { inline_keyboard: [] }), null);
  assert.equal(await transport.answerTelegramCallback('query-id'), false);
  assert.equal(await transport.sendTelegramChunks('Hello'), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(waits, []);
});

test('missing chat or message identifiers fail without calling the bot', async () => {
  const { transport, calls } = makeTransport({}, { chatId: '' });
  assert.equal(await transport.sendTelegramMessageResult('Hello'), null);
  assert.equal(await transport.sendTelegramMessage('Hello'), false);
  assert.equal(await transport.sendTelegramPhoto('photo', 'Caption'), false);
  assert.equal(await transport.editTelegramMessage('Updated', null, 101), null);
  assert.equal(await transport.editTelegramMessage('Updated', -42, undefined), null);
  assert.equal(await transport.editTelegramReplyMarkup(-42, undefined, { inline_keyboard: [] }), null);
  assert.equal(await transport.answerTelegramCallback(''), false);
  assert.deepEqual(calls, []);
});

test('network failures retry exact payloads with configured waits and return only the real response', async () => {
  const failure = Object.assign(new Error('socket hang up'), { code: 'EFATAL' });
  const { transport, calls, waits } = makeTransport({ sendMessage: [failure, failure, message] });
  const options = { reply_parameters: { message_id: 90 }, reply_markup: { inline_keyboard: [] } };
  assert.strictEqual(await transport.sendTelegramMessageResult('Hello', -42, options), message);
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call.args, [-42, 'Hello', {
    parse_mode: 'HTML', reply_parameters: { message_id: 90, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [] },
  }]);
});

test('rate limiting honors retry_after instead of retrying too soon', async () => {
  const { transport, waits } = makeTransport({
    sendMessage: [apiError(429, 'Too Many Requests', { retry_after: 7 }), message],
  });
  assert.strictEqual(await transport.sendTelegramMessageResult('Hello'), message);
  assert.deepEqual(waits, [7000]);
});

test('exhausted network sends return null and never synthesize message IDs', async () => {
  const failure = new Error('ETIMEDOUT');
  const { transport, calls, waits } = makeTransport({ sendMessage: [failure, failure, failure] });
  assert.equal(await transport.sendTelegramMessageResult('Hello'), null);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [2000, 2000]);
});

test('failed legacy sends and photos return false', async () => {
  const failure = apiError(403, 'Forbidden');
  const { transport, calls, waits } = makeTransport({ sendMessage: [failure], sendPhoto: [failure] });
  assert.equal(await transport.sendTelegramMessage('Hello'), false);
  assert.equal(await transport.sendTelegramPhoto('photo', 'Caption'), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, []);
});

test('send rejects malformed successful API responses rather than fabricating IDs', async () => {
  for (const response of [true, false, null, undefined, {}, { message_id: 0 }, { message_id: '101' }]) {
    const { transport } = makeTransport({ sendMessage: [response] });
    assert.equal(await transport.sendTelegramMessageResult('Hello'), null);
  }
});

test('removed reply parents fall back once without reply even when retries are disabled', async () => {
  for (const description of ['Bad Request: message to be replied not found', 'Bad Request: REPLY_MESSAGE_ID_INVALID']) {
    const { transport, calls, waits } = makeTransport({
      sendMessage: [apiError(400, description), message],
    }, { sendRetryAttempts: 0 });
    assert.strictEqual(await transport.sendTelegramMessageResult('Hello', -42, {
      reply_parameters: { message_id: 90 }, disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: 'Why', callback_data: 'why:90' }]] },
    }), message);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, [-42, 'Hello', {
      parse_mode: 'HTML', disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: 'Why', callback_data: 'why:90' }]] },
    }]);
    assert.deepEqual(waits, []);
  }
});

test('failed parent fallback returns null instead of treating recovery as successful', async () => {
  const { transport, calls } = makeTransport({ sendMessage: [
    apiError(400, 'Bad Request: message to be replied not found'), apiError(403, 'Forbidden'),
  ] });
  assert.equal(await transport.sendTelegramMessageResult('Hello', -42, {
    reply_parameters: { message_id: 90 },
  }), null);
  assert.equal(calls.length, 2);
});

test('unrelated bad requests do not drop replies or retry', async () => {
  const { transport, calls, waits } = makeTransport({ sendMessage: [apiError(400, 'Bad Request: cannot parse entities')] });
  assert.equal(await transport.sendTelegramMessageResult('<b>Hello', -42, {
    reply_parameters: { message_id: 90 },
  }), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('edit returns the Message using explicit IDs and inline markup', async () => {
  const { transport, calls } = makeTransport();
  assert.strictEqual(await transport.editTelegramMessage('Updated', -99, 101, {
    reply_markup: { inline_keyboard: [] }, disable_notification: true,
    reply_parameters: { message_id: 90 },
  }), editedMessage);
  assert.deepEqual(calls, [{ method: 'editMessageText', args: ['Updated', {
    chat_id: -99, message_id: 101, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] },
  }] }]);
});

test('not-modified edits are successful without retrying or sending a replacement', async () => {
  const { transport, calls, waits } = makeTransport({
    editMessageText: [apiError(400, 'Bad Request: message is not modified: specified new message content is the same')],
  });
  assert.equal(await transport.editTelegramMessage('Hello', -42, 101), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('edit supports literal true API results but returns null for deleted or uneditable messages', async () => {
  for (const result of [true, apiError(400, 'Bad Request: message to edit not found'), apiError(400, "Bad Request: message can't be edited")]) {
    const { transport, calls } = makeTransport({ editMessageText: [result] });
    assert.equal(await transport.editTelegramMessage('Updated', -42, 101), result === true ? true : null);
    assert.equal(calls.length, 1);
  }
});

test('edits and photos use the shared transient retry policy', async () => {
  const { transport, waits } = makeTransport({
    editMessageText: [apiError(502, 'Bad Gateway'), editedMessage],
    sendPhoto: [apiError(429, 'Too Many Requests', { retry_after: 5 }), photoMessage],
  });
  assert.strictEqual(await transport.editTelegramMessage('Updated', -42, 101), editedMessage);
  assert.equal(await transport.sendTelegramPhoto('photo', 'Caption'), true);
  assert.deepEqual(waits, [2000, 5000]);
});

test('reply-markup edits target the persisted message without altering HTML text', async () => {
  const { transport, calls } = makeTransport();
  const markup = { inline_keyboard: [[{ text: 'Unmute', callback_data: 'mute:90' }]] };
  assert.strictEqual(await transport.editTelegramReplyMarkup(-99, 101, markup), editedMessage);
  assert.deepEqual(calls, [{ method: 'editMessageReplyMarkup', args: [
    { inline_keyboard: [[{ text: 'Unmute', callback_data: 'mute:90' }]] },
    { chat_id: -99, message_id: 101 },
  ] }]);
});

test('reply-markup edits retry transient errors, accept not-modified and expose failures', async () => {
  const { transport, calls, waits } = makeTransport({ editMessageReplyMarkup: [
    apiError(429, 'Too Many Requests', { retry_after: 4 }), editedMessage,
    apiError(400, 'Bad Request: message is not modified'),
    apiError(400, 'Bad Request: message to edit not found'), true,
  ] });
  const markup = { inline_keyboard: [] };
  assert.strictEqual(await transport.editTelegramReplyMarkup(-42, 101, markup), editedMessage);
  assert.equal(await transport.editTelegramReplyMarkup(-42, 101, markup), true);
  assert.equal(await transport.editTelegramReplyMarkup(-42, 101, markup), null);
  assert.equal(await transport.editTelegramReplyMarkup(-42, 101, markup), true);
  assert.equal(calls.length, 5);
  assert.deepEqual(waits, [4000]);
});

test('callback acknowledgement forwards options and returns a boolean', async () => {
  const { transport, calls } = makeTransport();
  assert.equal(await transport.answerTelegramCallback('query-id', {
    text: 'Muted', show_alert: false, cache_time: 0,
  }), true);
  assert.deepEqual(calls, [{ method: 'answerCallbackQuery', args: ['query-id', {
    text: 'Muted', show_alert: false, cache_time: 0,
  }] }]);
});

test('callback network failures retry but expired callback IDs return false', async () => {
  const { transport, waits, calls } = makeTransport({ answerCallbackQuery: [
    new Error('ECONNRESET'), true, apiError(400, 'Bad Request: query is too old and response timeout expired'),
  ] });
  assert.equal(await transport.answerTelegramCallback('active'), true);
  assert.equal(await transport.answerTelegramCallback('expired'), false);
  assert.deepEqual(waits, [2000]);
  assert.equal(calls.length, 3);
});

test('transport logs never expose token-bearing errors, URLs or response descriptions', async () => {
  const token = '123456789:secret-token-value';
  const failure = apiError(502, `Failed https://api.telegram.org/bot${token}/sendMessage`);
  failure.code = token;
  const { transport, logs } = makeTransport({ sendMessage: [failure, failure, failure] });
  assert.equal(await transport.sendTelegramMessageResult('Hello'), null);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(logs.join('\n'), /secret-token-value|123456789|api\.telegram\.org|https:/);
});

test('HTML splitter keeps short messages unchanged and returns no chunks for empty text', () => {
  const html = '<b>Gold</b> <i>release</i> <code>3.5%</code> &amp; <a href="https://example.com">Source</a>';
  assert.deepEqual(splitTelegramHtml(html), [html]);
  assert.deepEqual(splitTelegramHtml(''), []);
});

test('HTML splitter reserves closing tags inside the exact length limit', () => {
  assert.deepEqual(splitTelegramHtml('<b>1234567890</b>', 12), ['<b>12345</b>', '<b>67890</b>']);
  assert.deepEqual(splitTelegramHtml('123456', 3), ['123', '456']);
  assert.deepEqual(splitTelegramHtml('<code>12345</code>', 16), ['<code>123</code>', '<code>45</code>']);
});

test('HTML splitter reopens nested styles and preserves their text order', () => {
  assert.deepEqual(splitTelegramHtml('<b>12<i>3456789</i>0</b>', 20), [
    '<b>12<i>3456</i></b>', '<b><i>789</i>0</b>',
  ]);
});

test('HTML splitter keeps quoted link attributes and entity spellings intact', () => {
  const opening = '<a href="https://example.com/?a=1&amp;b=2>1">';
  assert.deepEqual(splitTelegramHtml(`${opening}abcdef</a>`, opening.length + 7), [
    `${opening}abc</a>`, `${opening}def</a>`,
  ]);
  assert.deepEqual(splitTelegramHtml('12&amp;34&#x1F680;56&#128640;78&lt;9&gt;&quot;', 11), [
    '12&amp;34', '&#x1F680;56', '&#128640;78', '&lt;9&gt;', '&quot;',
  ]);
});

test('HTML splitter does not break Unicode code points or grapheme clusters', () => {
  assert.deepEqual(splitTelegramHtml('ab\u{1F680}cd', 3), ['ab', '\u{1F680}c', 'd']);
  assert.deepEqual(splitTelegramHtml('abe\u0301cd', 3), ['ab', 'e\u0301c', 'd']);
  assert.deepEqual(splitTelegramHtml('ab\u{1F469}\u200D\u{1F4BB}cd', 6), [
    'ab', '\u{1F469}\u200D\u{1F4BB}c', 'd',
  ]);
});

test('long HTML chunks stay balanced, bounded and preserve rendered text and links', () => {
  const { load } = require('cheerio');
  const section = '<b>Gold &amp; FX</b> <i>\u{1F680} e\u0301</i> <code>&lt;4.5&gt;</code> ' +
    '<a href="https://example.com/?a=1&amp;b=2">Source &#128640;</a>\n';
  const source = section.repeat(300);
  const chunks = splitTelegramHtml(source);
  assert.ok(chunks.length > 1);
  const textOf = (html) => load(html, {}, false).text();
  assert.equal(chunks.map(textOf).join(''), textOf(source));
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3800);
    assert.ok(chunk.length > 0);
    assert.equal(chunk.isWellFormed(), true);
    assert.equal(load(chunk, { xml: { decodeEntities: false, selfClosingTags: false } }, false).html(), chunk);
    for (const link of load(chunk, {}, false)('a').toArray()) {
      assert.equal(link.attribs.href, 'https://example.com/?a=1&b=2');
    }
  }
});

test('HTML splitter rejects invalid limits or indivisible content that cannot fit', () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => splitTelegramHtml('Hello', limit), RangeError);
  }
  assert.throws(() => splitTelegramHtml('<b>1</b>', 7), RangeError);
  assert.throws(() => splitTelegramHtml('&amp;', 4), RangeError);
  assert.throws(() => splitTelegramHtml('\u{1F680}', 1), RangeError);
});

test('malformed HTML is rejected instead of producing invalid outgoing chunks', () => {
  for (const html of ['<b>unclosed', '<b><i>crossed</b></i>', 'orphan</b>']) {
    assert.throws(() => splitTelegramHtml(html), /Malformed Telegram HTML/);
  }
});

test('chunk sends return ordered real messages with exact reply, silent and keyboard payloads', async () => {
  const second = { ...message, message_id: 102, text: '67890' };
  const { transport, calls } = makeTransport({ sendMessage: [message, second] });
  const results = await transport.sendTelegramChunks('<b>1234567890</b>', -99, {
    maxLength: 12, disable_notification: true, reply_parameters: { message_id: 90 },
    reply_markup: { inline_keyboard: [[{ text: 'Why', callback_data: 'why:90' }]] },
  });
  assert.deepEqual(results, [message, second]);
  assert.strictEqual(results[0], message);
  assert.strictEqual(results[1], second);
  assert.deepEqual(calls, [{
    method: 'sendMessage', args: [-99, '<b>12345</b>', {
      parse_mode: 'HTML', disable_notification: true,
      reply_parameters: { message_id: 90, allow_sending_without_reply: true },
    }],
  }, {
    method: 'sendMessage', args: [-99, '<b>67890</b>', {
      parse_mode: 'HTML', disable_notification: true,
      reply_parameters: { message_id: 90, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: 'Why', callback_data: 'why:90' }]] },
    }],
  }]);
});

test('chunk sends apply the 3800 default limit without truncating long text', async () => {
  const second = { ...message, message_id: 102 };
  const { transport, calls } = makeTransport({ sendMessage: [message, second] });
  assert.deepEqual(await transport.sendTelegramChunks('x'.repeat(3801)), [message, second]);
  assert.deepEqual(calls.map((call) => call.args[1]), ['x'.repeat(3800), 'x']);
});

test('chunk failure returns null and stops later sends without pretending partial delivery was complete', async () => {
  const { transport, calls } = makeTransport({ sendMessage: [message, apiError(403, 'Forbidden')] });
  assert.equal(await transport.sendTelegramChunks('123456789', -42, { maxLength: 3 }), null);
  assert.deepEqual(calls.map((call) => call.args[1]), ['123', '456']);
});

test('invalid or empty chunk input never calls the bot', async () => {
  const { transport, calls } = makeTransport();
  assert.equal(await transport.sendTelegramChunks('prefix<b>unclosed'), null);
  assert.equal(await transport.sendTelegramChunks('<b>12345</b>', -42, { maxLength: 7 }), null);
  assert.equal(await transport.sendTelegramChunks(''), null);
  assert.deepEqual(calls, []);
});

const renderedText = (html) => require('cheerio').load(html, {}, false).text();

const assertVisibleChunks = (source, limit, expectedText = renderedText(source)) => {
  const chunks = splitTelegramHtml(source, limit);
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= limit, `Oversized chunk: ${chunk.length}`);
    assert.ok(renderedText(chunk).trim(), `Whitespace-only chunk: ${JSON.stringify(chunk)}`);
  }
  assert.equal(chunks.map(renderedText).join(''), expectedText);
  return chunks;
};

test('a full formatted message plus a newline is rebalanced without losing rendered text', () => {
  const source = `<b>${'x'.repeat(3793)}</b>\n`;
  const chunks = assertVisibleChunks(source, 3800);
  assert.deepEqual(chunks, [`<b>${'x'.repeat(3792)}</b>`, '<b>x</b>\n']);
});

test('trailing whitespace inside and outside formatting stays with visible text', () => {
  for (const source of [
    '<b>12345\n</b>', '<b>12345</b>\n', '<b>1234</b><i>\n</i>',
    '<b>12345</b> \t\n', '<i>12345&#10;</i>', '12345&#32;',
  ]) {
    assertVisibleChunks(source, 16);
  }
  assertVisibleChunks('<b>12345\n</b>', 12);
  assertVisibleChunks('<b>12345</b> \t\n', 12);
  assertVisibleChunks('12345&#32;', 10);
});

test('boundary planning preserves ordinary leading and between-text whitespace', () => {
  for (const [source, limit] of [
    ['  abc', 3], ['ab  c', 2], ['ab   cde', 3], ['a  b  c', 3],
    ['<b>ab</b>  <i>cd</i>', 10], ['ab&#32;cd', 7],
  ]) {
    assertVisibleChunks(source, limit);
  }
});

test('long leading, trailing and between-text whitespace cannot create empty messages', () => {
  assertVisibleChunks(`a${' '.repeat(7000)}b`, 3800);
  assertVisibleChunks(`${' '.repeat(3799)}x`, 3800);
  assertVisibleChunks(`x${' '.repeat(3799)}`, 3800);
  assertVisibleChunks(`${' '.repeat(9000)}<b>Hello</b>`, 3800, 'Hello');
  assertVisibleChunks(`<b>Hello</b>${'\n'.repeat(9000)}`, 3800, 'Hello');
  assertVisibleChunks(`left  intact${' '.repeat(9000)}<i>right</i>`, 3800, 'left  intact right');
  assertVisibleChunks(`left${'\n'.repeat(9000)}right`, 3800, 'left\nright');
});

test('boundary planning preserves every feasible small whitespace arrangement', () => {
  const canPreserve = (source, limit) => {
    if (!source) return true;
    for (let end = 1; end <= Math.min(source.length, limit); end += 1) {
      if (source.slice(0, end).trim() && canPreserve(source.slice(end), limit)) return true;
    }
    return false;
  };
  for (let mask = 0; mask < 243; mask += 1) {
    let digits = mask;
    let source = '';
    for (let i = 0; i < 5; i += 1) {
      source += ['x', ' ', '\n'][digits % 3];
      digits = Math.floor(digits / 3);
    }
    for (const limit of [2, 3, 4]) {
      if (source.trim() && canPreserve(source, limit)) assertVisibleChunks(source, limit);
    }
  }
});

test('all-whitespace HTML, including entities, is rejected before any network operation', async () => {
  const { transport, calls } = makeTransport();
  for (const source of [' \t\r\n', '<b> \n</b>', '<i>&#32;&#10;</i>', '\u00a0', ' '.repeat(9000)]) {
    assert.deepEqual(splitTelegramHtml(source), []);
    assert.equal(await transport.sendTelegramChunks(source), null);
  }
  assert.deepEqual(calls, []);
});

test('a trailing newline alert reaches Telegram once per chunk with controls on the last visible message', async () => {
  const calls = [];
  const responses = [message, { ...message, message_id: 102 }];
  const waits = [];
  const transport = createTelegramTransport({
    config: { mode: 'polling', chatId: -42, sendRetryAttempts: 2, sendRetryDelaySeconds: 2 },
    bot: { sendMessage: async (chatId, html, options) => {
      calls.push({ chatId, html, options });
      if (!renderedText(html).trim()) throw apiError(400, 'Bad Request: message text is empty');
      return responses[calls.length - 1];
    } },
    logger: { error: () => {} },
    delay: async (ms) => waits.push(ms),
  });
  const source = `<b>${'x'.repeat(3793)}</b>\n`;
  assert.deepEqual(await transport.sendTelegramChunks(source, -42, {
    reply_markup: { inline_keyboard: [[{ text: 'Mute', callback_data: 'mute:90' }]] },
  }), responses);
  assert.deepEqual(calls, [
    { chatId: -42, html: `<b>${'x'.repeat(3792)}</b>`, options: { parse_mode: 'HTML' } },
    { chatId: -42, html: '<b>x</b>\n', options: { parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'Mute', callback_data: 'mute:90' }]] } } },
  ]);
  assert.deepEqual(waits, []);
});

const loadWiredTelegram = (mode) => {
  const { readFileSync } = require('node:fs');
  const { runInNewContext } = require('node:vm');
  const { createRequire } = require('node:module');
  const TelegramBot = require('node-telegram-bot-api');
  const filename = require.resolve('../src/telegram');
  const localRequire = createRequire(filename);
  const requests = [];
  class OfflineTelegramBot extends TelegramBot {
    _request(method, options) {
      requests.push(structuredClone({ method, ...options }));
      return Promise.resolve(method === 'answerCallbackQuery' ? true : message);
    }
  }
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, 'utf8'), {
    module, console, setTimeout,
    require: (id) => {
      if (id === 'dotenv') return { config: () => {} };
      if (id === 'node-telegram-bot-api') return OfflineTelegramBot;
      if (id === './config') return { config: { telegram: {
        mode, chatId: -42, token: 'test-only', polling: false,
        sendRetryAttempts: 0, sendRetryDelaySeconds: 2, pollingErrorLogThrottleSeconds: 60,
      } } };
      return localRequire(id);
    },
  }, { filename });
  return { telegram: module.exports, requests };
};

test('telegram.js wires the actual SDK and flat config into the message, edit and callback APIs', async () => {
  const { telegram, requests } = loadWiredTelegram('webhook');
  assert.strictEqual(await telegram.sendTelegramMessageResult('Hello'), message);
  assert.equal(await telegram.sendTelegramMessage('Legacy'), true);
  assert.equal(await telegram.sendTelegramPhoto('https://example.com/photo.png', '<b>Caption</b>'), true);
  assert.strictEqual(await telegram.editTelegramMessage('Updated', -99, 101), message);
  assert.strictEqual(await telegram.editTelegramReplyMarkup(-99, 101, { inline_keyboard: [] }), message);
  assert.equal(await telegram.answerTelegramCallback('query-id', { text: 'Muted' }), true);
  assert.deepEqual(await telegram.sendTelegramChunks('123456', -99, {
    maxLength: 3, reply_markup: { inline_keyboard: [] },
    reply_parameters: { message_id: 90 }, disable_notification: true,
  }), [message, message]);
  assert.deepEqual(telegram.splitTelegramHtml('<b>123456</b>', 10), ['<b>123</b>', '<b>456</b>']);
  assert.deepEqual(requests, [
    { method: 'sendMessage', form: { chat_id: -42, text: 'Hello', parse_mode: 'HTML' } },
    { method: 'sendMessage', form: { chat_id: -42, text: 'Legacy', parse_mode: 'HTML' } },
    { method: 'sendPhoto', qs: { chat_id: -42, caption: '<b>Caption</b>', parse_mode: 'HTML', photo: 'https://example.com/photo.png' }, formData: null },
    { method: 'editMessageText', form: { chat_id: -99, message_id: 101, text: 'Updated', parse_mode: 'HTML' } },
    { method: 'editMessageReplyMarkup', form: { chat_id: -99, message_id: 101, reply_markup: { inline_keyboard: [] } } },
    { method: 'answerCallbackQuery', form: { callback_query_id: 'query-id', text: 'Muted' } },
    { method: 'sendMessage', form: { chat_id: -99, text: '123', parse_mode: 'HTML', disable_notification: true,
      reply_parameters: { message_id: 90, allow_sending_without_reply: true } } },
    { method: 'sendMessage', form: { chat_id: -99, text: '456', parse_mode: 'HTML', disable_notification: true,
      reply_parameters: { message_id: 90, allow_sending_without_reply: true }, reply_markup: { inline_keyboard: [] } } },
  ]);
});

test('disabled telegram.js wiring makes no SDK requests including webhook registration', async () => {
  const { telegram, requests } = loadWiredTelegram('disabled');
  assert.equal(telegram.bot.options.polling, false);
  assert.equal(await telegram.sendTelegramMessage('Hello'), false);
  assert.equal(await telegram.sendTelegramMessageResult('Hello'), null);
  assert.equal(await telegram.sendTelegramPhoto('photo', 'Caption'), false);
  assert.equal(await telegram.sendTelegramChunks('Hello'), null);
  assert.equal(await telegram.editTelegramMessage('Updated', -42, 101), null);
  assert.equal(await telegram.editTelegramReplyMarkup(-42, 101, { inline_keyboard: [] }), null);
  assert.equal(await telegram.answerTelegramCallback('query-id'), false);
  assert.equal(await telegram.registerTelegramWebhook({}), false);
  assert.deepEqual(requests, []);
});
