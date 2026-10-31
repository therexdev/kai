# Local API and privacy

Install **Remote Access** to configure KAI's local API, project keys, budgets and optional remote access. Keep it local unless you deliberately configure remote exposure.

Use the endpoint and project key shown by the plugin with compatible API clients. Never publish a project key or expose an unauthenticated endpoint. Installed models and available compute determine what can be served.

Core offers Local-Only, Local-First and Network privacy choices. Local inference keeps model computation on your computer. Choosing network AI sends the request through the scheduler and a provider. Connected apps and external API providers receive the data needed for the actions you choose.

Native plugins have full access available to KAI and are not confined by their permission list. The Koinos Node plugin's explicitly enabled blockchain networking is separate from AI privacy mode.
