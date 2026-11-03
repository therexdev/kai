# KAI Core reference snapshot

PLUGIN_AUTHOR_GUIDE.md, api-v1.d.ts and the test-only verifier fixture
scripts/fixtures/core-plugin-package.cjs are unmodified copies from
therexdev/kai-core commit 324c18835bbbba3ff3be1f34a31b09b03fa32167.
The web IDE and AI read them through lib/builder/plugin-docs.js. They are
read-only server reference material, not user workspace instructions.

When updating this snapshot, review Core's package verifier, public API and
examples together, update CORE_REVISION and the documentation source links,
and validate both exported starter packages with the matching Core verifier.
Native trust, restricted credit authorization, shared locale and lifecycle
semantics must remain explicit. Do not silently treat newer SDK types as
implemented runtime capabilities.
