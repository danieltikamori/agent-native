function isFalsy(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

const chromeExtensionUrl =
  import.meta.env.VITE_CLIPS_CHROME_EXTENSION_URL?.trim() ??
  "https://chromewebstore.google.com/detail/baoipacpchggcdigagnajakiidcgcffn";

// The Chrome extension is published to the Web Store, so the recorder picker
// shows it by default. Set VITE_CLIPS_CHROME_EXTENSION_ENABLED=0 (or false/no/
// off) to hide it again — e.g. a deployment that only ships the desktop app.
export const clipsChromeExtensionEnabled = !isFalsy(
  import.meta.env.VITE_CLIPS_CHROME_EXTENSION_ENABLED,
);

export const clipsChromeExtensionUrl = chromeExtensionUrl || null;
