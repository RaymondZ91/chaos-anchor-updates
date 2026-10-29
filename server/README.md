# Chaos Anchor game server

This small server lets copies of the Chaos Anchor desktop app see who is online, add friends, form parties,
queue together and play online matches. It stores no emails or passwords.

## Put it online with Render (free)

1. Make a free account at https://github.com and create a **new repository** called `chaos-anchor-server`
   (Public or Private both work).
2. On the repository page click **Add file → Upload files**, drag in the three files from this folder
   (`server.js`, `package.json`, `README.md`) and click **Commit changes**.
3. Make a free account at https://render.com (sign in with GitHub is easiest).
4. In Render click **New → Web Service**, pick your `chaos-anchor-server` repository and fill in:
   - **Region:** Singapore (closest to Australia)
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
5. Click **Create Web Service**. After a minute or two the page shows an address like
   `https://chaos-anchor-server-abcd.onrender.com`. Open it in your browser: it should say
   "Chaos Anchor server is running".
6. Open the Chaos Anchor app → **Friends** → paste that address into **Server address** → **Save**.
   Everyone who plays with you does the same once (or ask Claude to build the app with the address built in).

## Play in the browser (no download, no Claude)

The server also hosts the whole game as a website. Once it is on Render, anyone can play by opening your server
address (for example `https://chaos-anchor-server-abcd.onrender.com`) in Chrome, Edge or Firefox. They are
connected to the same online lobby as the desktop app automatically. Send that link to friends who don't want to install anything.

## Make yourself the owner (admin panel)

1. In the app open **Friends**. Under **Online** it shows your **Player id** (starts with `u_`). Click **Copy**.
2. In Render open your service → **Environment** → **Add Environment Variable**:
   key `OWNER_ID`, value = your player id. Save (the server restarts).
3. Reopen the app: you now have the **Admin** button. Admins you add are saved on the server; to make an
   admin permanent even after the server is redeployed, also add an `ADMINS` variable with their ids,
   separated by commas.

## Good to know

- The free plan sleeps after about 15 minutes with nobody online. The first person to open the app then
  waits up to a minute while it wakes ("Connecting…"). A paid plan (about US$7/month) stays awake.
- One server in one region: players far away (e.g. in America) will have higher ping.
- Your player id is made from a secret code saved by the app on your computer. If you reinstall Windows or
  clear the app's data you get a new id (and lose friends/admin until you set it up again).

## Run it on your own computer (testing)

Install Node.js 18+ from https://nodejs.org, then in this folder run `npm install` and `npm start`.
The app's server address is then `ws://localhost:8080` (only works on that computer).
