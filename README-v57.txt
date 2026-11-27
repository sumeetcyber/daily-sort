# Daily Sort v57 — task card layout

This build implements the supplied task-card sketch using the v56 project source.

- Today and Not Today use the same card component and layout.
- Each task is one continuous rounded card.
- Task text spans the full available width above the toolbar and wraps/grows vertically.
- The toolbar is attached to the bottom edge of the card, divided into centered cells.
- Completion checkbox and task number occupy their own cells; the number appears only when Show task numbers is enabled.
- Reorder, selection, move-zone, and expand controls remain available.
- The existing notes/details section remains below the card body.

Only asset version references in `index.html` and the cache-check build identifier in `js/cache.js` were bumped. `sw.js`, Supabase/auth, task storage, import/export, undo/redo, themes, manifest, and icons were not changed.

Replace the project files with this package. No database migration or `sw.js` upload is required for this change.
