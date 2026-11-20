# Better Crunchyroll

Chrome extension that adds a cinema-mode (moon) button to the Crunchyroll player.
Cinema mode moves the controls into a strip below the picture and darkens the rest of the page.

## Build & install

```sh
npm install
npm run build      # or: npm run watch
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. After rebuilding, click the reload icon on the extension card and refresh Crunchyroll.

The cinema-mode setting is remembered across episodes.
