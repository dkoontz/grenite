# Grenite data layer: the Article mapping, worked

Design artifact for the database access layer discussion. Scope B (mapping,
codecs, version stamps, typed upgrade chain) with the layout-as-data
commitment that keeps option C (derived schema diffs) open.

Context: `examples/realworld-supabase/src/Supabase.gren` hand-writes decoders,
encoders, and patches for the `Article` aggregate. The mapping below replaces
those with one declaration per field that also knows the storage layout.

## Core vocabulary (Grenite.Data, backend-neutral)

Concept sketch. The implemented core splits the value under construction
into `Fields record buildState` and stores each field as a `FieldSpec`; see
the Prototype status section for what exists today.

```gren
type Mapping a
    = Mapping
        { build : a                -- grows from (field -> record) to record
        , bindings : Array Binding
        }

type alias Binding =
    { id : String                  -- stable field identity, survives renames
    , storage : Storage
    , codec : FieldCodec           -- concrete per-type variant
    }

type Storage
    = KeyColumn String
    | Column String
    | BlobPart { column : String, key : String }
    | ChildRows { table : String, foreignKey : String, order : Maybe String }
    | Embedded { foreignKey : String }
    | ComputedField

-- Pure data, serializable. This is what the C diff engine compares.
toLayout : Mapping record -> Layout
```

`Mapping a` holds the partially applied build function, so intermediate
values have types like `Mapping (String -> rest)`, exactly the trick
`RouteParser.required` uses. Each typed combinator appends one `Binding`:

```gren
-- Postgres (backend module). One combinator per column type.

text : String -> (record -> String) -> Mapping (String -> rest) -> Mapping rest
text column accessor (Mapping m) =
    Mapping
        { build = m.build
        , bindings =
            m.bindings
                |> Array.pushLast
                    { id = column
                    , storage = Column column
                    , codec = TextField column
                    }
        }
```

Decode applies `build` to the decoded field values in binding order. Encode
projects through the accessors. One declaration serves both directions.

## The Article mapping (faithful to db/schema.sql)

```gren
module Data.Article exposing (Article, ArticleV2, ArticleV3, articleV2, articleV3, ...)

import Array exposing (Array)
import Data.Profile exposing (Profile, profile)
import Grenite.Data exposing (Mapping)
import Grenite.Data.Postgres as Pg

-- The unsuffixed alias names the current type, so handler code stays stable
-- across layout bumps. Re-point it when the fields change.

type alias Article =
    ArticleV3


type alias ArticleV3 =
    { slug : String
    , title : String
    , description : String
    , body : String
    , tagList : Array String
    , createdAt : String
    , updatedAt : String
    , favorited : Bool
    , favoritesCount : Int
    , author : Profile
    }

-- A type alias has no constructor in Gren, so the mapping names a build
-- function. Field order is the binding order below.

buildArticleV3 :
    String -> String -> String -> String -> Array String
    -> String -> String -> Bool -> Int -> Profile
    -> ArticleV3
buildArticleV3 slug title description body tagList createdAt updatedAt favorited favoritesCount author =
    { slug = slug
    , title = title
    , description = description
    , body = body
    , tagList = tagList
    , createdAt = createdAt
    , updatedAt = updatedAt
    , favorited = favorited
    , favoritesCount = favoritesCount
    , author = author
    }

-- The live schema in db/schema.sql. Versioning is part of the mapping, not
-- an opt-in, so the read path can always assume the stamp.

articleV3 : Mapping ArticleV3
articleV3 =
    Pg.mapping
        { table = "articles"
        , keys =
            -- Row identity. Contributes no field to the model. Used for
            -- joins and the favorites/follows embeds.
            [ Pg.key "id" Pg.Serial ]
        , version =
            { column = "schema_version"
            , current = 3
            , history = [ Pg.upgradeFrom 2 articleV2 upgradeV2toV3 ]
            }
        }
        buildArticleV3
        |> Pg.text "slug" .slug
        |> Pg.text "title" .title
        |> Pg.text "description" .description
        |> Pg.text "body" .body
        |> Pg.childRows
            { table = "article_tags"
            , foreignKey = "article_id"
            , order = Just "position"
            , valueColumn = "tag"
            }
            .tagList
        |> Pg.timestamp "created_at" .createdAt
        |> Pg.timestamp "updated_at" .updatedAt
        |> Pg.computed "favorited" (Pg.embedFlag "favorites")
        |> Pg.computed "favoritesCount" (Pg.embedCount "favorites")
        |> Pg.embedded "author" { foreignKey = "author_id" } profile
        |> Pg.finish
```

Notes:

- `slug`, `title`, `description`, `body`, `created_at`, `updated_at` are
  direct columns of `articles`. Uncontroversial bindings.
- `tagList` lives in `article_tags` rows. The binding names the child table,
  the foreign key, and the ordering column. On PostgREST this becomes the
  `article_tags(...)` embed that `decodeArticle` consumes today.
- `favorited` and `favoritesCount` are `ComputedField`. They never enter the
  layout as columns. `embedFlag` is "not empty" over the viewer-filtered
  `favorites` embed, which is what `decodeFavorited` does today. `embedCount`
  counts the same embed.
- `author` is `Embedded`, pointed at the `profile` mapping through
  `author_id`. Nested mappings compose.
- `schema_version` does not exist in the live schema yet. It is the write
  stamp from scope B. Reads with a stamp below `current` decode through the
  matching history mapping, then chain upgrades.

## The nested Profile mapping

```gren
module Data.Profile exposing (Profile, profile)

type alias Profile =
    { username : String
    , bio : Maybe String
    , image : Maybe String
    , following : Bool
    }

profile : Mapping Profile
profile =
    Pg.mapping
        { table = "users"
        , keys = [ Pg.key "id" Pg.Serial ]
        , version =
            { column = "schema_version"
            , current = 1
            , history = []
            }
        }
        buildProfile
        |> Pg.text "username" .username
        |> Pg.textNullable "bio" .bio
        |> Pg.textNullable "image" .image
        |> Pg.computed "following" (Pg.embedFlag "follows")
        |> Pg.finish
```

`following` mirrors `decodeFollowing`: absent or empty `follows` embed means
false, a viewer-filtered row means true.

## The version chain

Version 2 stored the tags as one comma-joined text column. Version 3 moved
them to `article_tags`. The upgrade is type-checked Gren:

```gren
type alias ArticleV2 =
    { slug : String
    , title : String
    , description : String
    , body : String
    , tagsCsv : String
    , createdAt : String
    , updatedAt : String
    , favorited : Bool
    , favoritesCount : Int
    , author : Profile
    }

articleV2 : Mapping ArticleV2
articleV2 =
    Pg.mapping
        { table = "articles"
        , keys = [ Pg.key "id" Pg.Serial ]
        , version =
            { column = "schema_version"
            , current = 2
            , history = []
            }
        }
        buildArticleV2
        |> Pg.text "slug" .slug
        |> Pg.text "title" .title
        |> Pg.text "description" .description
        |> Pg.text "body" .body
        |> Pg.text "tags_csv" .tagsCsv
        |> Pg.timestamp "created_at" .createdAt
        |> Pg.timestamp "updated_at" .updatedAt
        |> Pg.computed "favorited" (Pg.embedFlag "favorites")
        |> Pg.computed "favoritesCount" (Pg.embedCount "favorites")
        |> Pg.embedded "author" { foreignKey = "author_id" } profile
        |> Pg.finish

upgradeV2toV3 : ArticleV2 -> ArticleV3
upgradeV2toV3 old =
    buildArticleV3
        old.slug
        old.title
        old.description
        old.body
        (String.split "," old.tagsCsv)
        old.createdAt
        old.updatedAt
        old.favorited
        old.favoritesCount
        old.author
```

A v1 example (description added in v2, backfilled as the empty string) is
elided. Reads of a v1 row decode with `articleV1`, apply `upgradeV1toV2`,
then `upgradeV2toV3`. Writes always stamp the current version.

## Reads and writes stay hand-shaped

The mapping replaces codecs and layout knowledge. It does not replace the
query API, because reads need viewer context:

```gren
getArticle : Pg.Config -> String -> Maybe Int -> Task Pg.Error (Maybe Article)
getArticle cfg slug viewerId =
    Pg.select cfg articleV3
        |> Pg.whereEq "slug" slug
        |> Pg.withViewer viewerId
        |> Pg.expectOne
```

`withViewer` adds the viewer-filtered `favorites` embed to the PostgREST
URL. The generated select list comes from the mapping and always includes
the stamp column, so a versioned decode finds its stamp.

Writes: `Pg.insert cfg articleV3 value` posts the column projection to the
table route. Multi-table writes, such as article plus `article_tags` rows,
go through the rpc the backend module names, as `createArticle` does today.
The mapping supplies the field projection for the rpc body.

## The hybrid layout variant

The demo mapping was removed from the example app, because the live schema
never moved to this layout. The layout stays expressible, and a real
migration to it would look like this: identity and timestamps as columns,
everything else in one `data` JSONB column:

```gren
Pg.mapping
    { table = "articles"
    , keys = [ Pg.key "id" Pg.Serial ]
    , version =
        { column = "schema_version"
        , current = 4
        , history = [ Pg.upgradeFrom 3 articleV3 (\record -> record) ]
        }
    }
    buildArticleHybrid
    |> Pg.timestamp "created_at" .createdAt
    |> Pg.timestamp "updated_at" .updatedAt
    |> Pg.blobText "data" "slug" .slug
    |> Pg.blobText "data" "title" .title
    |> Pg.blobText "data" "description" .description
    |> Pg.blobText "data" "body" .body
    |> Pg.blobTextArray "data" "tagList" .tagList
    |> Pg.computed "favorited" (Pg.embedFlag "favorites")
    |> Pg.computed "favoritesCount" (Pg.embedCount "favorites")
    |> Pg.embedded "author" { foreignKey = "author_id" } profile
    |> Pg.finish
```

The version counts mapping revisions, and the type changes only when fields
change. A layout-only bump keeps the type and uses the identity upgrade.
Bind order matches the build function's parameter order, so a second layout
over one model needs its own builder with the fields in bind order.

Payoff for option C: adding another `blobText` binding diffs to
`AddBlobField`, which renders to no DDL on any backend, only a version bump.
Promoting `title` to a real column diffs to `PromoteToColumn`, which renders
to `ALTER TABLE ... ADD COLUMN` plus a backfill through the upgrade chain.

## Decisions carried into the v1 types

1. `Mapping` is data first: every binding records storage facts that
   serialize into `Layout`. C diffs `Layout` values.
2. Typed combinators per column type (`text`, `int`, `timestamp`, ...). Each
   records the codec and the layout fact together, so they cannot drift.
3. Field identity defaults to the column name. Renames need either an
   explicit id or a per-version rename manifest. Open choice.
4. `ComputedField` and `Embedded` never render as columns. Viewer context
   reaches them through the backend query API, not the mapping.
5. Versioning is required, not an opt-in. The mapping header record carries
   the table, the key columns, and the version spec: stamp column, current
   version, upgrade history. `unversioned` exists only for sources you do
   not own. The read path can then always assume the stamp and always select
   it. Metafields such as keys live in the header, never in the field chain,
   so the chain stays one step per build-function argument.
6. Naming convention: suffix retired types and mapping values with their
   version (`ArticleV2`, `articleV2`), and keep an unsuffixed alias for the
   current type (`type alias Article = ArticleV3`). Handler code stays
   stable across layout bumps.
7. Decode errors keep their structure. `decode` returns
   `Result Decode.Error record`, and the backend's `DecodeFailed` carries
   `Decode.Error`. Consumers call `Decode.errorToString` when they want
   text.

## Prototype status

Implemented and compile-verified on gren 0.6.5:

- `src/Grenite/Data.gren`: `Fields`, `Mapping`, `FieldSpec`, `Storage`,
  `Write`, `Layout`, `Upgrade`, `beginVersioned`, `beginUnversioned`, and
  the applicative building, decoding, encoding, and version-stamp routing.
- `src/Grenite/Data/Postgres.gren`: the typed combinators, `embedFlag` and
  `embedCount` derivations, the `Select` read builder, and `insert`. The
  generated select list includes the stamp column, so a versioned decode
  always finds its stamp.
- `examples/realworld-supabase/src/Data/Profile.gren` and `Data/Article.gren`:
  the mappings from this document.
- `examples/realworld-supabase/src/MappingCheck.gren`: a runnable check.
  Build it with `gren make MappingCheck --output=build/check.js`, run it with
  `node -e 'require("./build/check.js").Gren.MappingCheck.init()'`, then read
  `build/check-output.txt`. All six checks pass: v3 decode, v2 upgrade, a
  structural decode failure, a missing version stamp, encode, layout
  projection. The failure checks print the structured `Decode.Error`.

Open items:

1. The live `db/schema.sql` has no `schema_version` column on any table.
   Wiring a live read needs the stamp column added, `INT NOT NULL DEFAULT 1`,
   plus a backfill stamp of 1 on existing rows.
2. The `follows` embed under a nested author still needs a hand-shaped
   select; `withViewer` covers only the top-level `favorites` embed.
3. Field identity is still the column name. The rename manifest is open.

Deviations found while implementing:

1. `computed` and `embedded` take no accessor. They never enter the flat
   write payload, so the accessor had no job.
2. Bind order must match the build function's parameter order. A second
   layout over one model needs its own builder with the fields in bind
   order.
3. A versioned row without a stamp fails the decode. Backfills must stamp
   rows before the mapping can read them.
4. The row-polymorphic `record` inference works: accessors constrain the
   record type field by field, and the final annotation closes it.
