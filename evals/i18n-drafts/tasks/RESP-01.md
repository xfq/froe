# Make site navigation pages usable on mobile

The main informational pages under `nav/` are laid out for desktop and overflow or become difficult to use on a phone.

Add responsive viewport metadata to these English and Simplified Chinese pages:

- `about`, `ask`, `find`, `follow`, `learn`, and `participate`
- the existing `zh-hans` translations of `about`, `learn`, and `participate`

Add a shared mobile layout at a maximum width of 767px. At that width, content margins and type should remain readable; asides, directory navigation, search, examples, figures, and notes should return to a usable single-column flow; navigation should wrap; and images must not exceed the viewport. Preserve the desktop layout and avoid page-specific style forks.

Verify representative English and Chinese pages at 390px and 1280px widths.
