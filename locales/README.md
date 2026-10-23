# Interface translations

Every user-visible string of the client lives in this directory, one JSON file
per language. `en.json` is the base language: it holds the canonical wording
and is used as the fallback whenever another file is missing a key.

The files are discovered automatically — the application lists this directory
at runtime, so a new file is a new language; no code has to change.

## Adding a language

1. Copy `en.json` to `<code>.json`, where `<code>` is the two-letter language
   code (`fr`, `es`, `pt`, `it`, …).
2. Translate the **values** only. Keep every key exactly as it is, and keep the
   `{placeholders}` such as `{version}` or `{service}` inside the values — the
   application fills them in at runtime.
3. Set `_meta.name` to the language's own name (the name speakers of that
   language use, e.g. `Français`); this is what the Language menu shows.
4. Start the application with that file present — it appears in the
   **Language** menu immediately, next to *Automatic* (the system language).

A key that is missing or empty in your file simply falls back to the English
text, so a partial translation is safe to ship.

## Notes

- `_meta.code` should match the file name; it is informational.
- `_meta.acceptLocale` (optional) is the full locale tag of the language —
  `hu-HU`, `de-DE`, `fr-FR` and so on. It is what the browser sends as
  `Accept-Language` and reports as `navigator.language`, which is how the
  Language menu also steers the language the services offer their content in.
  Without it the bare code from the file name is used.
- The language is stored in `prefs.json` (`"language"`): `"auto"` follows the
  system locale, an explicit code pins the language.
