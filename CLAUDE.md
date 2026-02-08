# Figma MCP — Project Rules

## Sync: `get_node_info_detailed` and `figma_node_table.py`

When adding, removing, or renaming a field in the `getNodeInfoDetailed` function (`src/cursor_mcp_plugin/code.js`), you **MUST** update `scripts/figma_node_table.py` to match:

1. **Extract the field** in `flatten_node()` — read it from the node dict
2. **Add it to the row dict** in the `rows.append({...})` block
3. **Add the column name** to the `columns` list in `to_markdown()`

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
| `pluginData.source` | `node.getPluginData("source")` | `source` |
| `likelySvg` | heuristic (FRAME with all vector/group descendants) | `likelySvg` |
