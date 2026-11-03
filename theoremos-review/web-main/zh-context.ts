// Review-only harness adaptation: LANG does not select Chromium's locale on this macOS host.
// Does not change application code or assertions.
import { chromium } from 'playwright';
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const context = browser.newContext.bind(browser);
  browser.newContext = options => context({ locale: 'zh-CN', ...options });
  return browser;
};
