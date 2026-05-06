import { query, } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Extract accumulated text from an SDK assistant message's content blocks.
 */
function extractText(msg) {
    const content = msg.message?.content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
}
/**
 * Extract session_id from any SDKMessage that carries one.
 */
function getSessionId(msg) {
    if ("session_id" in msg) {
        return msg.session_id;
    }
    return undefined;
}
/**
 * Build an async iterable yielding a single SDKUserMessage with optional
 * image content blocks.  The session_id is set to "" — the SDK assigns the
 * real session id once the process starts.
 */
async function* singleUserMessage(text, images) {
    const contentBlocks = [{ type: "text", text }];
    if (images?.length) {
        for (const img of images) {
            contentBlocks.push({
                type: "image",
                source: {
                    type: "base64",
                    media_type: img.source.media_type,
                    data: img.source.data,
                },
            });
        }
    }
    const msg = {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: {
            role: "user",
            content: contentBlocks,
        },
    };
    yield msg;
}
// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
export async function claudeQuery(options) {
    const { prompt, cwd, resume, model, permissionMode, images, onPermissionRequest, } = options;
    logger.info("Starting Claude query", {
        cwd,
        model,
        permissionMode,
        resume: !!resume,
        hasImages: !!images?.length,
    });
    // When images are present we use the multi-content AsyncIterable path;
    // otherwise a plain string is simpler and sufficient.
    const hasImages = images && images.length > 0;
    const promptParam = hasImages
        ? singleUserMessage(prompt, images)
        : prompt;
    // --- Build SDK options ---
    const stderrChunks = [];
    const sdkOptions = {
        cwd,
        permissionMode,
        settingSources: ["user", "project"],
        stderr: (data) => {
            stderrChunks.push(data);
            logger.debug("Claude subprocess stderr", { data: data.slice(0, 500) });
        },
    };
    if (model)
        sdkOptions.model = model;
    if (resume)
        sdkOptions.resume = resume;
    // Permission callback — bridges the SDK's CanUseTool to our simpler handler.
    if (onPermissionRequest) {
        const canUseTool = async (toolName, input) => {
            const inputStr = JSON.stringify(input);
            logger.info("Permission request from SDK", { toolName });
            try {
                const allowed = await onPermissionRequest(toolName, inputStr);
                if (allowed) {
                    return { behavior: "allow", updatedInput: input };
                }
                return {
                    behavior: "deny",
                    message: "Permission denied by user.",
                    interrupt: true,
                };
            }
            catch (err) {
                logger.error("Permission handler error", { toolName, err });
                return {
                    behavior: "deny",
                    message: "Permission check failed.",
                    interrupt: true,
                };
            }
        };
        sdkOptions.canUseTool = canUseTool;
    }
    // --- Execute query & accumulate output ---
    let sessionId = "";
    const textParts = [];
    let errorMessage;
    try {
        const result = query({ prompt: promptParam, options: sdkOptions });
        for await (const message of result) {
            const sid = getSessionId(message);
            if (sid)
                sessionId = sid;
            // Log every message type for debugging
            logger.debug("SDK message received", {
                type: message.type,
                subtype: message.subtype,
                hasSessionId: !!sid,
            });
            switch (message.type) {
                case "assistant": {
                    const text = extractText(message);
                    if (text) {
                        textParts.push(text);
                        logger.debug("Assistant text extracted", { textLength: text.length, preview: text.slice(0, 200) });
                    }
                    break;
                }
                case "result": {
                    const rm = message;
                    logger.info("SDK result message", {
                        subtype: rm.subtype,
                        hasResult: "result" in rm,
                        resultPreview: "result" in rm ? String(rm.result).slice(0, 200) : undefined,
                        hasErrors: "errors" in rm,
                        errors: "errors" in rm ? rm.errors : undefined,
                    });
                    if (rm.subtype === "success" && "result" in rm) {
                        if (rm.result) {
                            const combined = textParts.join("");
                            if (!combined.includes(rm.result)) {
                                textParts.push(rm.result);
                            }
                        }
                    }
                    else if ("errors" in rm && rm.errors.length > 0) {
                        errorMessage = rm.errors.join("; ");
                        logger.error("SDK returned error result", { errors: rm.errors });
                    }
                    break;
                }
                case "system": {
                    logger.debug("SDK system message", {
                        subtype: message.subtype,
                    });
                    break;
                }
                default:
                    // Log unknown message types
                    logger.debug("SDK other message", {
                        type: message.type,
                        keys: Object.keys(message),
                    });
                    break;
            }
        }
    }
    catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        const stderrOutput = stderrChunks.join("").slice(0, 2000);
        logger.error("Claude query threw", { error: errorMessage, stderr: stderrOutput || "(empty)" });
    }
    const fullText = textParts.join("\n").trim();
    if (!fullText && !errorMessage) {
        errorMessage = "Claude returned an empty response.";
    }
    logger.info("Claude query completed", {
        sessionId,
        textLength: fullText.length,
        hasError: !!errorMessage,
    });
    return {
        text: fullText,
        sessionId,
        error: errorMessage,
    };
}
