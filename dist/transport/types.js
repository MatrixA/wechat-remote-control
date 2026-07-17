/**
 * IM transport abstraction.
 *
 * The bridge core (src/index.js) drives a tmux-hosted coding agent and forwards
 * its output to an instant-messenger. WeChat was hard-coded throughout; this
 * interface lets a second IM (Telegram) plug in without the core knowing which
 * transport it talks to.
 *
 * The single most important idea: a reply destination is an OPAQUE `target`
 * string that only the transport understands. WeChat encodes its
 * `(userId, contextToken)` couple into one string; Telegram uses `String(chatId)`
 * or `"<chatId>:<threadId>"` for a forum-topic destination. The core never
 * parses `target` — it just hands it back to the transport.
 */
export {};
