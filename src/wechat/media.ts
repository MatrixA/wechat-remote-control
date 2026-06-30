import type { MessageItem } from './types.js';

// The bridge does not download inbound WeChat media — normalizeWeixinMessage (in
// transport.ts) replies with a "not supported" notice for image/voice/file/video.
// The former CDN download pipeline (download*, the cdn.ts download half, crypto.ts)
// was never reached and has been removed; recover from git history if needed.
// extractText is the only live helper: it pulls the text body out of a message item.
export function extractText(item: MessageItem): string {
  return item.text_item?.text ?? '';
}
