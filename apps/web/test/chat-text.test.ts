import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_TEXT_DEFAULT, CHAT_TEXT_MAX, CHAT_TEXT_MIN, chatTextStyle, clampChatTextSize, parseChatTextSize } from "../src/lib/chat-text.ts";

test("a saved text size is a whole number of px within the range, and anything else is the standard size", () => {
  assert.equal(parseChatTextSize("16"), 16);
  assert.equal(parseChatTextSize("15.6"), 16);
  assert.equal(parseChatTextSize("99"), CHAT_TEXT_MAX);
  assert.equal(parseChatTextSize("3"), CHAT_TEXT_MIN);
  for (const saved of [null, "", " ", "large", "Infinity", "NaN"]) assert.equal(parseChatTextSize(saved), CHAT_TEXT_DEFAULT, String(saved));
  assert.equal(clampChatTextSize(CHAT_TEXT_MIN - 1), CHAT_TEXT_MIN);
  assert.equal(clampChatTextSize(CHAT_TEXT_MAX + 1), CHAT_TEXT_MAX);
});

test("the conversation's text is scaled by the size picked over the standard size", () => {
  assert.deepEqual(chatTextStyle(CHAT_TEXT_DEFAULT), { "--chat-scale": 1 });
  assert.deepEqual(chatTextStyle(CHAT_TEXT_DEFAULT * 1.5), { "--chat-scale": 1.5 });
});
