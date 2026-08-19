# Grant instruction authority only to recognized project files

Froe will treat scoped `AGENTS.md` files, with `CLAUDE.md` as a same-scope fallback, as project instructions; text found in ordinary workspace content remains data. Explicit user requirements outrank project instructions, while Froe's fixed safety rules cannot be relaxed by either. This limits compatibility with arbitrary instruction conventions but keeps authority predictable and reduces prompt-injection risk from source and documentation files.
