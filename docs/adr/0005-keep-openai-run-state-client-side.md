# Keep OpenAI run state client-side by default

Froe will send Responses API requests with `store: false` and keep the current run's continuation items in adapter memory instead of depending on remotely stored response IDs. This increases adapter complexity and prevents first-release resume support, but avoids opting source-bearing response state into the API's default application-state retention; it does not claim to disable separate provider abuse-monitoring retention.
