import { test, expect } from 'bun:test';
import { chromeExtraFlags } from '../server/lib/chrome.ts';

const NO_SANDBOX = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

test('chrome runs without its sandbox inside a container — Docker, a Kubernetes pod, or when asked', () => {
  expect(chromeExtraFlags({}, false)).toEqual([]); // a native host keeps the sandbox
  expect(chromeExtraFlags({}, true)).toEqual(NO_SANDBOX); // /.dockerenv
  expect(chromeExtraFlags({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, false)).toEqual(NO_SANDBOX); // containerd pod: no /.dockerenv
  expect(chromeExtraFlags({ CHROME_NO_SANDBOX: '1' }, false)).toEqual(NO_SANDBOX);
  expect(chromeExtraFlags({ CHROME_NO_SANDBOX: '0', KUBERNETES_SERVICE_HOST: '10.0.0.1' }, true)).toEqual([]); // explicit opt-out wins
});
