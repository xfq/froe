# Modernize Chinese font stacks and punctuation fallback

The Simplified and Traditional Chinese translations use legacy default fonts and can render punctuation inconsistently across operating systems.

Update both shared 2022 stylesheets. Give `zh-hans` and `zh-hant` modern system sans-serif fallback stacks suited to each writing system, with Windows, macOS, and broadly available CJK fallbacks. Add local-only punctuation faces with a narrow Unicode range so curly quotes, dashes, ellipses, and related marks come from the appropriate Chinese font. Do not add downloaded font files or external requests.

Keep the article and site-page stacks aligned. Check both writing systems and make sure non-Chinese languages are unaffected.
