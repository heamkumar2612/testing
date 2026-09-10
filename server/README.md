# Kairos Backend v2

Express + JSON-file persistence backend. This version intentionally avoids native SQLite modules so it installs cleanly on modern Node.js/Windows without Visual Studio C++ build tools.

Run:
```bash
npm install
npm run dev
```

API: http://localhost:4000

First-run demo accounts:
- admin / admin123
- hospital / hospital123
- ambulance / ambulance123
- user / user123

Passwords are stored as bcrypt hashes. Sessions use JWT.

For production, replace the JSON store with a managed database (PostgreSQL/Supabase/etc.) and use strong environment secrets.

## Frontend access (CORS)

Set `FRONTEND_ORIGINS` to a comma-separated list of deployed frontend origins, for example:

```env
FRONTEND_ORIGINS=https://heamkumar2612.github.io,https://your-custom-domain.example
```

Localhost origins are permitted for development. A browser request from any other origin is rejected deliberately.
