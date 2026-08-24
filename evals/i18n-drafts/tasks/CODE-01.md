# Remove nested code background from examples

Inline `code` inside an `.example` block receives its own gray background, producing an unwanted box within the example's existing background.

Make code nested anywhere in an example inherit the example background. Preserve the normal gray highlight for inline code outside examples and reuse the existing shared-style rule for contexts that suppress code backgrounds.
