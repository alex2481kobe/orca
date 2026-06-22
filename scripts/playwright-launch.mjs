import process from 'node:process';

export async function launchChromium(pw, options = {}) {
  const launchOptions = { headless: true, ...options };
  const executablePath = String(process.env.ORCA_PLAYWRIGHT_EXECUTABLE || '').trim();
  if (executablePath) {
    return pw.chromium.launch({ ...launchOptions, executablePath });
  }
  const configuredChannel = String(process.env.ORCA_PLAYWRIGHT_CHANNEL || '').trim();
  if (configuredChannel) {
    return pw.chromium.launch({ ...launchOptions, channel: configuredChannel });
  }
  try {
    return await pw.chromium.launch(launchOptions);
  } catch (error) {
    const fallbacks = ['chrome', 'msedge'];
    for (const channel of fallbacks) {
      try {
        console.warn(`[playwright-launch] bundled Chromium unavailable; trying system ${channel}.`);
        return await pw.chromium.launch({ ...launchOptions, channel });
      } catch {
        // Try the next installed-channel fallback.
      }
    }
    throw error;
  }
}
