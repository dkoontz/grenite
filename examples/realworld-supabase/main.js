"use strict";

// The only JavaScript in this example. A compiled Gren node program exports
// `Gren.Main.init` instead of starting itself, so one call starts the
// server. Everything else - routing, validation, the Supabase HTTP calls -
// lives in the Gren code under src/.
//
// Environment variables (all optional):
//   SUPABASE_URL           PostgREST base URL
//                          (default http://127.0.0.1:3100)
//   SUPABASE_API_KEY       apikey header value (default local-dev-key)
//   SUPABASE_SERVICE_TOKEN optional Authorization: Bearer value, for a
//                          hosted Supabase project's service role key

require("./build/main.js").Gren.Main.init();
