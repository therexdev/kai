# Run a Koinos Node

Install the regular **KAI Koinos Node** plugin in Core's **Plugins** page, then open it from **Apps**. It manages Docker, chain synchronization, the Node wallet, block production and reward returns.

## Wallet first

Create a dedicated Node wallet rather than using the KAI Core wallet. Back up the key securely. Verify the selected network and address before funding or signing any operation.

## Bring an existing Koinos AI node

1. Leave Docker available but close the old KAI app and its tray process.
2. Open the plugin's Dashboard or Node page. If it identifies a supported node owned by another profile, choose **Migrate node to this plugin**.
3. Review the locations and network, acknowledge that the old app is closed, and choose **Stop old node and migrate**.
4. Wait for completion. If paused, resume before starting either node.
5. Start the migrated node and let it catch up. Configure and register the intended production key separately before enabling block production.

Migration moves chain data only. Wallets, production keys and funds are not migrated. Arbitrary standalone Docker deployments are not supported by this migration flow.

[Full illustrated transfer guide](https://github.com/therexdev/kai-core/blob/main/docs/TRANSFER_GUIDE.md) · [Node plugin source and releases](https://github.com/therexdev/kai-plugin-koinos-node)

Use **Stop node** when you intend to stop Docker containers; closing to the tray does not stop the Node service.

## Transfer snapshots

These illustrations render the actual app interface with example paths and data. Your values will differ.

![Node Wallet interface](img/beta-node-wallet.png)

![Node Transfer interface](img/beta-node-transfer.png)
