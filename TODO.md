# Cursor Talk to Figma MCP - Development Roadmap

Last Updated: 2026-02-05

---

## ✅ Completed

- [x] Figma Variables Support
  - [x] `list_variables` - List all local variables
  - [x] `get_node_variables` - Get variable bindings for nodes
  - [x] `create_variable` - Create new variables
  - [x] `set_variable_value` - Set/update variable values
  - [x] `list_collections` - List variable collections
  - [x] `get_node_paints` - Get fills/strokes from nodes
  - [x] `set_node_paints` - Set fills/strokes with variable support

- [x] Paint Style Management
  - [x] `get_styles` - Get all styles (with multi-layer support)
  - [x] `create_paint_style` - Create color/paint styles
    - [x] Hardcoded colors support
    - [x] Variable-bound colors support
    - [x] Multi-layer paint support
    - [x] Gradients support
    - [x] Image fills support
    - [x] Per-layer opacity

---

## 🔥 Phase 1: Essential - Complete the Styles Workflow

**Priority: CRITICAL** - These complete the create → apply workflow

- [x] **`apply_paint_style`** ✅ **COMPLETED**
  - Apply existing paint styles to node fills or strokes
  - Parameters: `nodeId`, `styleId`, `property` ("fills" | "strokes")
  - Use case: Apply brand colors, bulk styling
  - Estimated complexity: Low

- [x] **`create_text_style`** ✅ **COMPLETED**
  - Create text styles with font properties
  - Parameters: `name`, `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, etc.
  - Support variable binding for font size, letter spacing
  - Use case: Design system typography
  - Estimated complexity: Medium

- [x] **`apply_text_style`** ✅ **COMPLETED**
  - Apply existing text styles to text nodes
  - Parameters: `nodeId`, `styleId`
  - Use case: Apply typography consistently
  - Estimated complexity: Low

---

## 🔶 Phase 2: Very Useful - Style Inspection & Effects

**Priority: HIGH** - Adds critical design system capabilities

- [x] **`get_node_styles`** ✅ **COMPLETED**
  - Get all styles currently applied to a node
  - Returns: `{ fillStyleId, strokeStyleId, textStyleId, effectStyleId }`
  - Use case: Audit styling, understand what's applied
  - Estimated complexity: Low

- [x] **`create_effect_style`** ✅ **COMPLETED**
  - Create shadow and blur effect styles
  - Support: DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR
  - Parameters: `name`, `effects` array
  - Support variable binding
  - Use case: Elevation system, consistent shadows
  - Estimated complexity: Medium

- [x] **`apply_effect_style`** ✅ **COMPLETED**
  - Apply effect styles to nodes
  - Parameters: `nodeId`, `styleId`
  - Use case: Apply shadows/blurs
  - Estimated complexity: Low

---

## 🔷 Phase 3: Style Management

**Priority: MEDIUM** - Enables style editing and maintenance

- [x] **`update_paint_style`** ✅ **COMPLETED**
  - Modify existing paint styles
  - Parameters: `styleId`, `paints`, `name`, `description`
  - Supports variable-bound colors, gradients, image fills
  - Use case: Rebrand colors, update styles
  - Estimated complexity: Medium

- [x] **`update_text_style`** ✅ **COMPLETED**
  - Modify existing text styles
  - Parameters: `styleId`, font properties, `boundVariables`
  - Use case: Update typography system
  - Estimated complexity: Medium

- [x] **`update_effect_style`** ✅ **COMPLETED**
  - Modify existing effect styles
  - Parameters: `styleId`, `effects`, `boundVariables`
  - Use case: Adjust shadows/blurs
  - Estimated complexity: Medium

- [x] **`delete_style`** ✅ **COMPLETED**
  - Remove styles from document
  - Parameters: `styleId`
  - Works with paint, text, effect, and grid styles
  - Estimated complexity: Low

- [x] **`detach_style`** ✅ **COMPLETED**
  - Remove style from node but keep properties
  - Parameters: `nodeId`, `styleType` ("fill" | "stroke" | "text" | "effect")
  - Uses async setters for dynamic-page access
  - Use case: Make custom one-off changes
  - Estimated complexity: Low

---

## 💎 Phase 4: Advanced Features

**Priority: NICE TO HAVE** - Advanced workflows and automation

### Component & Instance Management

- [x] **`create_component`** ✅ **COMPLETED**
  - Create reusable components from nodes
  - Parameters: `nodeId`, `name`, `description`
  - Use case: Build component libraries
  - Estimated complexity: Medium

- [x] **`swap_component_instance`** ✅ **COMPLETED**
  - Change which component an instance points to
  - Parameters: `instanceId`, `newComponentKey`
  - Use case: Swap button variants, update instances
  - Estimated complexity: Low

- [x] **`get_component_styles`** ✅ **COMPLETED**
  - Get all styles used in a component tree
  - Parameters: `componentId`
  - Returns: Array of style IDs and usage count per category (fill/stroke/text/effect)
  - Use case: Audit component styling, extract tokens
  - Estimated complexity: Medium

### Style Utilities

- [x] **`duplicate_style`** ✅ **COMPLETED**
  - Clone existing styles for variations
  - Parameters: `styleId`, `newName`
  - Supports paint, text, and effect styles
  - Use case: Create style variations (light/dark)
  - Estimated complexity: Low

- [x] **`find_nodes_with_style`** ✅ **COMPLETED**
  - Find all nodes using a specific style
  - Parameters: `styleId`
  - Returns: Array of node IDs, names, types, and which property uses the style
  - Use case: Impact analysis before style changes
  - Estimated complexity: Medium

- [x] **`batch_apply_styles`** ✅ **COMPLETED**
  - Apply multiple styles to multiple nodes at once
  - Parameters: `operations` array of `{ nodeId, styleId, styleType }`
  - Reports per-operation success/failure
  - Use case: Bulk styling operations
  - Estimated complexity: Medium

### Auto Layout Enhancements

- [x] **`set_auto_layout`** ✅ **COMPLETED**
  - Comprehensive auto-layout configuration in a single call
  - Parameters: `nodeId`, `mode`, `padding` (uniform or per-side), `itemSpacing`, `counterAxisSpacing`, alignment, sizing, `layoutWrap`
  - Use case: Create responsive components
  - Estimated complexity: High

- [x] **`set_constraints`** ✅ **COMPLETED**
  - Set layout constraints for nodes
  - Parameters: `nodeId`, `horizontal`, `vertical` (MIN/MAX/CENTER/STRETCH/SCALE)
  - Use case: Responsive design
  - Estimated complexity: Low

---

## 🎨 Phase 5: Design Token Management

**Priority: FUTURE** - Advanced design systems features

- [ ] **`export_design_tokens`**
  - Export variables and styles as design tokens JSON
  - Format: Style Dictionary compatible
  - Use case: Code generation, design-dev handoff
  - Estimated complexity: High

- [ ] **`import_design_tokens`**
  - Import design tokens and create variables/styles
  - Parameters: `tokens` JSON object
  - Use case: Sync from code to design
  - Estimated complexity: High

- [ ] **`sync_variable_to_style`**
  - Automatically create/update styles from variables
  - Parameters: `variableId` or collection
  - Use case: Maintain variable-style consistency
  - Estimated complexity: Medium

---

## 📊 Progress Summary

**Total Tasks:** 30
**Completed:** 27 (90%)
**Phase 1 (Critical):** 3/3 (100%) ✅
**Phase 2 (High):** 3/3 (100%) ✅
**Phase 3 (Medium):** 5/5 (100%) ✅
**Phase 4 (Nice to Have):** 8/8 (100%) ✅
**Phase 5 (Future):** 0/3 (0%)

---

## 🚀 Immediate Next Steps

1. ~~**`apply_paint_style`**~~ ✅ **COMPLETED**
2. ~~**`create_text_style`**~~ ✅ **COMPLETED**
3. ~~**`apply_text_style`**~~ ✅ **COMPLETED**

---

## 📝 Notes

- All style tools should support both local and team library styles
- Consider adding batch operations for performance
- Effect styles should support multiple effects (like paint layers)
- Consider adding style validation before applying
- Add error handling for missing styles/nodes
- Document which Figma API versions are required

---

## 🐛 Known Issues & Improvements

- [ ] Fix optional chaining in older Figma plugin environment (if more found)
- [ ] Add better error messages for style operations
- [ ] Add progress reporting for batch operations
- [ ] Consider adding style preview/thumbnail generation
- [ ] Add style usage analytics (which styles are most used)

---

Last updated: 2026-02-05
Generated with Claude Code 🎨
