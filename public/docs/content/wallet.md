# Your Core wallet and Node wallet

Core's **Wallet** is used for Core network payments and earning. The **KAI Koinos Node** plugin owns a separate Node wallet.

## Moving from Alpha

Close Alpha and use **Settings → Migrate from Koinos AI Alpha → Wallet**. This copies the encrypted wallet and preserves its address and password; it does not send tokens to a new address. Unlock it in Core and verify the address. Core will not overwrite an existing wallet.

[Follow the illustrated transfer guide](https://github.com/therexdev/kai-core/blob/main/docs/TRANSFER_GUIDE.md).

## Keep a separate Node wallet

We recommend creating a new, dedicated wallet inside the Node plugin instead of using your Core wallet. Back up its private key securely offline. Import an existing dedicated Node wallet only if that is the address you intend to use.

Node chain migration does not move wallets, private production keys, KOIN or VHP. Funds remain at their original addresses until you deliberately transfer them.

Never paste a private key into a website account form or support message.

## Transfer snapshots

These illustrations render the actual app interface with example paths and data. Your values will differ.

![Wallet interface](img/beta-wallet.png)
