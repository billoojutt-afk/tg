# TG Sender — Data-Safe Admin Update

This package contains application code only. It intentionally excludes existing user data and secrets:
- SQLite databases (`*.db`, `*.sqlite`, `*.sqlite3`)
- `config.json` and `.env*`
- Telegram `.session` files
- `media/`, `exports/`
- logs and Python cache

## Update safely
1. Back up your existing database and Telegram session files.
2. Replace application code files with the files from this package.
3. Keep your existing database, config/secrets, media, exports, and session files.
4. Restart the app.

The database initialization is additive: it creates missing tables and adds missing columns; it does not intentionally delete existing account rows.

## Render
SQLite data stored on an ephemeral Render filesystem can be lost across service replacement/redeploy. Use a persistent disk or an external persistent database if you need accounts/sessions to survive redeploys.

Set the owner ID in Render Environment Variables:
OWNER_USER_ID=YOUR_OWNER_ID

Do not commit API hashes, passwords, or other secrets to GitHub.

## API key add fix
The Add API action now sends an explicit JSON payload and the frontend cache version is bumped to v12, preventing the `[object Object]` request-body error.
