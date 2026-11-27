# Daily Sort v56

This package is based on the uploaded `daily-sort-main.zip`.

## What changed
- Rebuilt the task card layout using the actual DOM nesting in `core.js`.
- The text editor occupies the full card width and grows with its content.
- The toolbar is a single full-width bottom row.
- Toolbar controls are centered in equal-width cells.
- The task number is a toolbar cell and is visible only when **Show task numbers** is enabled.
- Removed the old top-right notch and polygon clipping from the active card layout.
- Replaced the accumulated task-editor CSS overrides with one authoritative layout layer.
- Updated asset/cache build versions to v56.

## Replace these files in the repository
- `index.html`
- `js/core.js`
- `css/task-editor.css`
- `js/cache.js`
- `sw.js`

`css/app.css` is not modified. It still contains legacy card rules, but the new task-editor layer explicitly neutralizes their card pseudo-elements and clipping.

## Data and integrations
No Supabase schema, account, session token, authentication, task data, import/export, undo/redo, theme definitions, or PWA manifest/icon data was intentionally changed.

## Validation
JavaScript syntax checks passed. The actual card DOM structure was rendered in Chromium using the repository's `app.css` and the new `task-editor.css`; both Today and Not Today layouts were checked, including the bottom toolbar and text clipping. This is a layout fixture test, not a full end-to-end test of Supabase or the live app.
