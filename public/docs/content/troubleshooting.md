# Troubleshooting Core Beta

## Start with the right version

Update Core from Settings or the [release page](https://github.com/therexdev/kai-core/releases/latest). Update plugins separately in Plugins. Record both versions when reporting a problem.

## Models or wallet did not transfer

Close Alpha, including its tray icon. Review the profile selected in **Settings → Migrate from Koinos AI Alpha**. Core keeps an existing wallet rather than overwriting it. The tool transfers supported GGUF model files, not Ollama's cache or plugin accounts. [Transfer guide](https://github.com/therexdev/kai-core/blob/main/docs/TRANSFER_GUIDE.md).

## Credits or earning unavailable

Check your network connection, Core privacy mode and the status shown by Credits and Usage or Earn KOIN. Use the app's reconnect or recovery action when offered. Do not resend a payment just because a status read failed; review its saved state first.

## Node migration paused

Keep the old app closed and resume the transfer before starting either node. Do not delete containers, data directories or wallet files to bypass a warning.

## Need help

Report Core issues in [kai-core](https://github.com/therexdev/kai-core/issues), and plugin issues in that plugin's repository. Include reproduction steps and sanitized diagnostics; never include private keys, passwords or account tokens.
