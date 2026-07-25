// Drive the Firebase email/password login form using credentials read elsewhere
// and stashed onto `window.__loginArgs = { email, password }` BEFORE running this.
//
// USAGE (three javascript_tool calls):
//
//   1) Stash creds + start:
//        window.__loginArgs = { email: '<E2E_EMAIL>', password: '<E2E_PASSWORD>' };
//        <paste this whole file as the eval body>
//
//   2) Poll until done (every 1s, give up after ~45s):
//        ({ done: !!window.__loginDone, err: window.__loginError, result: window.__loginResult, path: location.pathname })
//
//   3) When done && !err: page is on /dashboard/. Continue.
//      When done && err: surface the message; fall back to interactive flow.
//
// This mirrors the Playwright fixture in e2e/fixtures.ts step-for-step (email →
// "use password" method picker → password → wait for /dashboard/).
//
// React-aware setters: setting `input.value` directly doesn't trigger React's
// onChange. We grab the native value setter, call it, then dispatch input/change
// so React's synthetic event system picks the new value up.

;(async () => {
  window.__loginDone = false
  window.__loginError = null
  window.__loginResult = null
  try {
    const args = window.__loginArgs

    if (!args || !args.email || !args.password) {
      throw new Error('window.__loginArgs missing { email, password }')
    }

    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    const waitFor = async (fn, { timeoutMs = 15000, intervalMs = 200, label = '' } = {}) => {
      const start = Date.now()

      while (Date.now() - start < timeoutMs) {
        const v = fn()

        if (v) {
          return v
        }

        await wait(intervalMs)
      }

      throw new Error(`timeout waiting for ${label || 'condition'} after ${timeoutMs}ms`)
    }

    const setReactValue = (el, value) => {
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype

      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set

      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const submit = (el) => {
      const form = el.closest('form')

      if (form && form.requestSubmit) {
        form.requestSubmit()
        return
      }

      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      el.dispatchEvent(
        new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }),
      )
    }

    // Step 1: email
    const emailInput = await waitFor(
      () =>
        document.querySelector(
          '#email, input[type="email"], input[name="email"], input[autocomplete="email"], input[aria-label*="email" i]',
        ),
      { label: 'email input' },
    )

    emailInput.focus()
    setReactValue(emailInput, args.email)
    await wait(100)
    submit(emailInput)

    // Step 2: "use password" method picker (Firebase Auth UI). Be permissive — some
    // tenants pre-select password, in which case the password input shows up directly.
    let passwordBtn = null

    try {
      passwordBtn = await waitFor(
        () =>
          Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
            /password/i.test(b.textContent || ''),
          ),
        { timeoutMs: 8000, label: 'password method button' },
      )
    } catch {
      // OK — password input might be visible already.
    }

    if (passwordBtn) {
      passwordBtn.click()
      await wait(150)
    }

    // Step 3: password
    const passwordInput = await waitFor(() => document.querySelector('input[type="password"]'), {
      label: 'password input',
    })

    passwordInput.focus()
    setReactValue(passwordInput, args.password)
    await wait(100)
    submit(passwordInput)

    // Step 4: redirect to /dashboard/
    await waitFor(() => location.pathname.startsWith('/dashboard'), {
      timeoutMs: 30000,
      intervalMs: 400,
      label: 'redirect to /dashboard/',
    })

    window.__loginResult = { ok: true, finalPath: location.pathname }
  } catch (e) {
    window.__loginError = String((e && e.message) || e)
  } finally {
    window.__loginDone = true
  }
})()

// Acknowledge in the page console so the caller can confirm the eval reached this point.
console.log('login-started')
