import { describe, expect, it } from "vitest";

import {
  appWindow,
  launchesTemporarySession,
  quitRequested,
} from "./app-window.js";

describe("appWindow", () => {
  it("brings back setup that was closed before this computer connected", () => {
    expect(appWindow({ enrolled: false, setupOpen: false })).toBe("setup");
  });

  it("keeps setup in front while it is open", () => {
    expect(appWindow({ enrolled: true, setupOpen: true })).toBe("setup");
  });

  it("opens the main window once this computer is connected", () => {
    expect(appWindow({ enrolled: true, setupOpen: false })).toBe("main");
  });
});

describe("quitRequested", () => {
  it("quits for the uninstaller, as the second instance or the only one", () => {
    expect(quitRequested(["Linger.exe", "--quit"])).toBe(true);
    expect(quitRequested(["Linger.exe", "--background"])).toBe(false);
  });
});

describe("launchesTemporarySession", () => {
  it("opens a temporary session on an ordinary launch of a supported build", () => {
    expect(launchesTemporarySession(["Linger"], true, false)).toBe(true);
  });

  it.each(["--regular", "--background", "--quit"])(
    "keeps the explicit %s launch path",
    (flag) => {
      expect(launchesTemporarySession(["Linger", flag], true, false)).toBe(
        false,
      );
    },
  );

  it("leaves a supervised session and an unsupported build on their own startup paths", () => {
    expect(launchesTemporarySession(["Linger"], true, true)).toBe(false);
    expect(launchesTemporarySession(["Linger"], false, false)).toBe(false);
  });
});
