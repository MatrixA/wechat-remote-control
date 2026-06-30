// WeChat Work (企业微信) protocol type definitions
// Extracted from the ClawBot WeChat plugin API
// ── Enums ──────────────────────────────────────────────────────────────────
export var MessageType;
(function (MessageType) {
    MessageType[MessageType["USER"] = 1] = "USER";
    MessageType[MessageType["BOT"] = 2] = "BOT";
})(MessageType || (MessageType = {}));
export var MessageItemType;
(function (MessageItemType) {
    MessageItemType[MessageItemType["TEXT"] = 1] = "TEXT";
    MessageItemType[MessageItemType["IMAGE"] = 2] = "IMAGE";
    MessageItemType[MessageItemType["VOICE"] = 3] = "VOICE";
    MessageItemType[MessageItemType["FILE"] = 4] = "FILE";
    MessageItemType[MessageItemType["VIDEO"] = 5] = "VIDEO";
})(MessageItemType || (MessageItemType = {}));
export var MessageState;
(function (MessageState) {
    MessageState[MessageState["NEW"] = 0] = "NEW";
    MessageState[MessageState["GENERATING"] = 1] = "GENERATING";
    MessageState[MessageState["FINISH"] = 2] = "FINISH";
})(MessageState || (MessageState = {}));
