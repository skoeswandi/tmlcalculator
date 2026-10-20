# TML Cost Calculator

Single-page calculator (Beta V1.0). Static site, no build step for hosting.

- Live: https://tmlcalculator.netlify.app
- Deploys automatically from `main` via Netlify.

## Logins

The calculator is AES-encrypted inside `index.html`. Everyone shares one password
(it derives the key); the gate only lets listed emails through. Users and their
roles are listed in the app's runtime shim (`USERS`) inside the encrypted page.

## Activity log

Every change to master data, monthly inputs and saved quotes is logged with the
signed-in user, time and the values that changed. See the **Activity log** tab
(filter by user or area, export CSV). The log, like all data in this static
build, lives in the browser's localStorage.

## Editing the app

```sh
node tools/crypt.mjs decrypt index.html '<password>' build/app.html   # edit build/app.html
node tools/crypt.mjs encrypt build/app.html '<password>' index.html 'a@x.com,b@x.com'
```

`build/` is git-ignored. Do not commit the decrypted app.
