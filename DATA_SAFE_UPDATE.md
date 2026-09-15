# TG Sender — Data-Safe Update

This package contains CODE ONLY. It intentionally does not include:

- app.db / tg_sender.db / SQLite databases
- config.json
- media/ or exports/
- Python __pycache__ files
- log files
- Telegram .session files

## Important: preserve existing accounts

Before updating an existing installation:

1. Make a backup of your current `app.db`.
2. Extract this ZIP into a temporary folder.
3. Copy/replace the application CODE files into your existing project.
4. Do NOT delete or replace your existing `app.db`.
5. Do NOT delete your existing configuration/secrets.
6. Restart the server.

The application database initialization uses `CREATE TABLE IF NOT EXISTS` and only adds missing columns with `ALTER TABLE`; it is designed to preserve existing rows.

## Render

If the service is using SQLite on Render, make sure the database is stored on a persistent disk/volume or move the database to a persistent external database. A normal Render redeploy can otherwise lose files stored on an ephemeral filesystem.

Set secrets through Render Environment Variables rather than committing `config.json`.

Required owner variable:

`OWNER_USER_ID=YOUR_OWNER_ID`

Telegram API credentials can be provided with:

`API_ID=...`
`API_HASH=...`

The database stores Telegram account session strings and API-key assignments, so preserving the database is essential when updating the code.
