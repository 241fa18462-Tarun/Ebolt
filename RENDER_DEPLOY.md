# Render deployment

This project is configured for Render as a Node web service.

- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- `npm start` runs Nitro's Node server from `.output/server/index.mjs`.
- `vite.config.ts` uses Nitro's `node-server` preset instead of Vercel's `.vercel/output`.

If Render already has custom commands configured, replace them with the commands above.
