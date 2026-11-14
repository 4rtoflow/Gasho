import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampPanelWidth,
  clampSidebarWidth,
  defaultPanelWidth,
  parseWidth,
} from "../src/lib/widths.ts";

test("a saved width is a whole number of px within the range, and anything else is none", () => {
  const clamp = (width: number) => clampSidebarWidth(width);
  assert.equal(parseWidth("300", clamp), 300);
  assert.equal(parseWidth("300.6", clamp), 301);
  assert.equal(parseWidth("999", clamp), SIDEBAR_WIDTH_MAX);
  assert.equal(parseWidth("10", clamp), SIDEBAR_WIDTH_MIN);
  for (const saved of [null, "", " ", "wide", "Infinity", "NaN"]) assert.equal(parseWidth(saved, clamp), null, String(saved));
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

test("a session's side panel leaves the conversation as much as the narrowest computer screen does", () => {
  // 40% of the window when none is saved, as before it could be dragged.
  assert.equal(defaultPanelWidth(768), PANEL_WIDTH_MIN);
  assert.equal(defaultPanelWidth(1280), 512);
  assert.equal(defaultPanelWidth(1920), PANEL_WIDTH_MAX);
  // The room is the window but the sidebar: 768 − 248 leaves the narrowest panel, 1280 − 360 the widest.
  assert.equal(clampPanelWidth(PANEL_WIDTH_MAX, 768 - SIDEBAR_WIDTH_DEFAULT), PANEL_WIDTH_MIN);
  assert.equal(clampPanelWidth(PANEL_WIDTH_MAX, 1000 - SIDEBAR_WIDTH_MAX), 500);
  assert.equal(clampPanelWidth(PANEL_WIDTH_MAX, 1280 - SIDEBAR_WIDTH_MAX), PANEL_WIDTH_MAX);
  assert.equal(clampPanelWidth(300, 1280), PANEL_WIDTH_MIN);
});
