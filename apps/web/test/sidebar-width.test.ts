import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  parseSidebarWidth,
} from "../src/lib/sidebar-width.ts";

test("a saved sidebar width is a whole number of px within the range, and anything else is the default width", () => {
  assert.equal(parseSidebarWidth("300"), 300);
  assert.equal(parseSidebarWidth("300.6"), 301);
  assert.equal(parseSidebarWidth("999"), SIDEBAR_WIDTH_MAX);
  assert.equal(parseSidebarWidth("10"), SIDEBAR_WIDTH_MIN);
  for (const saved of [null, "", " ", "wide", "Infinity", "NaN"]) assert.equal(parseSidebarWidth(saved), SIDEBAR_WIDTH_DEFAULT, String(saved));
});

test("on a narrow window the sidebar is no wider than the default width leaves the narrowest computer screen", () => {
  // The narrowest computer screen (768px): the conversation keeps what it has beside the default width.
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX, 768), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(220, 768), 220);
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX, 800), 280);
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX, 1280), SIDEBAR_WIDTH_MAX);
  // Never below the narrowest width, however small the window.
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX, 500), SIDEBAR_WIDTH_MIN);
});
