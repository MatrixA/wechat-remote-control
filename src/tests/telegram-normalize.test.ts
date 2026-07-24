import { test } from 'node:test';
import assert from 'node:assert';

import { normalizeUpdate } from '../telegram/monitor.js';
import type { TgUpdate } from '../telegram/types.js';

const privateChat = { id: 42, type: 'private', username: 'alice' };
const forumChat = { id: -1001234567890, type: 'supergroup', title: 'wrc', is_forum: true };

test('normalizeUpdate maps a text message', () => {
  const u: TgUpdate = {
    update_id: 1,
    message: { message_id: 10, chat: privateChat, from: { id: 7, is_bot: false, username: 'alice' }, date: 0, text: 'hello' },
  };
  assert.deepStrictEqual(normalizeUpdate(u), {
    target: '42', replyToken: '', text: 'hello', kind: 'text', userKey: '7', messageId: '10',
  });
});

test('normalizeUpdate encodes a forum-topic message as chatId:threadId', () => {
  const u: TgUpdate = {
    update_id: 8,
    message: {
      message_id: 20, chat: forumChat, from: { id: 7, is_bot: false }, date: 0,
      text: 'run tests', message_thread_id: 55, is_topic_message: true,
    },
  };
  assert.deepStrictEqual(normalizeUpdate(u), {
    target: '-1001234567890:55', replyToken: '', text: 'run tests', kind: 'text', userKey: '7', messageId: '20',
  });
});

test('normalizeUpdate keeps a General-topic message on the plain chat target', () => {
  // General has no is_topic_message/message_thread_id → plain chat id.
  const u: TgUpdate = {
    update_id: 9,
    message: { message_id: 21, chat: forumChat, from: { id: 7, is_bot: false }, date: 0, text: '/ls' },
  };
  assert.strictEqual(normalizeUpdate(u)?.target, '-1001234567890');
});

test('normalizeUpdate ignores a bare message_thread_id without is_topic_message', () => {
  // Replies in plain chats carry message_thread_id too — must NOT become a topic target.
  const u: TgUpdate = {
    update_id: 10,
    message: { message_id: 22, chat: privateChat, from: { id: 7, is_bot: false }, date: 0, text: 'hi', message_thread_id: 99 },
  };
  assert.strictEqual(normalizeUpdate(u)?.target, '42');
});

test('normalizeUpdate maps a callback_query (button tap)', () => {
  const u: TgUpdate = {
    update_id: 2,
    callback_query: {
      id: 'cb-1', from: { id: 7, is_bot: false },
      message: { message_id: 11, chat: privateChat, date: 0 },
      data: 'quiz:1:0:1',
    },
  };
  assert.deepStrictEqual(normalizeUpdate(u), {
    target: '42', replyToken: 'cb-1', text: '', kind: 'callback', callbackData: 'quiz:1:0:1', userKey: '7',
    messageId: '11',
  });
});

test('normalizeUpdate routes a callback tapped inside a topic back into that topic', () => {
  const u: TgUpdate = {
    update_id: 11,
    callback_query: {
      id: 'cb-2', from: { id: 7, is_bot: false },
      message: { message_id: 30, chat: forumChat, date: 0, message_thread_id: 55, is_topic_message: true },
      data: 'sw:1',
    },
  };
  assert.strictEqual(normalizeUpdate(u)?.target, '-1001234567890:55');
});

test('normalizeUpdate flags unsupported media with a note', () => {
  const photo = normalizeUpdate({ update_id: 3, message: { message_id: 12, chat: privateChat, date: 0, photo: [{}] } });
  assert.strictEqual(photo?.kind, 'unsupported_media');
  assert.ok(photo?.mediaNote && photo.mediaNote.includes('图片'));

  const voice = normalizeUpdate({ update_id: 4, message: { message_id: 13, chat: privateChat, date: 0, voice: {} } });
  assert.strictEqual(voice?.kind, 'unsupported_media');
  assert.ok(voice?.mediaNote && voice.mediaNote.includes('语音'));
});

test('normalizeUpdate returns null for unroutable / service updates', () => {
  assert.strictEqual(normalizeUpdate({ update_id: 5 }), null);
  // callback without a message can't be replied to
  assert.strictEqual(
    normalizeUpdate({ update_id: 6, callback_query: { id: 'x', from: { id: 1, is_bot: false }, data: 'sw:0' } }),
    null,
  );
});

test('normalizeUpdate falls back to chat id for userKey when no sender', () => {
  const u: TgUpdate = { update_id: 7, message: { message_id: 14, chat: privateChat, date: 0, text: 'hi' } };
  assert.strictEqual(normalizeUpdate(u)?.userKey, '42');
});

test('normalizeUpdate maps a forum_topic_edited service message to topic_edited', () => {
  const u: TgUpdate = {
    update_id: 12,
    message: {
      message_id: 40, chat: forumChat, from: { id: 7, is_bot: false }, date: 0,
      message_thread_id: 55, forum_topic_edited: { name: 'mywork' },
    },
  };
  assert.deepStrictEqual(normalizeUpdate(u), {
    target: '-1001234567890:55', replyToken: '', text: '', kind: 'topic_edited',
    topicName: 'mywork', userKey: '7', messageId: '40',
  });
});

test('normalizeUpdate drops icon-only and threadless topic edits', () => {
  // Icon change only — no name to sync.
  assert.strictEqual(normalizeUpdate({
    update_id: 13,
    message: { message_id: 41, chat: forumChat, date: 0, message_thread_id: 55, forum_topic_edited: { icon_custom_emoji_id: 'x' } },
  }), null);
  // No thread id — can't map to a topic.
  assert.strictEqual(normalizeUpdate({
    update_id: 14,
    message: { message_id: 42, chat: forumChat, date: 0, forum_topic_edited: { name: 'mywork' } },
  }), null);
});
