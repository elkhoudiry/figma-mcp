# Figma MCP — Project Rules

## Sync: MCP tools and `figma-mcp-list.txt`

When adding, removing, or changing the signature of an MCP tool (`server.tool()` in `server.ts` + handler in `code.js`), you **MUST** update `~/.claude/personal-automation/agents/design/figma-mcp-list.txt` to match, then deploy:

1. **Update the entry** — tool name, description, all parameters with types and required/optional
2. **Deploy to live** — copy to `~/.claude/agents/design/figma-mcp-list.txt`

The reverse also applies: if the list file describes a parameter that doesn't exist in code, fix the list.

## Sync: MCP limitations and `figma-mcp-limitations.txt`

When fixing a limitation, discovering a new one, or adding/changing a workaround, you **MUST** update `~/.claude/personal-automation/agents/design/figma-mcp-limitations.txt` to match, then deploy:

1. **Update the entry** — tool name, limitation description, and workaround steps
2. **Deploy to live** — copy to `~/.claude/agents/design/figma-mcp-limitations.txt`

If a limitation is fixed in code, remove it from the file. If a new Figma API limitation is discovered during development or testing, add it.

## Sync: `get_node_info_detailed` and `figma_node_table.py`

When adding, removing, or renaming a field in the `getNodeInfoDetailed` function (`src/cursor_mcp_plugin/code.js`), you **MUST** update `~/.claude/personal-automation/agents/design/scripts/figma_node_table.py` to match, then deploy:

1. **Extract the field** in `flatten_node()` — read it from the node dict
2. **Add it to the row dict** in the `rows.append({...})` block
3. **Add the column name** to the `columns` list in `to_markdown()`
4. **Deploy to live** — copy to `~/.claude/agents/design/scripts/figma_node_table.py`

The reverse also applies: if you add a column to the table script, the data must come from `getNodeInfoDetailed`.

### Current enriched fields (added beyond JSON_REST_V1 export)

These are read directly from the Figma node object in `getNodeInfoDetailed`:

| Field | Source | Table column(s) |
|---|---|---|
| `strokeWeight` | `node.strokeWeight` | `strokeWeight` |
| `strokeAlign` | `node.strokeAlign` | `strokeAlign` |
| `opacity` | `node.opacity` | `opacity` |
| `clipsContent` | `node.clipsContent` | `clipsContent` |
| `constraints` | `node.constraints` | `constraintH`, `constraintV` |
| `textAutoResize` | `node.textAutoResize` (TEXT only) | `textAutoResize` |
| `textTruncation` | `node.textTruncation` (TEXT only) | `textTruncation` |
| `effects` | `node.effects` | `effects` |
| `layoutGrids` | `node.layoutGrids` | `layoutGrids` |
| `exportSettings` | `node.exportSettings` | `exportSettings` |
| `dashPattern` | `node.dashPattern` (non-empty arrays only) | `dashPattern` |
| `pluginData.source` | `node.getPluginData("source")` | `source` |
| `likelySvg` | heuristic (FRAME with all vector/group descendants) | `likelySvg` |
