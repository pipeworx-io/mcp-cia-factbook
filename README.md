# @pipeworx/cia-factbook

CIA World Factbook country profiles (final 2026 edition) for 261 entities, covering history, geography, people, government, economy, energy, military and transnational issues, plus side-by-side field comparison across countries.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1875+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `factbook_country(country, sections?)`: one entity's profile. Returns Introduction, Geography, People and Society, Government and Economy by default; `sections` picks others, or `["all"]` for everything (~35 KB). Answers "tell me about Kenya" or "what type of government does Chile have".
- `factbook_compare(countries, fields)`: up to 10 countries × 10 fields side by side, e.g. Population, Real GDP per capita, Life expectancy at birth. Field names match Factbook headings (case-insensitive, partial match allowed); `"Economy > Exports"` pins the section.
- `factbook_fields(country?)`: the sections and field names a profile carries. Use it to find the exact field name for `factbook_compare`.
- `factbook_entities(query?, region?, limit?)`: list or search the 261 entities (countries, territories, oceans, the EU, the World) with their Factbook codes and regions.

`country` accepts a name ("South Korea", "Myanmar", "Ivory Coast"), an ISO 3166 code ("KE", "DEU"), or a Factbook code written as `gec:<code>`. If a name matches nothing, the tool returns `found:false` and lists the closest matches.

Every response carries `source`, `licence`, `data_as_of` and an `edition_note`.

## Auth

Keyless.

## Data sources

- Central Intelligence Agency, The World Factbook. The CIA published it in the public domain and discontinued it in February 2026. This pack reads the final edition from the open JSON archive that the factbook project maintains under CC0-1.0. The pack calls the archive on each request and stores no copy.

Things worth knowing:

- **The data is frozen.** The archive's last data update was 2026-01-22, and the Factbook will not be updated again, so `data_as_of` is always `2026-01-22`. Each figure carries its own estimate year, e.g. "55,751,717 (2025 est.)".
- **Factbook codes are not ISO codes.** In GEC codes, `au` is Austria and `gm` is Germany. The pack reads a bare 2- or 3-letter input as ISO first and treats it as a GEC code only when no ISO country matches. Use `gec:au` to force the Factbook code.
- **The Factbook uses its own spellings.** It says "Burma", "Turkey", "DRC", "Congo (Brazzaville)", "Côte d'Ivoire" and "The Gambia". The pack maps the common alternatives to these names.
- Some profiles have fewer sections than others. Oceans have no People and Society section, and some territories have no Military section. `other_sections` and `factbook_fields` show what a given profile contains.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "cia-factbook": {
      "url": "https://gateway.pipeworx.io/cia-factbook/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/cia-factbook/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1875+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/factbook_country \
  -H 'Content-Type: application/json' \
  -d '{"country":"Kenya"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/factbook_country`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "cia-factbook": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-cia-factbook"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-cia-factbook
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Cia Factbook data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
