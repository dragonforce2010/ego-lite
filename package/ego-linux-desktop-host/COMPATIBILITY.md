# Experimental Linux reference host

This is an opt-in Electron host for SDK v2.2.0, not an official ego lite Linux
release or the proprietary Ego browser engine.

- Start with `ego-browser-linux skill`; run scripts with `ego-browser-linux nodejs`.
- Reuse one TaskSpace per goal. Multiple spaces are appropriate only when requested.
- The top-right counter opens all spaces. Cards show real page previews; selecting
  a card returns to that existing space and page without navigating or recreating it.
- Every space uses its own persistent browser partition. The host does not import
  a personal browser profile or inherit desktop-browser logins.
- Snapshots use Chromium Accessibility and DOMSnapshot APIs, with real backend
  node and frame identifiers. They are not the proprietary Ego snapshots.
- Browser-wide operations and foreign task targets are refused. The private Unix
  socket is a local trusted-user interface, not an authenticated remote gateway.
- Selecting Take over in the browser changes ownership of the current space and
  blocks its automation. Return control before continuing. An optional local
  desktop-supervisor control file can also block all Agent input.
- Linux clipboard transactions preserve text and HTML, serialize across clients,
  and avoid restoring over a clipboard change made by the user.
- Use `page.screenshot()` and inspect the actual image when visual reasoning is
  necessary. Browser automation does not control other desktop applications.
- Certificate errors, CAPTCHA, authentication and permission prompts require
  normal user handling. Do not bypass them.
