# Grenite

A type-safe HTTP server framework for Node.js, powered by Gren.

## Quick start

Requirements: Gren 0.6.5 and Node.js (current LTS).

1. Add grenite as a dependency of your Gren node application.
2. Define an application and routes.
3. Compile with `gren make Main` and run with `node app`.

See `examples/basic` for a complete server.
See `examples/sqlite` for a server that stores data in SQLite through task ports.

## Define routes

A route defines the following elements and with the help of the compiler checks that all five are
compatible with each other.

- HTTP method - GET, PUT, POST, etc.
- Path pattern - "/route/to/resource/:id"
- Request body decoder - A decoder that checks if what the client sent is what your route expects
- Response body encoder - A decoder that checks that what the handler returns is what the route expects
- Handler - The function that takes in a request and produces the response

```gren
getUserRoute : Grenite.Types.RouteHandler AppModel Error
getUserRoute =
    Grenite.createRoute
        { method = HttpServer.GET
        , route =
            RouteParser.defineRoute
                "/user/:id"
                (RouteParser.succeed (\id -> { id = id })
                    |> RouteParser.required "id" RouteParser.int
                )
        , requestDecoder = Helpers.emptyRequestBodyDecoder
        , responseEncoder = Helpers.jsonResponseBodyEncoder encodeUser
        , handler = getUserHandler
        }

getUserHandler : AppModel
    -> Grenite.Types.Request { id : Int } Helpers.EmptyRequestBody
    -> Task Error (Grenite.Types.Response User)
getUserHandler _ request =
    Task.succeed
        { status = 200
        , body = { id = request.params.id, name = "John Doe" }
        , headers = [ GHttp.ResponseContentType GHttp.ApplicationJson ]
        }
```

## Start the server

```gren
application : Grenite.Types.Application AppModel Error
application =
    { host = "0.0.0.0"
    , port_ = 3000
    , routes = [ getUserRoute, createUserRoute ]
    , notFoundHandler = \_ ->
        { status = 404
        , body = "{\"error\": \"Not Found\"}"
        , headers = []
        }
    , errorHandler = handleError
    , init = \_ -> {}
    }

main : Grenite.Server AppModel Error
main =
    Grenite.createServer application
```

## Modules

| Module                 | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `Grenite`              | `createServer`, `createRoute`, program wiring                       |
| `Grenite.Types`        | `Application`, `Request`, `Response`, `RouteConfig`, `RouteHandler` |
| `Grenite.RouteParser`  | Path patterns with typed `:param` extraction                        |
| `Grenite.Http`         | Typed header vocabulary and parsers, IMF-fixdate helpers            |
| `Grenite.Helpers`      | Body decoders and encoders for JSON, string, and empty bodies       |
| `Grenite.ErrorHelpers` | `HttpClient.Error` to response mapping                              |


## Known gaps

- No request body size cap.
- No per-request timeout.
- No structured logging. Startup messages go to stdout and stderr.
- Request bodies must be valid UTF-8 text, because `requestDecoder` takes a
  `String`. Binary bodies need a follow-up design.

## Compile and run the examples

### basic

```bash
cd examples/basic
gren make Main
node app
```

The server listens on `0.0.0.0:3000`.

- `GET /user/1` returns 200 and JSON.
- `GET /user/0` returns 422.
- `GET /user/1/post/2` returns 200 and text.
- `POST /user` with a valid body returns 201.
- `POST /user` with an invalid body returns 400.
- Any unknown path or method returns 404.

### sqlite

```bash
cd examples/sqlite
npm run build
npm start
```

The build script compiles the Gren app to `build/main.js` with `--output`.
The file `main.js` imports that build, opens a SQLite database, and registers
one task port handler per port. The server listens on `0.0.0.0:3000`.

See `examples/sqlite/README.md` for the endpoint list.
