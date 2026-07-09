# checkin-bot

A Discord bot that automates employee attendance tracking across departments in a Discord server.

## Overview

The bot monitors voice channels and screen sharing to verify employee check-ins. It supports per-department sessions, leave management, and automated summaries.

## Tech Stack

- **Runtime**: Node.js 20
- **Bot Library**: discord.js v14
- **Keep-alive**: Express (listens on port 3000)
- **Storage**: Local JSON files (`bot_timer_data.json`, `leaves.json`)

## Key Commands

- `!addchannel` — Register the current channel as a check-in point for a department
- `!startcheckin` — Start a 10-minute check-in session for the department
- `!checkin` — Employee check-in (requires voice channel + screen share)
- `!checkleave` — Show who is on leave today
- `!resettest` — Reset the session for testing

## Configuration

- **TOKEN** — Discord Bot Token (set as a Replit Secret)
- **GUILD_ID** — Hardcoded in `index.js` (`1442466109503569992`)

## Entry Point

`index.js` — contains all bot logic and Express keep-alive server.

## Workflow

Single workflow `Start application` runs `npm start` (i.e., `node index.js`), console output type on port 3000.
