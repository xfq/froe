# Treat approval policy as a boundary, not an operating-system sandbox

Superseded by [0006: Sandbox spawned commands with macOS Seatbelt](./0006-sandbox-spawned-commands-with-macos-seatbelt.md).

Froe will constrain its own file actions to the workspace and require approval for risky commands, but it will not claim to isolate executed programs from the host. Child processes receive a small environment allowlist, never the OpenAI API key, and additional variables can be allowed only by user-controlled configuration. A portable macOS/Linux sandbox would add substantial platform machinery and obscure the teaching implementation, while command classification and environment filtering cannot contain arbitrary code; users who need isolation must run Froe inside a container or other sandbox.
