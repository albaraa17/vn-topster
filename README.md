# VN Topster

A [Topsters](https://topsters.org)-style chart maker for **visual novels**, powered by the [VNDB](https://vndb.org) API.

## Run

```powershell
node server.js
```

Then open http://localhost:3000. (No dependencies — just Node 18+.)

The tiny server serves `public/` and proxies VNDB cover images via `/img`, because `t.vndb.org` doesn't send CORS headers and the PNG export needs CORS-clean images.

## Features

- Search VNDB by title or ID (`v17`, or a vndb.org URL); sort by relevance, popularity, rating, or newest
- Click a cover to add it to the next empty slot, or drag it onto a specific slot
- Drag between slots to swap; drag off the chart or right-click to remove; double-click to open on VNDB
- Layouts: custom collage (up to 10×10), Top 40, Top 42, Top 100
- Cover shape (2:3 box art, 3:4, square, 16:9), size, gap, padding, corner radius, shadows
- Titles beside the chart or below each cover, with optional rank / year / developer / original (Japanese) title
- Blurs explicit (or suggestive) covers, based on VNDB's image flagging
- Colour presets, custom colours, fonts (including Japanese fonts), background image
- Import from a public VNDB user list (Voted / Finished / Playing / …), sorted by vote
- Multiple charts, saved automatically in localStorage; JSON backup/restore
- Export to PNG at 1× or 2×
