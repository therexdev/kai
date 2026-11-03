This is editable source for a KAI Core desktop plugin. The installable package
is produced and signed on your development computer, not by the web builder.

## Included functionality

- Sandboxed HTML/CSS/JavaScript UI; no Node or direct network requests.
- Plugin-scoped note storage and shared installed local models.
- AI produces a draft for the user to apply; it does not overwrite notes silently.
- Core language changes update interface labels in English, Spanish, Portuguese,
  French and German while preserving notes and model output.

Use Core 0.7.17 or newer for the shared language API. Set that minimum version
in catalog metadata if you publish a catalog entry; it is not a manifest field.

## Develop and test

Edit plugin/manifest.json, plugin/index.html, plugin/app.js and plugin/style.css.
plugin/i18n.js owns the offline interface translations. Keep user text literal.
Read the Reference tab in Build Koinos and https://koinosai.com/docs/#plugin-builder.

Run `node --test tests/*.test.cjs` from this source directory. Then test the
signed package in KAI Core with a ready local model, missing permissions and
language changes. These unit checks do not run Electron or local inference.

## Sign and install

Clone https://github.com/therexdev/kai-core and follow its plugin author guide.
With an existing Ed25519 publisher key kept outside your source, run from Core:

    node scripts/core/pack-plugin.js /path/to/source/plugin /private/publisher-private-key.pem /path/to/my-plugin-1.0.0.kaiplugin

Install the result with Plugins → Install 3rd Party Plugins. Review its publisher
and permissions. Increase the manifest version for updates and use the same
publisher key. The packer refuses to overwrite an existing output file.

The ZIP from Build Koinos is a source archive, not a signed .kaiplugin package.
Build Koinos does not sign, install, launch or submit your plugin to a marketplace.
Never add API keys, wallet keys or publisher private keys to this project.
