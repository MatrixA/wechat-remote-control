import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeUpdate } from '../telegram/monitor.js';
const privateChat = { id: 42, type: 'private', username: 'alice' };
test('normalizeUpdate maps a text message', () => {
    const u = {
        update_id: 1,
        message: { message_id: 10, chat: privateChat, from: { id: 7, is_bot: false, username: 'alice' }, date: 0, text: 'hello' },
    };
    assert.deepStrictEqual(normalizeUpdate(u), {
        target: '42', replyToken: '', text: 'hello', kind: 'text', userKey: '7',
    });
});
test('normalizeUpdate maps a callback_query (button tap)', () => {
    const u = {
        update_id: 2,
        callback_query: {
            id: 'cb-1', from: { id: 7, is_bot: false },
            message: { message_id: 11, chat: privateChat, date: 0 },
            data: 'quiz:0:1',
        },
    };
    assert.deepStrictEqual(normalizeUpdate(u), {
        target: '42', replyToken: 'cb-1', text: '', kind: 'callback', callbackData: 'quiz:0:1', userKey: '7',
    });
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
    assert.strictEqual(normalizeUpdate({ update_id: 6, callback_query: { id: 'x', from: { id: 1, is_bot: false }, data: 'sw:0' } }), null);
});
test('normalizeUpdate falls back to chat id for userKey when no sender', () => {
    const u = { update_id: 7, message: { message_id: 14, chat: privateChat, date: 0, text: 'hi' } };
    assert.strictEqual(normalizeUpdate(u)?.userKey, '42');
});
