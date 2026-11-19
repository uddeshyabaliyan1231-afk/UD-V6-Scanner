UD FULL BODY CANDLE HUNTER V6
COINDCX PROXY DEPLOYMENT

This project uses a Node.js proxy to access CoinDCX public APIs.

RENDER SETTINGS:

Service Type: Web Service
Runtime: Node
Build Command: Leave blank
Start Command: npm start
Health Check Path: /health

The service listens on the PORT provided by Render.

After deployment, open:
https://YOUR-RENDER-URL/health

Expected response:
{"ok":true,"service":"UD V6 CoinDCX proxy"}
