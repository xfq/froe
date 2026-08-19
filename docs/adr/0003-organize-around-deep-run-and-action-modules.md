# Organize the implementation around deep Run and Action modules

Froe will keep orchestration in one deep Run module, workspace mutation and command policy in one deep Action Runtime, and vendor translation behind the Model Provider seam; the CLI remains a thin composition layer. This rejects a class-per-tool architecture whose interfaces would expose nearly as much complexity as their implementations, concentrating behavior so tests can exercise complete runs through a small surface.
