const { load } = require('cheerio');

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

const sharedTagDepth = (left, right) => {
  let depth = 0;
  while (depth < left.length && left[depth] === right[depth]) depth += 1;
  return depth;
};

const renderHtmlUnits = (units) => {
  let previous = [];
  let html = '';
  for (const unit of units) {
    const shared = sharedTagDepth(previous, unit.tags);
    html += previous.slice(shared).reverse().map((tag) => tag.closing).join('');
    html += unit.tags.slice(shared).map((tag) => tag.raw).join('') + unit.raw;
    previous = unit.tags;
  }
  return html + previous.slice().reverse().map((tag) => tag.closing).join('');
};

const planHtmlChunks = (units, maxLength) => {
  const size = units.length;
  const lengths = [0];
  const sharedLengths = [];
  for (let i = 0; i < size; i += 1) {
    const shared = sharedTagDepth(units[i - 1]?.tags || [], units[i].tags);
    sharedLengths[i] = units[i].tags.slice(0, shared)
      .reduce((length, tag) => length + tag.raw.length + tag.closing.length, 0);
    lengths[i + 1] = lengths[i] + units[i].raw.length + units[i].wrapperLength - sharedLengths[i];
  }
  const lengthOf = (start, end) => lengths[end] - lengths[start] + sharedLengths[start];
  const furthest = [];
  for (let start = 0, end = 0; start < size; start += 1) {
    end = Math.max(start, end);
    while (end < size && lengthOf(start, end + 1) <= maxLength) end += 1;
    furthest[start] = end;
  }

  // A cut is legal only if both its chunk and the remaining suffix can contain
  // visible text. Suffix counts make these reachability checks constant-time.
  const finishable = Array(size + 1).fill(false);
  const suffixCounts = Array(size + 2).fill(0);
  finishable[size] = true;
  suffixCounts[size] = 1;
  for (let start = size - 1, nextVisible = size; start >= 0; start -= 1) {
    if (units[start].visible) nextVisible = start;
    finishable[start] = nextVisible < furthest[start] &&
      suffixCounts[nextVisible + 1] > suffixCounts[furthest[start] + 1];
    suffixCounts[start] = suffixCounts[start + 1] + Number(finishable[start]);
  }
  if (!finishable[0]) return null;
  const previousCut = [];
  for (let i = 0, cut = 0; i <= size; i += 1) {
    if (finishable[i]) cut = i;
    previousCut[i] = cut;
  }
  const chunks = [];
  for (let start = 0; start < size;) {
    const end = previousCut[furthest[start]];
    chunks.push(renderHtmlUnits(units.slice(start, end)));
    start = end;
  }
  return chunks;
};

const splitTelegramHtml = (text, maxLength = 3800) => {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) throw new RangeError('Invalid Telegram chunk limit');
  if (typeof text !== 'string') throw new TypeError('Telegram HTML must be a string');
  const $ = load(text, { xml: { decodeEntities: false, withStartIndices: true, withEndIndices: true } }, false);
  const tokens = [];
  const malformed = () => { throw new Error('Malformed Telegram HTML'); };
  const visit = (node) => {
    if (node.type === 'text') {
      tokens.push({ type: 'text', raw: node.data });
      return;
    }
    if (node.type !== 'tag' || !['b', 'i', 'code', 'a'].includes(node.name)) malformed();
    const source = text.slice(node.startIndex, node.endIndex + 1);
    // The parser supplies structure; source slices retain quotes and entity spelling.
    const opening = source.match(/^<(?:[^>"']|"[^"]*"|'[^']*')+>/)?.[0];
    const closing = source.match(/<\/(b|i|code|a)\s*>$/);
    if (!opening || !closing || closing[1] !== node.name) malformed();
    tokens.push({ type: 'open', raw: opening, closing: closing[0] });
    node.children.forEach(visit);
    tokens.push({ type: 'close', raw: closing[0] });
  };
  $.root()[0].children.forEach(visit);
  // Reject parser repairs, such as silently discarded or mismatched closing tags.
  if (tokens.map((token) => token.raw).join('') !== text) malformed();

  const units = [];
  let tags = [];
  let wrapperLength = 0;
  for (const token of tokens) {
    if (token.type === 'open') {
      tags = [...tags, token];
      wrapperLength += token.raw.length + token.closing.length;
    } else if (token.type === 'close') {
      const opening = tags.at(-1);
      wrapperLength -= opening.raw.length + opening.closing.length;
      tags = tags.slice(0, -1);
    } else {
      const parts = token.raw.split(/(&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi);
      for (let i = 0; i < parts.length; i += 1) {
        const segments = i % 2 ? [{ segment: parts[i] }] : graphemes.segment(parts[i]);
        for (const { segment } of segments) {
          const rendered = i % 2 ? load(segment, { xml: true }, false).text() : segment;
          units.push({ raw: segment, tags, wrapperLength, visible: Boolean(rendered.trim()),
            newline: /[\r\n]/.test(rendered) });
        }
      }
    }
  }
  if (!units.some((unit) => unit.visible)) return [];
  if (units.some((unit) => unit.visible && unit.raw.length + unit.wrapperLength > maxLength)) {
    throw new RangeError('Telegram HTML token and its formatting exceed the chunk limit');
  }
  if (text.length <= maxLength) return [text];
  let chunks = planHtmlChunks(units, maxLength);
  if (chunks) return chunks;

  // Some whitespace runs cannot fit beside any visible text. Normalize the
  // largest runs only as needed, preserving ordinary spacing everywhere else.
  const runs = [];
  for (const unit of units) {
    if (runs.at(-1)?.visible !== unit.visible) runs.push({ visible: unit.visible, units: [], length: 0 });
    runs.at(-1).units.push(unit);
    runs.at(-1).length += unit.raw.length;
  }
  const whitespace = runs.filter((run) => !run.visible).sort((left, right) => right.length - left.length);
  for (const run of whitespace) {
    const edge = run === runs[0] || run === runs.at(-1);
    run.units = edge ? [] : [{ raw: run.units.some((unit) => unit.newline) ? '\n' : ' ',
      tags: [], wrapperLength: 0, visible: false }];
    chunks = planHtmlChunks(runs.flatMap((part) => part.units), maxLength);
    if (chunks) return chunks;
  }
  throw new RangeError('Telegram whitespace cannot fit beside visible text within the chunk limit');
};

const isMessage = (value) => Number.isSafeInteger(value?.message_id) && value.message_id > 0;

// config is the flat config.telegram object, not the application's root config.
const createTelegramTransport = ({
  bot,
  config,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
}) => {
  const retryAttempts = config.sendRetryAttempts ?? 2;
  const retryDelayMs = (config.sendRetryDelaySeconds ?? 2) * 1000;
  const enabled = () => config.mode !== 'disabled';

  const request = async (label, operation, { edit = false, removeReply } = {}) => {
    if (!enabled()) return null;
    let retries = 0;
    let removedReply = false;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        const body = error?.response?.body;
        const status = Number(body?.error_code || error?.response?.statusCode);
        const description = String(body?.description || error?.message || '');
        if (edit && status === 400 && /message is not modified/i.test(description)) return true;

        if (status === 400 && removeReply && !removedReply &&
          /message to be replied(?: to)? (?:not found|is not found)|reply_message_id_invalid/i.test(description)) {
          removeReply();
          removedReply = true;
          continue;
        }

        // Error messages and SDK error objects can contain the bot token in URLs.
        const statusLabel = Number.isInteger(status) && status >= 100 && status <= 599 ?
          `HTTP ${status}` : 'network error';
        logger.error(`${label} failed (${retries + 1}/${retryAttempts + 1}; ${statusLabel})`);
        const transient = !status || status === 429 || (status >= 500 && status < 600);
        if (!transient || retries >= retryAttempts) return null;
        retries += 1;
        const retryAfterMs = Number(body?.parameters?.retry_after) * 1000;
        await delay(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ?
          Math.max(retryDelayMs, retryAfterMs) : retryDelayMs);
      }
    }
  };

  const sendTelegramMessageResult = async (text, targetChatId = config.chatId, options = {}) => {
    const recipient = targetChatId ?? config.chatId;
    if (!enabled() || !recipient) return null;
    const payload = { parse_mode: 'HTML' };
    if (options.disable_notification !== undefined) payload.disable_notification = options.disable_notification;
    if (options.reply_markup !== undefined) payload.reply_markup = options.reply_markup;
    if (options.reply_parameters) payload.reply_parameters = {
      ...options.reply_parameters,
      allow_sending_without_reply: true,
    };
    const result = await request('Telegram Send', () => (
      bot.sendMessage(recipient, text, structuredClone(payload))
    ), {
      removeReply: payload.reply_parameters ? () => { delete payload.reply_parameters; } : undefined,
    });
    return isMessage(result) ? result : null;
  };

  const sendTelegramMessage = async (text, targetChatId = config.chatId) => (
    (await sendTelegramMessageResult(text, targetChatId)) !== null
  );

  const sendTelegramPhoto = async (photoUrl, captionText, targetChatId = config.chatId) => {
    const recipient = targetChatId ?? config.chatId;
    if (!enabled() || !recipient) return false;
    return Boolean(await request('Telegram Photo Send', () => (
      bot.sendPhoto(recipient, photoUrl, { caption: captionText, parse_mode: 'HTML' })
    )));
  };

  const editTelegramMessage = async (text, targetChatId, messageId, options = {}) => {
    const recipient = targetChatId ?? config.chatId;
    if (!enabled() || !recipient || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
    const payload = { chat_id: recipient, message_id: messageId, parse_mode: 'HTML' };
    if (options.reply_markup !== undefined) payload.reply_markup = options.reply_markup;
    const result = await request('Telegram Edit', () => (
      bot.editMessageText(text, structuredClone(payload))
    ), { edit: true });
    return result === true || isMessage(result) ? result : null;
  };

  const editTelegramReplyMarkup = async (targetChatId, messageId, replyMarkup) => {
    const recipient = targetChatId ?? config.chatId;
    if (!enabled() || !recipient || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
    const result = await request('Telegram Markup Edit', () => (
      bot.editMessageReplyMarkup(structuredClone(replyMarkup), { chat_id: recipient, message_id: messageId })
    ), { edit: true });
    return result === true || isMessage(result) ? result : null;
  };

  const answerTelegramCallback = async (id, options = {}) => {
    if (!enabled() || !id) return false;
    return (await request('Telegram Callback', () => (
      bot.answerCallbackQuery(id, structuredClone(options))
    ))) === true;
  };

  const sendTelegramChunks = async (text, targetChatId = config.chatId, options = {}) => {
    if (!enabled() || !(targetChatId ?? config.chatId)) return null;
    let chunks;
    try {
      chunks = splitTelegramHtml(text, options.maxLength ?? 3800);
    } catch {
      logger.error('Telegram chunking failed: invalid HTML or chunk limit');
      return null;
    }
    if (!chunks.length) return null;
    const messages = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunkOptions = { ...options };
      // The persisted last message owns the callback keyboard for the whole alert.
      if (i < chunks.length - 1) delete chunkOptions.reply_markup;
      const result = await sendTelegramMessageResult(chunks[i], targetChatId, chunkOptions);
      if (!result) return null;
      messages.push(result);
    }
    return messages;
  };

  return {
    sendTelegramMessage, sendTelegramMessageResult, sendTelegramPhoto,
    editTelegramMessage, editTelegramReplyMarkup, answerTelegramCallback, sendTelegramChunks,
  };
};

module.exports = { createTelegramTransport, splitTelegramHtml };
